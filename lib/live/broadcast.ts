// The three broadcast graphics use the same public runs and computed rankings as the overlay.
import type { ContestInfo, RunInfo } from './types';
import { hiddenFromOf, publicRunVerdict } from './model';
import type { ScoreboardState } from './scoreboard';

export function medalCutoff(info: ContestInfo, board: ScoreboardState, group: string, medal: string) {
    const { ranking, rows } = board;
    const teams = new Map(info.teams.map((team) => [team.id, team]));
    const local = group === 'all' ? null : ranking.groups[group];
    const awards = group === 'all' ? ranking.awards : local?.awards;
    const award = awards?.find((item) => item.id === medal + '-medal');
    const order = ranking.order.filter((id) => teams.has(id) && !teams.get(id)!.isOutOfContest
        && (group === 'all' || local?.ranks[id]) && rows.get(id)!.totalScore > 0);
    const insideId = award?.teams.at(-1);
    const insideIndex = insideId ? order.indexOf(insideId) : -1;
    const outsideId = insideIndex >= 0 ? order[insideIndex + 1] : undefined;
    const entry = (id: string | undefined) => {
        if (!id) return null;
        const row = rows.get(id)!;
        return { name: teams.get(id)!.shortName, solved: row.totalScore, penalty: row.penalty,
            rank: local?.ranks[id] ?? ranking.ranks[ranking.order.indexOf(id)] };
    };
    return { group: info.groups.find((g) => g.id === group)?.displayName ?? group, medal, citation: award?.citation,
        inside: entry(insideId), outside: entry(outsideId) };
}

export function problemFocus(info: ContestInfo, runs: Iterable<RunInfo>, problemId: string, group: string) {
    const problem = info.problems.find((item) => item.id === problemId);
    const hiddenFrom = hiddenFromOf(info);
    if (!problem || !problem.letter || (hiddenFrom !== undefined && problem.ordinal >= hiddenFrom)) return null;
    const teams = new Map(info.teams.filter((team) => group === 'all' || team.groups.includes(group)).map((team) => [team.id, team.shortName]));
    const attempted = new Set<string>();
    const solved = new Set<string>();
    const verdicts: Record<string, number> = {};
    const recent: { team: string; verdict: string; time: number }[] = [];
    let submissions = 0;
    for (const run of runs) {
        if (run.problemId !== problemId || !teams.has(run.teamId)) continue;
        attempted.add(run.teamId);
        const verdict = publicRunVerdict(run.result);
        if (run.result.type === 'ICPC' && run.result.verdict.isAccepted) solved.add(run.teamId);
        verdicts[verdict] = (verdicts[verdict] || 0) + 1;
        submissions++;
        recent.push({ team: teams.get(run.teamId)!, verdict, time: run.time });
        if (recent.length > 4) recent.shift();
    }
    return { problem: problem.letter, attempted: attempted.size, solved: solved.size, submissions, verdicts, recent: recent.reverse() };
}

export interface FirstSolveNews { problem: string; teams: string[]; time: number | null; expires: number }

export class FirstSolveBulletin {
    private known: Map<string, string> | null = null;
    private active = new Map<string, FirstSolveNews>();

    update(info: ContestInfo, winners: Map<string, RunInfo[]>, onAir: boolean, reset: boolean, now: number) {
        if (reset) { this.known = null; this.active.clear(); }
        const teams = new Map(info.teams.map((team) => [team.id, team.shortName]));
        const next = new Map<string, string>();
        if (!onAir || info.status.type === 'before') this.active.clear();
        const hiddenFrom = hiddenFromOf(info);
        for (const problem of info.problems) {
            const anonymous = !problem.letter || (hiddenFrom !== undefined && problem.ordinal >= hiddenFrom);
            const list = anonymous ? [] : (winners.get(problem.id) || []);
            const key = list.map((run) => run.id).join(',');
            next.set(problem.id, key);
            if (onAir && info.status.type !== 'before' && this.known && (this.known.get(problem.id) || '') !== key) {
                if (!list.length) this.active.delete(problem.id);
                else this.active.set(problem.id, { problem: problem.letter, teams: list.map((run) => teams.get(run.teamId)!),
                    time: list[0].time, expires: now + 12_000 });
            }
        }
        this.known = next;
    }

    items(now: number) {
        for (const [id, item] of this.active) if (item.expires <= now) this.active.delete(id);
        return [...this.active.values()];
    }
}
