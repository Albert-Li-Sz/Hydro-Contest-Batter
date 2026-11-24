/**
 * CCPC 新榜单模式 (lib/settings.ts CcpcBoard) and 过题后忽略再次提交, applied to the board data every public
 * channel reads (the board, screens, Live, the public CCS view), so none of them names a problem the board hides.
 * Pure; index.ts applies it after loading the contest.
 */
import { type BoardData, UNSET_PROBLEM_COLOR } from './board';
import type { BoardSettings, CcpcBoard } from './settings';

/** Without the submissions a team made to a problem after its first accepted run there. */
export function dropAfterAccept(data: BoardData): BoardData {
    const solved = new Set<string>();
    const kept = new Set<BoardData['submissions'][number]>();
    const ordered = [...data.submissions].sort((a, b) => a.timestamp - b.timestamp || a.submission_id.localeCompare(b.submission_id));
    for (const run of ordered) {
        const key = `${run.team_id}/${run.problem_id}`;
        if (solved.has(key)) continue;
        kept.add(run);
        if (run.status === 'CORRECT') solved.add(key);
    }
    return kept.size === data.submissions.length ? data : { ...data, submissions: data.submissions.filter((run) => kept.has(run)) };
}

/** Teams that must solve a problem before its label shows: a count, or a share of the teams rounded down (at least 1). */
export function revealThreshold(board: Pick<CcpcBoard, 'revealBasis' | 'reveal'>, teams: number) {
    return Math.max(1, board.revealBasis === 'percent' ? Math.floor((teams * board.reveal) / 100 + 1e-9) : board.reveal);
}

/** The hidden board applies from the start until the board freezes (Hydro: strictly after lockAt), or to the end. */
export function labelsHidden(board: CcpcBoard, contest: { beginAt: Date; endAt: Date; lockAt?: Date | null }, now: number) {
    if (!board.enabled) return false;
    if (now < contest.beginAt.getTime() || now >= contest.endAt.getTime()) return false;
    return !(contest.lockAt && contest.lockAt.getTime() < now);
}

/**
 * The board as CCPC 新榜单模式 shows it before the freeze. Columns are positions in each team's own row: first the
 * shown problems (labelled, the same for every team), then the team's other accepts by time, its other attempts by
 * their last submission, and the problems it never tried by number, all unlabelled. Every submission moves to
 * its position in its team's row. `hiddenFrom` is the first unlabelled column.
 */
export function hideProblemLabels(data: BoardData, board: CcpcBoard): BoardData & { hiddenFrom: number } {
    const count = data.contest.problem_quantity;
    const solvers = Array.from({ length: count }, () => new Set<string>());
    for (const run of data.submissions) if (run.status === 'CORRECT' && run.problem_id >= 0 && run.problem_id < count) solvers[run.problem_id].add(run.team_id);
    const threshold = revealThreshold(board, data.teams.length);
    const shown = solvers.flatMap((teams, index) => (teams.size >= threshold ? [index] : []));
    const shownSet = new Set(shown);
    const byTeam = new Map<string, { solved: Map<number, number>; last: Map<number, number> }>();
    for (const run of data.submissions) {
        if (run.problem_id < 0 || run.problem_id >= count) continue;
        const team = byTeam.get(run.team_id) || { solved: new Map(), last: new Map() };
        byTeam.set(run.team_id, team);
        if (run.status === 'CORRECT') team.solved.set(run.problem_id, Math.min(team.solved.get(run.problem_id) ?? Infinity, run.timestamp));
        team.last.set(run.problem_id, Math.max(team.last.get(run.problem_id) ?? -Infinity, run.timestamp));
    }
    const slots = new Map<string, Map<number, number>>();
    const slotOf = (teamId: string) => {
        let mapping = slots.get(teamId);
        if (mapping) return mapping;
        const team = byTeam.get(teamId) || { solved: new Map<number, number>(), last: new Map<number, number>() };
        const rest = Array.from({ length: count }, (_, index) => index).filter((index) => !shownSet.has(index));
        const solved = rest.filter((index) => team.solved.has(index)).sort((a, b) => team.solved.get(a)! - team.solved.get(b)! || a - b);
        const tried = rest.filter((index) => !team.solved.has(index) && team.last.has(index)).sort((a, b) => team.last.get(a)! - team.last.get(b)! || a - b);
        const untried = rest.filter((index) => !team.last.has(index));
        mapping = new Map([...shown, ...solved, ...tried, ...untried].map((problem, slot) => [problem, slot]));
        slots.set(teamId, mapping);
        return mapping;
    };
    const labels = data.contest.problem_id as string[];
    const colors = data.contest.balloon_color as { color: string; background_color: string }[] | undefined;
    const plain = { color: '#000', background_color: UNSET_PROBLEM_COLOR };
    return {
        ...data,
        hiddenFrom: shown.length,
        contest: {
            ...data.contest,
            problem_id: Array.from({ length: count }, (_, slot) => (slot < shown.length ? labels[shown[slot]] : '')),
            ...colors ? { balloon_color: Array.from({ length: count }, (_, slot) => (slot < shown.length ? colors[shown[slot]] : plain)) } : {},
        },
        submissions: data.submissions.map((run) => (run.problem_id >= 0 && run.problem_id < count
            ? { ...run, problem_id: slotOf(run.team_id).get(run.problem_id)! } : run)),
    };
}

/** What a viewer of the public projection sees, by the contest's settings. */
export function applyBoardRules(data: BoardData, settings: Pick<BoardSettings, 'ccpcBoard' | 'ignoreAfterAccept'>,
    contest: { beginAt: Date; endAt: Date; lockAt?: Date | null }, now: number, realtime: boolean) {
    let result: BoardData & { hiddenFrom?: number } = settings.ignoreAfterAccept ? dropAfterAccept(data) : data;
    if (!realtime && labelsHidden(settings.ccpcBoard, contest, now)) result = hideProblemLabels(result, settings.ccpcBoard);
    return result;
}
