import { imageBytes } from '../lib/screens-data';
import type { ContestLinks } from '../lib/links';
import { ResolverPhotos, photoUrl } from '../lib/resolver-photos';
import { ceremonyScript } from '../lib/ceremony';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Environment } from 'nunjucks';
import { type BoardData, enhanceBoard } from '../lib/board';
import { specialAwardResults } from '../lib/special-awards';
import type { BoardSettings } from '../lib/settings';
import { toScriptJson } from '../lib/settings';
import { defaultResolverConfig, parseResolverConfig, prepareResolver, ResolverError, resolverBoards, resolverCodeBase } from '../lib/resolver-data';
import { ResolverSessions } from '../lib/resolver-sessions';
import { previewDatabase } from './resolver-memory-db';

export function createResolverPreview(env: Environment, logoNames: Record<string, string>, version: string, db = previewDatabase().db, links?: ContestLinks) {
    const codeBase = resolverCodeBase(version);
    const photos = new ResolverPhotos(db);
    const photoBase = '/d/system/contest/demo/resolver';
    const key = 'system/demo';
    links?.add({ id: 'resolver-photos', label: '滚榜队伍照片', status: () => photos.status(key), revoke: () => photos.rotate(key) });
    const sessions = new ResolverSessions(db);
    const base = '/contest/demo/resolver';
    const scope = { domainId: 'system', contestId: 'demo', ownerId: 1 };
    return async (request: IncomingMessage, response: ServerResponse, url: URL, data: BoardData, settings: BoardSettings) => {
        if (url.pathname.startsWith(photoBase + '/photos/')) {
            const id = url.pathname.split('/').pop()?.match(/^([0-9a-f]{32})\.jpg$/)?.[1];
            if (url.searchParams.get('check') === '1') {
                const valid = !!id && !!await photos.exists(key, id);
                response.writeHead(valid ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify({ valid }));
                return true;
            }
            const photo = id && await photos.get(key, id);
            if (!photo) response.writeHead(404).end();
            else response.writeHead(200, { 'Content-Type': photo.mime, 'Cache-Control': 'no-store' }).end(imageBytes(photo.data));
            return true;
        }
        if (!url.pathname.startsWith(base)) return false;
        response.setHeader('Cache-Control', 'no-store');
        const json = (value: unknown, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(value));
        try {
            const ended = url.searchParams.get('running') !== '1';
            const boards = resolverBoards(data, settings, true);
            const defaults = defaultResolverConfig(settings, ended);
            let body: Record<string, any> = {};
            if (request.method === 'POST') {
                let text = '';
                for await (const chunk of request) {
                    text += chunk;
                    if (text.length > (url.pathname === base + '/photos' ? 1500000 : 16000)) throw new ResolverError('请求内容过大');
                }
                body = JSON.parse(text || '{}');
            }
            if (url.pathname === base + '/photos' && request.method === 'POST') {
                const uid = String(body.uid);
                if (!data.teams.some(t => t.team_id === uid)) throw new ResolverError('未知队伍');
                if (body.image) json({ url: photoUrl(photoBase, await photos.put(key, uid, body.image, 1)) });
                else { await photos.delete(key, uid); json({ url: null }); }
            } else if (url.pathname === base && request.method === 'GET') {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(env.render('xcpcio_resolver_config.html', {
                    tdoc: { title: data.contest.contest_name }, assetBase: '/hydro-resolver', codeBase, settingsUrl: '/contest/demo/xcpcio-settings', contestUrl: '/contest/demo/scoreboard/xcpcio-plus',
                    runtimeJson: toScriptJson({
                        base, contestUrl: '/contest/demo/scoreboard/xcpcio-plus', title: data.contest.contest_name,
                        initialStats: {
                            teamCount: data.teams.length,
                            officialCount: data.teams.filter((team) => !team.group.includes('unofficial')).length,
                            problemCount: data.contest.problem_quantity,
                        },
                        photos: await photos.urls(key, photoBase), teams: data.teams.map(t => ({ uid: t.team_id, name: t.name, account: `team${t.team_id}` })),
                        boards, ended, config: defaults, sessionDays: 0, durationSeconds: data.contest.end_time - data.contest.start_time,
                        contestFreezeAtSeconds: Number(data.contest.frozen_time) > 0
                            ? data.contest.end_time - data.contest.start_time - Number(data.contest.frozen_time) : null,
                    }),
                }));
            } else if (url.pathname === `${base}/sessions` && request.method === 'GET') {
                json({ sessions: await sessions.list(scope) });
            } else if ([`${base}/sessions`, `${base}/preview`].includes(url.pathname) && request.method === 'POST') {
                const input = JSON.parse(body.config);
                const board = boards.find((item) => item.id === input?.boardId);
                const config = parseResolverConfig(input, defaultResolverConfig({ ...settings, medals: board?.medals || settings.medals }, ended));
                const payload = prepareResolver(data, boards, config, {
                    contestId: 'demo', photos: await photos.urls(key, photoBase), ended, capturedAt: new Date(), logoNames, special: specialAwardResults(enhanceBoard(data, settings), settings),
                });
                if (url.pathname.endsWith('/preview')) json({ game: payload.game, config: payload.config, overview: payload.overview });
                else {
                    const session = await sessions.create(scope, payload);
                    json({ id: session._id, url: `${base}/sessions/${session._id}`, overview: session.overview });
                }
            } else {
                const match = /^\/sessions\/([a-f\d-]+)(?:\/(data|playback|delete|script))?$/.exec(url.pathname.slice(base.length));
                if (!match) throw new ResolverError('Not found', 404);
                const session = await sessions.get(scope, match[1]);
                const operation = match[2];
                if (!operation && request.method === 'GET') {
                    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(env.render('xcpcio_resolver_play.html', {
                        tdoc: { title: session.overview.title }, codeBase, configUrl: base, scriptUrl: `${base}/sessions/${session._id}/script`, runtimeJson: toScriptJson({
                            id: session._id, controlToken: session.controlToken, screensUrl: '/contest/demo/screens',
                            base: `${base}/sessions/${session._id}`, rehearsal: session.config.rehearsal,
                        }),
                    }));
                } else if (operation === 'script' && request.method === 'GET') {
                    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(env.render('xcpcio_resolver_script.html', {
                        tdoc: { title: session.overview.title }, codeBase, playUrl: `${base}/sessions/${session._id}`, script: ceremonyScript(await sessions.read(session)),
                    }));
                } else if (operation === 'delete' && request.method === 'POST') {
                    await sessions.remove(session);
                    json({ deleted: true });
                } else {
                    sessions.checkToken(session, request.headers['x-resolver-control']);
                    if (operation === 'data' && request.method === 'GET') {
                        json({ ...(await sessions.read(session)).game, playback: sessions.playback(session), overview: session.overview });
                    } else if (operation === 'playback' && request.method === 'GET') json({ playback: sessions.playback(session) });
                    else if (operation === 'playback' && request.method === 'POST') {
                        const result = await sessions.move(session, body.index, body.revision);
                        json(result, result.status);
                    } else throw new ResolverError('Method not allowed', 405);
                }
            }
        } catch (error) {
            json({ error: error instanceof Error ? error.message : 'Invalid request' }, error instanceof ResolverError ? error.status : 400);
        }
        return true;
    };
}
