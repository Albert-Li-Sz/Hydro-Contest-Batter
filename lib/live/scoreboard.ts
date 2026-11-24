/**
 * ICPC scoreboard rows as computed by ICPC Live v3 (cds/core scoreboard/*.kt, MIT), ported to TypeScript.
 * Penalty, ranks and medals follow the rest of this plugin: Hydro's ACM rule (whole seconds summed) or
 * the ICPC rule (whole minutes, then the last accepted run), 20 minutes per wrong attempt.
 */
import type {
    Award, ContestInfo, ICPCProblemResult, OptimismLevel, RunInfo, ScoreboardDiff, ScoreboardRow, SolutionsStatistic, TimeLineRunInfo,
} from './types';
import { publicRunVerdict } from './model';
import { schoolRanks, trophyWinners } from '../../resolver/public/js/trophies.js';

const isJudged = (run: RunInfo) => run.result.type === 'ICPC';
const isAccepted = (run: RunInfo) => run.result.type === 'ICPC' && run.result.verdict.isAccepted;
const isAddingPenalty = (run: RunInfo) => run.result.type === 'ICPC' && run.result.verdict.isAddingPenalty;

const rules: Record<OptimismLevel, {
    accepted: (run: RunInfo, index: number, count: number) => boolean;
    pending: (run: RunInfo, index: number, count: number) => boolean;
    penalty: (run: RunInfo, index: number, count: number) => boolean;
}> = {
    normal: {
        accepted: (run) => isAccepted(run),
        pending: (run) => !isJudged(run),
        penalty: (run) => isJudged(run) && isAddingPenalty(run),
    },
    pessimistic: {
        accepted: (run) => isAccepted(run),
        pending: () => false,
        penalty: (run) => !isJudged(run) || isAddingPenalty(run),
    },
    optimistic: {
        accepted: (run, index, count) => isAccepted(run) || (!isJudged(run) && index === count - 1),
        pending: () => false,
        penalty: (run, index, count) => isAddingPenalty(run) || (!isJudged(run) && index !== count - 1),
    },
};

/** `runs` of one team, in submission order. */
export function scoreboardRow(info: ContestInfo, runs: RunInfo[], level: OptimismLevel): ScoreboardRow {
    const rule = rules[level];
    const byProblem = new Map<string, RunInfo[]>();
    for (const run of runs) {
        if (run.isHidden) continue;
        byProblem.set(run.problemId, [...(byProblem.get(run.problemId) || []), run]);
    }
    let solved = 0;
    let penalty = 0;
    let lastAccepted = 0;
    const problemResults = info.problems.filter((problem) => !problem.isHidden).map((problem): ICPCProblemResult => {
        const problemRuns = byProblem.get(problem.id) || [];
        const okIndex = problemRuns.findIndex((run, index) => rule.accepted(run, index, problemRuns.length));
        const before = okIndex === -1 ? problemRuns : problemRuns.slice(0, okIndex);
        const okRun = okIndex === -1 ? null : problemRuns[okIndex];
        const wrongAttempts = before.filter((run, index) => rule.penalty(run, index, problemRuns.length)).length;
        const result: ICPCProblemResult = {
            type: 'ICPC',
            wrongAttempts,
            pendingAttempts: before.filter((run, index) => rule.pending(run, index, problemRuns.length)).length,
            isSolved: !!okRun,
            isFirstToSolve: okRun?.result.type === 'ICPC' && okRun.result.isFirstToSolveRun,
            lastSubmitTimeMs: (okRun || before.at(-1))?.time ?? null,
        };
        if (okRun) {
            solved += problem.weight;
            // ICPC rule (each_submission_down_to_minute): every accepted time counts in whole minutes.
            const accepted = info.penaltyRoundingMode === 'each_submission_down_to_minute'
                ? Math.floor(okRun.time / 60_000) * 60 : Math.floor(okRun.time / 1000);
            penalty += accepted + wrongAttempts * info.penaltyPerWrongAttemptSeconds;
            lastAccepted = Math.max(lastAccepted, okRun.time);
        }
        return result;
    });
    return { totalScore: solved, penalty, lastAcceptedMs: lastAccepted, problemResults };
}

/**
 * The plugin's one ranking rule (resolver/public/js/standings.js compareStandings, also used by the
 * board's award policy): more problems, then less penalty (whole seconds under Hydro's rule; whole
 * minutes under the ICPC rule, which then puts the earlier last accepted run first); teams equal
 * on all of these share a rank. Within a tie, names in the same collation, then team id.
 */
const names = new Intl.Collator('en');
const ccpc = (info: ContestInfo) => info.customFields?.hydroTieBreak === 'ccpc';
const icpcTies = (info: ContestInfo) => info.penaltyRoundingMode === 'each_submission_down_to_minute' && !ccpc(info);
const lastMinute = (row: ScoreboardRow) => (row.totalScore > 0 ? Math.floor(row.lastAcceptedMs / 60_000) : -1);
const scoreOrder = (info: ContestInfo, a: ScoreboardRow, b: ScoreboardRow) => b.totalScore - a.totalScore || a.penalty - b.penalty
    || (icpcTies(info) ? lastMinute(a) - lastMinute(b) : 0);
/** Equal on everything the rule ranks by: the two share a rank. */
export const sameScore = (info: ContestInfo, a: ScoreboardRow, b: ScoreboardRow) => scoreOrder(info, a, b) === 0;
/** CCPC ties are listed by the earlier last accept (附录二), in whole seconds as Hydro records them. */
const tieOrder = (info: ContestInfo, a: ScoreboardRow, b: ScoreboardRow) => (ccpc(info) && a.totalScore > 0
    ? Math.floor(a.lastAcceptedMs / 1000) - Math.floor(b.lastAcceptedMs / 1000) : 0);
export function compareTeams(info: ContestInfo, a: { id: string; name: string; row: ScoreboardRow }, b: { id: string; name: string; row: ScoreboardRow }) {
    return scoreOrder(info, a.row, b.row) || tieOrder(info, a.row, b.row) || names.compare(a.name, b.name) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export interface GroupRanking {
    ranks: Record<string, number>;
    awards: Award[];
}

export interface Ranking {
    order: string[];
    ranks: number[];
    /** School rank of each official team in `order` (CCPC 基本规则 4.2), 0 for the others. */
    schoolRanks: number[];
    awards: Award[];
    /** Per sub-board (ICPC Live group): ranks within the board and its own medals, as on the board's view. */
    groups: Record<string, GroupRanking>;
}

type Entry = { id: string; name: string; row: ScoreboardRow; out: boolean; groups: string[]; school: string };

/**
 * Ranks and medals as on the board (lib/award-policy.mjs): out-of-contest teams are listed but
 * unranked and never medalled; medals go to official teams that solved something, by rank when
 * tied teams share a medal, otherwise by position.
 */
function rankEntries(info: ContestInfo, entries: Entry[], chain: ContestInfo['awardsSettings'][number] | undefined) {
    const ranks = new Map<string, number>();
    const excluded = new Set(chain?.excludedGroups || []);
    const medals = (chain?.awards || []).map((award) => ({ ...award, teams: [] as string[] }));
    const same = (a: Entry, b: Entry) => sameScore(info, a.row, b.row);
    const rows = entries.map((entry) => ({ entry, teamId: entry.id, official: !entry.out, solved: entry.row.totalScore,
        school: entry.school, lastAcceptMs: entry.row.totalScore > 0 ? Math.floor(entry.row.lastAcceptedMs / 1000) * 1000 : null }));
    const sameRow = (a: typeof rows[number], b: typeof rows[number]) => same(a.entry, b.entry);
    const schools = schoolRanks(rows, sameRow);
    let position = 0;
    let previous: Entry | null = null;
    let previousRank = 0;
    for (const entry of entries) {
        if (entry.out) continue;
        position++;
        const rank = previous && same(previous, entry) ? previousRank : position;
        ranks.set(entry.id, rank);
        previous = entry;
        previousRank = rank;
        if (entry.row.totalScore <= 0 || entry.groups.some((group) => excluded.has(group))) continue;
        for (const medal of medals) {
            const awardRank = chain?.hydroMedalRanking === 'school' ? schools.get(entry.id)! : medal.tiebreakMode === 'ALL' ? rank : position;
            if (awardRank <= (medal.chainLimit ?? 0)) {
                medal.teams.push(entry.id);
                break;
            }
        }
    }
    const awards = medals.map(({ id, citation, teams }) => ({ id, citation, teams }));
    if (chain?.hydroPodium) {
        const eligible = rows.filter((row) => !row.entry.groups.some((group) => excluded.has(group)));
        for (const trophy of trophyWinners(eligible, chain.hydroPodium, sameRow)) {
            awards.push({ id: `podium-${trophy.place + 1}`, citation: trophy.name, teams: trophy.teamIds });
        }
    }
    return { ranks, schools, awards };
}

export function ranking(info: ContestInfo, rows: Map<string, ScoreboardRow>): Ranking {
    const entries: Entry[] = info.teams.filter((team) => !team.isHidden)
        .map((team) => ({ id: team.id, name: team.name, row: rows.get(team.id)!, out: team.isOutOfContest, groups: team.groups,
            school: team.customFields?.hydroSchool || team.organizationId || `#${team.id}` }))
        .filter(({ row }) => info.showTeamsWithoutSubmissions || row.problemResults.some((result) => result.lastSubmitTimeMs !== null))
        .sort((a, b) => compareTeams(info, a, b));
    const order = entries.map(({ id }) => id);
    const main = rankEntries(info, entries, info.awardsSettings.find((chain) => !chain.groups?.length));
    const groups: Record<string, GroupRanking> = {};
    for (const group of info.groups) {
        if (group.isHidden) continue;
        const members = entries.filter((entry) => entry.groups.includes(group.id));
        if (!members.length) continue;
        const chain = info.awardsSettings.find((item) => item.groups?.length === 1 && item.groups[0] === group.id);
        const result = rankEntries(info, members, chain);
        groups[group.id] = { ranks: Object.fromEntries(result.ranks), awards: result.awards.filter((award) => award.teams.length) };
    }
    return { order, ranks: order.map((id) => main.ranks.get(id) ?? 0), schoolRanks: order.map((id) => main.schools.get(id) ?? 0), awards: main.awards, groups };
}

/** A team's rank among `rows` by the same rule; 0 when it is not ranked. */
export function rankOf(info: ContestInfo, rows: Map<string, ScoreboardRow>, teamId: string) {
    const team = info.teams.find((item) => item.id === teamId);
    const row = rows.get(teamId);
    if (!team || !row || team.isOutOfContest || team.isHidden) return 0;
    let better = 0;
    for (const other of info.teams) {
        if (other.isOutOfContest || other.isHidden || other.id === teamId) continue;
        const candidate = rows.get(other.id);
        if (candidate && scoreOrder(info, candidate, row) < 0) better++;
    }
    return better + 1;
}

/**
 * Each target run's team rank and solved count right after that run, replaying `runs` (in
 * submission order) on the normal scoreboard. Commentary uses this, so history regenerated
 * after a restart states the rank of the time, not today's.
 */
export function standingsAtRuns(info: ContestInfo, runs: RunInfo[], targets: Set<string>) {
    const result = new Map<string, { rank: number; solved: number }>();
    const first = runs.findIndex((run) => targets.has(run.id));
    if (first < 0) return result;
    // Everything before the earliest target is settled: build those rows once, then replay only
    // from there (during a contest the targets are the newest runs, so this is short).
    const byTeam = new Map<string, RunInfo[]>();
    for (const run of runs.slice(0, first)) {
        if (run.isHidden) continue;
        if (!byTeam.has(run.teamId)) byTeam.set(run.teamId, []);
        byTeam.get(run.teamId)!.push(run);
    }
    const rows = new Map(info.teams.map((team) => [team.id, scoreboardRow(info, byTeam.get(team.id) || [], 'normal')]));
    let remaining = targets.size;
    for (const run of runs.slice(first)) {
        if (run.isHidden) continue;
        if (!byTeam.has(run.teamId)) byTeam.set(run.teamId, []);
        const list = byTeam.get(run.teamId)!;
        list.push(run);
        rows.set(run.teamId, scoreboardRow(info, list, 'normal'));
        if (!targets.has(run.id)) continue;
        result.set(run.id, {
            rank: rankOf(info, rows, run.teamId),
            solved: rows.get(run.teamId)!.problemResults.filter((item) => item.isSolved).length,
        });
        if (!--remaining) break;
    }
    return result;
}

export interface ScoreboardState {
    rows: Map<string, ScoreboardRow>;
    ranking: Ranking;
}

export function runsByTeam(runs: RunInfo[]) {
    const result = new Map<string, RunInfo[]>();
    for (const run of runs) result.set(run.teamId, [...(result.get(run.teamId) || []), run]);
    return result;
}

export function computeScoreboard(info: ContestInfo, byTeam: Map<string, RunInfo[]>, level: OptimismLevel): ScoreboardState {
    const rows = new Map(info.teams.map((team) => [team.id, scoreboardRow(info, byTeam.get(team.id) || [], level)]));
    return { rows, ranking: ranking(info, rows) };
}

/** A full snapshot, or only the rows that differ from `previous`. */
export function scoreboardDiff(state: ScoreboardState, previous?: ScoreboardState): ScoreboardDiff {
    const rows: Record<string, ScoreboardRow> = {};
    for (const id of state.ranking.order) {
        const row = state.rows.get(id)!;
        if (!previous || JSON.stringify(previous.rows.get(id)) !== JSON.stringify(row)) rows[id] = row;
    }
    const { groups, ...ranking } = state.ranking;
    return { rows, ...ranking, hydroGroups: groups };
}

export function statistics(info: ContestInfo, state: ScoreboardState, runs: Iterable<RunInfo>): SolutionsStatistic {
    const problems = info.problems.filter((problem) => !problem.isHidden);
    const visible = new Set(problems.map((problem) => problem.id));
    const verdictCounts: Record<string, number> = {};
    for (const run of runs) {
        if (run.isHidden || !visible.has(run.problemId)) continue;
        const code = publicRunVerdict(run.result);
        verdictCounts[code] = (verdictCounts[code] ?? 0) + 1;
    }
    return {
        type: 'ICPC',
        teamsCount: state.ranking.order.length,
        verdictCounts,
        stats: problems.map((_, index) => {
            let success = 0;
            let wrong = 0;
            let pending = 0;
            for (const id of state.ranking.order) {
                const result = state.rows.get(id)?.problemResults[index];
                if (!result) continue;
                if (result.isSolved) success++;
                else if (result.pendingAttempts > 0) pending++;
                else if (result.wrongAttempts > 0) wrong++;
            }
            return { success, wrong, pending };
        }),
    };
}

/** TimelineService.toTimeLine: each problem until (and including) its first accepted run. */
export function timeline(runs: RunInfo[]): TimeLineRunInfo[] {
    const accepted = new Set<string>();
    const result: TimeLineRunInfo[] = [];
    for (const run of runs) {
        if (run.result.type === 'IN_PROGRESS') {
            result.push({ type: 'IN_PROGRESS', time: run.time, problemId: run.problemId, ...(run.result.frozen ? { frozen: true } : {}) });
            continue;
        }
        if (accepted.has(run.problemId)) continue;
        if (run.result.verdict.isAccepted) accepted.add(run.problemId);
        result.push({ type: 'ICPC', time: run.time, problemId: run.problemId, isAccepted: run.result.verdict.isAccepted, shortName: run.result.verdict.shortName });
    }
    return result;
}
