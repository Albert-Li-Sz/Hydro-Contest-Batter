/**
 * 重测复核: after a rejudge, the submissions of a contest whose result it changed, what that did to the teams,
 * and what was made from the earlier results (resolver sessions). The new results stand unless the jury restores
 * the original ones. Pure; lib/results-routes.ts reads the rejudge history and applies the jury's choices.
 */
import { ACCEPTED, statusShort } from './manage/rejudge';
import { compareResults, resultBoard, restoreRejudge, type ResultsData } from './results';

export interface ReviewItem {
    rid: string;
    job: string;
    /** When the rejudge was started. */
    jobAt: number;
    pid: number;
    before: number;
    beforeScore: number | null;
    after: number | null;
    afterScore: number | null;
    judgedAt: number | null;
    /** The jury put the original result back (on the record's latest rejudge item). */
    restored?: { at: number; by: number } | null;
    /** The jury took a restore back: the rejudged result stands again. */
    reapplied?: { at: number; by: number } | null;
}

export type ChangeKind = 'lostAccept' | 'gainedAccept' | 'other';
/** kept: the rejudged result stands; restored: the original is back; moved: the record changed again since. */
export type ChangeState = 'kept' | 'restored' | 'moved';

export interface ReviewChange {
    rid: string;
    pid: number;
    original: number;
    originalScore: number | null;
    rejudged: number;
    rejudgedScore: number | null;
    current: number | null;
    kind: ChangeKind;
    state: ChangeState;
    /** When the result last changed: judged again, or restored. */
    changedAt: number;
    jobs: string[];
}

export const kindOf = (original: number, rejudged: number): ChangeKind => (original === ACCEPTED && rejudged !== ACCEPTED ? 'lostAccept'
    : original !== ACCEPTED && rejudged === ACCEPTED ? 'gainedAccept' : 'other');

/**
 * One row per rejudged submission whose result moved: its result before the first rejudge, after the latest, and
 * now. Submissions still being judged are counted, not listed.
 */
export function reviewChanges(items: ReviewItem[], current: Map<string, number>) {
    const byRecord = new Map<string, ReviewItem[]>();
    for (const item of items) byRecord.set(item.rid, [...byRecord.get(item.rid) || [], item]);
    const changes: ReviewChange[] = [];
    let pending = 0;
    for (const [rid, list] of byRecord) {
        list.sort((a, b) => a.jobAt - b.jobAt || a.job.localeCompare(b.job));
        const first = list[0];
        const latest = list[list.length - 1];
        if (latest.after === null) { pending++; continue; }
        const restored = latest.restored || null;
        if (first.before === latest.after && !restored) continue;
        const now = current.get(rid) ?? null;
        const state: ChangeState = restored && now === first.before ? 'restored' : now === latest.after ? 'kept' : 'moved';
        changes.push({
            rid, pid: latest.pid, original: first.before, originalScore: first.beforeScore, rejudged: latest.after, rejudgedScore: latest.afterScore,
            current: now, kind: kindOf(first.before, latest.after), state,
            changedAt: Math.max(latest.judgedAt ?? latest.jobAt, restored?.at ?? 0, latest.reapplied?.at ?? 0), jobs: [...new Set(list.map((item) => item.job))],
        });
    }
    changes.sort((a, b) => a.rid.localeCompare(b.rid));
    return { changes, pending };
}

/** The latest moment rejudges or the jury changed a result of this contest; null when nothing changed. */
export function lastChange(changes: ReviewChange[]) {
    return changes.reduce<number | null>((latest, change) => Math.max(latest ?? 0, change.changedAt), null);
}

/** Resolver sessions built from the results before the latest change. */
export function staleSessions<T extends { createdAt: Date | string | number }>(sessions: T[], changedAt: number | null) {
    if (changedAt === null) return [];
    return sessions.filter((session) => new Date(session.createdAt).getTime() < changedAt);
}

export interface ReviewFilter {
    pids?: number[];
    kinds?: ChangeKind[];
    states?: ChangeState[];
    /** Only submissions of teams whose rank or awards differ from what the original results give. */
    affecting?: boolean;
}

export function filterChanges<T extends ReviewChange>(changes: T[], filter: ReviewFilter, affects: (change: T) => boolean) {
    return changes.filter((change) => (!filter.pids?.length || filter.pids.includes(change.pid))
        && (!filter.kinds?.length || filter.kinds.includes(change.kind))
        && (!filter.states?.length || filter.states.includes(change.state))
        && (!filter.affecting || affects(change)));
}

export const verdictName = (status: number | null) => (status === null ? '—' : statusShort(status));

/** The results as they would be without these changes, against the results now: who moves, who wins or loses an award. */
export function impactOf(current: ResultsData, changes: Pick<ReviewChange, 'rid' | 'original' | 'originalScore'>[], statusOf: (status: number) => string) {
    const original = new Map(changes.map((change) => [change.rid, { status: statusOf(change.original), score: change.originalScore }]));
    const comparison = compareResults(resultBoard(restoreRejudge(current, current.at, original), 'all'), resultBoard(current, 'all'));
    return new Map(comparison.rows.map((row) => {
        const awards = (side?: typeof row.before) => [...side?.trophies || [], ...side?.medals || [], ...side?.firsts || [], ...side?.specials || []];
        return [row.id, {
            name: row.name, rankBefore: row.before?.rank ?? 0, rankAfter: row.after?.rank ?? 0,
            awardsBefore: awards(row.before), awardsAfter: awards(row.after),
            changed: (row.before?.rank ?? 0) !== (row.after?.rank ?? 0) || awards(row.before).join() !== awards(row.after).join(),
        }];
    }));
}
