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

export function publicRunVerdict(result: RunResult): string {
    if (result.type === 'ICPC') return result.verdict.shortName;
    return result.frozen ? 'FROZEN' : 'PENDING';
}

export interface LiveBoard {
    id: string;
    name: string;
    teamIds: string[];
}

export interface LiveSource {
    contest: LiveContestTimes;
    /** Public Live projection with detailed verdicts and the contest freeze applied. */
    data: BoardData;
    boards: LiveBoard[];
    settings: BoardSettings;
    identity: boolean;
    logoNames: Record<string, string>;
    now: number;
    /** Before the public board may be shown (contest not started): no teams, no runs. */
    hidden?: boolean;
    /** Published reaction videos keyed by submission id. */
    reactionVideos?: Record<string, MediaType[]>;
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
    TIME_LIMIT_EXCEEDED: { shortName: 'TLE', isAccepted: false, isAddingPenalty: true },
    MEMORY_LIMIT_EXCEEDED: { shortName: 'MLE', isAccepted: false, isAddingPenalty: true },
    RUNTIME_ERROR: { shortName: 'RE', isAccepted: false, isAddingPenalty: true },
    OUTPUT_LIMIT_EXCEEDED: { shortName: 'OLE', isAccepted: false, isAddingPenalty: true },
    HACKED: { shortName: 'HK', isAccepted: false, isAddingPenalty: true },
    JUDGEMENT_FAILED: { shortName: 'SE', isAccepted: false, isAddingPenalty: true },
    UNKNOWN_ERROR: { shortName: 'UNK', isAccepted: false, isAddingPenalty: true },
    IGNORED: { shortName: 'IGN', isAccepted: false, isAddingPenalty: true },
    HACK_SUCCESSFUL: { shortName: 'HACK+', isAccepted: false, isAddingPenalty: true },
    HACK_UNSUCCESSFUL: { shortName: 'HACK-', isAccepted: false, isAddingPenalty: true },
    // Older or explicitly grouped input only.
    REJECTED: { shortName: 'RJ', isAccepted: false, isAddingPenalty: true },
    // Exempt from penalty in Hydro's ACM rule.
    COMPILATION_ERROR: { shortName: 'CE', isAccepted: false, isAddingPenalty: false },
    PRESENTATION_ERROR: { shortName: 'FE', isAccepted: false, isAddingPenalty: false },
    CANCELED: { shortName: 'CANCEL', isAccepted: false, isAddingPenalty: false },
};

export function verdictFor(status: string): Verdict | null {
    if (status === 'PENDING' || status === 'FROZEN') return null;
    return verdicts[status] || verdicts.UNKNOWN_ERROR;
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
    const podium = rules.podiumEnabled ? { hydroPodium: { basis: rules.podiumBasis, tie: rules.podiumTie, names: rules.podiumNames } } : {};
    return awards.length || rules.podiumEnabled
        ? [{ awards, excludedGroups: ['unofficial'], hydroMedalRanking: rules.medalRanking, ...podium, ...group ? { groups: [group] } : {} }] : [];
}

const logoKey = (name: string) => name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');

export function buildContestInfo(source: LiveSource, { fallbackOrganizationLogo = true } = {}): ContestInfo {
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
                    ? `${resolverAssetBase}/logos/${logoId}.webp`
                    : fallbackOrganizationLogo ? `${resolverAssetBase}/assets/img/icpc-logo.png` : null;
                organizations.set(organizationId, {
                    id: organizationId, displayName: school, fullName: school,
                    logo: url ? [{ type: 'Image', url }] : [], customFields: {},
                });
            }
        }
        return {
            id: team.team_id, name: team.name, shortName: team.name,
            groups: [...new Set([unofficial ? 'unofficial' : 'official', ...(membership.get(team.team_id) || [])])],
            hashTag: null, medias: source.medias?.[team.team_id] ?? {}, isHidden: false, isOutOfContest: unofficial,
            organizationId, color: null, reactionVideoTemplate: null, sourceTemplate: null,
            // Team contests: members for title templates ({team.customFields.members}) and the console.
            customFields: { ...team.members?.length ? { members: team.members.join(' · ') } : {}, ...team.school_key ? { hydroSchool: team.school_key } : {} } as Record<string, string>,
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
        penaltyRoundingMode: source.settings.tieBreak === 'icpc' || source.settings.tieBreak === 'ccpc' ? 'each_submission_down_to_minute' : 'sum_in_seconds',
        // The main board's medals, then each sub-board's own (as the board shows a sub-board).
        awardsSettings: [...medalChain(source.settings, eligible(teams)),
            ...groups.flatMap((group) => medalChain(source.settings, eligible(teams.filter((team) => team.groups.includes(group.id))), group.id))],
        penaltyPerWrongAttemptSeconds: 1200,
        queueSettings: { ...defaultQueueSettings },
        showTeamsWithoutSubmissions: true,
        problemColorPolicy: { type: 'always' },
        // The ranking rule's name: CCPC times by the minute as ICPC, but equal teams share the rank.
        customFields: { hydroTieBreak: source.settings.tieBreak ?? 'hydro' }, persons: [], accounts: [], mainScoreboardGroupId: null,
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
            : { type: 'IN_PROGRESS', testedPart: 0, isAfterFirstOk: false, ...(record.status === 'FROZEN' ? { frozen: true } : {}) };
        return {
            id: record.submission_id, result, problemId: String(record.problem_id), teamId: record.team_id,
            time: record.timestamp, languageId: null, reactionVideos: verdict ? source.reactionVideos?.[record.submission_id] ?? [] : [], isHidden: false,
        };
    });
    const solved = new Set<string>();
    for (const run of runs) {
        const key = `${run.teamId}/${run.problemId}`;
        if (solved.has(key)) run.result.isAfterFirstOk = true;
        else if (run.result.type === 'ICPC' && run.result.verdict.isAccepted) solved.add(key);
    }
    const rules = awardsFor(source.settings, 'all');
    for (const list of firstSolveRuns(runs, info.teams, rules).values()) {
        for (const run of list) if (run.result.type === 'ICPC') run.result.isFirstToSolveRun = true;
    }
    return runs;
}

/** Runs are in contest-time order. Include every eligible team tied at the first accepted time. */
export function firstSolveRuns(runs: RunInfo[], teams: TeamInfo[], rules: { firstSolve: boolean; unofficialFirstSolve: boolean }) {
    const winners = new Map<string, RunInfo[]>();
    if (!rules.firstSolve) return winners;
    const eligible = new Set(teams.filter((team) => !team.isOutOfContest || rules.unofficialFirstSolve).map((team) => team.id));
    for (const run of runs) {
        if (!eligible.has(run.teamId) || run.result.type !== 'ICPC' || !run.result.verdict.isAccepted || run.result.isAfterFirstOk) continue;
        const list = winners.get(run.problemId);
        if (!list) winners.set(run.problemId, [run]);
        else if (list[0].time === run.time) list.push(run);
    }
    return winners;
}
