import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import type { Environment } from 'nunjucks';
import type { Context } from 'hydrooj';
import type { BoardData } from '../lib/board';
import type { BoardSettings } from '../lib/settings';
import { awardsFor, toScriptJson } from '../lib/settings';
import { resolverBoards, resolverCodeBase } from '../lib/resolver-data';
import { hideProblemLabels } from '../lib/ccpc-board';
import { ScreenDevices, screenClient, deviceItem, deviceState } from '../lib/screen-devices';
import type { ContestLinks } from '../lib/links';
import { ResolverSessions } from '../lib/resolver-sessions';
import {
    decodePoster, defaultScreenConfig, groupSources, hiddenBeforeStart, intervalTypes, maxPosterImages, presentationItem,
    eligibleScreenReaction, reactionPlaylist, saveScreenConfig, screenCategories, screenData, ScreenError, screenLabels, screenProjection, ScreenType, screenTypes, screenVariants, standingsTypes, scalableTypes,
} from '../lib/screens-data';

/** Local preview of the big-screen pages. Mirrors lib/screens-routes.ts without Hydro or MongoDB. */
export function createScreensPreview(env: Environment, logoNames: Record<string, string>, version: string, db: Context['db'],
    announcements: () => { subject: number; text: string; at: number }[] = () => [],
    publicVideos = (_layoutId?: string) => [] as {id:string;layoutId:string; teamUid:number; firstSolve:boolean; accepted:boolean; url:string; team:string; problem:string}[],
    reactionLayouts = () => [] as { id: string; name: string }[],
    links?: ContestLinks, playVideo?: (req: IncomingMessage, res: ServerResponse) => void) {
    const codeBase = resolverCodeBase(version);
    const sessions = new ResolverSessions(db);
    const base = '/contest/demo';
    let config = defaultScreenConfig();
    let token = 'preview0000000000000000000000000000000000000000';
    const devices = new ScreenDevices(db);
    const indexes = devices.ensureIndexes();
    const contestKey = 'system/demo';
    links?.add({ id: 'screens', label: '大屏', status: async () => ({ count: 1, issuedAt: null }),
        revoke: async () => { token = randomBytes(24).toString('hex'); return 1; } });
    links?.add({ id: 'screen-devices', label: '大屏设备', status: () => devices.status(contestKey), revoke: () => devices.revoke(contestKey) });
    const images = new Map<string, ReturnType<typeof decodePoster>>();
    return async (request: IncomingMessage, response: ServerResponse, url: URL, data: BoardData, settings: BoardSettings) => {
        if (!url.pathname.startsWith(base + '/screen') && !url.pathname.startsWith('/xcpcio-screen')) return false;
        await indexes;
        const cookie = /(?:^|;\s*)xcpcio_screen=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie || '')?.[1];
        const setCookie = (value: string) => response.setHeader('Set-Cookie', 'xcpcio_screen=' + value + '; Max-Age=31536000; Path=/xcpcio-screen; HttpOnly; SameSite=Lax');
        let commands: object | null = null;
        const json = (value: unknown, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(commands ? { ...value as object, ...commands } : value));
        const boards = resolverBoards(data, settings, settings.showIdentity);
        try {
            const site = '/xcpcio-screen';
            if (url.pathname === base + '/screens/devices') {
                if (request.method === 'POST') {
                    let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 8000) throw new ScreenError('设备请求过大'); }
                    json(await devices.action(contestKey, JSON.parse(JSON.parse(text).payload), boards.map(b => b.id)));
                } else if (url.searchParams.get('thumb')) json({ thumb: await devices.thumb(contestKey, url.searchParams.get('thumb')!) });
                else { await devices.watch(contestKey); json({ devices: await devices.list(contestKey) }); }
                return true;
            }
            if (url.pathname === site) {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(env.render('xcpcio_screen_device.html', {
                    codeBase, title: '大屏设备', runtimeJson: toScriptJson({ device: true, version, dataUrl: site + '/data', pairUrl: site + '/pair', thumbUrl: site + '/thumb' }),
                }));
                return true;
            }
            if (url.pathname === site + '/pair' && request.method === 'POST') {
                const result = await devices.pair(cookie, request.socket.remoteAddress || '');
                if ('cookie' in result && result.cookie) setCookie(result.cookie);
                json('code' in result ? { code: result.code, expiresAt: result.expiresAt } : { paired: true }); return true;
            }
            if (url.pathname === site + '/thumb' && request.method === 'POST') {
                const device = await devices.authenticate(cookie);
                if (!device) { json({ error: '设备未配对' }, 404); return true; }
                let text = ''; for await (const chunk of request) { text += chunk; if (text.length > 200_000) throw new ScreenError('缩略图过大'); }
                json({ saved: await devices.saveThumb(device, JSON.parse(text)) }); return true;
            }
            if (url.pathname.startsWith(site + '/k/')) {
                const cookie = await devices.redeem(url.pathname.slice((site + '/k/').length));
                if (!cookie) throw new ScreenError('启动链接已失效', 404);
                setCookie(cookie); response.writeHead(302, { Location: site, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' }).end(); return true;
            }
            if (url.pathname === `${base}/screens`) {
                if (request.method === 'POST') {
                    let text = '';
                    for await (const chunk of request) {
                        text += chunk;
                        if (text.length > 3_000_000) throw new ScreenError('请求内容过大');
                    }
                    const body = JSON.parse(text || '{}');
                    if (body.operation === 'resolver_sessions' || body.operation === 'bind_resolver') {
                        const scope = { domainId: 'system', contestId: 'demo', ownerId: 1 };
                        if (body.operation === 'resolver_sessions') json({ sessions: await sessions.list(scope), sessionId: config.items.resolver.sessionId });
                        else {
                            await sessions.get(scope, body.sessionId);
                            config.items.resolver.sessionId = body.sessionId;
                            json({ sessionId: body.sessionId, audienceUrl: `${base}/screen/${token}/resolver` });
                        }
                    } else if (body.operation === 'reset_token') {
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
                        reactionLayouts: reactionLayouts(), standingsTypes: [...standingsTypes], scalableTypes: [...scalableTypes], boards: boards.map(({ id, name }) => ({ id, name })),
                        sessions: own.map((row) => ({ id: row.id, createdAt: row.createdAt, title: row.overview.title,
                            board: boards.find((board) => board.id === row.config.boardId)?.name || row.config.boardId, rehearsal: row.config.rehearsal })),
                        contest: { start: new Date(data.contest.start_time * 1000).toISOString(), end: new Date(data.contest.end_time * 1000).toISOString() },
                    }),
                }));
                return true;
            }
            const match = /^\/contest\/demo\/screen\/([^/]+)\/([a-z-]+)(\/data|\/images\/([a-f\d]{24}))?$/.exec(url.pathname);
            const pairedRoute = url.pathname.startsWith(site + '/');
            if (!match && !pairedRoute) return false;
            const device = pairedRoute ? await devices.authenticate(cookie) : null;
            if (pairedRoute && !device) {
                if (url.pathname === site + '/data') json({ paired: false }); else json({ error: '设备未配对' }, 404);
                return true;
            }
            if (match && (match[1] !== token || !screenTypes.includes(match[2] as ScreenType))) throw new ScreenError('大屏链接无效或已作废', 404);
            const type = device?.type || match![2] as ScreenType;
            const mediaBase = device ? site : `${base}/screen/${token}/${type}`;
            const item = deviceItem(type, config.items[type], device?.boardId);
            const image = match?.[4] || (device && /^\/xcpcio-screen\/images\/([a-f0-9]{24})$/.exec(url.pathname)?.[1]);
            if (image) {
                const file = type === 'poster' && config.items.poster.images.includes(image) ? images.get(image) : undefined;
                if (!file) throw new ScreenError('图片不存在', 404);
                response.writeHead(200, { 'Content-Type': file.mime, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }).end(file.data);
                return true;
            }
            if (device && url.pathname !== site + '/data') {
                const id = decodeURIComponent(url.pathname.slice((site + '/videos/').length));
                const teams = item.boardId === 'all' ? null : new Set(boards.find(b => b.id === item.boardId)?.teamIds || []);
                const video = type === 'reactions' && url.pathname.startsWith(site + '/videos/') && publicVideos(item.layoutId || undefined)
                    .find(v => v.id === id && eligibleScreenReaction(v, item, teams));
                if (!video || !playVideo) throw new ScreenError('视频不可播放', 404);
                playVideo(request, response); return true;
            }
            if (device) {
                await devices.heartbeat(device, screenClient(JSON.parse(url.searchParams.get('client') || '{}'), request.socket.remoteAddress || '', request.headers['user-agent'] || ''));
                if (url.searchParams.get('acks')) await devices.acknowledge(device, JSON.parse(url.searchParams.get('acks')!));
                commands = { paired: true, device: deviceState(device) };
            }
            if (match && !match[3]) {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(env.render('xcpcio_screen_view.html', {
                    codeBase, title: `${data.contest.contest_name} · ${screenLabels[type]}`,
                    runtimeJson: toScriptJson({ type, dataUrl: `${url.pathname}/data${url.search}` }),
                }));
                return true;
            }
            const head = { type, locale: config.locale, serverTime: Date.now(), title: data.contest.contest_name };
            if (url.searchParams.get('phase') === 'upcoming' && hiddenBeforeStart.has(type)) {
                json({ ...head, notice: '比赛尚未开始' });
                return true;
            }
            if (type === 'resolver') {
                const session = item.sessionId ? await sessions.find('system', 'demo', item.sessionId) : null;
                if (!session) json({ ...head, notice: item.sessionId ? '滚榜会话已结束或删除，请重新投屏' : '等待主持人投到观众屏' });
                else {
                    const number = (key: string) => url.searchParams.has(key) ? Number(url.searchParams.get(key)) : undefined;
                    json({ ...head, renderer: item.variant, session: session._id, ...await sessions.audience(session, url.searchParams.get('session') || undefined, number('revision'), number('index')) });
                }
                return true;
            }
            const boardId = standingsTypes.has(type) ? item.boardId : 'all';
            const board = boards.find((candidate) => candidate.id === boardId);
            if (!board) { json({ ...head, notice: '所选分榜已不存在，请在大屏管理页重新选择' }); return true; }
            let payload: unknown;
            const problems = data.contest.problem_id as string[];
            if (type === 'poster') payload = item.images.map((id) => `${mediaBase}/images/${id}`);
            else if (type === 'reactions') payload = reactionPlaylist(publicVideos(item.layoutId || undefined).map(v => ({ ...v, url: device ? mediaBase + '/videos/' + encodeURIComponent(v.id) : v.url })), item, boardId === 'all' ? null : new Set(board?.teamIds));
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
                const frozen = locked ? { ...data, contest: { ...data.contest, frozen_time: 4 * 3600 } } : data;
                // As index.ts applyBoardRules: ?running=1 is before the freeze, where the CCPC board hides labels.
                const source = standingsTypes.has(type) && settings.ccpcBoard.enabled && url.searchParams.get('running') === '1' && !locked
                    ? hideProblemLabels(frozen, settings.ccpcBoard) : frozen;
                const rules = awardsFor(settings, boardId);
                const projection = screenData(source, boardId === 'all' ? null : new Set(board.teamIds), {
                    logoNames, locked, seats, trend: type === 'rank-trend',
                    groups: type === 'groups' && item.source === 'boards' ? boards.filter((group) => group.id !== 'all') : null,
                    firstSolve: rules.firstSolve, unofficialFirstSolve: rules.unofficialFirstSolve, tieBreak: rules.tieBreak,
                });
                try {
                    if (type === 'balloons' && source.hiddenFrom !== undefined) throw new ScreenError('封榜前隐藏题号时不显示气球配送图');
                    payload = screenProjection(type, item, projection, source.submissions.filter((row) => row.status === 'CORRECT').slice(-5)
                        .map((row) => ({ teamId: row.team_id, problemId: String(row.problem_id), submissionId: row.submission_id })));
                } catch (error) {
                    if (!(error instanceof ScreenError)) throw error;
                    json({ ...head, notice: error.message });
                    return true;
                }
            }
            json({ ...head, item: presentationItem(type, item, data), data: payload });
        } catch (error) {
            json({ error: error instanceof Error ? error.message : 'Invalid request' }, error instanceof ScreenError ? error.status : 400);
        }
        return true;
    };
}
