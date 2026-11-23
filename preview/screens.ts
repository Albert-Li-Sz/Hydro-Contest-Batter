import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Environment } from 'nunjucks';
import type { Context } from 'hydrooj';
import type { BoardData } from '../lib/board';
import type { BoardSettings } from '../lib/settings';
import { awardsFor, toScriptJson } from '../lib/settings';
import { resolverBoards, resolverCodeBase } from '../lib/resolver-data';
import { ResolverSessions } from '../lib/resolver-sessions';
import {
    decodePoster, defaultScreenConfig, groupSources, hiddenBeforeStart, intervalTypes, maxPosterImages, presentationItem,
    saveScreenConfig, screenCategories, screenData, ScreenError, screenLabels, screenProjection, ScreenType, screenTypes, screenVariants, standingsTypes,
} from '../lib/screens-data';

/** Local preview of the big-screen pages. Mirrors lib/screens-routes.ts without Hydro or MongoDB. */
export function createScreensPreview(env: Environment, logoNames: Record<string, string>, version: string, db: Context['db'],
    announcements: () => { subject: number; text: string; at: number }[] = () => []) {
    const codeBase = resolverCodeBase(version);
    const sessions = new ResolverSessions(db);
    const base = '/contest/demo';
    let config = defaultScreenConfig();
    let token = 'preview0000000000000000000000000000000000000000';
    const images = new Map<string, ReturnType<typeof decodePoster>>();
    return async (request: IncomingMessage, response: ServerResponse, url: URL, data: BoardData, settings: BoardSettings) => {
        const json = (value: unknown, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
        const boards = resolverBoards(data, settings, settings.showIdentity);
        try {
            if (url.pathname === `${base}/screens`) {
                if (request.method === 'POST') {
                    let text = '';
                    for await (const chunk of request) {
                        text += chunk;
                        if (text.length > 3_000_000) throw new ScreenError('请求内容过大');
                    }
                    const body = JSON.parse(text || '{}');
                    if (body.operation === 'reset_token') {
                        token = `preview${Date.now().toString(16).padStart(41, '0')}`;
                        json({ linkBase: `${base}/screen/${token}` });
                    } else if (body.operation === 'upload_poster') {
                        if (config.items.poster.images.length >= maxPosterImages) throw new ScreenError(`最多上传 ${maxPosterImages} 张图片`);
                        const id = randomBytes(12).toString('hex');
                        images.set(id, decodePoster(body.image));
                        config.items.poster.images.push(id);
                        json({ images: config.items.poster.images });
                    } else if (body.operation === 'remove_poster') {
                        config.items.poster.images = config.items.poster.images.filter((id) => id !== body.imageId);
                        images.delete(body.imageId);
                        json({ images: config.items.poster.images });
                    } else {
                        config = saveScreenConfig(JSON.parse(body.config), config);
                        json({ config });
                    }
                    return true;
                }
                const own = await sessions.list({ domainId: 'system', contestId: 'demo', ownerId: 1 });
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(env.render('xcpcio_screens.html', {
                    codeBase, tdoc: { title: data.contest.contest_name }, runtimeJson: toScriptJson({
                        base: `${base}/screens`, contestUrl: `${base}/scoreboard/xcpcio-plus`, linkBase: `${base}/screen/${token}`,
                        title: data.contest.contest_name, config, types: screenTypes, labels: screenLabels, variants: screenVariants, query: url.search,
                        categories: screenCategories, groupSources, intervalTypes: [...intervalTypes],
                        standingsTypes: [...standingsTypes], boards: boards.map(({ id, name }) => ({ id, name })),
                        sessions: own.map((row) => ({ id: row.id, createdAt: row.createdAt, title: row.overview.title,
                            board: boards.find((board) => board.id === row.config.boardId)?.name || row.config.boardId, rehearsal: row.config.rehearsal })),
                        contest: { start: new Date(data.contest.start_time * 1000).toISOString(), end: new Date(data.contest.end_time * 1000).toISOString() },
                    }),
                }));
                return true;
            }
            const match = /^\/contest\/demo\/screen\/([^/]+)\/([a-z-]+)(\/data|\/images\/([a-f\d]{24}))?$/.exec(url.pathname);
            if (!match) return false;
            if (match[1] !== token || !screenTypes.includes(match[2] as ScreenType)) throw new ScreenError('大屏链接无效或已作废', 404);
            const type = match[2] as ScreenType;
            if (match[4]) {
                const file = type === 'poster' && config.items.poster.images.includes(match[4]) ? images.get(match[4]) : undefined;
                if (!file) throw new ScreenError('图片不存在', 404);
                response.writeHead(200, { 'Content-Type': file.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }).end(file.data);
                return true;
            }
            if (!match[3]) {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(env.render('xcpcio_screen_view.html', {
                    codeBase, title: `${data.contest.contest_name} · ${screenLabels[type]}`,
                    runtimeJson: toScriptJson({ type, dataUrl: `${url.pathname}/data${url.search}` }),
                }));
                return true;
            }
            const item = config.items[type];
            const head = { type, locale: config.locale, serverTime: Date.now(), title: data.contest.contest_name };
            if (url.searchParams.get('phase') === 'upcoming' && hiddenBeforeStart.has(type)) {
                json({ ...head, notice: '比赛尚未开始' });
                return true;
            }
            if (type === 'resolver') {
                const session = item.sessionId ? await sessions.find('system', 'demo', item.sessionId) : null;
                if (!session) json({ ...head, notice: '等待滚榜开始' });
                else if (session.revision === Number(url.searchParams.get('revision')) && session._id === url.searchParams.get('session')) {
                    json({ ...head, session: session._id, playback: sessions.playback(session) });
                } else json({ ...head, session: session._id, ...await sessions.spectator(session) });
                return true;
            }
            const boardId = standingsTypes.has(type) ? item.boardId : 'all';
            const board = boards.find((candidate) => candidate.id === boardId);
            if (!board) { json({ ...head, notice: '所选分榜已不存在，请在大屏管理页重新选择' }); return true; }
            let payload: unknown;
            const problems = data.contest.problem_id as string[];
            if (type === 'poster') payload = item.images.map((id) => `${base}/screen/${token}/poster/images/${id}`);
            else if (type === 'clarifications') payload = announcements().map((item) => ({
                ...item, subject: item.subject === -1 ? '技术' : problems[item.subject - 101] || '',
            }));
            else if (type === 'problem-list') payload = problems.map((label, i) => ({ label, title: ['热身题', '星际旅行', '排列组合', '树上路径'][i % 4],
                color: (data.contest.balloon_color as { background_color: string }[])[i]?.background_color, timeMs: 2000, memoryMb: 256 }));
            else if (type === 'judges') payload = { queueLength: 3, alerts: 1, machines: [
                { number: 1, builtin: true, state: 'busy', online: true, active: 2, concurrency: 4, judged5: 15, systemErrors15: 0, cpu: 38, memory: 42, temperature: 52 },
                { number: 2, builtin: false, state: 'offline', online: false, active: 0, concurrency: 4, judged5: 0, systemErrors15: 1 },
            ] };
            else {
                const seats = new Map(data.teams.map((team, i) => [team.team_id, `${String.fromCharCode(65 + Math.floor(i / 8))}-${String(i % 8 + 1).padStart(2, '0')}`]));
                const locked = url.searchParams.get('phase') === 'frozen';
                const source = locked ? { ...data, contest: { ...data.contest, frozen_time: 4 * 3600 } } : data;
                const projection = screenData(source, boardId === 'all' ? null : new Set(board.teamIds), {
                    logoNames, locked, seats, trend: type === 'rank-trend',
                    groups: type === 'groups' && item.source === 'boards' ? boards.filter((group) => group.id !== 'all') : null,
                    firstSolve: awardsFor(settings, boardId).firstSolve, unofficialFirstSolve: awardsFor(settings, boardId).unofficialFirstSolve,
                });
                payload = screenProjection(type, item, projection, data.submissions.filter((row) => row.status === 'CORRECT').slice(-5)
                    .map((row) => ({ teamId: row.team_id, problemId: String(row.problem_id), submissionId: row.submission_id })));
            }
            json({ ...head, item: presentationItem(type, item, data), data: payload });
        } catch (error) {
            json({ error: error instanceof Error ? error.message : 'Invalid request' }, error instanceof ScreenError ? error.status : 400);
        }
        return true;
    };
}
