/**
 * 赛况总览 for the ICPC Live overlay: the inspection screen's overview (lib/overview.ts) over the
 * live module's own data, which is the public board's (specific public verdicts, frozen runs, venue identity rule). Pure, so it is tested without Hydro.
 */
import { contestOverview, overviewVerdictStatus } from '../overview';
import { verdictFor, type LiveSource } from './model';

export type LiveOverview = ReturnType<typeof contestOverview> & {
    hidden: false;
    verdicts: (ReturnType<typeof contestOverview>['verdicts'][number] & { code?: string })[];
    /** Runs after the freeze are still hidden (also after the end, until the board is unfrozen). */
    frozenRuns: number;
} | {
    hidden: true;
    title: string;
    status: 'before';
    serverTime: number;
    beginAt: number;
    endAt: number;
    lockAt: number | null;
};

export function liveOverview(source: LiveSource): LiveOverview {
    const beginAt = source.contest.beginAt.getTime();
    const endAt = source.contest.endAt.getTime();
    // An unfrozen board is not frozen any more, whatever the contest's freeze time.
    const lockAt = source.contest.lockAt && !source.contest.unlocked ? source.contest.lockAt.getTime() : null;
    // Before the public board may be shown, nothing about the field.
    if (source.hidden) return { hidden: true, title: source.contest.title, status: 'before', serverTime: source.now, beginAt, endAt, lockAt };
    const overview = contestOverview({
        title: source.contest.title, beginAt, endAt, lockAt, now: source.now, data: source.data,
        unofficialFirstSolve: source.settings.unofficialFirstSolve, tieBreak: source.settings.tieBreak,
    });
    const verdicts = overview.verdicts.map((item) => {
        const status = overviewVerdictStatus.get(item.key);
        return { ...item, code: status && verdictFor(status)?.shortName };
    });
    return { ...overview, verdicts, hidden: false, frozenRuns: source.data.submissions.filter((record) => record.status === 'FROZEN').length };
}

/** The overview without its clock, to tell whether anything an audience sees has changed. */
export function overviewKey(overview: LiveOverview) {
    const { serverTime: _serverTime, ...rest } = overview;
    return JSON.stringify(rest);
}
