import type { BoardData } from '../board';
import { problemColor, schoolGroup, schoolName, UNSET_PROBLEM_COLOR } from '../board';
import type { BoardSettings } from '../settings';
import { awardsFor, medalCounts } from '../settings';
import { resolverAssetBase } from '../resolver-data';
import type {
    AwardChain, ContestInfo, ContestStatus, GroupInfo, MediaType, OrganizationInfo, ProblemInfo, RunInfo, RunResult, TeamInfo, Verdict,
} from './types';

export interface LiveContestTimes {
    title: string;
    beginAt: Date;
    endAt: Date;
    lockAt?: Date | null;
    unlocked?: boolean;
}

export interface LiveBoard {
    id: string;
    name: string;
    teamIds: string[];
}

export interface LiveSource {
    contest: LiveContestTimes;
    /** Public projection of the contest (loadContestData(tdoc, false, identity, false)). */
    data: BoardData;
    boards: LiveBoard[];
    settings: BoardSettings;
    identity: boolean;
    logoNames: Record<string, string>;
    now: number;
    /** Before the public board may be shown (contest not started): no teams, no runs. */
    hidden?: boolean;
    /** Each team's camera and screen from 画面采集 (lib/live/capture.ts), by team id. */
    medias?: Record<string, Record<string, MediaType[]>>;
}

/** ICPC Live's ContestInfo defaults (cds/core ContestInfo.kt QueueSettings). */
export const defaultQueueSettings = {
    waitTimeSeconds: 60, firstToSolveWaitTimeSeconds: 120, featuredRunWaitTimeSeconds: 60,
    inProgressRunWaitTimeSeconds: 300, maxQueueSize: 20, maxUntestedRun: 15,
};

const verdicts: Record<string, Verdict> = {
    CORRECT: { shortName: 'AC', isAccepted: true, isAddingPenalty: false },
    WRONG_ANSWER: { shortName: 'WA', isAccepted: false, isAddingPenalty: true },
    TIME_LIMIT_EXCEEDED: { shortName: 'TL', isAccepted: false, isAddingPenalty: true },
    MEMORY_LIMIT_EXCEEDED: { shortName: 'ML', isAccepted: false, isAddingPenalty: true },
    RUNTIME_ERROR: { shortName: 'RE', isAccepted: false, isAddingPenalty: true },
    OUTPUT_LIMIT_EXCEEDED: { shortName: 'OL', isAccepted: false, isAddingPenalty: true },
    HACKED: { shortName: 'HK', isAccepted: false, isAddingPenalty: true },
    JUDGEMENT_FAILED: { shortName: 'FL', isAccepted: false, isAddingPenalty: true },
    // The public board shows a wrong answer as "rejected" until the contest ends; Hydro also charges ignored records.
    REJECTED: { shortName: 'RJ', isAccepted: false, isAddingPenalty: true },
    // Exempt from penalty in Hydro's ACM rule.
    COMPILATION_ERROR: { shortName: 'CE', isAccepted: false, isAddingPenalty: false },
    PRESENTATION_ERROR: { shortName: 'PE', isAccepted: false, isAddingPenalty: false },
    CANCELED: { shortName: 'IG', isAccepted: false, isAddingPenalty: false },
};

export function verdictFor(status: string): Verdict | null {
    if (status === 'PENDING' || status === 'FROZEN') return null;
    return verdicts[status] || verdicts.JUDGEMENT_FAILED;
}

export function contestStatus(contest: LiveContestTimes, now: number): ContestStatus {
    const start = contest.beginAt.getTime();
    const end = contest.endAt.getTime();
    const lock = contest.lockAt ? contest.lockAt.getTime() : null;
    // As ContestModel.isLocked: frozen strictly after the lock time, until the contest is unlocked.
    const frozenAt = lock !== null && lock < now && !contest.unlocked ? lock : null;
    if (now < start) return { type: 'before', scheduledStartAtUnixMs: start };
    if (now < end) return { type: 'running', startedAtUnixMs: start, frozenAtUnixMs: frozenAt };
    if (frozenAt !== null) return { type: 'over', startedAtUnixMs: start, finishAtUnixMs: end, frozenAtUnixMs: frozenAt };
    return { type: 'finalized', startedAtUnixMs: start, finishAtUnixMs: end, finalizedAtUnixMs: end, frozenAtUnixMs: null };
}

/** `eligible`: official teams of the board that solved something, the base of 按比例设奖. */
function medalChain(settings: BoardSettings, eligible: number, group?: string): AwardChain[] {
    const rules = awardsFor(settings, group || 'all');
    const tiebreakMode = rules.medalSameScore ? 'ALL' : 'NONE';
    const counts = medalCounts(rules, eligible);
    const awards = [];
    let total = 0;
    for (const [key, citation] of [['gold', rules.goldCitation], ['silver', rules.silverCitation], ['bronze', rules.bronzeCitation]] as const) {
        const count = counts[key];
        total += count;
        // Medals go to official teams that solved something, as on the board (cappedMedals).
        if (count > 0) awards.push({ id: `${key}-medal`, citation, chainLimit: total, minScore: 1, tiebreakMode } as const);
    }
    return awards.length ? [{ awards, excludedGroups: ['unofficial'], ...group ? { groups: [group] } : {} }] : [];
}

const logoKey = (name: string) => name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

export function buildContestInfo(source: LiveSource): ContestInfo {
    const { data, contest, identity } = source;
    const durationMs = contest.endAt.getTime() - contest.beginAt.getTime();
    const problems: ProblemInfo[] = Array.from({ length: data.contest.problem_quantity }, (_, index) => {
        const letter = (data.contest.problem_id as string[])[index];
        const color = (data.contest.balloon_color as { background_color: string }[] | undefined)?.[index]?.background_color;
        const normalized = color ? problemColor(color) : UNSET_PROBLEM_COLOR;
        return {
            id: String(index), letter, name: letter, ordinal: index, minScore: null, maxScore: null,
            color: normalized === UNSET_PROBLEM_COLOR ? null : normalized,
            scoreMergeMode: null, isHidden: false, weight: 1,
            ftsMode: { type: awardsFor(source.settings, 'all').firstSolve ? 'auto' : 'hidden' },
        };
    });
    const membership = new Map<string, string[]>();
    const groups: GroupInfo[] = [
        { id: 'official', displayName: '正式参赛', isHidden: false, isOutOfContest: false },
        { id: 'unofficial', displayName: '非正式参赛', isHidden: false, isOutOfContest: true },
    ];
    for (const board of source.hidden ? [] : source.boards) {
        if (board.id === 'all') continue;
        if (!groups.some((group) => group.id === board.id)) groups.push({ id: board.id, displayName: board.name, isHidden: false, isOutOfContest: false });
        for (const teamId of board.teamIds) membership.set(teamId, [...(membership.get(teamId) || []), board.id]);
    }
    const organizations = new Map<string, OrganizationInfo>();
    const teams: TeamInfo[] = (source.hidden ? [] : data.teams).map((team) => {
        const unofficial = team.group.includes('unofficial');
        let organizationId: string | null = null;
        if (identity) {
            const school = schoolName(team.organization);
            organizationId = schoolGroup(school);
            if (!organizations.has(organizationId)) {
                const logoId = team.organization ? source.logoNames[logoKey(team.organization)] : undefined;
                const url = logoId && /^[a-f\d]{12}$/.test(logoId)
                    ? `${resolverAssetBase}/logos/${logoId}.webp` : `${resolverAssetBase}/assets/img/icpc-logo.png`;
                organizations.set(organizationId, {
                    id: organizationId, displayName: school, fullName: school,
                    logo: [{ type: 'Image', url }], customFields: {},
                });
            }
        }
        return {
            id: team.team_id, name: team.name, shortName: team.name,
            groups: [...new Set([unofficial ? 'unofficial' : 'official', ...(membership.get(team.team_id) || [])])],
            hashTag: null, medias: source.medias?.[team.team_id] ?? {}, isHidden: false, isOutOfContest: unofficial,
            organizationId, color: null, reactionVideoTemplate: null, sourceTemplate: null,
            // Team contests: members for title templates ({team.customFields.members}) and the console.
            customFields: (team.members?.length ? { members: team.members.join(' · ') } : {}) as Record<string, string>,
        };
    });
    // As on the board (lib/board.ts): official teams with an accepted run among the data shown.
    const solved = new Set(data.submissions.filter((record) => record.status === 'CORRECT' && record.timestamp >= 0
        && record.timestamp < durationMs).map((record) => record.team_id));
    const eligible = (list: TeamInfo[]) => list.filter((team) => !team.isOutOfContest && solved.has(team.id)).length;
    return {
        name: contest.title,
        status: contestStatus(contest, source.now),
        resultType: 'ICPC',
        contestLengthMs: durationMs,
        freezeTimeMs: contest.lockAt ? contest.lockAt.getTime() - contest.beginAt.getTime() : null,
        problems, teams, groups, organizations: [...organizations.values()],
        languages: [], emulationSpeed: 1,
        penaltyRoundingMode: source.settings.tieBreak === 'icpc' ? 'each_submission_down_to_minute' : 'sum_in_seconds',
        // The main board's medals, then each sub-board's own (as the board shows a sub-board).
        awardsSettings: [...medalChain(source.settings, eligible(teams)),
            ...groups.flatMap((group) => medalChain(source.settings, eligible(teams.filter((team) => team.groups.includes(group.id))), group.id))],
        penaltyPerWrongAttemptSeconds: 1200,
        queueSettings: { ...defaultQueueSettings },
        showTeamsWithoutSubmissions: true,
        problemColorPolicy: { type: 'always' },
        customFields: {}, persons: [], accounts: [], mainScoreboardGroupId: null,
    };
}

/**
 * Runs as ICPC Live's CDS adapters would emit them: frozen and pending runs are in progress,
 * first-to-solve follows the board's first-solve rules and computation, and runs after a team's
 * first accepted run on a problem are marked.
 */
export function buildRuns(source: LiveSource, info: ContestInfo): RunInfo[] {
    const { data } = source;
    const known = new Set(info.teams.map((team) => team.id));
    const records = [...new Map(data.submissions.map((record) => [record.submission_id, record])).values()]
        .filter((record) => known.has(record.team_id) && record.timestamp >= 0 && record.timestamp < info.contestLengthMs
            && Number.isInteger(record.problem_id) && record.problem_id >= 0 && record.problem_id < info.problems.length)
        .sort((a, b) => a.timestamp - b.timestamp || a.submission_id.localeCompare(b.submission_id));
    const runs: RunInfo[] = records.map((record) => {
        const verdict = verdictFor(record.status);
        const result: RunResult = verdict
            ? { type: 'ICPC', verdict, isFirstToSolveRun: false, isAfterFirstOk: false }
            : { type: 'IN_PROGRESS', testedPart: 0, isAfterFirstOk: false };
        return {
            id: record.submission_id, result, problemId: String(record.problem_id), teamId: record.team_id,
            time: record.timestamp, languageId: null, reactionVideos: [], isHidden: false,
        };
    });
    const solved = new Set<string>();
    for (const run of runs) {
        const key = `${run.teamId}/${run.problemId}`;
        if (solved.has(key)) run.result.isAfterFirstOk = true;
        else if (run.result.type === 'ICPC' && run.result.verdict.isAccepted) solved.add(key);
    }
    const rules = awardsFor(source.settings, 'all');
    if (rules.firstSolve) {
        // As on the board (lib/award-policy.mjs): per problem, the earliest accepted run among
        // eligible teams; runs accepted at the same moment are all first solves.
        const outOfContest = new Set(info.teams.filter((team) => team.isOutOfContest).map((team) => team.id));
        const first = new Map<string, RunInfo[]>();
        for (const run of runs) {
            if (run.result.type !== 'ICPC' || !run.result.verdict.isAccepted || run.result.isAfterFirstOk) continue;
            if (outOfContest.has(run.teamId) && !rules.unofficialFirstSolve) continue;
            const current = first.get(run.problemId);
            if (!current || run.time < current[0].time) first.set(run.problemId, [run]);
            else if (run.time === current[0].time) current.push(run);
        }
        for (const list of first.values()) for (const run of list) if (run.result.type === 'ICPC') run.result.isFirstToSolveRun = true;
    }
    return runs;
}
