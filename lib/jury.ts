/**
 * 裁判操作 during a contest, applied to every channel through the board data (index.ts loadData):
 *
 * 暂缓公布 (hold): while the jury checks a problem (wrong data, a rejudge awaiting approval), its results stay
 * hidden from every public view as still judging; staff views and judging go on as usual. Balloons for it wait.
 * 计时补偿 (credit): a team that lost time to a machine or network failure from `from` for `minutes` has that
 * downtime taken out of the time of every later submission, as if its clock had stopped (CCS "removing a time
 * interval" for one team). The contest still ends at the same moment for it.
 *
 * Pure; lib/jury-routes.ts stores the state and records every action with its reason and operator.
 */
import type { BoardData } from './board';
import { rejudgeStatuses } from './manage/rejudge';

/** Results the jury may set by hand, with Hydro's codes (as 批量重测 offers them, without "waiting"). */
export const verdictChoices = rejudgeStatuses.filter(([code]) => code !== 0);

export interface ProblemHold {
    id: string;
    /** Hydro problem id. */
    pid: number;
    /** Seconds from the contest start; submissions from then on are held. 0: the whole problem. */
    since: number;
    reason: string;
    by: number;
    at: number;
    /** The batch rejudge that placed it, released with that rejudge's approval. */
    jobId?: string;
}

export interface TimeCredit {
    id: string;
    teamId: string;
    /** Seconds from the contest start when the downtime began. */
    from: number;
    minutes: number;
    reason: string;
    by: number;
    at: number;
}

export interface JuryState {
    holds: ProblemHold[];
    credits: TimeCredit[];
}

export const emptyJury = (): JuryState => ({ holds: [], credits: [] });

/** A submission's time with the team's downtime taken out: never earlier than the downtime's start. */
export function creditedTime(timestamp: number, credits: readonly Pick<TimeCredit, 'from' | 'minutes'>[]) {
    let removed = 0;
    let coveredUntil = 0;
    for (const credit of [...credits].sort((a, b) => a.from - b.from)) {
        const start = credit.from * 1000;
        if (start >= timestamp) break;
        const end = Math.min(timestamp, start + credit.minutes * 60_000);
        removed += Math.max(0, end - Math.max(start, coveredUntil));
        coveredUntil = Math.max(coveredUntil, end);
    }
    return timestamp - removed;
}

/**
 * The board data with the jury's credits (every view) and holds (public views only). `pids` maps the data's
 * problem positions to Hydro problem ids.
 */
export function applyJury(data: BoardData, jury: JuryState | null | undefined, pids: number[], publicView: boolean): BoardData {
    if (!jury || (!jury.credits.length && !(publicView && jury.holds.length))) return data;
    const credits = new Map<string, TimeCredit[]>();
    for (const credit of jury.credits) credits.set(credit.teamId, [...credits.get(credit.teamId) || [], credit]);
    const holds = publicView ? jury.holds : [];
    const heldSince = new Map<number, number>();
    for (const hold of holds) {
        const index = pids.indexOf(hold.pid);
        if (index >= 0) heldSince.set(index, Math.min(heldSince.get(index) ?? Infinity, hold.since * 1000));
    }
    return {
        ...data,
        submissions: data.submissions.map((run) => {
            const own = credits.get(run.team_id);
            const held = heldSince.has(run.problem_id) && run.timestamp >= heldSince.get(run.problem_id)!;
            if (!own && !held) return run;
            // A frozen result stays frozen; the hold only hides what the public could otherwise see.
            return { ...run, ...own ? { timestamp: creditedTime(run.timestamp, own) } : {}, ...held && run.status !== 'FROZEN' ? { status: 'PENDING' } : {} };
        }),
    };
}

/** Problems with results held from the public, with the earliest held moment (milliseconds since the epoch). */
export function heldProblems(jury: JuryState | null | undefined, beginAt: number) {
    const result = new Map<number, number>();
    for (const hold of jury?.holds || []) result.set(hold.pid, Math.min(result.get(hold.pid) ?? Infinity, beginAt + hold.since * 1000));
    return result;
}

export class JuryError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}

const reasonOf = (value: unknown) => {
    const reason = typeof value === 'string' ? value.trim() : '';
    if (!reason || reason.length > 200) throw new JuryError('请填写 1 至 200 字的原因');
    return reason;
};

export function readHold(input: Record<string, unknown>, pids: number[], durationSeconds: number) {
    const pid = Number(input.pid);
    if (!pids.includes(pid)) throw new JuryError('请选择本场比赛的题目');
    const since = input.since === undefined || input.since === null ? 0 : Number(input.since);
    if (!Number.isSafeInteger(since) || since < 0 || since > durationSeconds) throw new JuryError('暂缓的起点应在比赛时间内');
    return { pid, since, reason: reasonOf(input.reason) };
}

export function readCredit(input: Record<string, unknown>, teams: Set<string>, durationSeconds: number) {
    const teamId = String(input.teamId ?? '');
    if (!teams.has(teamId)) throw new JuryError('请选择参赛队伍');
    const from = Number(input.from);
    if (!Number.isSafeInteger(from) || from < 0 || from >= durationSeconds) throw new JuryError('停机开始时间应在比赛时间内');
    const minutes = Number(input.minutes);
    if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > Math.ceil(durationSeconds / 60)) throw new JuryError('补偿时长应为 1 分钟到比赛时长之间的整数');
    return { teamId, from, minutes, reason: reasonOf(input.reason) };
}

export const readReason = reasonOf;
