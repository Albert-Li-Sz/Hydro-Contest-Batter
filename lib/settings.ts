export interface Medals {
    gold: number;
    silver: number;
    bronze: number;
}

export interface ManualBoard {
    id: string;
    name: string;
    teamIds: string[];
    medals?: Medals;
}

/**
 * count: `medals` are numbers of teams. ratio: `medals` are percentages of the board's eligible teams (official
 * teams that solved at least one problem), each rounded up, as ICPC regionals award 金 10% / 银 20% / 铜 30%.
 */
export type MedalBasis = 'count' | 'ratio';

export interface BoardAwards {
    medals: Medals;
    medalBasis: MedalBasis;
    goldCitation: string;
    silverCitation: string;
    bronzeCitation: string;
    medalSameScore: boolean;
    firstSolve: boolean;
    podiumEnabled: boolean;
    unofficialFirstSolve: boolean;
}

/**
 * How teams equal in solved problems are ordered, for every board, resolver, screen, broadcast and the CCS API.
 * hydro: Hydro's ACM rule, penalty in whole seconds, equal penalty shares a rank.
 * icpc: the ICPC regional rule, total time in minutes (accepted time truncated to the minute plus 20 minutes per
 * rejected run), then the earlier last accepted run; teams equal in both share a rank.
 */
export type TieBreak = 'hydro' | 'icpc';
export const tieBreaks: readonly TieBreak[] = ['hydro', 'icpc'];

export interface BoardSettings extends BoardAwards {
    tieBreak: TieBreak;
    boardAwards: Record<string, BoardAwards>;
    schoolBoards: boolean;
    participationBoards: boolean;
    manualBoards: ManualBoard[];
    publicAccess: boolean;
    replaceNative: boolean;
    /** Show Hydro's private display name and school to viewers without PERM_VIEW_USER_PRIVATE_INFO. */
    showIdentity: boolean;
    /** Serve the contest through the ICPC CCS Contest API (lib/ccs). */
    ccsApi: boolean;
    ccsAutoFinalize: boolean;
}

export const defaultSettings: BoardSettings = {
    medals: { gold: 1, silver: 2, bronze: 3 },
    medalBasis: 'count',
    goldCitation: '金奖', silverCitation: '银奖', bronzeCitation: '铜奖',
    medalSameScore: true, firstSolve: false, podiumEnabled: false, unofficialFirstSolve: false,
    tieBreak: 'hydro',
    boardAwards: {},
    schoolBoards: false,
    participationBoards: false,
    manualBoards: [],
    publicAccess: false,
    replaceNative: true,
    showIdentity: false,
    ccsApi: false,
    ccsAutoFinalize: false,
};

function object(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} 必须是对象`);
    return value as Record<string, unknown>;
}

function medals(value: unknown, label: string): Medals {
    const input = object(value, label);
    const result = {} as Medals;
    for (const key of ['gold', 'silver', 'bronze'] as const) {
        const count = input[key];
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 0 || count > 100000) {
            throw new Error(`${label}.${key} 必须是 0 至 100000 的整数`);
        }
        result[key] = count;
    }
    return result;
}

function normalizeAwards(input: Record<string, unknown>, fallback: BoardAwards): BoardAwards {
    if (input.medalBasis !== undefined && input.medalBasis !== 'count' && input.medalBasis !== 'ratio') throw new Error('奖牌名额方式无效');
    // Medals saved without a basis (settings from before 按比例设奖) are numbers of teams; only rules that
    // bring no medals of their own take the default's basis along with its medals.
    const medalBasis: MedalBasis = (input.medalBasis as MedalBasis | undefined)
        ?? (input.medals !== undefined ? 'count' : fallback.medalBasis ?? 'count');
    const counts = medals(input.medals ?? fallback.medals, '奖牌数量');
    if (medalBasis === 'ratio' && counts.gold + counts.silver + counts.bronze > 100) throw new Error('按比例设奖时，金银铜比例之和不能超过 100%');
    const result: BoardAwards = { medals: counts, medalBasis,
        goldCitation: fallback.goldCitation, silverCitation: fallback.silverCitation, bronzeCitation: fallback.bronzeCitation,
        medalSameScore: fallback.medalSameScore, firstSolve: fallback.firstSolve,
        podiumEnabled: fallback.podiumEnabled, unofficialFirstSolve: fallback.unofficialFirstSolve };
    for (const key of ['medalSameScore', 'firstSolve', 'podiumEnabled', 'unofficialFirstSolve'] as const) {
        if (input[key] === undefined) continue;
        if (typeof input[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
        result[key] = input[key];
    }
    for (const key of ['goldCitation', 'silverCitation', 'bronzeCitation'] as const) {
        if (input[key] === undefined) continue;
        if (typeof input[key] !== 'string' || !input[key].trim() || input[key].trim().length > 80) throw new Error(`${key} 应为 1 至 80 个字符`);
        result[key] = input[key].trim();
    }
    return result;
}

export type BoardRules = BoardAwards & { tieBreak: TieBreak };

/** Medals of each tier for a board with `eligible` official teams that solved something (before capping). */
export function medalCounts(rules: Pick<BoardAwards, 'medals' | 'medalBasis'>, eligible: number): Medals {
    if (rules.medalBasis !== 'ratio') return rules.medals;
    // Integer arithmetic: 10% of 30 teams is 3, not 3.0000000000000004 rounded up to 4.
    const share = (percent: number) => Math.ceil((eligible * percent) / 100 - 1e-9);
    return { gold: share(rules.medals.gold), silver: share(rules.medals.silver), bronze: share(rules.medals.bronze) };
}

/** A board override is shared by the live board and new resolver snapshots; the ranking rule is the contest's. */
export function awardsFor(settings: BoardSettings, boardId: string): BoardRules {
    const tieBreak = settings.tieBreak ?? 'hydro';
    if (settings.boardAwards[boardId]) return { ...settings.boardAwards[boardId], tieBreak };
    const manual = settings.manualBoards.find((board) => `manual-${board.id}` === boardId);
    return { medals: manual?.medals || settings.medals, medalBasis: manual?.medals ? 'count' : settings.medalBasis ?? 'count',
        goldCitation: settings.goldCitation, silverCitation: settings.silverCitation, bronzeCitation: settings.bronzeCitation,
        medalSameScore: settings.medalSameScore, firstSolve: settings.firstSolve,
        podiumEnabled: settings.podiumEnabled, unofficialFirstSolve: settings.unofficialFirstSolve, tieBreak };
}

export function normalizeSettings(value: unknown): BoardSettings {
    const input = object(value, '榜单设置');
    for (const key of ['schoolBoards', 'participationBoards', 'publicAccess', 'replaceNative', 'unofficialAwards', 'showIdentity', 'ccsApi', 'ccsAutoFinalize']) {
        if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
    }
    if (input.tieBreak !== undefined && !tieBreaks.includes(input.tieBreak as TieBreak)) throw new Error('同分规则无效');
    if (!Array.isArray(input.manualBoards) || input.manualBoards.length > 50) {
        throw new Error('手动分榜必须是数组，最多 50 个');
    }
    const ids = new Set<string>();
    const manualBoards = input.manualBoards.map((value, index): ManualBoard => {
        const board = object(value, `手动分榜 ${index + 1}`);
        if (typeof board.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,47}$/.test(board.id) || ids.has(board.id)) {
            throw new Error('分榜标识应为 1 至 48 位小写字母、数字、下划线或连字符，且不能重复');
        }
        ids.add(board.id);
        if (typeof board.name !== 'string' || !board.name.trim() || board.name.trim().length > 64) {
            throw new Error('分榜名称应为 1 至 64 个字符');
        }
        if (!Array.isArray(board.teamIds) || board.teamIds.length > 10000
            || board.teamIds.some((id) => typeof id !== 'string' || !/^\d{1,16}$/.test(id))) {
            throw new Error('分榜成员必须是 Hydro 用户 ID 字符串数组，最多 10000 人');
        }
        return {
            id: board.id,
            name: board.name.trim(),
            teamIds: [...new Set(board.teamIds as string[])],
            ...(board.medals === undefined ? {} : { medals: medals(board.medals, board.name) }),
        };
    });
    // Legacy broad award permission migrates to first-solve eligibility only.
    const awards = normalizeAwards({ ...input, unofficialFirstSolve: input.unofficialFirstSolve ?? input.unofficialAwards }, defaultSettings);
    const overrides = input.boardAwards === undefined ? {} : object(input.boardAwards, '分榜奖项');
    const boardAwards: Record<string, BoardAwards> = {};
    for (const [id, value] of Object.entries(overrides)) {
        if (!/^(all|official|unofficial|school-[a-f0-9]{16}|manual-[a-z0-9][a-z0-9_-]{0,47})$/.test(id)) throw new Error('分榜奖项标识无效');
        // A deleted manual board takes its award rules with it (also for settings saved before this rule).
        if (id.startsWith('manual-') && !ids.has(id.slice('manual-'.length))) continue;
        boardAwards[id] = normalizeAwards(object(value, '分榜奖项'), awards);
    }
    return {
        ...awards, boardAwards,
        tieBreak: input.tieBreak === 'icpc' ? 'icpc' : 'hydro',
        schoolBoards: input.schoolBoards === true,
        participationBoards: input.participationBoards === true,
        manualBoards,
        // Anything that widens who can see what stays off unless it was saved explicitly.
        publicAccess: input.publicAccess === true,
        replaceNative: input.replaceNative === undefined ? true : input.replaceNative as boolean,
        showIdentity: input.showIdentity === true,
        ccsApi: input.ccsApi === true,
        ccsAutoFinalize: input.ccsAutoFinalize === true,
    };
}

/** Compared the way viewers read them: width, case and spacing differences do not make a name distinct. */
export function boardNameKey(name: string): string {
    return name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
}

/** Checked on save only, so settings stored before this rule existed still load. */
export function checkBoardNames(settings: BoardSettings, reserved: string[] = []) {
    const taken = new Set(reserved.map(boardNameKey));
    for (const board of settings.manualBoards) {
        const key = boardNameKey(board.name);
        if (taken.has(key)) throw new Error(`分榜名称“${board.name}”与其他榜单重复，请改用不同的名称`);
        taken.add(key);
    }
}

export function pruneMembers(settings: BoardSettings, knownIds: Set<string>): BoardSettings {
    return { ...settings, manualBoards: settings.manualBoards.map((board) => ({ ...board, teamIds: board.teamIds.filter((id) => knownIds.has(id)) })) };
}

export function toScriptJson(value: unknown): string {
    return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
