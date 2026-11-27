import type { SpecialResult } from './special-awards';
import type { BoardData } from './board';
import { enhanceBoard, medalPool } from './board';
import type { BoardAwards, BoardSettings, MedalPool } from './settings';
import { awardsFor, cappedMedals, medalCounts } from './settings';
import type { ResolverBoard, ResolverConfig, ResolverContest, ResolverPayload } from './resolver-types';
import { buildGame } from '../resolver/server/lib/engine.js';

export const resolverAssetBase = '/hydro-resolver';
/** Scripts and styles are published per plugin version (see scripts/assets.mjs). */
export const resolverCodeBase = (version: string) => `${resolverAssetBase}/${version}`;
const pendingStatuses = new Set(['PENDING']);
const exemptStatuses = new Set(['CORRECT', 'COMPILATION_ERROR', 'PRESENTATION_ERROR', 'CANCELED']);

export class ResolverError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}

export function resolverBoards(data: BoardData, settings: BoardSettings, identity: boolean): ResolverBoard[] {
    const enhanced = enhanceBoard(data, settings, { identity });
    const groups = enhanced.contest.group as Record<string, string>;
    const board = (id: string, name: string, teamIds: string[]): ResolverBoard => {
        const awards = awardsFor(settings, id);
        const pool = medalPool(data, teamIds);
        // As on the board: never more medals than official teams that solved something.
        return { id, name, teamIds, medals: awards.medals, awards, eligible: pool.solved, pool, medalCounts: cappedMedals(medalCounts(awards, pool), pool.solved) };
    };
    return [board('all', '主榜', data.teams.map((team) => team.team_id)),
        ...Object.entries(groups).map(([id, name]) => board(id, name, enhanced.teams.filter((team) => team.group.includes(id)).map((team) => team.team_id)))];
}

/** `pool`: the board's official teams the medal counts rest on (lib/settings.ts MedalBase). */
function resolverAwardConfig(awards: BoardAwards, pool: number | MedalPool = 0) {
    const counts = medalCounts(awards, pool);
    const honors = awards.honors;
    return { goldCount: counts.gold, silverCount: counts.silver, bronzeCount: counts.bronze,
        goldCitation: awards.goldCitation, silverCitation: awards.silverCitation, bronzeCitation: awards.bronzeCitation,
        medalSameScore: awards.medalSameScore, podiumEnabled: awards.podiumEnabled, firstSolve: awards.firstSolve,
        podiumBasis: awards.podiumBasis ?? 'team', podiumTie: awards.podiumTie ?? 'lastAccept', podiumNames: awards.podiumNames, medalRanking: awards.medalRanking ?? 'team',
        honorsEnabled: !!honors?.enabled, honorsHighest: honors?.highest ?? 25, honorsHigh: honors?.high ?? 50, honorsStandard: honors?.standard ?? 100 };
}

export function defaultResolverConfig(settings: BoardAwards, ended: boolean): ResolverConfig {
    return {
        mode: 'board', boardId: 'all', rehearsal: !ended, freezeMode: 'contest', freezeAtSeconds: null,
        ...resolverAwardConfig(settings), rowsPerScreen: 12, autoplay: false,
        autoplaySpeed: 4, autoStopAtMedals: true, startScreen: 'splash', renderer: '2d', showSchool: true,
    };
}

export function parseResolverConfig(raw: unknown, defaults: ResolverConfig): ResolverConfig {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ResolverError('滚榜配置格式无效');
    const input = raw as Record<string, unknown>;
    const config = { ...defaults };
    const enums = { mode: ['board', 'official'], freezeMode: ['contest', 'custom'], startScreen: ['splash', 'scoreboard'], renderer: ['2d', '3d'] };
    for (const [key, allowed] of Object.entries(enums)) {
        if (input[key] === undefined) continue;
        if (!allowed.includes(input[key] as string)) throw new ResolverError(`${key} 无效`);
        Object.assign(config, { [key]: input[key] });
    }
    for (const key of ['rehearsal', 'medalSameScore', 'podiumEnabled', 'firstSolve', 'autoplay', 'autoStopAtMedals', 'showSchool'] as const) {
        if (input[key] === undefined) continue;
        if (typeof input[key] !== 'boolean') throw new ResolverError(`${key} 必须为布尔值`);
        config[key] = input[key];
    }
    const ranges = { goldCount: [0, 10000], silverCount: [0, 10000], bronzeCount: [0, 10000], rowsPerScreen: [4, 30], autoplaySpeed: [0.25, 16] };
    for (const [key, [min, max]] of Object.entries(ranges)) {
        const value = input[key];
        if (value === undefined) continue;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (key !== 'autoplaySpeed' && !Number.isInteger(value))) {
            throw new ResolverError(`${key} 应在 ${min} 至 ${max} 之间`);
        }
        Object.assign(config, { [key]: value });
    }
    for (const key of ['boardId', 'goldCitation', 'silverCitation', 'bronzeCitation'] as const) {
        if (input[key] === undefined) continue;
        if (typeof input[key] !== 'string' || !input[key].trim() || input[key].length > 80) throw new ResolverError(`${key} 无效`);
        config[key] = input[key].trim();
    }
    if (input.freezeAtSeconds !== undefined && input.freezeAtSeconds !== null) {
        if (typeof input.freezeAtSeconds !== 'number' || !Number.isSafeInteger(input.freezeAtSeconds) || input.freezeAtSeconds < 0) {
            throw new ResolverError('封榜点应为从比赛开始计算的非负整数秒');
        }
        config.freezeAtSeconds = input.freezeAtSeconds;
    }
    return config;
}

export function prepareResolver(
    data: BoardData, boards: ResolverBoard[], config: ResolverConfig,
    context: { contestId: string; ended: boolean; capturedAt: Date; logoNames: Record<string, string>; photos?: Record<string, string>; special?: SpecialResult[] },
): ResolverPayload {
    const board = boards.find((item) => item.id === config.boardId);
    if (!board) throw new ResolverError('所选分榜已不存在，请刷新配置页');
    // Shared rules are authoritative, including for stale pages and direct API callers. A ratio counts the
    // board's official teams with an accepted run in the final results, which the resolver reveals.
    config = { ...config, ...resolverAwardConfig(board.awards, board.pool ?? board.eligible) };
    if (config.mode === 'official' && config.boardId === 'all') throw new ResolverError('请选择一个分榜作为正式参赛范围');
    const durationMs = (data.contest.end_time - data.contest.start_time) * 1000;
    if (!(durationMs > 0)) throw new ResolverError('比赛时间无效');
    const freezeAtSeconds = config.freezeMode === 'custom' ? config.freezeAtSeconds
        : Number(data.contest.frozen_time) > 0 ? durationMs / 1000 - Number(data.contest.frozen_time) : null;
    if (freezeAtSeconds === null) throw new ResolverError('比赛未设置封榜时间，请指定本次滚榜的封榜点');
    if (freezeAtSeconds < 0 || freezeAtSeconds * 1000 >= durationMs) throw new ResolverError('封榜点须在比赛开始至结束之前');
    const members = new Set(board.teamIds);
    const teams = data.teams.filter((team) => config.mode === 'official' || members.has(team.team_id)).map((team) => {
        const logoKey = (team.organization || '').normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');
        const logoId = context.logoNames[logoKey];
        const school = (team.organization || '').trim();
        const unrank = team.group.includes('unofficial') || (config.mode === 'official' && !members.has(team.team_id));
        return {
            id: team.team_id, name: team.name, displayName: config.showSchool && school ? `${team.name}（${school}）` : team.name,
            photo: context.photos?.[team.team_id], organizationName: school, unrank, ...team.school_key ? { schoolKey: team.school_key } : {},
            ...team.members?.length ? { members: team.members } : {},
            logo: logoId && /^[a-f\d]{12}$/.test(logoId) ? `${resolverAssetBase}/logos/${logoId}.webp` : `${resolverAssetBase}/assets/img/icpc-logo.png`,
        };
    });
    if (!teams.length) throw new ResolverError('所选榜单没有参赛成员');
    const selectedIds = new Set(teams.map((team) => team.id));
    const problems = Array.from({ length: data.contest.problem_quantity }, (_, index) => ({
        id: String(index), label: (data.contest.problem_id as string[])[index],
        color: (data.contest.balloon_color as { background_color: string }[])[index].background_color,
    }));
    const journal = new Map(data.submissions.map((record) => [record.submission_id, record]));
    const submissions = [...journal.values()].filter((record) => selectedIds.has(record.team_id)
        && record.timestamp >= 0 && record.timestamp < durationMs
        && Number.isInteger(record.problem_id) && record.problem_id >= 0 && record.problem_id < problems.length)
        .sort((a, b) => a.timestamp - b.timestamp || a.submission_id.localeCompare(b.submission_id))
        .map((record) => ({
            id: record.submission_id, teamId: record.team_id, problemId: String(record.problem_id), contestTime: record.timestamp,
            status: (record.status === 'CORRECT' ? 'solved' : pendingStatuses.has(record.status) ? 'pending' : 'failed') as 'solved' | 'pending' | 'failed',
            penalty: !exemptStatuses.has(record.status),
        }));
    const rehearsal = !context.ended || config.rehearsal;
    const unjudgedCount = submissions.filter((record) => record.status === 'pending').length;
    if (!rehearsal && unjudgedCount) throw new ResolverError(`还有 ${unjudgedCount} 条提交未完成评测，请等待评测完成或选择彩排`);
    const snapshot: ResolverContest = {
        contestId: context.contestId, name: data.contest.contest_name,
        startTime: new Date(data.contest.start_time * 1000).toISOString(), durationMs,
        freezeDurationMs: durationMs - freezeAtSeconds * 1000, scoringMode: 'hydro', tieBreak: board.awards.tieBreak ?? 'hydro', penaltyMinutes: 20,
        unofficialFirstSolve: board.awards.unofficialFirstSolve, firstSolveEnabled: config.firstSolve,
        // 特别奖 are presented with each winner, after the medals (ICPC Tools' honors awards).
        teams, problems, submissions, awards: (context.special || []).map((award) => ({
            id: `special-${award.id}`, citation: award.name, teamIds: award.teamIds.filter((id) => selectedIds.has(id)), displayMode: 'detail', awardType: 'honors',
        })).filter((award) => award.teamIds.length),
    };
    const effectiveConfig = { ...config, rehearsal };
    const game = buildGame(snapshot, {
        ...effectiveConfig, freezeMode: 'feed', medalMode: 'custom', showAwards: true,
        firstSolveMode: config.firstSolve ? 'all' : 'imported', firstSolveIncludeUnrank: board.awards.unofficialFirstSolve,
    });
    return {
        snapshot, config: effectiveConfig, game,
        overview: {
            title: snapshot.name, teamCount: teams.length, officialCount: teams.filter((team) => !team.unrank).length,
            problemCount: problems.length, pendingCount: game.meta.pendingCount, unjudgedCount,
            freezeAtSeconds, durationSeconds: durationMs / 1000, capturedAt: context.capturedAt.toISOString(),
            ended: context.ended, rehearsal,
        },
    };
}
