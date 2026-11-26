/**
 * Hydro contest data as CCS Contest API objects (2026-01). Pure: lib/ccs/source.ts gathers the
 * Hydro data, this turns it into every endpoint's objects for one view.
 *
 * Views:
 * - `full`: judges and administrators, real-time and unmasked.
 * - `public`: what the public board shows (frozen after the freeze, wrong results only as RE until
 *   the contest ends, nothing before it starts). Teams see this plus their own team's details.
 *
 * Ranks, medals and first solves come from the same code as the board and ICPC Live
 * (lib/live/model.ts, lib/live/scoreboard.ts), so every surface agrees.
 */
import type { BoardData } from '../board';
import { creditedTime, type TimeCredit } from '../jury';
import { enhanceBoard, schoolGroup, schoolName } from '../board';
import { buildContestInfo, buildRuns, hiddenFromOf, type LiveBoard, type LiveSource } from '../live/model';
import { compareTeams, computeScoreboard, runsByTeam, sameScore, standingsAtRuns } from '../live/scoreboard';
import type { RunInfo } from '../live/types';
import { awardsFor, type BoardSettings } from '../settings';
import { resultsFinal, specialAwardResults } from '../special-awards';
import { isPending, judgementTypeOf, judgementTypes, simplifiedOf } from './judgement-types';
import {
    abstime, type Account, type Award, type Clarification, type Commentary, type Contest, type Group, type Judgement,
    type JudgementType, type Language, languageId, type Organization, type Person, type Problem, reltime, type Run, type Scoreboard,
    type ScoreboardRow, type State, type Submission, type Team, teamId, stableId,
} from './types';

export type View = 'full' | 'public' | `team-${string}`;

export interface CcsContest {
    /** Hydro contest id (hex), also the CCS contest id. */
    id: string;
    domainId: string;
    title: string;
    beginAt: number;
    endAt: number;
    lockAt: number | null;
    unlocked: boolean;
    allowTeam: boolean;
}

/** What the plugin records about a contest beyond Hydro's own fields (lib/ccs/store.ts). */
export interface CcsMeta {
    /** A thaw scheduled through PATCH contest (contest_thaw). */
    thawAt?: number | null;
    /** When the board was seen unlocked (Hydro keeps no time). */
    thawedAt?: number | null;
    finalizedAt?: number | null;
    endOfUpdatesAt?: number | null;
    finalizeRequested?: number | null;
    /** Countdown paused through PATCH contest (contest_start): the time left once resumed. */
    countdownPauseMs?: number | null;
}

export interface ProblemSource {
    pid: number;
    label: string;
    title: string;
    timeLimitMs: number | null;
    memoryMb: number | null;
    testCount: number;
    color: string | null;
    colorName: string | null;
    attachments: { name: string; size: number }[];
}

export interface LanguageSource { key: string; display: string; extension: string | null; compile: string | null; execute: string | null; submittable?: boolean }

export interface JudgingSource {
    status: number;
    /** When judging started, if seen (lib/ccs/writer.ts); null otherwise. */
    startAt: number | null;
    judgeAt: number | null;
    /** Longest run in ms, as Hydro records it. */
    time: number | null;
    cases: { status: number; time: number }[];
}

export interface RecordSource {
    rid: string;
    /** Submission id in the API: the record id, or the id an admin PUT the submission with. */
    submissionId: string;
    /** The user who submitted (a member in team contests). */
    uid: number;
    /** The team credited (Hydro uid; negative for team-contest teams). */
    teamUid: number;
    pid: number;
    lang: string;
    submittedAt: number;
    held?: boolean;
    /** Earlier judgings (record.history) first, the current one last. */
    judgings: JudgingSource[];
}

export interface ClarificationSource {
    docId: string;
    /** The id an admin PUT the clarification with, if any. */
    ccsId?: string;
    /** Hydro user who asked, 0 for a message from the jury to everyone. */
    owner: number;
    subject: number;
    content: string;
    at: number;
    replies: { id: string; owner: number; content: string; at: number }[];
}

export interface PersonSource { uid: number; name: string; teamUid: number | null; role: 'contestant' | 'staff' }
export interface AccountSource { uid: number; uname: string; name: string; type: 'team' | 'admin' | 'judge'; teamUid: number | null }

export interface AwardOverride { id: string; citation?: string; team_ids?: string[] | null; deleted?: boolean }
export interface PostedComment {
    id: string; at: number; message: string; tags: string[]; sourceUid: number | null;
    team_ids: string[] | null; problem_ids: string[] | null; submission_ids: string[] | null;
}

export interface CcsSource {
    now: number;
    contest: CcsContest;
    meta: CcsMeta;
    settings: BoardSettings;
    /** Real-time, unmasked board data with names and schools (loadContestData(tdoc, true, true, true)). */
    full: BoardData;
    /** The public board's data (loadContestData(tdoc, false, settings.showIdentity, false)). */
    public: BoardData;
    /** Whether the public may see the teams and results yet (Hydro canShowScoreboard for a guest). */
    publicVisible: boolean;
    /** Sub-boards (CCS groups) with names and schools; the public's own list follows its identity rule. */
    boards: LiveBoard[];
    publicBoards: LiveBoard[];
    logoNames: Record<string, string>;
    logoIndex: Record<string, { width: number; height: number; md5: string }>;
    problems: ProblemSource[];
    languages: LanguageSource[];
    records: RecordSource[];
    credits?: Record<string, Pick<TimeCredit, 'from' | 'minutes'>[]>;
    clarifications: ClarificationSource[];
    persons: PersonSource[];
    accounts: AccountSource[];
    /** Team-contest members and their team (Hydro uid → team uid). */
    teamOfUser: Map<number, number>;
    awardOverrides: AwardOverride[];
    comments: PostedComment[];
    extraClarifications?: Clarification[];
    codeLimit?: number;
}

export interface CcsObjects {
    contest: Contest;
    state: State;
    'judgement-types': JudgementType[];
    languages: Language[];
    problems: Problem[];
    groups: Group[];
    organizations: Organization[];
    teams: Team[];
    persons: Person[];
    accounts: Account[];
    submissions: Submission[];
    judgements: Judgement[];
    runs: Run[];
    clarifications: Clarification[];
    awards: Award[];
    commentary: Commentary[];
}

const PENALTY_MS = 20 * 60_000;
const logoKey = (name: string) => name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
/** Commentary messages refer to objects as `{type:id}`; literal braces and backslashes are escaped. */
const escapeMessage = (text: string) => text.replace(/\\/g, '\\\\').replace(/\{/g, '\\{');
const MIME: Record<string, string> = {
    pdf: 'application/pdf', zip: 'application/zip', txt: 'text/plain', md: 'text/markdown', png: 'image/png', jpg: 'image/jpeg',
    jpeg: 'image/jpeg', gif: 'image/gif', svg: 'image/svg+xml', json: 'application/json', csv: 'text/csv', html: 'text/html',
    in: 'text/plain', out: 'text/plain', ans: 'text/plain', c: 'text/x-c', cpp: 'text/x-c++', cc: 'text/x-c++', py: 'text/x-python', java: 'text/x-java',
};
export const mimeOf = (name: string) => MIME[name.split('.').pop()?.toLowerCase() || ''] || 'application/octet-stream';

/** The contest's own clock rules: frozen strictly after the lock time, until Hydro unlocks it. */
export function contestTimes(source: CcsSource) {
    const { contest, meta, now } = source;
    const started = now >= contest.beginAt && meta.countdownPauseMs == null;
    const ended = started && now >= contest.endAt;
    const freezes = contest.lockAt !== null && contest.lockAt > contest.beginAt && contest.lockAt < contest.endAt;
    const frozen = freezes && started && now > contest.lockAt!;
    // Hydro stores no thaw time: the moment the writer saw it unlocked, else just after the end.
    const thawedAt = freezes && contest.unlocked && ended ? Math.max(meta.thawedAt ?? contest.endAt + 1, contest.endAt + 1) : null;
    return { started, ended, freezes, frozen, thawedAt, publicFrozen: frozen && thawedAt === null };
}

export function buildState(source: CcsSource): State {
    const { contest, meta } = source;
    const times = contestTimes(source);
    const endedAt = times.ended ? contest.endAt : null;
    const finalized = endedAt !== null && meta.finalizedAt ? Math.max(meta.finalizedAt, endedAt + 1) : null;
    const lastBefore = Math.max(finalized ?? 0, times.thawedAt ?? 0);
    return {
        started: times.started ? abstime(contest.beginAt) : null,
        frozen: times.frozen ? abstime(contest.lockAt!) : null,
        ended: endedAt !== null ? abstime(endedAt) : null,
        thawed: times.thawedAt !== null ? abstime(times.thawedAt) : null,
        finalized: finalized !== null ? abstime(finalized) : null,
        // Only after the results are final and, when it froze, thawed (state ordering rules).
        end_of_updates: finalized !== null && (!times.freezes || times.thawedAt !== null) && meta.endOfUpdatesAt
            ? abstime(Math.max(meta.endOfUpdatesAt, lastBefore + 1)) : null,
    };
}

export function buildContest(source: CcsSource): Contest {
    const { contest, meta } = source;
    const paused = meta.countdownPauseMs != null;
    return {
        id: contest.id,
        name: contest.title,
        formal_name: contest.title,
        start_time: paused ? null : abstime(contest.beginAt),
        countdown_pause_time: paused ? reltime(meta.countdownPauseMs!) : null,
        duration: reltime(contest.endAt - contest.beginAt),
        scoreboard_freeze_duration: contest.lockAt !== null && contest.lockAt > contest.beginAt && contest.lockAt < contest.endAt ? reltime(contest.endAt - contest.lockAt) : null,
        scoreboard_thaw_time: meta.thawAt != null || meta.thawedAt != null ? abstime(meta.thawAt ?? meta.thawedAt!) : null,
        scoreboard_type: 'pass-fail',
        main_scoreboard_group_id: 'official',
        penalty_time: reltime(PENALTY_MS),
    };
}

function liveSource(source: CcsSource, view: View): LiveSource {
    const { contest } = source;
    return {
        contest: {
            title: contest.title, beginAt: new Date(contest.beginAt), endAt: new Date(contest.endAt),
            lockAt: contest.lockAt === null ? null : new Date(contest.lockAt), unlocked: contest.unlocked,
        },
        data: view === 'full' ? source.full : source.public,
        boards: view === 'full' ? source.boards : source.publicBoards,
        settings: source.settings,
        identity: view === 'full' || source.settings.showIdentity,
        logoNames: source.logoNames,
        now: source.now,
        hidden: view === 'public' && !source.publicVisible,
    };
}

const standingsCache = new WeakMap<CcsSource, Map<View, ReturnType<typeof computeStandings>>>();
function computeStandings(source: CcsSource, view: View) {
    const live = liveSource(source, view);
    const info = buildContestInfo(live);
    const runs = buildRuns(live, info);
    const state = computeScoreboard(info, runsByTeam(runs), 'normal');
    return { live, info, runs, state };
}

/** Ranks, rows and awards of one view, from the board's ranking code (computed once per source). */
export function standings(source: CcsSource, view: View) {
    let byView = standingsCache.get(source);
    if (!byView) standingsCache.set(source, byView = new Map());
    let result = byView.get(view);
    if (!result) byView.set(view, result = computeStandings(source, view));
    return result;
}

function problemIdOf(source: CcsSource, index: number) {
    return String(source.problems[index]?.pid ?? index);
}

/** Scoreboard rows for a set of teams, ranked among themselves (main board: official teams). */
function scoreboardRows(source: CcsSource, view: View, members: Set<string> | null): ScoreboardRow[] {
    const { info, runs, state } = standings(source, view);
    const byTeam = runsByTeam(runs);
    const official = new Set(info.teams.filter((team) => !team.isOutOfContest).map((team) => team.id));
    const included = state.ranking.order.filter((id) => (members ? members.has(id) : official.has(id)));
    const rows: ScoreboardRow[] = [];
    let previous: (typeof state.rows extends Map<string, infer R> ? R : never) | null = null;
    let rank = 0;
    included.forEach((liveTeamId, position) => {
        const row = state.rows.get(liveTeamId)!;
        // The contest's ranking rule decides who shares a rank (also the ICPC last-accepted tie-break).
        if (!previous || !sameScore(info, previous, row)) rank = position + 1;
        previous = row;
        const teamRuns = byTeam.get(liveTeamId) || [];
        rows.push({
            rank,
            team_id: teamId(Number(liveTeamId)),
            score: {
                num_solved: row.totalScore,
                total_time: reltime(row.penalty * 1000),
                time: row.totalScore > 0 ? reltime(row.lastAcceptedMs) : null,
            },
            problems: info.problems.map((problem, index) => {
                const problemRuns = teamRuns.filter((run) => run.problemId === problem.id && !run.isHidden);
                const solvedIndex = problemRuns.findIndex((run) => run.result.type === 'ICPC' && run.result.verdict.isAccepted);
                const upTo = solvedIndex < 0 ? problemRuns : problemRuns.slice(0, solvedIndex + 1);
                return {
                    problem_id: problemIdOf(source, index),
                    num_judged: upTo.filter((run) => run.result.type === 'ICPC').length,
                    num_pending: upTo.filter((run) => run.result.type !== 'ICPC').length,
                    solved: solvedIndex >= 0,
                    ...solvedIndex >= 0 ? { time: reltime(problemRuns[solvedIndex].time) } : {},
                };
            }),
        });
    });
    // Ties keep the board's own order (the same ranking code as the XCPCIO board).
    return rows;
}

export function buildScoreboard(source: CcsSource, view: View, groupId: string | null): Scoreboard {
    let members: Set<string> | null = null;
    if (groupId && groupId !== 'official') {
        const { info } = standings(source, view);
        members = new Set(info.teams.filter((team) => team.groups.some(id => stableId(id) === groupId)).map((team) => team.id));
    }
    const elapsed = Math.max(0, Math.min(source.now, source.contest.endAt) - source.contest.beginAt);
    return {
        time: abstime(source.now),
        contest_time: reltime(elapsed),
        state: buildState(source),
        rows: scoreboardRows(source, view, members),
    };
}

function buildLanguages(source: CcsSource): Language[] {
    const languages = new Map(source.languages.map(lang => [lang.key, lang]));
    // Disabled/deleted language settings must not leave historical submissions dangling.
    for (const record of source.records) if (!languages.has(record.lang)) languages.set(record.lang, {
        key: record.lang, display: record.lang, extension: null, compile: null, execute: null,
    });
    return [...languages.values()].map((lang) => ({
        id: languageId(lang.key),
        name: lang.display,
        entry_point_required: false,
        entry_point_name: null,
        extensions: lang.extension ? [lang.extension] : [],
        compiler: lang.compile ? { command: lang.compile } : null,
        runner: lang.execute ? { command: lang.execute } : null,
    }));
}

function buildProblems(source: CcsSource): Problem[] {
    return source.problems.map((problem, ordinal) => ({
        id: String(problem.pid),
        label: problem.label,
        name: problem.title,
        ordinal,
        rgb: problem.color,
        color: problem.colorName,
        time_limit: problem.timeLimitMs === null ? 0 : Math.round(problem.timeLimitMs) / 1000,
        memory_limit: problem.memoryMb === null ? 0 : Math.round(problem.memoryMb),
        test_data_count: problem.testCount,
        ...(source.codeLimit ? { code_limit: Math.ceil(source.codeLimit / 1024) } : {}),
        attachments: problem.attachments.length ? problem.attachments.map((file) => ({
            href: `contests/${source.contest.id}/problems/${problem.pid}/attachments/${encodeURIComponent(file.name)}`,
            filename: file.name,
            mime: mimeOf(file.name),
        })) : null,
    }));
}

/** Organizations (schools) and the teams, with their groups. */
function buildTeams(source: CcsSource, view: View) {
    const { info } = standings(source, view);
    const identity = view === 'full' || source.settings.showIdentity;
    const data = view === 'full' ? source.full : source.public;
    const schoolOf = new Map(data.teams.map((team) => [team.team_id, (team.organization || '').trim()]));
    const groups: Group[] = info.groups.map((group) => ({
        id: stableId(group.id),
        name: group.displayName,
        type: group.id === 'official' || group.id === 'unofficial' ? 'participation' : group.id.startsWith('school-') ? 'school' : 'board',
    }));
    const organizations = new Map<string, Organization>();
    const teams: Team[] = info.teams.map((team) => {
        const school = schoolOf.get(team.id) || '';
        let organizationId: string | null = null;
        if (identity && school) {
            const name = schoolName(school);
            organizationId = schoolGroup(name);
            if (!organizations.has(organizationId)) {
                const logoId = source.logoNames[logoKey(name)];
                const logo = logoId ? source.logoIndex[logoId] : undefined;
                organizations.set(organizationId, {
                    id: organizationId, name, formal_name: name,
                    logo: logo ? [{
                        href: `contests/${source.contest.id}/organizations/${organizationId}/logo`,
                        filename: 'logo.png', mime: 'image/png', width: logo.width, height: logo.height, hash: logo.md5,
                    }] : null,
                });
            }
        }
        const id = teamId(Number(team.id));
        return { id, name: team.name, label: id, display_name: null, organization_id: organizationId, group_ids: team.groups.map(stableId) };
    });
    return { groups, organizations: [...organizations.values()], teams };
}

/** Team-relative contest time; absolute timestamps remain the original clock readings. */
function teamTime(source: CcsSource, uid: number, at: number) {
    const elapsed = at - source.contest.beginAt;
    const credits = source.credits?.[String(uid)];
    return credits?.length ? creditedTime(elapsed, credits) : elapsed;
}

function buildSubmissions(source: CcsSource, view: View, visibleTeams: Set<string>) {
    const { contest } = source;
    const times = contestTimes(source);
    const knownProblems = new Set(source.problems.map((problem) => problem.pid));
    const knownAccounts = new Set(source.accounts.map((account) => account.uid));
    const submissions: Submission[] = [];
    const judgements: Judgement[] = [];
    const runs: Run[] = [];
    for (const record of source.records) {
        const team = teamId(record.teamUid);
        if (!visibleTeams.has(team)) continue;
        if (record.submittedAt < contest.beginAt || record.submittedAt >= contest.endAt) continue;
        if (!knownProblems.has(record.pid)) continue;
        submissions.push({
            id: record.submissionId,
            language_id: languageId(record.lang),
            problem_id: String(record.pid),
            team_id: team,
            account_id: knownAccounts.has(record.uid) ? `u${record.uid}` : null,
            time: abstime(record.submittedAt),
            contest_time: reltime(teamTime(source, record.teamUid, record.submittedAt)),
            entry_point: null,
            files: view === 'public' ? [] : [{ href: `contests/${contest.id}/submissions/${record.submissionId}/files`, filename: 'files.zip', mime: 'application/zip' }],
        });
        // The public sees results of submissions before the freeze (all of them once thawed), and
        // only "rejected" for a wrong one while the contest runs, as on the public board.
        const embargoed = view === 'public' && (record.held || (times.publicFrozen && record.submittedAt > contest.lockAt!));
        if (embargoed) continue;
        const simplified = view === 'public' && !times.ended;
        const judgings = view === 'public' ? record.judgings.slice(-1) : record.judgings;
        const offset = view === 'public' ? record.judgings.length - 1 : 0;

        judgings.forEach((judging, index) => {
            const seq = offset + index + 1;
            const current = seq === record.judgings.length;
            // Queued again (status 0) means not being judged yet: no judgement until it starts.
            if (judging.status === 0 && judging.judgeAt === null) return;
            const done = !isPending(judging.status) && judging.judgeAt !== null;
            const start = judging.startAt;
            const type = done ? judgementTypeOf(judging.status) : null;
            const id = stableId(`${record.rid}.${seq}`);
            judgements.push({
                id,
                submission_id: record.submissionId,
                judgement_type_id: simplified ? null : type,
                simplified_judgement_type_id: simplifiedOf(type),
                current,
                ...(start !== null ? { start_time: abstime(start), start_contest_time: reltime(teamTime(source, record.teamUid, start)) } : {}),
                end_time: done ? abstime(judging.judgeAt!) : null,
                end_contest_time: done ? reltime(teamTime(source, record.teamUid, judging.judgeAt!)) : null,
                max_run_time: done && judging.time !== null ? Math.round(judging.time) / 1000 : null,
            });
            if (view === 'full') {
                judging.cases.forEach((testCase, caseIndex) => {
                    if (isPending(testCase.status)) return;
                    runs.push({
                        id: stableId(`${id}.${caseIndex + 1}`),
                        judgement_id: id,
                        ordinal: caseIndex + 1,
                        judgement_type_id: judgementTypeOf(testCase.status) ?? 'CS',
                        run_time: Math.round(testCase.time || 0) / 1000,
                    });
                });
            }
        });
    }
    return { submissions, judgements, runs };
}

/**
 * Hydro clarifications: a question from a team (`owner`) or a message from the jury to all
 * (`owner` 0), each with its replies. A jury reply to a team goes to that team only.
 */
function buildClarifications(source: CcsSource, view: View, visibleTeams: Set<string>, visibleGroups: Set<string>): Clarification[] {
    const { contest } = source;
    const problemIds = new Set(source.problems.map((problem) => problem.pid));
    const teamOfOwner = (uid: number) => {
        const team = teamId(source.teamOfUser.get(uid) ?? uid);
        return visibleTeams.has(team) ? team : null;
    };
    const result: Clarification[] = [];
    for (const doc of [...source.clarifications].sort((a, b) => a.at - b.at)) {
        const asker = doc.owner ? teamOfOwner(doc.owner) : null;
        if (doc.owner && !asker) continue; // asked by someone who is not (or no longer) a team
        if (view === 'public' && doc.owner) continue; // public: only messages to everyone
        const questionId = doc.ccsId ?? `c${doc.docId}`;
        const problemId = doc.subject > 0 && problemIds.has(doc.subject) ? String(doc.subject) : null;
        const at = (time: number) => ({ time: abstime(time), contest_time: reltime(time - contest.beginAt) });
        result.push({
            id: questionId, from_team_id: asker, to_team_ids: null, to_group_ids: null, reply_to_id: null,
            problem_id: problemId, text: doc.content, ...at(doc.at),
        });
        for (const reply of doc.replies) {
            const fromAsker = !!doc.owner && teamOfOwner(reply.owner) === asker;
            result.push({
                id: `r${reply.id}`,
                from_team_id: fromAsker ? asker : null,
                to_team_ids: fromAsker || !asker ? null : [asker],
                to_group_ids: null,
                reply_to_id: questionId,
                problem_id: problemId,
                text: reply.content,
                ...at(reply.at),
            });
        }
    }
    result.push(...(source.extraClarifications || []).filter(clar => (!clar.from_team_id || visibleTeams.has(clar.from_team_id))
        && (view === 'full' || (!clar.from_team_id && clar.to_team_ids == null && clar.to_group_ids == null))).map(clar => ({
            ...clar, to_team_ids: clar.to_team_ids?.filter(id => visibleTeams.has(id)) ?? null,
            to_group_ids: clar.to_group_ids?.filter(id => visibleGroups.has(id)) ?? null,
            problem_id: clar.problem_id && problemIds.has(Number(clar.problem_id)) ? clar.problem_id : null,
        })));
    const ids = new Set(result.map(clar => clar.id));
    return result.map(clar => ({ ...clar, reply_to_id: clar.reply_to_id && ids.has(clar.reply_to_id) ? clar.reply_to_id : null }));
}

function buildAwards(source: CcsSource, view: View, teams: Team[]): Award[] {
    const { info, runs, state } = standings(source, view);
    const hiddenFrom = hiddenFromOf(info);
    const toCcs = (ids: string[]) => ids.map((id) => teamId(Number(id)));
    const teamNames = new Map(info.teams.map((team) => [team.id, team.name]));
    const awards: Award[] = state.ranking.awards.map((award) => ({ id: award.id, citation: award.citation, team_ids: toCcs(award.teams) }));
    const official = info.teams.filter((team) => !team.isOutOfContest);
    // Honor the contest's configured tie-break, podium-tie and same-score rules for winner & group-winner awards.
    const leaders = (ids: string[], boardId: string) => {
        const rows = ids.map((id) => ({ id, name: teamNames.get(id) || id, row: state.rows.get(id)! })).filter(({ row }) => row && row.totalScore > 0);
        if (!rows.length) return [];
        rows.sort((a, b) => compareTeams(info, a, b));
        const best = rows[0];
        const rules = awardsFor(source.settings, boardId);
        const tied = rows.filter(({ row }) => sameScore(info, best.row, row));
        if (!rules.medalSameScore) return toCcs([best.id]);
        if (rules.podiumEnabled && rules.podiumTie === 'lastAccept') {
            const bestSec = Math.floor(best.row.lastAcceptedMs / 1000);
            return toCcs(tied.filter(({ row }) => Math.floor(row.lastAcceptedMs / 1000) === bestSec).map(({ id }) => id));
        }
        return toCcs(tied.map(({ id }) => id));
    };
    awards.unshift({ id: 'winner', citation: '冠军', team_ids: leaders(official.map((team) => team.id), 'all') });
    if (awardsFor(source.settings, 'all').firstSolve) {
        const ftsRules = awardsFor(source.settings, 'all');
        const eligible = new Set(info.teams.filter(team => !team.isOutOfContest || ftsRules.unofficialFirstSolve).map(team => team.id));
        info.problems.forEach((problem, index) => {
            if (!problem.letter || (hiddenFrom !== undefined && index >= hiddenFrom)) return;
            const first = runs.filter((run) => run.problemId === problem.id && run.result.type === 'ICPC' && run.result.isFirstToSolveRun
                && !runs.some(earlier => earlier.problemId === problem.id && eligible.has(earlier.teamId) && !earlier.isHidden
                    && earlier.time <= run.time && earlier.result.type !== 'ICPC'));
            awards.push({
                id: `first-to-solve-${problemIdOf(source, index)}`,
                citation: `${problem.letter} 题一血`,
                team_ids: toCcs([...new Set(first.map((run: RunInfo) => run.teamId))]),
            });
        });
    }
    for (const group of info.groups) {
        if (group.id === 'official' || group.id === 'unofficial') continue;
        const members = official.filter((team) => team.groups.includes(group.id)).map((team) => team.id);
        awards.push({ id: `group-winner-${group.id}`, citation: `${group.displayName}第一名`, team_ids: leaders(members, group.id) });
    }
    // 特别奖, from the data this view sees: none while the freeze hides results from it.
    const data = view === 'full' ? source.full : source.public;
    const times = contestTimes(source);
    if (source.settings.specialAwards.length && (view === 'full' || !times.publicFrozen) && resultsFinal(data, times.ended)) {
        const board = enhanceBoard(data, source.settings, { identity: view === 'full' || source.settings.showIdentity });
        for (const award of specialAwardResults(board, source.settings)) {
            if (award.teamIds.length) awards.push({ id: `special-${award.id}`, citation: award.name, team_ids: toCcs(award.teamIds) });
        }
    }
    // Administrators may take over any award (POST/PUT/PATCH/DELETE awards).
    const known = new Set(teams.map((team) => team.id));
    const byId = new Map(awards.map((award) => [stableId(award.id), { ...award, id: stableId(award.id) }]));
    for (const override of source.awardOverrides) {
        if (override.deleted) { byId.delete(override.id); continue; }
        const base = byId.get(override.id);
        byId.set(override.id, {
            id: override.id,
            citation: override.citation ?? base?.citation ?? override.id,
            team_ids: override.team_ids === null ? null : (override.team_ids ?? base?.team_ids ?? []).filter((id) => known.has(id)),
        });
    }
    return [...byId.values()].map(award => ({ ...award, id: stableId(award.id) }));
}

/**
 * Commentary: one message per submission and one per verdict, generated from the view's runs in
 * the style of the live module's analytics, plus messages posted through the API.
 */
function buildCommentary(source: CcsSource, view: View, visibleTeams: Set<string>): Commentary[] {
    const { contest } = source;
    const { info, runs } = standings(source, view);
    const needStanding = new Set(runs.filter((run) => run.result.type === 'ICPC' && run.result.verdict.isAccepted && !run.result.isFirstToSolveRun).map((run) => run.id));
    const at = needStanding.size ? standingsAtRuns(info, runs, needStanding) : new Map<string, { rank: number; solved: number }>();
    const records = new Map(source.records.map((record) => [record.rid, record]));
    const teamName = new Map(info.teams.map((team) => [team.id, team.name]));
    const problemOf = new Map(info.problems.map((problem, index) => [problem.id, { letter: problem.letter, id: problemIdOf(source, index) }]));
    const result: Commentary[] = [];
    for (const run of runs) {
        const team = teamId(Number(run.teamId));
        const problem = problemOf.get(run.problemId);
        const record = records.get(run.id);
        if (!visibleTeams.has(team) || !problem || !record) continue;
        const name = escapeMessage(teamName.get(run.teamId) || team);
        const problemLabel = problem.letter ? `${problem.letter} 题` : '未公开题目';
        const refs = { team_ids: [team], problem_ids: [problem.id], submission_ids: [record.submissionId] };
        const submittedAt = record.submittedAt;
        result.push({
            id: `s${record.rid}`, time: abstime(submittedAt), contest_time: reltime(teamTime(source, record.teamUid, submittedAt)),
            message: `${name} 提交了 ${problemLabel}`, tags: ['submission'], source_id: null, ...refs,
        });
        if (run.result.type !== 'ICPC') continue;
        const judgeAt = record.judgings.at(-1)?.judgeAt ?? submittedAt;
        const standing = at.get(run.id);
        let message: string;
        const tags: string[] = [];
        if (!run.result.verdict.isAccepted) {
            // The public sees only "rejected" until the contest ends, as on the board.
            const type = view === 'public' && !contestTimes(source).ended ? null : judgementTypeOf(record.judgings.at(-1)?.status ?? -1);
            message = `${name} 的 ${problemLabel}未通过${type ? `（${type}）` : ''}`;
            tags.push('rejected');
        } else if (run.result.isFirstToSolveRun) {
            message = `${name} 拿下 ${problemLabel}一血！`;
            tags.push('accepted', `accepted-first-to-solve-${problem.id}`);
        } else {
            message = standing && standing.rank
                ? `${name} 通过 ${problemLabel}，共通过 ${standing.solved} 题，当前排名第 ${standing.rank}`
                : `${name} 通过 ${problemLabel}`;
            tags.push('accepted');
        }
        result.push({
            id: `v${record.rid}`, time: abstime(Math.max(judgeAt, submittedAt)), contest_time: reltime(teamTime(source, record.teamUid, Math.max(judgeAt, submittedAt))),
            message, tags, source_id: null, ...refs,
        });
    }
    const knownProblems = new Set(source.problems.map((p) => String(p.pid)));
    const visibleSubmissions = new Set(source.records.filter((r) => visibleTeams.has(teamId(r.teamUid))).map((r) => r.submissionId));
    const visiblePersons = new Set(source.persons.filter((person) => view === 'full' || person.role === 'contestant').map((person) => person.uid));
    for (const comment of source.comments) {
        if (comment.team_ids?.some(id => !visibleTeams.has(id))
            || comment.problem_ids?.some(id => !knownProblems.has(id))
            || comment.submission_ids?.some(id => !visibleSubmissions.has(id))) continue;
        result.push({
            id: comment.id, time: abstime(comment.at), contest_time: reltime(comment.at - contest.beginAt),
            message: comment.message, tags: comment.tags,
            source_id: comment.sourceUid !== null && visiblePersons.has(comment.sourceUid) ? `p${comment.sourceUid}` : null,
            team_ids: comment.team_ids, problem_ids: comment.problem_ids, submission_ids: comment.submission_ids,
        });
    }
    return result;
}

function buildPeople(source: CcsSource, view: View, visibleTeams: Set<string>) {
    const persons: Person[] = [];
    for (const person of source.persons) {
        const team = person.teamUid === null ? null : teamId(person.teamUid);
        if (person.role === 'contestant' && (!team || !visibleTeams.has(team))) continue;
        if (person.role === 'staff' && view !== 'full') continue; // the jury is listed to the jury
        persons.push({ id: `p${person.uid}`, team_ids: person.role === 'contestant' ? [team!] : [], name: person.name, role: person.role });
    }
    const personIds = new Set(persons.map((person) => person.id));
    const accounts: Account[] = source.accounts
        .filter((account) => account.teamUid === null || visibleTeams.has(teamId(account.teamUid)))
        .map((account) => ({
            id: `u${account.uid}`, username: account.uname, name: account.name, type: account.type,
            team_id: account.teamUid === null ? null : teamId(account.teamUid),
            person_id: personIds.has(`p${account.uid}`) ? `p${account.uid}` : null,
        }));
    return { persons, accounts };
}

type CachedObjects = {
    base: Omit<CcsObjects, 'commentary'>;
    visibleTeams: Set<string>;
    hidden: boolean;
    full?: CcsObjects;
    lite?: CcsObjects;
};
const objectsCache = new WeakMap<CcsSource, Map<View, CachedObjects>>();

/** Every endpoint's objects for one view (computed once per source and view). */
export function buildObjects(source: CcsSource, view: View, options?: { skipCommentary?: boolean }): CcsObjects {
    let byView = objectsCache.get(source);
    if (!byView) objectsCache.set(source, byView = new Map());
    let cached = byView.get(view);
    if (!cached) {
        if (view.startsWith('team-')) {
            const held = new Set(source.records.filter((record) => record.held).map((record) => record.submissionId));
            const full = buildObjects(source, 'full', { skipCommentary: true });
            const pub = buildObjects(source, 'public', { skipCommentary: true });
            const { commentary: _c, ...base } = teamObjects(full, pub, view.slice(5), held);
            cached = { base, visibleTeams: new Set(), hidden: false };
        } else {
            cached = computeBaseObjects(source, view);
        }
        byView.set(view, cached);
    }
    if (options?.skipCommentary) {
        if (cached.full) return cached.full;
        return cached.lite ||= { ...cached.base, commentary: [] };
    }
    if (!cached.full) {
        const commentary = view.startsWith('team-')
            ? buildObjects(source, 'public').commentary
            : cached.hidden ? [] : buildCommentary(source, view, cached.visibleTeams);
        cached.full = { ...cached.base, commentary };
    }
    return cached.full;
}

function computeBaseObjects(source: CcsSource, view: View): CachedObjects {
    const hidden = view === 'public' && !source.publicVisible;
    const { groups, organizations, teams } = buildTeams(source, view);
    const visibleTeams = new Set(hidden ? [] : teams.map((team) => team.id));
    const live = buildSubmissions(source, view, visibleTeams);
    const people = buildPeople(source, view, visibleTeams);
    return {
        hidden,
        visibleTeams,
        base: {
            contest: buildContest(source),
            state: buildState(source),
            'judgement-types': judgementTypes,
            languages: buildLanguages(source),
            // Problems are secret until the contest starts, except to the jury.
            problems: view === 'public' && !contestTimes(source).started ? [] : buildProblems(source),
            groups,
            organizations: hidden ? [] : organizations,
            teams: hidden ? [] : teams,
            persons: people.persons,
            accounts: view === 'full' ? people.accounts : [],
            submissions: live.submissions,
            judgements: live.judgements,
            runs: live.runs,
            clarifications: buildClarifications(source, view, visibleTeams, new Set(groups.map(group => group.id))),
            awards: hidden ? [] : buildAwards(source, view, teams),
        },
    };
}

/**
 * What a team sees: the public view, with its own submissions' full judgements and runs, and its
 * own clarifications (questions and the replies to them).
 */
export function teamObjects(full: CcsObjects, publicObjects: CcsObjects, team: string, held: ReadonlySet<string> = new Set()): CcsObjects {
    const own = new Set(full.submissions.filter((submission) => submission.team_id === team).map((submission) => submission.id));
    const ownJudgements = full.judgements.filter((judgement) => own.has(judgement.submission_id) && !held.has(judgement.submission_id));
    const ownJudgementIds = new Set(ownJudgements.map((judgement) => judgement.id));
    const groups = new Set(full.teams.find(t => t.id === team)?.group_ids || []);
    const ownClars = full.clarifications.filter((clar) => clar.from_team_id === team || clar.to_team_ids?.includes(team)
        || clar.to_group_ids?.some(group => groups.has(group)));
    const ownClarIds = new Set(ownClars.map((clar) => clar.id));
    const merge = <T extends { id: string }>(base: T[], extra: T[]) => {
        const byId = new Map(base.map((item) => [item.id, item]));
        for (const item of extra) byId.set(item.id, item);
        return [...byId.values()];
    };
    // The team's own submissions refer to it even while the public may not see the teams yet.
    const ownTeam = full.teams.find((item) => item.id === team);
    const teams = ownTeam && !publicObjects.teams.some((item) => item.id === team)
        ? [...publicObjects.teams, publicObjects.organizations.some(org => org.id === ownTeam.organization_id) ? ownTeam : { ...ownTeam, organization_id: null }]
        : publicObjects.teams;
    return {
        ...publicObjects,
        teams: teams.map((item) => (item.id === team ? { ...item, group_ids: item.group_ids.filter(id => publicObjects.groups.some(group => group.id === id)) } : item)),
        submissions: merge(publicObjects.submissions.map(submission => ({ ...submission, files: [] })), full.submissions.filter((submission) => own.has(submission.id))),
        judgements: merge(publicObjects.judgements.filter((judgement) => !own.has(judgement.submission_id)), ownJudgements),
        runs: full.runs.filter((run) => ownJudgementIds.has(run.judgement_id)),
        // A jury reply may be shared with additional teams without disclosing its private parent.
        clarifications: merge(publicObjects.clarifications, ownClars.map(clar => ({ ...clar,
            to_group_ids: clar.to_group_ids?.filter(id => publicObjects.groups.some(group => group.id === id)) ?? null,
            reply_to_id: clar.reply_to_id && (ownClarIds.has(clar.reply_to_id) || publicObjects.clarifications.some(item => item.id === clar.reply_to_id)) ? clar.reply_to_id : null,
        }))),
    };
}
