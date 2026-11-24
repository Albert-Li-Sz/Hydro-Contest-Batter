/**
 * 赛事中控: one page for the settings a contest day needs, which otherwise sit on the settings, balloon, capture
 * and print pages. Pure; lib/control-routes.ts reads and saves through each module.
 */
import { type BalloonSettings } from './balloons';
import { type BoardSettings, defaultPodiumNames, normalizeSettings } from './settings';

export type PresetId = 'hydro' | 'icpc' | 'ccpc';

type BalloonPatch = Partial<Pick<BalloonSettings, 'afterFreeze' | 'teamColors'>> & { first?: Partial<BalloonSettings['first']> };

type BoardPatch = Partial<Omit<BoardSettings, 'ccpcBoard'>> & { ccpcBoard?: Partial<BoardSettings['ccpcBoard']> };

/** 赛制: the ranking rule and what goes with it on the board and the balloons. Medals, boards and access stay. */
export const presets: Record<PresetId, { name: string; board: BoardPatch; balloons: BalloonPatch }> = {
    hydro: {
        name: 'Hydro',
        board: { tieBreak: 'hydro', ccpcBoard: { enabled: false }, ignoreAfterAccept: false, podiumBasis: 'team', podiumTie: 'lastAccept', medalRanking: 'team' },
        balloons: { first: { style: 'problem' }, teamColors: false },
    },
    icpc: {
        name: 'ICPC 区域赛',
        board: { tieBreak: 'icpc', ccpcBoard: { enabled: false }, ignoreAfterAccept: false, podiumBasis: 'team', podiumTie: 'lastAccept', medalRanking: 'team' },
        balloons: { afterFreeze: 'hold', first: { style: 'problem' }, teamColors: false },
    },
    ccpc: {
        name: 'CCPC',
        board: {
            tieBreak: 'ccpc', ccpcBoard: { enabled: true }, ignoreAfterAccept: true,
            podiumEnabled: true, podiumBasis: 'school', podiumTie: 'lastAccept', podiumNames: defaultPodiumNames, medalRanking: 'team',
            // CCPC 基本规则 6.2: unofficial teams can win first solve.
            firstSolve: true, unofficialFirstSolve: true,
        },
        balloons: { afterFreeze: 'hold', first: { style: 'uniform' }, teamColors: true },
    },
};
export const presetIds = Object.keys(presets) as PresetId[];

const matches = (actual: Record<string, unknown>, wanted: Record<string, unknown>): boolean => Object.entries(wanted).every(([key, value]) => (
    value && typeof value === 'object' && !Array.isArray(value)
        ? matches((actual[key] || {}) as Record<string, unknown>, value as Record<string, unknown>)
        : JSON.stringify(actual[key]) === JSON.stringify(value)));

/** The 赛制 the settings follow now, or null when they were changed by hand. */
export function presetOf(board: BoardSettings, balloons: BalloonSettings | null): PresetId | null {
    return presetIds.find((id) => matches(board as unknown as Record<string, unknown>, presets[id].board as Record<string, unknown>)
        && (!balloons?.enabled || matches(balloons as unknown as Record<string, unknown>, presets[id].balloons as Record<string, unknown>))) ?? null;
}

/** Board settings with `patch` merged in (objects one level deep), checked as the settings page saves them. */
export function patchBoard(settings: BoardSettings, patch: Record<string, unknown>): BoardSettings {
    const merged: Record<string, unknown> = { ...settings };
    for (const [key, value] of Object.entries(patch)) {
        const current = merged[key];
        merged[key] = value && typeof value === 'object' && !Array.isArray(value) && current && typeof current === 'object' && !Array.isArray(current)
            ? { ...current as object, ...value as object } : value;
    }
    return normalizeSettings(merged);
}

/** The board's state in plain words: before, running, frozen, ended but still frozen (until 解除封榜), ended. */
export function contestPhase(contest: { beginAt: Date; endAt: Date; lockAt?: Date | null; unlocked?: boolean }, now: number) {
    const frozen = !!contest.lockAt && contest.lockAt.getTime() < now && !contest.unlocked;
    if (now < contest.beginAt.getTime()) return 'before';
    if (now < contest.endAt.getTime()) return frozen ? 'frozen' : 'running';
    return frozen ? 'sealed' : 'ended';
}
