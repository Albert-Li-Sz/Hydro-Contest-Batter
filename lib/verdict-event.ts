/**
 * A verdict changed by hand (裁判改判, restoring or reapplying a rejudge on the results page). It is not Hydro's
 * `record/judge`: that event means a judge finished, and its listeners (rejudge history, judge monitor, other
 * addons) would take a hand-set verdict for a judging result. The plugin's own views that follow verdicts listen here.
 */
export const VERDICT_CHANGED = 'xcpcio/verdict-changed';

export interface VerdictChange {
    _id: unknown;
    domainId: string;
    contest: unknown;
    pid: number;
    uid: number;
    status: number;
    score: number;
}

export function verdictChange(rdoc: { _id: unknown; domainId: string; contest?: unknown; pid: number; uid: number }, status: number, score: number): VerdictChange {
    return { _id: rdoc._id, domainId: rdoc.domainId, contest: rdoc.contest, pid: rdoc.pid, uid: rdoc.uid, status, score };
}
