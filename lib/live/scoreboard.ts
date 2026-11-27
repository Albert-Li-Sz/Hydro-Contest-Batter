/**
 * ICPC scoreboard rows as computed by ICPC Live v3 (cds/core scoreboard/*.kt, MIT), ported to TypeScript.
 * Penalty, ranks and medals follow the rest of this plugin: Hydro's ACM rule (whole seconds summed) or
 * the ICPC rule (whole minutes, then the last accepted run), 20 minutes per wrong attempt.
 */
import type {
    Award, ContestInfo, ICPCProblemResult, OptimismLevel, RunInfo, ScoreboardDiff, ScoreboardRow, SolutionsStatistic, TeamTrend, TeamTrendPoint, TimeLineRunInfo,
} from './types';
import { hiddenFromOf, publicRunVerdict } from './model';
import { awardPlaces, trophyWinners } from '../../resolver/public/js/trophies.js';
import { honorsWinners } from '../../resolver/public/js/honors.js';

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
        let list = byProblem.get(run.problemId);
        if (!list) { list = []; byProblem.set(run.problemId, list); }
        list.push(run);
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

function rankEntries(info: ContestInfo, entries: Entry[], chain: ContestInfo['awardsSettings'][number] | undefined) {
    const ranks = new Map<string, number>();
    const excluded = new Set(chain?.excludedGroups || []);
    const medals = (chain?.awards || []).map((award) => ({ ...award, teams: [] as string[] }));
    const same = (a: Entry, b: Entry) => sameScore(info, a.row, b.row);
    const rows = entries.map((entry) => ({ entry, teamId: entry.id, official: !entry.out, solved: entry.row.totalScore,
        school: entry.school, lastAcceptMs: entry.row.totalScore > 0 ? Math.floor(entry.row.lastAcceptedMs / 1000) * 1000 : null }));
    const sameRow = (a: typeof rows[number], b: typeof rows[number]) => same(a.entry, b.entry);
    const places = awardPlaces(rows, sameRow);
    const schools = new Map<string, number>();
    for (const entry of entries) {
        const place = places.get(entry.id)!;
        if (!entry.out) {
            ranks.set(entry.id, place.rank);
            schools.set(entry.id, place.school);
        } else if (!chain?.hydroUnofficialMedals || !entry.groups.includes('unofficial')) continue;
        if (entry.row.totalScore <= 0 || entry.groups.some((group) => excluded.has(group))) continue;
        for (const medal of medals) {
            const awardRank = chain?.hydroMedalRanking === 'school' ? place.school : medal.tiebreakMode === 'ALL' ? place.rank : place.position;
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
    if (chain?.hydroHonors) {
        const ranked = entries.filter((entry) => !entry.out && !entry.groups.some((group) => excluded.has(group)))
            .map((entry) => ({ teamId: entry.id, rank: ranks.get(entry.id)!, solved: entry.row.totalScore }));
        for (const award of honorsWinners(ranked, chain.hydroHonors)) awards.push({ id: award.id, citation: award.citation, teams: award.teamIds });
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

type TeamTrack = {
    totalScore: number;
    penalty: number;
    lastAcceptedMs: number;
    solvedCount: number;
    official: boolean;
    problems: Map<string, { solved: boolean; wrong: number }>;
};

/**
 * Replays runs one at a time on the normal scoreboard (scoreboardRow's rule, kept incrementally):
 * every team's score after the runs applied so far, ranked by scoreOrder like the board. The
 * commentary's standings and the single-team trend both use it, so neither can drift from the board.
 */
function standingsReplay(info: ContestInfo) {
    const problemWeights = new Map(info.problems.filter((problem) => !problem.isHidden).map((problem) => [problem.id, problem.weight]));
    const roundMinutes = info.penaltyRoundingMode === 'each_submission_down_to_minute';
    const newTrack = (official: boolean): TeamTrack => ({ totalScore: 0, penalty: 0, lastAcceptedMs: 0, solvedCount: 0, official, problems: new Map() });
    const tracks = new Map<string, TeamTrack>();
    const official: TeamTrack[] = [];
    for (const team of info.teams) {
        const track = newTrack(!team.isOutOfContest && !team.isHidden);
        tracks.set(team.id, track);
        if (track.official) official.push(track);
    }
    /** True when `a` ranks strictly above `b`. */
    const above = (a: TeamTrack, b: TeamTrack) => scoreOrder(info, a as unknown as ScoreboardRow, b as unknown as ScoreboardRow) < 0;
    return {
        above,
        track: (teamId: string) => tracks.get(teamId),
        /** Applies one run: its team's track and whether it newly solved a problem (null for a hidden run). */
        apply(run: RunInfo) {
            if (run.isHidden) return null;
            let track = tracks.get(run.teamId);
            if (!track) tracks.set(run.teamId, track = newTrack(false));
            const weight = problemWeights.get(run.problemId);
            if (weight === undefined) return { track, solved: false };
            let state = track.problems.get(run.problemId);
            if (!state) track.problems.set(run.problemId, state = { solved: false, wrong: 0 });
            if (state.solved) return { track, solved: false };
            if (!isAccepted(run)) {
                if (isJudged(run) && isAddingPenalty(run)) state.wrong++;
                return { track, solved: false };
            }
            state.solved = true;
            track.solvedCount++;
            track.totalScore += weight;
            const accepted = roundMinutes ? Math.floor(run.time / 60_000) * 60 : Math.floor(run.time / 1000);
            track.penalty += accepted + state.wrong * info.penaltyPerWrongAttemptSeconds;
            track.lastAcceptedMs = Math.max(track.lastAcceptedMs, run.time);
            return { track, solved: true };
        },
        /** The track's rank among official teams (teams equal on score share it), 0 when not official. */
        rank(track: TeamTrack) {
            if (!track.official) return 0;
            let better = 0;
            for (const other of official) if (other !== track && above(other, track)) better++;
            return better + 1;
        },
    };
}

/**
 * Each target run's team rank and solved count right after that run, replaying `runs` (in
 * submission order) on the normal scoreboard. Commentary uses this, so history regenerated
 * after a restart states the rank of the time, not today's.
 */
export function standingsAtRuns(info: ContestInfo, runs: RunInfo[], targets: Set<string>) {
    const result = new Map<string, { rank: number; solved: number }>();
    if (!targets.size) return result;
    const first = runs.findIndex((run) => targets.has(run.id));
    if (first < 0) return result;
    const replay = standingsReplay(info);
    for (let i = 0; i < first; i++) replay.apply(runs[i]);
    let remaining = targets.size;
    for (let i = first; i < runs.length; i++) {
        const run = runs[i];
        const applied = replay.apply(run);
        if (!applied || !targets.has(run.id)) continue;
        result.set(run.id, { rank: replay.rank(applied.track), solved: applied.track.solvedCount });
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
    for (const run of runs) {
        let list = result.get(run.teamId);
        if (!list) { list = []; result.set(run.teamId, list); }
        list.push(run);
    }
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
    const hiddenFrom = hiddenFromOf(info);
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
        stats: problems.map((problem, index) => {
            // CCPC hidden-label mode: anonymous columns hold a different problem per team, so do not aggregate across teams.
            if (hiddenFrom !== undefined && problem.ordinal >= hiddenFrom) return { success: 0, wrong: 0, pending: 0 };
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

/**
 * One team's solved-count and official-rank trajectory over contest time, computed strictly from
 * public judged runs (frozen runs stay in-progress and never affect the curve) under the same
 * ranking rule as the live scoreboard. `points` is a step function: the start, then every moment
 * the team's solved count or rank changed, including when another team's solve passed it. Like the
 * scoreboard it depends on the runs alone, never on the clock, so an unchanged contest yields the
 * same trend on every refresh and its last rank is always the board's.
 */
export function teamTrend(info: ContestInfo, runs: RunInfo[], teamId: string): TeamTrend {
    const visibleProblems = info.problems.filter((problem) => !problem.isHidden);
    const officialTeams = info.teams.filter((team) => !team.isHidden && !team.isOutOfContest);
    const target = info.teams.find((team) => !team.isHidden && team.id === teamId);
    const ranked = !!target && !target.isOutOfContest;
    const base = { teamsCount: officialTeams.length, problemsCount: visibleProblems.length, ranked };
    if (!target || info.contestLengthMs <= 0 || info.status.type === 'before') {
        return { ...base, frozenAtMs: null, bestRank: null, currentRank: null, points: [] };
    }
    const frozenAtMs = (info.status.type === 'running' || info.status.type === 'over') && info.status.frozenAtUnixMs != null
        ? Math.max(0, Math.min(info.contestLengthMs, info.status.frozenAtUnixMs - info.status.startedAtUnixMs)) : null;
    const judged = runs
        .filter((run) => !run.isHidden && isJudged(run))
        .sort((a, b) => a.time - b.time || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    const replay = standingsReplay(info);
    const targetTrack = replay.track(teamId)!;
    // Official teams ranked strictly above the target. Only a solve changes a team's score, so another
    // team's solve moves this count by at most one; the target's own solve needs a full recount.
    let better = 0;
    // Before its first solve a team has no place to show (no fake #1 at 00:00).
    const rank = () => (ranked && targetTrack.solvedCount > 0 ? better + 1 : 0);

    const points: TeamTrendPoint[] = [{ time: 0, solved: 0, rank: 0 }];
    let bestRank: number | null = null;
    for (let index = 0; index < judged.length;) {
        const time = judged[index].time;
        // Runs at the same moment count together.
        for (; index < judged.length && judged[index].time === time; index++) {
            const run = judged[index];
            const track = replay.track(run.teamId);
            if (track === targetTrack) {
                if (replay.apply(run)?.solved && ranked) better = replay.rank(targetTrack) - 1;
            } else if (ranked && track?.official) {
                const wasAbove = replay.above(track, targetTrack);
                if (replay.apply(run)?.solved) better += Number(replay.above(track, targetTrack)) - Number(wasAbove);
            }
        }
        const point = { time: Math.max(0, time), solved: targetTrack.solvedCount, rank: rank() };
        const last = points[points.length - 1];
        if (point.solved !== last.solved || point.rank !== last.rank) {
            if (last.time === point.time) points[points.length - 1] = point;
            else points.push(point);
        }
        if (point.rank > 0) bestRank = bestRank === null ? point.rank : Math.min(bestRank, point.rank);
    }
    const currentRank = rank();
    return { ...base, frozenAtMs, bestRank, currentRank: currentRank > 0 ? currentRank : null, points };
}
