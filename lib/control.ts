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

/**
 * 奖牌模板: how a kind of contest counts its medals, applied on top of the 赛制 (which leaves medals alone).
 * CCPC 全国赛: 基本规则附 1; CCPC 总决赛: 学校名次 1–10/11–30/31–60; ICPC 区域赛: 至少过一题的队伍分档取整;
 * 金牌倍数: ICPC 西安邀请赛 (金牌为队伍数的 10%，银牌 2 倍，铜牌 3 倍); WF: 4-6-10 and Honors (2026 ICPC World Finals Rules).
 */
export const medalTemplates: { id: string; name: string; board: BoardPatch }[] = [
    { id: 'ccpc-national', name: 'CCPC 全国赛', board: { medalBasis: 'ratio', medals: { gold: 10, silver: 20, bronze: 30 }, medalBase: 'submitted', medalRounding: 'cumulative',
        medalRanking: 'team', honors: { enabled: false, highest: 25, high: 50, standard: 100 } } },
    { id: 'ccpc-final', name: 'CCPC 总决赛', board: { medalBasis: 'count', medals: { gold: 10, silver: 20, bronze: 30 }, medalRanking: 'school',
        honors: { enabled: false, highest: 25, high: 50, standard: 100 } } },
    { id: 'icpc-regional', name: 'ICPC 区域赛', board: { medalBasis: 'ratio', medals: { gold: 10, silver: 20, bronze: 30 }, medalBase: 'solved', medalRounding: 'tier',
        medalRanking: 'team', honors: { enabled: false, highest: 25, high: 50, standard: 100 } } },
    { id: 'icpc-multiple', name: '金牌倍数', board: { medalBasis: 'multiple', medals: { gold: 10, silver: 2, bronze: 3 }, medalBase: 'registered',
        medalRanking: 'team', honors: { enabled: false, highest: 25, high: 50, standard: 100 } } },
    { id: 'wf', name: 'ICPC World Finals', board: { medalBasis: 'count', medals: { gold: 4, silver: 6, bronze: 10 }, medalRanking: 'team',
        honors: { enabled: true, highest: 25, high: 50, standard: 100 } } },
];

/** The 奖牌模板 the medals follow now, or null when they were set by hand. */
export function medalTemplateOf(board: BoardSettings): string | null {
    const fields = ['medalBasis', 'medals', 'medalRanking', 'honors'] as const;
    return medalTemplates.find((template) => fields.every((key) => JSON.stringify(board[key]) === JSON.stringify(template.board[key]))
        && (board.medalBasis === 'count' || (template.board.medalBase === board.medalBase
            && (board.medalBasis !== 'ratio' || template.board.medalRounding === board.medalRounding))))?.id ?? null;
}

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
