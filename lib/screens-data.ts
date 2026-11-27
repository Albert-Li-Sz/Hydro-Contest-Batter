// Big-screen data for the ICPC Tools presentation ports bundled from Resolver-Web v1.4.0.
// The projection below follows Resolver-Web server/platform/model.js publicContest() and
// presentationStats() (Apache-2.0 / ICPC Software License, see licenses/), adapted to read the
// plugin's already freeze-masked public board instead of a CCS event feed.
import type { BoardData } from './board';
import { resolverAssetBase } from './resolver-data';
import { computeCells, normalizeContest } from '../resolver/server/lib/engine.js';
import { memoryLimitMb, timeLimitMs } from './ccs/source';

export const screenTypes = [
    'scoreboard', 'leaders', 'tiles', 'first-solves', 'queue', 'clock', 'countdown', 'message', 'resolver',
    'problem-stats', 'rank-trend', 'outcomes', 'groups', 'logo-wall', 'team-intro', 'problem-colors', 'reactions',
    'floor', 'balloons', 'announce', 'judges', 'poster', 'clarifications', 'problem-list',
] as const;
export type ScreenType = typeof screenTypes[number];
export const screenCategories: [string, ScreenType[]][] = [
    ['常用', ['scoreboard', 'leaders', 'tiles', 'first-solves', 'queue', 'clock', 'countdown', 'message', 'resolver']],
    ['统计图表', ['problem-stats', 'rank-trend', 'outcomes']],
    ['榜单与展示', ['groups', 'logo-wall', 'team-intro', 'problem-colors', 'reactions']],
    ['场馆与现场', ['floor', 'balloons', 'announce', 'judges']],
    ['信息与编排', ['poster', 'clarifications', 'problem-list']],
];
/** Screens drawn from one board's teams: the board can be chosen. */
export const standingsTypes = new Set<ScreenType>([
    'scoreboard', 'leaders', 'tiles', 'first-solves', 'queue', 'problem-stats', 'rank-trend', 'outcomes', 'groups', 'logo-wall', 'team-intro',
    'floor', 'balloons', 'announce', 'reactions',
]);
/** A device's zoom enlarges these: DOM screens through the font unit, the resolver and the ICPC scoreboard family through fewer rows. */
export const scalableTypes = new Set<ScreenType>([
    'scoreboard', 'leaders', 'first-solves', 'resolver', 'rank-trend', 'outcomes', 'groups', 'team-intro', 'floor', 'balloons',
    'announce', 'judges', 'reactions', 'poster', 'clarifications', 'problem-list',
]);
/** Like the public board, these show nothing before the contest starts. */
export const hiddenBeforeStart = new Set<ScreenType>([
    'scoreboard', 'leaders', 'tiles', 'first-solves', 'queue', 'problem-stats', 'rank-trend', 'outcomes', 'groups', 'floor', 'balloons', 'announce', 'problem-list', 'problem-colors', 'reactions',
]);
export const intervalTypes = new Set<ScreenType>(['groups', 'team-intro', 'poster', 'clarifications', 'announce', 'reactions']);

export interface ScreenItem {
    layoutId?: string;
    boardId: string;
    variant: string;
    target: 'end' | 'start' | 'custom';
    targetTime: string | null;
    text: string;
    sessionId: string;
    /** 分组排行: groups are the boards or the schools. */
    source: string;
    /** Seconds per picture (poster) or per team (team intro). */
    interval: number;
    /** Uploaded pictures (poster), by media id. */
    images: string[];
}
export interface ScreenConfig {
    locale: 'zh-CN' | 'en';
    items: Record<ScreenType, ScreenItem>;
}

export const screenLabels: Record<ScreenType, string> = {
    reactions: '反应视频轮播', scoreboard: '实时榜单', leaders: '领先队伍榜', tiles: '方块榜', 'first-solves': '首解列表', queue: '判题队列',
    clock: '比赛时钟', countdown: '倒计时', message: '文字公告', resolver: '滚榜观众画面',
    'problem-stats': '题目通过统计', 'rank-trend': '排名走势图', outcomes: '评测结果分布', groups: '分组排行轮播',
    'logo-wall': '学校 Logo 墙', 'team-intro': '队伍巡礼', 'problem-colors': '题目与气球颜色', floor: '赛场平面图',
    balloons: '气球配送图', announce: '通过播报', judges: '评测机状态', poster: '图片海报', clarifications: '比赛公告滚动', 'problem-list': '题目列表',
};
export const screenVariants: Partial<Record<ScreenType, [string, string][]>> = {
    resolver: [['', '跟随会话'], ['2d', '原版 2D'], ['3d', '三维 3D']],
    tiles: [['standings', '实时方块榜（Tiles）'], ['rank', '按通过数分组（Tile rank）'], ['list', '按队名排列（Tile list）']],
    queue: [['queue', '判题队列（Judge queue）'], ['teams', '队伍判题（Team judgements）']],
    countdown: [['digital', '数字倒计时'], ['polar', '环形倒计时']],
    'problem-stats': [['chart', '柱状图：各题提交与通过'], ['summary', '题目卡片（ICPC Tools）']],
    outcomes: [['time', '按比赛时间'], ['problem', '按题目']],
    groups: [['group', '逐组轮播（每组前几名）'], ['all', '各组领先一览']],
    'logo-wall': [['wall', 'Logo 墙'], ['fade', '逐个淡入'], ['slide', '横向滚动']],
    floor: [['status', '过题数与最新结果'], ['problems', '各题通过情况']],
    reactions: [['first', '只播一血'], ['accepted', '所有通过']],
    announce: [['all', '播报所有通过'], ['first', '只播报一血']],
};
/** 分组排行 groups. */
export const groupSources: [string, string][] = [['boards', '按分榜分组'], ['schools', '按学校分组']];

/** The ICPC Tools presentation each screen is drawn with: [item type, variant]; screens not listed draw their own. */
const portItems: Partial<Record<ScreenType, (variant: string) => [string, string]>> = {
    'problem-stats': (variant) => (variant === 'summary' ? ['problems', 'summary'] : ['chart', 'problems']),
    'logo-wall': (variant) => ['logo-wall', variant || 'wall'],
    'problem-colors': () => ['problems', 'colors'],
};

export class ScreenError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}

export const maxPosterImages = 20;
export const maxPosterBytes = 2 * 1024 * 1024;
export const isPosterId = (value: unknown): value is string => typeof value === 'string' && /^[a-f\d]{24}$/.test(value);

export const imageBytes = (data: Buffer) => data instanceof Uint8Array ? Buffer.from(data)
    : Buffer.from((data as unknown as { value(): Uint8Array }).value());

export function decodePoster(encoded: string, maxBytes = maxPosterBytes) {
    if (typeof encoded !== 'string') throw new ScreenError('图片内容无效');
    if (encoded.length > 4 * Math.ceil(maxBytes / 3)) throw new ScreenError(`图片不能超过 ${maxBytes / 1024 ** 2} MiB`);
    if (!/^[A-Za-z\d+/]+={0,2}$/.test(encoded)) throw new ScreenError('图片内容无效');
    const data = Buffer.from(encoded, 'base64');
    if (data.length > maxBytes) throw new ScreenError(`图片不能超过 ${maxBytes / 1024 ** 2} MiB`);
    if (data.length >= 24 && data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return { data, mime: 'image/png' };
    if (data.length >= 8 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return { data, mime: 'image/jpeg' };
    if (data.length >= 16 && data.toString('ascii', 0, 4) === 'RIFF' && data.toString('ascii', 8, 12) === 'WEBP') return { data, mime: 'image/webp' };
    throw new ScreenError('请选择 PNG、JPEG 或 WebP 图片');
}

const blankItem = (): ScreenItem => ({ boardId: 'all', variant: '', target: 'end', targetTime: null, text: '', sessionId: '', source: 'boards', interval: 10, images: [] });
export function defaultScreenConfig(): ScreenConfig {
    const items = Object.fromEntries(screenTypes.map((type) => [type, {
        ...blankItem(), variant: screenVariants[type]?.[0][0] || '',
    }])) as Record<ScreenType, ScreenItem>;
    items.message.text = '比赛进行中';
    items['team-intro'].interval = 6;
    return { locale: 'zh-CN', items };
}

/** Validate an administrator's saved configuration; unknown fields are dropped. */
export function normalizeScreenConfig(raw: unknown, base = defaultScreenConfig()): ScreenConfig {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ScreenError('大屏配置格式无效');
    const input = raw as Record<string, any>;
    const config = structuredClone(base);
    if (input.locale !== undefined) {
        if (!['zh-CN', 'en'].includes(input.locale)) throw new ScreenError('大屏语言无效');
        config.locale = input.locale;
    }
    for (const type of screenTypes) {
        const item = input.items?.[type];
        if (item === undefined) continue;
        if (!item || typeof item !== 'object' || Array.isArray(item)) throw new ScreenError(`${screenLabels[type]}配置无效`);
        const next = config.items[type];
        if (type === 'reactions' && item.layoutId !== undefined) {
            if (typeof item.layoutId !== 'string' || !/^[\w-]{0,80}$/.test(item.layoutId)) throw new ScreenError('版式编号无效');
            next.layoutId = item.layoutId;
        }
        if (item.boardId !== undefined) {
            if (typeof item.boardId !== 'string' || !/^[\w-]{1,80}$/.test(item.boardId)) throw new ScreenError(`${screenLabels[type]}的分榜无效`);
            next.boardId = item.boardId;
        }
        if (item.variant !== undefined) {
            const allowed = screenVariants[type]?.map(([value]) => value) || [''];
            if (!allowed.includes(item.variant)) throw new ScreenError(`${screenLabels[type]}的样式无效`);
            next.variant = item.variant;
        }
        if (item.target !== undefined) {
            if (!['end', 'start', 'custom'].includes(item.target)) throw new ScreenError('倒计时目标无效');
            next.target = item.target;
        }
        if (item.targetTime !== undefined) {
            if (item.targetTime !== null && (typeof item.targetTime !== 'string' || !Number.isFinite(Date.parse(item.targetTime)))) {
                throw new ScreenError('倒计时目标时间无效');
            }
            next.targetTime = item.targetTime === null ? null : new Date(item.targetTime).toISOString();
        }
        if (item.text !== undefined) {
            if (typeof item.text !== 'string' || item.text.length > 2000) throw new ScreenError('公告文字最多 2000 字');
            next.text = item.text;
        }
        if (item.source !== undefined) {
            if (!groupSources.some(([value]) => value === item.source)) throw new ScreenError('分组方式无效');
            next.source = item.source;
        }
        if (item.interval !== undefined) {
            const seconds = Number(item.interval);
            if (!Number.isFinite(seconds) || seconds < 2 || seconds > 600) throw new ScreenError(`${screenLabels[type]}的切换间隔需为 2 至 600 秒`);
            next.interval = Math.round(seconds);
        }
        if (item.images !== undefined) {
            if (!Array.isArray(item.images) || item.images.length > maxPosterImages || !item.images.every(isPosterId)) {
                throw new ScreenError('图片列表无效（最多 20 张）');
            }
            next.images = [...new Set(item.images as string[])];
        }
        if (item.sessionId !== undefined) {
            if (typeof item.sessionId !== 'string' || !/^([a-f\d-]{36})?$/.test(item.sessionId)) throw new ScreenError('滚榜会话无效');
            next.sessionId = item.sessionId;
        }
    }
    if (config.items.countdown.target === 'custom' && !config.items.countdown.targetTime) throw new ScreenError('请填写倒计时的目标时间');
    return config;
}

/** Settings saves preserve images, which are managed by the upload and delete operations. */
export function saveScreenConfig(input: unknown, base: ScreenConfig) {
    const config = normalizeScreenConfig(input, base);
    config.items.poster.images = base.items.poster.images;
    return config;
}

const exemptStatuses = new Set(['CORRECT', 'COMPILATION_ERROR', 'PRESENTATION_ERROR', 'CANCELED']);

export interface ScreenReaction {
    url: string; teamUid: string | number; team: string; problem: string;
    layoutId: string; firstSolve: boolean; accepted: boolean;
}

export function eligibleScreenReaction(video: Pick<ScreenReaction, 'accepted' | 'firstSolve' | 'teamUid'>, item: ScreenItem, teamIds: Set<string> | null) {
    return (item.variant === 'first' ? video.firstSolve : video.accepted) && (!teamIds || teamIds.has(String(video.teamUid)));
}

/** Staff replay URLs never enter an audience screen. */
export function reactionPlaylist(videos: ScreenReaction[], item: ScreenItem, teamIds: Set<string> | null) {
    return videos.filter(v => (!item.layoutId || v.layoutId === item.layoutId) && eligibleScreenReaction(v, item, teamIds))
        .map(({ url, team, problem }) => ({ url, team, problem }));
}

/** The program item handed to PresentationView.render(). */
export function presentationItem(type: ScreenType, item: ScreenItem, data: BoardData) {
    const port = portItems[type];
    if (port) {
        const [portType, variant] = port(item.variant);
        return { type: portType, variant };
    }
    const result: Record<string, unknown> = { type };
    if (item.variant) result.variant = item.variant;
    if (intervalTypes.has(type)) result.interval = item.interval;
    if (type === 'message') result.text = item.text;
    if (type === 'countdown') {
        const start = data.contest.start_time * 1000;
        const end = data.contest.end_time * 1000;
        result.targetTime = item.target === 'start' ? start : item.target === 'end' ? end : Date.parse(item.targetTime || '') || end;
    }
    return result;
}

/** Public, freeze-masked board → the `data` object of Resolver-Web's presentation state. */
export function screenData(data: BoardData, members: Set<string> | null, context: {
    logoNames: Record<string, string>; locked: boolean;
    /** The board's first-solve rules (awardsFor), so screens highlight exactly what the board does. */
    firstSolve: boolean; unofficialFirstSolve: boolean;
    /** The contest's ranking rule (lib/settings.ts TieBreak). */
    tieBreak?: 'hydro' | 'icpc' | 'ccpc';
    /** 分组排行: the groups (boards, or schools when omitted) teams belong to. */
    groups?: { id: string; name: string; teamIds: string[] }[] | null;
    /** Seats onsite-toolkit imported, by team id. */
    seats?: Map<string, string>;
    trend?: boolean;
}) {
    const durationMs = (data.contest.end_time - data.contest.start_time) * 1000;
    const freezeMs = Number(data.contest.frozen_time) > 0 ? Number(data.contest.frozen_time) * 1000 : 0;
    // CCPC 新榜单模式 (lib/ccpc-board.ts): from `hiddenFrom` on, a column is a position in each team's row, not a
    // problem, so it has no first solve (lib/award-policy.mjs) and no per-problem statistics.
    const { hiddenFrom } = data;
    const hidden = (index: number) => hiddenFrom !== undefined && index >= hiddenFrom;
    const teams = data.teams.filter((team) => !members || members.has(team.team_id)).map((team) => {
        const school = (team.organization || '').trim();
        const logoId = context.logoNames[school.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ')];
        return {
            id: team.team_id, name: team.name, displayName: team.name, organizationName: school,
            unrank: team.group.includes('unofficial'),
            logo: logoId && /^[a-f\d]{12}$/.test(logoId) ? `${resolverAssetBase}/logos/${logoId}.webp` : `${resolverAssetBase}/assets/img/icpc-logo.png`,
            hasLogo: !!logoId && /^[a-f\d]{12}$/.test(logoId),
            ...school ? { organizationId: `org:${school}` } : {},
            ...team.members?.length ? { members: team.members } : {},
            seat: context.seats?.get(team.team_id) || '',
        };
    });
    // Schools for the logo wall, the order they first appear on the board.
    const organizations = [...new Map(teams.filter((team) => team.organizationId).map((team) => [team.organizationId!, {
        id: team.organizationId!, name: team.organizationName, formalName: team.organizationName, logo: team.hasLogo ? team.logo : null,
    }])).values()];
    const ids = new Set(teams.map((team) => team.id));
    const memberships = new Map<string, string[]>();
    const groups = context.groups
        ? context.groups.flatMap(({ id, name, teamIds }) => {
            const groupId = `group:${id}`;
            const members = teamIds.filter((teamId) => ids.has(teamId));
            for (const teamId of members) {
                if (!memberships.has(teamId)) memberships.set(teamId, []);
                memberships.get(teamId)!.push(groupId);
            }
            return members.length ? [{ id: groupId, name }] : [];
        })
        : organizations.map((org) => ({ id: org.id, name: org.name }));
    const inputTeams = teams.map(({ seat: _seat, hasLogo: _hasLogo, ...team }) => ({
        ...team,
        groupIds: context.groups
            ? memberships.get(team.id) || []
            : team.organizationId ? [team.organizationId] : [],
    }));
    const seats = Object.fromEntries(teams.filter((team) => team.seat).map((team) => [team.id, team.seat]));
    const problems = Array.from({ length: data.contest.problem_quantity }, (_, index) => ({
        id: String(index), label: (data.contest.problem_id as string[])[index],
        color: (data.contest.balloon_color as { background_color: string }[])[index]?.background_color,
    }));
    const frozen = freezeMs > 0 && context.locked;
    const visible = [...new Map(data.submissions.map((record) => [record.submission_id, record])).values()]
        .filter((record) => ids.has(record.team_id) && record.timestamp >= 0 && record.timestamp < durationMs
            && Number.isInteger(record.problem_id) && record.problem_id >= 0 && record.problem_id < problems.length)
        .sort((a, b) => a.timestamp - b.timestamp || a.submission_id.localeCompare(b.submission_id))
        .map((record) => frozen && record.timestamp > durationMs - freezeMs ? { ...record, status: 'FROZEN' } : record);
    const submissions = visible.map((record) => {
            // The board already shows post-freeze results as FROZEN; they stay pending here.
            const pending = record.status === 'PENDING' || record.status === 'FROZEN';
            return {
                id: record.submission_id, teamId: record.team_id, problemId: String(record.problem_id), contestTime: record.timestamp,
                status: record.status === 'CORRECT' ? 'solved' : pending ? 'pending' : 'failed',
                penalty: !pending && !exemptStatuses.has(record.status),
            };
        });
    const c = normalizeContest({
        name: data.contest.contest_name, startTime: new Date(data.contest.start_time * 1000).toISOString(),
        durationMs, freezeDurationMs: freezeMs, scoringMode: 'hydro', tieBreak: context.tieBreak ?? 'hydro', penaltyMinutes: 20,
        firstSolveEnabled: context.firstSolve, unofficialFirstSolve: context.unofficialFirstSolve,
        teams: inputTeams, organizations, groups, problems, submissions, awards: [],
    });
    c.awards = [];
    const result = computeCells(c as never, { frozen }) as ReturnType<typeof computeCells> & { results: Record<string, any[]> };
    const results = Object.fromEntries(Object.entries(result.results).map(([id, rows]) => [id, rows.map((row: any, index: number) => ({
        status: row.status, attempts: row.attempts, time: row.time, timeSeconds: row.timeSeconds,
        penaltyCount: row.penaltyCount ?? row._penaltyCount, pending: row.pending, firstToSolve: row.firstToSolve && !hidden(index),
    }))]));
    // The first-solves list follows the board's eligibility: starred participants only when allowed.
    // It lists the earliest eligible accepts even when the first-solve award itself is switched off.
    const unranked = new Set(teams.filter((team) => team.unrank).map((team) => team.id));
    const firstSolves: { id: string; teamId: string; problemId: string; contestTime: number; sourceOrder: number | undefined }[] = [];
    const sourceOrder = new Map((c.submissions as any[]).map((s, i) => [s.id, i]));
    const solved = new Set<string>();
    for (const submission of [...c.submissions as any[]].sort((a, b) => a.contestTime - b.contestTime)) {
        if ((unranked.has(submission.teamId) && !context.unofficialFirstSolve) || hidden(Number(submission.problemId))) continue;
        if (submission.status === 'solved' && !solved.has(submission.problemId)) {
            solved.add(submission.problemId);
            firstSolves.push({ ...submission, sourceOrder: sourceOrder.get(submission.id) });
        }
    }
    const teamIndex = new Map((c.teams as any[]).map((t, i) => [t.id, i]));
    const problemIndex = new Map((c.problems as any[]).map((p, i) => [p.id, i]));
    const stats: number[] = [];
    let lastEventMs = 0;
    for (const s of c.submissions as any[]) {
        const t = teamIndex.get(s.teamId), p = problemIndex.get(s.problemId);
        if (t === undefined || p === undefined) continue;
        const code = s.status === 'solved' ? 0 : s.status === 'failed' ? (s.penalty === false ? 3 : 1) : 2;
        stats.push(t, p, s.contestTime, code, -1, -1, -1);
        lastEventMs = Math.max(lastEventMs, s.contestTime);
    }
    const trend = context.trend ? rankTrend(c, result.standings, lastEventMs, frozen) : undefined;
    c.submissions = (c.submissions as any[]).slice(-100);
    return {
        outcomes: visible, seats, trend, hiddenFrom,
        // Unranked (打星) rows carry rank 0; show them with a star as the resolver does, not as "0".
        contest: c, results, standings: result.standings.map((row) => (row.unrank ? { ...row, rank: '*' } : row)), firstSolves, frozen,
        stats: { submissions: stats, lastEventMs },
        clock: { startTime: c.startTime, started: c.startTime, ended: null, multiplier: 1, countdownPauseTime: null },
    };
}

/** Sample the same Hydro scoring engine as the live board, with a bounded number of recomputations. */
function rankTrend(contest: ReturnType<typeof normalizeContest>, standings: ReturnType<typeof computeCells>['standings'], lastEventMs: number, frozen: boolean) {
    const leaders = standings.filter((row) => !row.unrank && row.solved > 0).slice(0, 5);
    if (!leaders.length || lastEventMs <= 0) return { times: [], teams: [], maxRank: 0 };
    const fiveMinutes = 300_000;
    const step = Math.max(1, Math.ceil(lastEventMs / (fiveMinutes * 15))) * fiveMinutes;
    const times = Array.from({ length: Math.ceil(lastEventMs / step) }, (_, i) => i * step).concat(lastEventMs);
    const history = times.slice(0, -1).map((time) => computeCells({
        ...contest, submissions: contest.submissions.filter((row: { contestTime: number }) => row.contestTime <= time),
    } as Parameters<typeof computeCells>[0], { frozen }).standings).concat([standings]);
    const teams = leaders.map(({ teamId }) => ({
        name: contest.teams.find((team: { id: string }) => team.id === teamId)?.name || teamId,
        ranks: history.map((rows) => Number(rows.find((row) => row.teamId === teamId)?.rank || 0)),
    }));
    return { times, teams, maxRank: Math.max(1, ...teams.flatMap((team) => team.ranks)) };
}

// ---------------------------------------------------------------- Data of the screens drawn by the plugin

/** 评测机状态 for a public screen: names, state and load, never accounts or addresses. */
export function judgeScreen(health: { alerts: { level: string; text: string }[]; machines: {
    name: string; kind: string; state: string; online: boolean; reportOnly: boolean; activeCount: number; concurrency: number | null;
    judged5: number; systemErrors15: number; metrics: { cpu: number | null; memoryRate: number | null; temperature: number | null; live?: boolean } | null;
}[] }, queueLength: number) {
    return {
        queueLength,
        alerts: health.alerts.length,
        machines: health.machines.map((machine, index) => ({
            number: index + 1, builtin: machine.kind === 'builtin', state: machine.reportOnly ? 'offline' : machine.state, online: machine.online,
            active: machine.activeCount, concurrency: machine.concurrency, judged5: machine.judged5, systemErrors15: machine.systemErrors15,
            cpu: machine.metrics?.cpu ?? null, memory: machine.metrics?.memoryRate ?? null, temperature: machine.metrics?.temperature ?? null,
        })),
    };
}

/** 比赛公告: what the jury broadcast to everyone (Hydro clarifications from no participant), newest first. */
export function broadcastRows(docs: { owner: number; content?: string; subject?: number; docId: { getTimestamp: () => Date } }[], pids: number[], labels: string[], limit = 20) {
    return docs.filter((doc) => doc.owner === 0 && doc.content).slice(0, limit).map((doc) => {
        const index = typeof doc.subject === 'number' ? pids.indexOf(doc.subject) : -1;
        return {
            text: String(doc.content).slice(0, 2000), at: doc.docId.getTimestamp().getTime(),
            subject: index >= 0 ? labels[index] : doc.subject === -1 ? '技术' : '',
        };
    });
}

/** 题目列表: labels, titles, colours and limits as Hydro's parsed problem config gives them. */
export function problemRows(pids: number[], pdocs: Record<number, { title?: string; config?: unknown } | null | undefined>, colors: string[], labels: string[]) {
    return pids.map((pid, index) => {
        const pdoc = pdocs[pid];
        const config = pdoc && typeof pdoc.config === 'object' && pdoc.config ? pdoc.config as { timeMax?: number; memoryMax?: number; type?: string } : null;
        return {
            label: labels[index], title: pdoc?.title || `#${pid}`, color: colors[index] || '',
            timeMs: timeLimitMs(config?.timeMax), memoryMb: memoryLimitMb(config?.memoryMax),
            type: config?.type && config.type !== 'default' ? config.type : '',
        };
    });
}

type ScreenProjection = ReturnType<typeof screenData>;
type Balloon = { teamId: string; problemId: string; submissionId: string };

/** Only the fields required by the selected view go to a token holder. */
export function screenProjection(type: ScreenType, item: ScreenItem, data: ScreenProjection, pendingBalloons: Balloon[] = []) {
    const { contest, standings, results, outcomes, seats, trend, ...common } = data;
    const { hiddenFrom } = common;
    if (type === 'rank-trend') return trend;
    // CCPC 新榜单模式: only the labelled columns are problems every team shares.
    const shown = hiddenFrom ?? contest.problems.length;
    if (hiddenFrom === 0 && (type === 'problem-stats' || (type === 'outcomes' && item.variant === 'problem'))) {
        throw new ScreenError('题号公开前不显示各题统计');
    }
    if (type === 'problem-stats' && hiddenFrom !== undefined) {
        const flat = common.stats.submissions;
        const kept: number[] = [];
        for (let i = 0; i + 6 < flat.length; i += 7) if (flat[i + 1] < shown) kept.push(...flat.slice(i, i + 7));
        return {
            ...common, stats: { ...common.stats, submissions: kept }, standings,
            contest: { ...contest, problems: contest.problems.slice(0, shown),
                submissions: (contest.submissions as { problemId: string }[]).filter((row) => Number(row.problemId) < shown) },
            results: Object.fromEntries(Object.entries(results).map(([id, cells]) => [id, cells.slice(0, shown)])),
        };
    }
    if (type === 'outcomes') {
        const stepMinutes = Math.max(15, Math.ceil(contest.durationMs / (60_000 * 16 * 15)) * 15);
        const byProblem = item.variant === 'problem';
        const buckets = new Map<number, Record<string, number>>();
        for (const record of outcomes) {
            if (byProblem && record.problem_id >= shown) continue;
            const index = byProblem ? record.problem_id : Math.floor(record.timestamp / (stepMinutes * 60_000));
            const status = record.status === 'FROZEN' ? 'PENDING' : record.status;
            const counts = buckets.get(index) || {};
            counts[status] = (counts[status] || 0) + 1;
            buckets.set(index, counts);
        }
        const length = byProblem ? shown : Math.max(-1, ...buckets.keys()) + 1;
        return Array.from({ length }, (_, index) => ({
            label: byProblem ? contest.problems[index].label : `${index * stepMinutes}–${Math.min((index + 1) * stepMinutes, Math.ceil(contest.durationMs / 60_000))} min`,
            counts: buckets.get(index) || {},
        }));
    }
    const teams = new Map<string, { id: string; displayName: string; organizationName: string; logo: string | null; members?: string[]; groupIds?: string[] }>(
        contest.teams.map((team: any) => [team.id, team]),
    );
    if (type === 'groups') {
        const groups = new Map<string, typeof standings>();
        for (const row of standings) for (const id of teams.get(row.teamId)?.groupIds || []) {
            if (!groups.has(id)) groups.set(id, []);
            groups.get(id)!.push(row);
        }
        // Resolver-Web leaves `groups` out when there are none (a contest without boards to group by).
        return (contest.groups || []).map(({ id, name }: { id: string; name: string }) => {
            let position = 0, rank = 0, previous: number | string = 0;
            const rows = (groups.get(id) || []).slice(0, 10).map((row) => {
                if (!row.unrank) {
                    position++;
                    if (row.rank !== previous) rank = position;
                    previous = row.rank;
                }
                const team = teams.get(row.teamId);
                return { name: team?.displayName, logo: team?.logo, rank: row.unrank ? '*' : rank, solved: row.solved, timeSeconds: row.timeSeconds,
                    cells: (results[row.teamId] || []).map((cell, index) => ({ label: contest.problems[index].label,
                        status: cell.status, attempts: cell.attempts, time: cell.time, first: cell.firstToSolve })) };
            });
            return { id, name, rows };
        });
    }
    if (type === 'team-intro') return [...teams.values()].map(({ displayName, organizationName, logo, members }) => ({ displayName, organizationName, logo, members }));
    // The resolver engine keeps a problem's balloon colour as `rgb`.
    const problems = contest.problems.map(({ id, label, rgb, color }: { id: string; label: string; rgb?: string | null; color?: string | null }) => (
        { id, label, color: rgb ?? color ?? '' }));
    if (type === 'floor') {
        const latest = new Map(outcomes.map((row) => [row.team_id, row.status === 'FROZEN' ? 'PENDING' : row.status]));
        return { problems, seats: standings.filter((row) => seats[row.teamId]).map((row) => ({
            seat: seats[row.teamId], name: teams.get(row.teamId)?.displayName, solved: row.solved, latest: latest.get(row.teamId),
            cells: (results[row.teamId] || []).map((cell) => cell.status),
        })) };
    }
    if (type === 'balloons') {
        const accepted = new Set(outcomes.filter((row) => row.status === 'CORRECT').map((row) => row.submission_id));
        const delivery = new Map<string, string[]>();
        for (const balloon of pendingBalloons) {
            if (!teams.has(balloon.teamId) || !accepted.has(balloon.submissionId)) continue;
            if (!delivery.has(balloon.teamId)) delivery.set(balloon.teamId, []);
            delivery.get(balloon.teamId)!.push(balloon.problemId);
        }
        return { problems, seats: [...teams.values()].map((team) => ({
            seat: seats[team.id] || '', name: team.displayName, balloons: delivery.get(team.id) || [],
        })).filter((team) => team.seat || team.balloons.length) };
    }
    if (type === 'announce') {
        const first = new Set(common.firstSolves.map((row) => row.id));
        const seen = new Set<string>();
        return outcomes.flatMap((row) => {
            const key = `${row.team_id}:${row.problem_id}`;
            if (row.status !== 'CORRECT' || seen.has(key)) return [];
            seen.add(key);
            if (item.variant === 'first' && !first.has(row.submission_id)) return [];
            // An accept in an unlabelled column is announced without a problem, as the board shows it.
            return [{ id: row.submission_id, name: teams.get(row.team_id)?.displayName, time: row.timestamp,
                problem: row.problem_id < shown ? problems[row.problem_id] : null, first: first.has(row.submission_id) }];
        }).slice(-20).reverse();
    }
    return { ...common, contest, standings, results };
}
