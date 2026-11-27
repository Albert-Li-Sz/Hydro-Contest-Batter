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
 * count: `medals` are numbers of teams. ratio: `medals` are percentages of the board's official teams counted by
 * `medalBase`, rounded up per tier (ICPC regionals: 金 10% / 银 20% / 铜 30%) or cumulatively (CCPC 基本规则附 1:
 * 金 ⌈10%⌉, 银 ⌈30%⌉ − 金, 铜 ⌈60%⌉ − 银 − 金). multiple: gold is `medals.gold` percent rounded up, silver and bronze
 * are `medals.silver` and `medals.bronze` times gold (ICPC 西安邀请赛: 10%, 2 倍, 3 倍).
 */
export type MedalBasis = 'count' | 'ratio' | 'multiple';
export const medalBases = ['count', 'ratio', 'multiple'] as const;
/** Which official teams of a board the percentages count: solved one problem, submitted once (CCPC), or all. */
export type MedalBase = 'solved' | 'submitted' | 'registered';
export const medalPoolKinds = ['solved', 'submitted', 'registered'] as const;
export type MedalRounding = 'tier' | 'cumulative';
/**
 * Under `ratio`, tiers marked here hold a number of teams instead of a percentage (e.g. 金 15 队, 银 20%, 铜 30%).
 * Cumulative rounding includes whole fixed awards and the exact share of every percentage tier so far.
 */
export interface MedalFixed {
    gold: boolean;
    silver: boolean;
    bronze: boolean;
}
export const noFixedMedals = (): MedalFixed => ({ gold: false, silver: false, bronze: false });

/** Official teams of one board: all of them, those with a submission in the contest, those that solved something. */
export interface MedalPool {
    registered: number;
    submitted: number;
    solved: number;
}

/**
 * ICPC World Finals Honors (2026 rules): Highest Honors to place `highest`, High Honors to `high`, Honors to
 * `standard`. Within Highest Honors the place is the rank; below it, teams solving the same number of problems
 * share the highest rank among them (resolver/public/js/honors.js).
 */
export interface Honors {
    enabled: boolean;
    highest: number;
    high: number;
    standard: number;
}
export const defaultHonors = (): Honors => ({ enabled: false, highest: 25, high: 50, standard: 100 });

/** What the trophies (冠军、亚军、季军 by default) go by, and how tied teams receive them (resolver/public/js/trophies.js). */
export type PodiumBasis = 'team' | 'school';
export type PodiumTie = 'lastAccept' | 'shared';
/** Medals by team rank, or by school rank (CCPC 总决赛: school ranks 1–10 gold, 11–30 silver, 31–60 bronze). */
export type MedalRanking = 'team' | 'school';

export interface BoardAwards {
    medals: Medals;
    medalBasis: MedalBasis;
    medalBase: MedalBase;
    medalRounding: MedalRounding;
    medalFixed: MedalFixed;
    medalRanking: MedalRanking;
    goldCitation: string;
    silverCitation: string;
    bronzeCitation: string;
    medalSameScore: boolean;
    firstSolve: boolean;
    podiumEnabled: boolean;
    podiumBasis: PodiumBasis;
    podiumTie: PodiumTie;
    /** One trophy per name, in order: 1 to 10 names. */
    podiumNames: string[];
    unofficialMedals: boolean;
    unofficialFirstSolve: boolean;
    honors: Honors;
}

/**
 * How teams equal in solved problems are ordered, for every board, resolver, screen, broadcast and the CCS API.
 * hydro: Hydro's ACM rule, penalty in whole seconds, equal penalty shares a rank.
 * icpc: the ICPC regional rule, total time in minutes (accepted time truncated to the minute plus 20 minutes per
 * rejected run), then the earlier last accepted run; teams equal in both share a rank.
 * ccpc: CCPC 基本规则 4.1, total time in minutes as ICPC; teams equal in solved and time share the rank (listed by
 * the earlier last accepted run, which also decides trophies by 附录二).
 */
export type TieBreak = 'hydro' | 'icpc' | 'ccpc';
export const tieBreaks: readonly TieBreak[] = ['hydro', 'icpc', 'ccpc'];

/**
 * CCPC 新榜单模式 (2026.9.14): until the freeze, the public board hides problem labels. A problem's label shows
 * once `reveal` teams solved it (a number of teams, or a percentage of the contest's teams rounded down, or with
 * `min` the smaller of `reveal` teams and `revealPercent` percent of the teams); each
 * team's row lists the shown problems first, then its other accepts by time, then its other attempts by the
 * last submission, then the problems it never tried. Staff and the frozen board see the usual board.
 */
export interface CcpcBoard {
    enabled: boolean;
    revealBasis: 'count' | 'percent' | 'min';
    reveal: number;
    /** The percentage compared with `reveal` teams under `min`. */
    revealPercent: number;
}
export const defaultCcpcBoard = (): CcpcBoard => ({ enabled: false, revealBasis: 'count', reveal: 50, revealPercent: 20 });

/**
 * 特别奖, named by the organiser and given by rule:
 * rank: the team placed `rank` on `board` (最佳女队 = 女队榜第 1 名, 最佳专科队伍 = 专科榜第 1 名);
 * lastAccept: the `count` teams whose last first accept came latest (顽强拼搏奖, CCPC 基本规则 6.4);
 * lastSolver: the `count` lowest-placed teams that solved something (顽强拼搏奖, the other reading);
 * firstSolution: the team with the contest's first accept (ICPC World Finals First Solution Award);
 * honorable: every team that solved something without a medal (CCPC 总决赛优胜奖);
 * manual: the teams chosen by hand.
 * Rule-based awards require `minSolved` accepted problems (at least one). Unofficial teams take part only with
 * `unofficial`. Conditions:
 * `minTeams` teams on the board (unofficial ones counted with `unofficial`), a standing no lower than the last
 * team holding the `floor` medal or a better one on the main board (最佳女队: not below the last bronze), and
 * with `excludeMedalists` no gold, silver or bronze on the main board (顽强拼搏奖).
 * With `ties`, teams the ranking rule cannot separate (or accepts in the same second) all get it.
 */
export type SpecialKind = 'rank' | 'lastAccept' | 'lastSolver' | 'firstSolution' | 'honorable' | 'manual';
export const specialKinds: readonly SpecialKind[] = ['rank', 'lastAccept', 'lastSolver', 'firstSolution', 'honorable', 'manual'];
export type SpecialFloor = 'none' | 'gold' | 'silver' | 'bronze';
export const specialFloors: readonly SpecialFloor[] = ['none', 'gold', 'silver', 'bronze'];

export interface SpecialAward {
    id: string;
    name: string;
    kind: SpecialKind;
    board: string;
    rank: number;
    teamIds: string[];
    unofficial: boolean;
    ties: boolean;
    /** Winners of lastAccept and lastSolver, 1 to 10. */
    count: number;
    /** No award when fewer teams are on the board (0: no threshold). */
    minTeams: number;
    /** Problems a team must have solved to be considered (1 to 1000; 优胜奖的过题门槛). */
    minSolved: number;
    floor: SpecialFloor;
    excludeMedalists: boolean;
}

export interface BoardSettings extends BoardAwards {
    tieBreak: TieBreak;
    specialAwards: SpecialAward[];
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
    autoUnfreezeMinutes: number | null;
    ccpcBoard: CcpcBoard;
    /** Submissions to a problem the team already solved are left out everywhere (CCPC 新榜单模式). */
    ignoreAfterAccept: boolean;
}

export const defaultPodiumNames = ['冠军', '亚军', '季军'];

export const defaultSettings: BoardSettings = {
    medals: { gold: 1, silver: 2, bronze: 3 },
    medalBasis: 'count', medalBase: 'solved', medalRounding: 'tier', medalFixed: noFixedMedals(), medalRanking: 'team',
    goldCitation: '金奖', silverCitation: '银奖', bronzeCitation: '铜奖',
    medalSameScore: true, firstSolve: false, podiumEnabled: false, unofficialMedals: false, unofficialFirstSolve: false,
    podiumBasis: 'team', podiumTie: 'lastAccept', podiumNames: defaultPodiumNames, honors: defaultHonors(),
    tieBreak: 'hydro',
    specialAwards: [],
    boardAwards: {},
    schoolBoards: false,
    participationBoards: false,
    manualBoards: [],
    publicAccess: false,
    replaceNative: true,
    showIdentity: false,
    ccsApi: false,
    ccsAutoFinalize: false,
    autoUnfreezeMinutes: null,
    ccpcBoard: defaultCcpcBoard(),
    ignoreAfterAccept: false,
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

function normalizeHonors(value: unknown, fallback: Honors): Honors {
    if (value === undefined) return { ...fallback };
    const input = object(value, 'Honors');
    const result = { ...fallback };
    if (input.enabled !== undefined) {
        if (typeof input.enabled !== 'boolean') throw new Error('honors.enabled 必须是布尔值');
        result.enabled = input.enabled;
    }
    for (const key of ['highest', 'high', 'standard'] as const) {
        if (input[key] === undefined) continue;
        const place = input[key];
        if (typeof place !== 'number' || !Number.isSafeInteger(place) || place < 1 || place > 100000) throw new Error('Honors 名次应为 1 至 100000 的整数');
        result[key] = place;
    }
    if (!(result.highest <= result.high && result.high <= result.standard)) throw new Error('Honors 名次应依次不减：Highest、High、Honors');
    return result;
}

function normalizeAwards(input: Record<string, unknown>, fallback: BoardAwards): BoardAwards {
    if (input.medalBasis !== undefined && !medalBases.includes(input.medalBasis as MedalBasis)) throw new Error('奖牌名额方式无效');
    if (input.medalBase !== undefined && !medalPoolKinds.includes(input.medalBase as MedalBase)) throw new Error('奖牌名额分母无效');
    if (input.medalRounding !== undefined && input.medalRounding !== 'tier' && input.medalRounding !== 'cumulative') throw new Error('奖牌名额取整方式无效');
    // Medals saved without a basis (settings from before 按比例设奖) are numbers of teams; only rules that
    // bring no medals of their own take the default's basis along with its medals. The same goes for the
    // count's base and rounding (settings from before 名额分母): official teams that solved, rounded per tier.
    const own = input.medals !== undefined;
    const medalBasis: MedalBasis = (input.medalBasis as MedalBasis | undefined) ?? (own ? 'count' : fallback.medalBasis ?? 'count');
    const medalBase: MedalBase = (input.medalBase as MedalBase | undefined) ?? (own ? 'solved' : fallback.medalBase ?? 'solved');
    const medalRounding: MedalRounding = (input.medalRounding as MedalRounding | undefined) ?? (own ? 'tier' : fallback.medalRounding ?? 'tier');
    const counts = medals(input.medals ?? fallback.medals, '奖牌数量');
    let medalFixed = own ? noFixedMedals() : { ...fallback.medalFixed ?? noFixedMedals() };
    if (input.medalFixed !== undefined) {
        const fixed = object(input.medalFixed, '固定名额的奖牌');
        medalFixed = noFixedMedals();
        for (const key of ['gold', 'silver', 'bronze'] as const) {
            if (fixed[key] === undefined) continue;
            if (typeof fixed[key] !== 'boolean') throw new Error(`medalFixed.${key} 必须是布尔值`);
            medalFixed[key] = fixed[key];
        }
    }
    // Only 按比例 mixes percentages with numbers of teams.
    if (medalBasis !== 'ratio') medalFixed = noFixedMedals();
    const percents = (['gold', 'silver', 'bronze'] as const).filter((key) => !medalFixed[key]).reduce((sum, key) => sum + counts[key], 0);
    if (medalBasis === 'ratio' && percents > 100) throw new Error('按比例设奖时，金银铜比例之和不能超过 100%');
    if (medalBasis === 'multiple' && (counts.gold > 100 || counts.silver > 20 || counts.bronze > 20)) throw new Error('按金牌倍数设奖时，金牌比例不超过 100%，银、铜不超过金牌的 20 倍');
    const result: BoardAwards = { medals: counts, medalBasis, medalBase, medalRounding, medalFixed, medalRanking: fallback.medalRanking ?? 'team',
        goldCitation: fallback.goldCitation, silverCitation: fallback.silverCitation, bronzeCitation: fallback.bronzeCitation,
        medalSameScore: fallback.medalSameScore, firstSolve: fallback.firstSolve,
        podiumEnabled: fallback.podiumEnabled, podiumBasis: fallback.podiumBasis ?? 'team', podiumTie: fallback.podiumTie ?? 'lastAccept',
        podiumNames: [...fallback.podiumNames ?? defaultPodiumNames], unofficialMedals: fallback.unofficialMedals ?? false, unofficialFirstSolve: fallback.unofficialFirstSolve,
        honors: normalizeHonors(input.honors, fallback.honors ?? defaultHonors()) };
    const choice = <K extends 'medalRanking' | 'podiumBasis' | 'podiumTie'>(key: K, allowed: BoardAwards[K][], label: string) => {
        if (input[key] === undefined) return;
        if (!allowed.includes(input[key] as BoardAwards[K])) throw new Error(`${label}无效`);
        result[key] = input[key] as BoardAwards[K];
    };
    choice('medalRanking', ['team', 'school'], '奖牌排名依据');
    choice('podiumBasis', ['team', 'school'], '奖杯排名依据');
    choice('podiumTie', ['lastAccept', 'shared'], '奖杯并列办法');
    if (input.podiumNames !== undefined) {
        if (!Array.isArray(input.podiumNames) || !input.podiumNames.length || input.podiumNames.length > 10) throw new Error('奖杯应有 1 至 10 个');
        result.podiumNames = input.podiumNames.map((name, index) => {
            if (typeof name !== 'string' || !name.trim() || name.trim().length > 40) throw new Error(`第 ${index + 1} 个奖杯名称应为 1 至 40 个字符`);
            return name.trim();
        });
    }
    for (const key of ['medalSameScore', 'firstSolve', 'podiumEnabled', 'unofficialMedals', 'unofficialFirstSolve'] as const) {
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

const boardIdPattern = /^(all|official|unofficial|girl|school-[a-f0-9]{16}|manual-[a-z0-9][a-z0-9_-]{0,47})$/;

function specialAwards(value: unknown, manualIds: Set<string>): SpecialAward[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 20) throw new Error('特别奖必须是数组，最多 20 个');
    const ids = new Set<string>();
    return value.flatMap((item, index): SpecialAward[] => {
        const award = object(item, `特别奖 ${index + 1}`);
        if (typeof award.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,31}$/.test(award.id) || ids.has(award.id)) throw new Error('特别奖标识无效或重复');
        ids.add(award.id);
        if (typeof award.name !== 'string' || !award.name.trim() || award.name.trim().length > 40) throw new Error('特别奖名称应为 1 至 40 个字符');
        const name = award.name.trim();
        if (!specialKinds.includes(award.kind as SpecialKind)) throw new Error(`特别奖“${name}”的类型无效`);
        const kind = award.kind as SpecialKind;
        const board = award.board === undefined ? 'all' : award.board;
        if (typeof board !== 'string' || !boardIdPattern.test(board)) throw new Error(`特别奖“${name}”的榜单无效`);
        // An award on a deleted manual board goes with it, as the board's own award rules do.
        if (kind !== 'manual' && board.startsWith('manual-') && !manualIds.has(board.slice('manual-'.length))) return [];
        const rank = award.rank === undefined ? 1 : award.rank;
        if (typeof rank !== 'number' || !Number.isSafeInteger(rank) || rank < 1 || rank > 1000) throw new Error(`特别奖“${name}”的名次应为 1 至 1000 的整数`);
        const teamIds = award.teamIds === undefined ? [] : award.teamIds;
        if (!Array.isArray(teamIds) || teamIds.length > 100 || teamIds.some((id) => typeof id !== 'string' || !/^-?\d{1,16}$/.test(id))) {
            throw new Error(`特别奖“${name}”的队伍必须是 Hydro 用户 ID，最多 100 个`);
        }
        if (kind === 'manual' && !teamIds.length) throw new Error(`特别奖“${name}”需要指定获奖队伍`);
        for (const key of ['unofficial', 'ties', 'excludeMedalists'] as const) {
            if (award[key] !== undefined && typeof award[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
        }
        const count = award.count === undefined ? 1 : award.count;
        if (typeof count !== 'number' || !Number.isSafeInteger(count) || count < 1 || count > 10) throw new Error(`特别奖“${name}”的获奖队数应为 1 至 10`);
        const minTeams = award.minTeams === undefined ? 0 : award.minTeams;
        if (typeof minTeams !== 'number' || !Number.isSafeInteger(minTeams) || minTeams < 0 || minTeams > 100000) throw new Error(`特别奖“${name}”的最少队数应为 0 至 100000`);
        const minSolved = award.minSolved === undefined ? 1 : award.minSolved;
        if (typeof minSolved !== 'number' || !Number.isSafeInteger(minSolved) || minSolved < 1 || minSolved > 1000) throw new Error(`特别奖“${name}”的过题门槛应为 1 至 1000 题`);
        const floor = award.floor === undefined ? 'none' : award.floor;
        if (!specialFloors.includes(floor as SpecialFloor)) throw new Error(`特别奖“${name}”的成绩线无效`);
        const rule = kind !== 'manual';
        return [{
            id: award.id, name, kind, board: kind === 'manual' ? 'all' : board, rank: kind === 'rank' ? rank : 1,
            teamIds: kind === 'manual' ? [...new Set(teamIds as string[])] : [],
            // Before 打星资格 applied to every rule, only 分榜名次 could include unofficial teams.
            unofficial: rule && award.unofficial === true, ties: award.ties !== false,
            count: kind === 'lastAccept' || kind === 'lastSolver' ? count : 1,
            minTeams: rule ? minTeams : 0, minSolved: rule ? minSolved : 1, floor: rule ? floor as SpecialFloor : 'none',
            excludeMedalists: rule && kind !== 'honorable' && award.excludeMedalists === true,
        }];
    });
}

/**
 * Medals of each tier for a board (before capping at the teams that solved something). `pool` counts the board's
 * official teams; a bare number counts all three the same (official teams that solved something).
 */
export function medalCounts(rules: Pick<BoardAwards, 'medals' | 'medalBasis'> & Partial<Pick<BoardAwards, 'medalBase' | 'medalRounding' | 'medalFixed'>>,
    pool: number | MedalPool): Medals {
    if (rules.medalBasis !== 'ratio' && rules.medalBasis !== 'multiple') return rules.medals;
    const teams = typeof pool === 'number' ? pool : pool[rules.medalBase ?? 'solved'];
    // Integer arithmetic: 10% of 30 teams is 3, not 3.0000000000000004 rounded up to 4.
    const share = (percent: number) => Math.ceil((teams * percent) / 100 - 1e-9);
    const { gold, silver, bronze } = rules.medals;
    if (rules.medalBasis === 'multiple') {
        const golds = share(gold);
        return { gold: golds, silver: golds * silver, bronze: golds * bronze };
    }
    const fixed = rules.medalFixed ?? noFixedMedals();
    if (rules.medalRounding === 'cumulative') {
        const result = { gold: 0, silver: 0, bronze: 0 };
        let hundredths = 0;
        let given = 0;
        for (const key of ['gold', 'silver', 'bronze'] as const) {
            hundredths += rules.medals[key] * (fixed[key] ? 100 : teams);
            const cumulative = Math.ceil(hundredths / 100);
            result[key] = cumulative - given;
            given = cumulative;
        }
        return result;
    }
    const tier = (key: 'gold' | 'silver' | 'bronze') => (fixed[key] ? rules.medals[key] : share(rules.medals[key]));
    return { gold: tier('gold'), silver: tier('silver'), bronze: tier('bronze') };
}

/** Never more medals than teams that solved something, gold first. */
export function cappedMedals(configured: Medals, solvedTeams: number): Medals {
    let remaining = solvedTeams;
    const result = { gold: 0, silver: 0, bronze: 0 };
    for (const key of ['gold', 'silver', 'bronze'] as const) {
        result[key] = Math.min(configured[key], remaining);
        remaining -= result[key];
    }
    return result;
}

/** A virtual placing can reach a fixed award even when no official team has solved a problem. */
export function boardMedalCounts(awards: BoardAwards, pool: MedalPool) {
    const counts = medalCounts(awards, pool);
    return awards.unofficialMedals ? counts : cappedMedals(counts, pool.solved);
}

/** A board override is shared by the live board and new resolver snapshots; the ranking rule is the contest's. */
export function awardsFor(settings: BoardSettings, boardId: string): BoardRules {
    const tieBreak = settings.tieBreak ?? 'hydro';
    if (settings.boardAwards[boardId]) return { ...settings.boardAwards[boardId], tieBreak };
    const manual = settings.manualBoards.find((board) => `manual-${board.id}` === boardId);
    return { medals: manual?.medals || settings.medals, medalBasis: manual?.medals ? 'count' : settings.medalBasis ?? 'count',
        medalBase: manual?.medals ? 'solved' : settings.medalBase ?? 'solved', medalRounding: manual?.medals ? 'tier' : settings.medalRounding ?? 'tier',
        medalFixed: manual?.medals ? noFixedMedals() : settings.medalFixed ?? noFixedMedals(),
        medalRanking: settings.medalRanking ?? 'team',
        goldCitation: settings.goldCitation, silverCitation: settings.silverCitation, bronzeCitation: settings.bronzeCitation,
        medalSameScore: settings.medalSameScore, firstSolve: settings.firstSolve,
        podiumEnabled: settings.podiumEnabled, podiumBasis: settings.podiumBasis ?? 'team', podiumTie: settings.podiumTie ?? 'lastAccept',
        podiumNames: settings.podiumNames ?? defaultPodiumNames, unofficialMedals: settings.unofficialMedals ?? false, unofficialFirstSolve: settings.unofficialFirstSolve,
        honors: settings.honors ?? defaultHonors(), tieBreak };
}

export function normalizeSettings(value: unknown): BoardSettings {
    const input = object(value, '榜单设置');
    for (const key of ['schoolBoards', 'participationBoards', 'publicAccess', 'replaceNative', 'unofficialAwards', 'showIdentity', 'ccsApi', 'ccsAutoFinalize', 'ignoreAfterAccept']) {
        if (input[key] !== undefined && typeof input[key] !== 'boolean') throw new Error(`${key} 必须是布尔值`);
    }
    if (input.tieBreak !== undefined && !tieBreaks.includes(input.tieBreak as TieBreak)) throw new Error('同分规则无效');
    if (!Array.isArray(input.manualBoards) || input.manualBoards.length > 50) {
        throw new Error('手动分榜必须是数组，最多 50 个');
    }
    const minutes = input.autoUnfreezeMinutes;
    if (minutes != null && (typeof minutes !== 'number' || !Number.isSafeInteger(minutes) || minutes < 0 || !Number.isFinite(new Date(Date.now() + minutes * 60000).getTime()))) {
        throw new Error('请填写有效的非负整数分钟，留空表示关闭');
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
        if (!boardIdPattern.test(id)) throw new Error('分榜奖项标识无效');
        // A deleted manual board takes its award rules with it (also for settings saved before this rule).
        if (id.startsWith('manual-') && !ids.has(id.slice('manual-'.length))) continue;
        boardAwards[id] = normalizeAwards(object(value, '分榜奖项'), awards);
    }
    return {
        ...awards, boardAwards,
        tieBreak: (input.tieBreak as TieBreak | undefined) ?? 'hydro',
        specialAwards: specialAwards(input.specialAwards, ids),
        schoolBoards: input.schoolBoards === true,
        participationBoards: input.participationBoards === true,
        manualBoards,
        // Anything that widens who can see what stays off unless it was saved explicitly.
        publicAccess: input.publicAccess === true,
        replaceNative: input.replaceNative === undefined ? true : input.replaceNative as boolean,
        showIdentity: input.showIdentity === true,
        autoUnfreezeMinutes: minutes ?? null,
        ccsApi: input.ccsApi === true,
        ccsAutoFinalize: input.ccsAutoFinalize === true,
        ccpcBoard: normalizeCcpcBoard(input.ccpcBoard),
        ignoreAfterAccept: input.ignoreAfterAccept === true,
    };
}

export function normalizeCcpcBoard(value: unknown): CcpcBoard {
    if (value === undefined) return defaultCcpcBoard();
    const input = object(value, 'CCPC 新榜单模式');
    const board = defaultCcpcBoard();
    if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new Error('ccpcBoard.enabled 必须是布尔值');
    board.enabled = input.enabled === true;
    if (input.revealBasis !== undefined) {
        if (input.revealBasis !== 'count' && input.revealBasis !== 'percent' && input.revealBasis !== 'min') throw new Error('题号显示门槛的方式无效');
        board.revealBasis = input.revealBasis;
    }
    if (input.reveal !== undefined) {
        const max = board.revealBasis === 'percent' ? 100 : 100000;
        if (typeof input.reveal !== 'number' || !Number.isSafeInteger(input.reveal) || input.reveal < 1 || input.reveal > max) {
            throw new Error(board.revealBasis === 'percent' ? '题号显示门槛应为 1% 至 100%' : '题号显示门槛应为 1 至 100000 队');
        }
        board.reveal = input.reveal;
    } else if (board.revealBasis === 'percent') board.reveal = 20;
    if (input.revealPercent !== undefined) {
        if (typeof input.revealPercent !== 'number' || !Number.isSafeInteger(input.revealPercent) || input.revealPercent < 1 || input.revealPercent > 100) {
            throw new Error('题号显示门槛的比例应为 1% 至 100%');
        }
        board.revealPercent = input.revealPercent;
    }
    return board;
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
