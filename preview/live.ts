import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Environment } from 'nunjucks';
import { WebSocketServer } from 'ws';
import type { BoardData } from '../lib/board';
import type { BoardSettings } from '../lib/settings';
import { toScriptJson } from '../lib/settings';
import { resolverBoards, resolverCodeBase } from '../lib/resolver-data';
import {
    adminApi, adminChannel, adminRuntime, builtinMediaNames, defaultVisualConfig, liveUrls, overlayApi, overlayChannel, previewRuntime, readBuiltinMedia, shell, storeName,
} from '../lib/live/api';
import { LiveHub } from '../lib/live/hub';
import { stateFromEntries, type LiveStateEntries } from '../lib/live/state';
import { createCapturePreview } from './capture';

const verdicts = ['CORRECT', 'CORRECT', 'WRONG_ANSWER', 'TIME_LIMIT_EXCEEDED', 'RUNTIME_ERROR', 'COMPILATION_ERROR'];

/**
 * Local preview of the live module. Mirrors lib/live/routes.ts without Hydro or MongoDB: a contest
 * that started 90 minutes ago, freezes one hour before the end, and keeps receiving submissions.
 */
export function createLivePreview(env: Environment, logoNames: Record<string, string>, version: string,
    demo: () => BoardData, settings: () => BoardSettings) {
    const base = '/contest/demo';
    const codeBase = resolverCodeBase(version);
    let token = 'live0000000000000000000000000000000000000000000000';
    const mediaKey = 'media000000000000000000000000000000000000000000000';
    const urls = () => liveUrls(base, token, mediaKey);
    const template = demo();
    const now = Date.now();
    const contest = {
        title: template.contest.contest_name,
        beginAt: new Date(now - 90 * 60_000),
        endAt: new Date(now + 210 * 60_000),
        lockAt: new Date(now + 150 * 60_000),
    };
    const submissions = template.submissions.map((record) => ({ ...record }));
    // The demo teams sit at A-01, A-02, …, as onsite-toolkit would import.
    const capture = createCapturePreview(env, {
        codeBase, base, contest,
        teams: () => template.teams.map((team, index) => ({ uid: Number(team.team_id), name: team.name, seat: `A-${String(index + 1).padStart(2, '0')}` })),
        overlayToken: () => token,
    });
    let next = 0;
    const timer = setInterval(() => {
        // A new submission is judged a few seconds later, so the queue shows both phases.
        const team = template.teams[Math.floor(Math.random() * template.teams.length)];
        const record = {
            submission_id: `live-${next++}`, team_id: team.team_id, problem_id: Math.floor(Math.random() * template.contest.problem_quantity),
            timestamp: Date.now() - contest.beginAt.getTime(), status: 'PENDING',
        };
        submissions.push(record);
        setTimeout(() => { record.status = verdicts[Math.floor(Math.random() * verdicts.length)]; }, 6000).unref();
    }, 9000);
    timer.unref();
    let visualConfig = defaultVisualConfig(contest.title);
    const uploaded = new Map<string, { data: Buffer; mime: string }>();
    const store = {
        visualConfig: async () => visualConfig,
        saveVisualConfig: async (value: string) => { visualConfig = value; },
        mediaNames: async () => [...new Set([...await builtinMediaNames(), ...uploaded.keys()])].sort(),
        saveMedia: async (name: string, data: Buffer, mime: string) => { uploaded.set(name, { data, mime }); },
        mediaUrl: async (name: string) => `${urls().media}/${encodeURIComponent(name)}`,
    };
    const state: LiveStateEntries = {};
    let revision = 0;
    const hub = new LiveHub({
        intervalMs: 2000,
        load: async () => {
            const current = settings();
            const data: BoardData = { ...template, submissions: submissions.map((record) => ({ ...record })) };
            return {
                contest, data, settings: current, identity: current.showIdentity, logoNames, now: Date.now(),
                boards: resolverBoards(data, current, current.showIdentity),
                medias: capture.medias(data),
            };
        },
        persist: async (patch) => {
            for (const [key, value] of Object.entries(patch)) {
                if (value === null) delete state[key];
                else state[key] = value;
            }
            return ++revision;
        },
        template: async (name) => {
            const file = uploaded.get(name) || await readBuiltinMedia(storeName(name));
            return file ? file.data.toString('utf8') : null;
        },
    });

    const html = (response: ServerResponse, body: string) => response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(body);

    async function readBody(request: IncomingMessage) {
        let text = '';
        for await (const chunk of request) { text += chunk; if (text.length > 1_000_000) throw new Error('请求过大'); }
        if (!text) return {};
        if ((request.headers['content-type'] || '').includes('application/json')) return JSON.parse(text);
        return text;
    }

    const handle = async (request: IncomingMessage, response: ServerResponse, url: URL) => {
        if (await capture.handle(request, response, url, readBody)) return true;
        if (url.pathname === `${base}/live`) {
            if (request.method === 'POST') {
                const body = await readBody(request);
                if (body?.operation !== 'reset_token') { response.writeHead(400).end(); return true; }
                token = `live${Date.now().toString(16).padStart(46, '0')}`;
                for (const [socket, used] of overlaySockets) if (used !== token) socket.close(4004, '直播链接已作废');
                capture.revoke(token);
                response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ overlay: urls().overlay }));
                return true;
            }
            const links = urls();
            html(response, env.render('xcpcio_live.html', {
                codeBase, tdoc: { title: contest.title },
                runtimeJson: toScriptJson({ base: links.root, contestUrl: `${base}/scoreboard/xcpcio-plus`, title: contest.title, overlay: links.overlay, admin: links.adminBase }),
            }));
            return true;
        }
        if (url.pathname === `${base}/live/admin` || url.pathname.startsWith(`${base}/live/admin/`)) {
            html(response, shell('admin', adminRuntime(urls()), `${contest.title} · 直播导播台`));
            return true;
        }
        if (url.pathname === `${base}/live/preview`) {
            html(response, shell('overlay', previewRuntime(urls()), `${contest.title} · 直播画面预览`));
            return true;
        }
        const preview = /^\/contest\/demo\/live\/api\/overlay\/(.*)$/.exec(url.pathname);
        if (preview) {
            const result = await overlayApi(hub, preview[1], visualConfig);
            if (!result) response.writeHead(404).end('Not found');
            else response.writeHead(result.status, { 'Content-Type': result.type, 'Cache-Control': 'no-store' }).end(result.body);
            return true;
        }
        const mainPage = /^\/contest\/demo\/live\/main-page\/(git|links)$/.exec(url.pathname);
        if (mainPage) {
            const links = urls();
            response.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(mainPage[1] === 'git'
                ? { commit: '200c82f', branch: 'v3.5.1', description: `ICPC Live v3.5.1 · preview ${version}` }
                : [{ name: '导播控制 /admin/controls', url: `${links.adminBase}/controls` }, { name: 'OBS 画面 /overlay?noStatus', url: `${links.overlay}?noStatus` }]));
            return true;
        }
        const admin = /^\/contest\/demo\/live\/api\/admin\/(.*)$/.exec(url.pathname);
        if (admin) {
            hub.touch();
            if (!hub.info) await hub.refresh();
            const result = await adminApi(hub, store, {
                method: request.method || 'GET', subpath: admin[1], query: Object.fromEntries(url.searchParams), querystring: url.search.slice(1),
                body: request.method === 'GET' ? {} : await readBody(request), files: [], user: 'preview',
            });
            if (!result) response.writeHead(404).end('Not found');
            else response.writeHead(result.status, { 'Content-Type': result.type, 'Cache-Control': 'no-store' }).end(result.body);
            return true;
        }
        const overlay = /^\/contest\/demo\/live-overlay\/([^/]+)(?:\/api\/overlay\/(.*))?$/.exec(url.pathname);
        if (overlay) {
            if (overlay[1] !== token) { response.writeHead(404).end('直播链接无效或已作废'); return true; }
            if (overlay[2] === undefined) { html(response, shell('overlay', urls(), `${contest.title} · 直播画面`)); return true; }
            const result = await overlayApi(hub, overlay[2], visualConfig);
            if (!result) response.writeHead(404).end('Not found');
            else response.writeHead(result.status, { 'Content-Type': result.type, 'Cache-Control': 'no-store' }).end(result.body);
            return true;
        }
        const media = /^\/contest\/demo\/live-media\/([^/]+)\/([^/]+)$/.exec(url.pathname);
        if (media) {
            const name = storeName(decodeURIComponent(media[2]));
            const file = media[1] === mediaKey ? uploaded.get(name) || await readBuiltinMedia(name) : null;
            if (!file) response.writeHead(404).end();
            else response.writeHead(200, { 'Content-Type': file.mime, 'X-Content-Type-Options': 'nosniff' }).end(file.data);
            return true;
        }
        return false;
    };

    const overlaySockets = new Map<import('ws').WebSocket, string>();
    /** `others` are tried first: other previews' sockets (the print management page). */
    const attach = (server: Server, others: ((request: IncomingMessage, socket: Duplex, head: Buffer, sockets: WebSocketServer) => boolean)[] = []) => {
        const sockets = new WebSocketServer({ noServer: true });
        server.on('upgrade', (request, socket, head) => {
            if (others.some((upgrade) => upgrade(request, socket, head, sockets))) return;
            if (capture.upgrade(request, socket, head, sockets)) return;
            const url = new URL(request.url || '/', 'http://localhost');
            const adminMatch = /^\/contest\/demo\/live\/ws\/admin\/(.+)$/.exec(url.pathname);
            const overlayMatch = /^\/contest\/demo\/live-overlay\/([^/]+)\/ws\/overlay\/(.+)$/.exec(url.pathname);
            const previewMatch = /^\/contest\/demo\/live\/ws\/overlay\/(.+)$/.exec(url.pathname);
            const channel = adminMatch ? adminChannel(adminMatch[1])
                : previewMatch ? overlayChannel(previewMatch[1])
                    : overlayMatch && overlayMatch[1] === token ? overlayChannel(overlayMatch[2]) : null;
            if (!channel) { socket.destroy(); return; }
            sockets.handleUpgrade(request, socket, head, (ws) => {
                const unsubscribe = hub.subscribe(channel, (payload) => ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload)));
                if (overlayMatch) overlaySockets.set(ws, overlayMatch[1]);
                ws.on('close', () => overlaySockets.delete(ws));
                // Like Hydro's websocket layer (faster): text "ping" to a quiet client, closed if it never answers.
                let heartbeat = Date.now();
                const keepAlive = setInterval(() => {
                    if (Date.now() - heartbeat > 25_000) {
                        console.warn(`live preview: closing silent socket ${channel}`);
                        ws.terminate();
                    } else if (Date.now() - heartbeat > 10_000) ws.send('ping');
                }, 5000);
                ws.on('message', () => { heartbeat = Date.now(); });
                ws.on('close', () => { clearInterval(keepAlive); unsubscribe(); });
                ws.on('error', () => { clearInterval(keepAlive); unsubscribe(); });
            });
        });
    };

    return { handle, attach, hub, state: () => stateFromEntries(state) };
}
