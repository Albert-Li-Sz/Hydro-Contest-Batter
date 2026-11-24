import { recordingPreview } from './recording';
import fs from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import type { Environment } from 'nunjucks';
import type { WebSocket, WebSocketServer } from 'ws';
import type { BoardData } from '../lib/board';
import {
    CaptureError, type CaptureDevice, captureMedias, captureProfile, CaptureRelay, captureSecretMatches, type CaptureSettings, type CaptureStream,
    captureStreams, defaultCaptureSettings, isCaptureOnline, newCaptureSecret, normalizeCaptureSettings, normalizeDeviceInput, participantDeviceId, streamAllowed,
} from '../lib/live/capture';
import { toScriptJson } from '../lib/settings';
import { startStunServer } from '../lib/live/stun';

/**
 * 画面采集 in the local preview, mirroring lib/live/capture-routes.ts without Hydro or MongoDB.
 * Every preview visitor counts as contest staff; the overlay link counts as the OBS overlay.
 * Open a device's capture link in another browser tab to try the whole path on one computer.
 */
export function createCapturePreview(env: Environment, options: {
    codeBase: string;
    base: string;
    contest: { title: string; beginAt: Date; endAt: Date };
    /** The demo teams and the seats they sit at. */
    teams: () => { uid: number; name: string; seat: string }[];
    overlayToken: () => string;
}) {
    const { base, codeBase, contest } = options;
    const contestKey = 'demo';
    const devices = new Map<string, CaptureDevice>();
    let settings: CaptureSettings = defaultCaptureSettings();
    // One process: the bus has nobody to reach.
    const relay = new CaptureRelay(() => {});
    // Hydro's own STUN server, on a port of its own here so it does not meet a local 3478.
    const stunPort = Number(process.env.XCPCIO_PREVIEW_STUN || 13478);
    if (stunPort) startStunServer(stunPort, (message) => console.warn(`preview STUN: ${message}`));
    const recording = recordingPreview(base, () => settings, contest, options.teams, devices, (id, data) => relay.toDevice(id, data));
    let counter = 0;
    const captureUrl = (device: CaptureDevice) => `${base}/live-capture/${device._id}/${device.secret}`;

    function create(input: { seat: string; name: string; teamUid: number | null }) {
        const id = (0x6800000000 + counter++).toString(16).padStart(24, '0');
        devices.set(id, { _id: id, contestKey, ...input, secret: newCaptureSecret(), createdAt: new Date(), lastSeen: null, connection: null, streams: [], client: null });
    }

    /** The preview's contestant: team `as` (default the first team), as if signed in and joined. */
    function participantDevice(teamUid: number) {
        const team = options.teams().find((item) => item.uid === teamUid);
        if (!team) throw new CaptureError('只有本场比赛的参赛选手可以开启画面采集', 403);
        const existing = [...devices.values()].find((device) => device.teamUid === teamUid)
            ?? [...devices.values()].find((device) => device.teamUid === null && team.seat && device.seat.toLowerCase() === team.seat.toLowerCase());
        if (existing) return existing;
        const _id = participantDeviceId(contestKey, teamUid);
        const device: CaptureDevice = { _id, contestKey, seat: team.seat, name: team.seat || team.name, teamUid: team.seat ? null : teamUid,
            secret: newCaptureSecret(), createdAt: new Date(), lastSeen: null, connection: null, streams: [], client: null };
        devices.set(_id, device);
        return device;
    }
    const asTeam = (url: URL) => Number(url.searchParams.get('as') || options.teams()[0]?.uid);

    function medias(data: BoardData) {
        if (!settings.enabled || !devices.size) return {};
        const seats = new Map(options.teams().map((team) => [String(team.uid), team.seat]));
        const teams = data.teams.map((team) => ({ teamId: team.team_id, uid: Number(team.team_id), seat: seats.get(team.team_id) || '' }));
        return captureMedias(teams, [...devices.values()], streamAllowed('screen', 'overlay', settings, contest, Date.now()), settings.webcam);
    }

    function data() {
        const now = Date.now();
        const teams = options.teams();
        const bySeat = new Map(teams.filter((team) => team.seat).map((team) => [team.seat.toLowerCase(), team]));
        return {
            settings, screenNow: streamAllowed('screen', 'overlay', settings, contest, now), contest, teams,
            devices: [...devices.values()].sort((a, b) => a.seat.localeCompare(b.seat, 'zh-CN', { numeric: true })).map((device) => ({
                id: device._id, name: device.name, seat: device.seat, teamUid: device.teamUid,
                team: device.teamUid !== null ? teams.find((team) => team.uid === device.teamUid) ?? null : bySeat.get(device.seat.toLowerCase()) ?? null,
                url: captureUrl(device), online: isCaptureOnline(device, now), streams: isCaptureOnline(device, now) ? device.streams : [],
                lastSeen: device.lastSeen, client: device.client, recordingStatus: device.recordingStatus,
            })),
        };
    }

    function operate(name: string, payload: any) {
        switch (name) {
        case 'create': {
            const item = normalizeDeviceInput(payload);
            if (item.seat && [...devices.values()].some((device) => device.seat === item.seat)) throw new CaptureError(`座位 ${item.seat} 已有采集设备`);
            create(item);
            return { created: 1 };
        }
        case 'create_from_seats': {
            const seats = [...new Set(options.teams().map((team) => team.seat).filter(Boolean))];
            const existing = new Set([...devices.values()].map((device) => device.seat.toLowerCase()));
            const missing = seats.filter((seat) => !existing.has(seat.toLowerCase()));
            for (const seat of missing) create({ seat, name: seat, teamUid: null });
            return { created: missing.length, seats: seats.length };
        }
        case 'update': {
            const device = devices.get(String(payload.id));
            if (!device) throw new CaptureError('设备不存在', 404);
            Object.assign(device, normalizeDeviceInput(payload.device, device));
            return { ok: true };
        }
        case 'delete': {
            const ids: string[] = (payload.ids || []).map(String);
            let deleted = 0;
            for (const id of ids) if (devices.delete(id)) { deleted++; relay.kickDevice(id, '采集设备已被删除'); }
            return { deleted };
        }
        case 'regenerate': {
            const device = devices.get(String(payload.id));
            if (!device) throw new CaptureError('设备不存在', 404);
            device.secret = newCaptureSecret();
            relay.kickDevice(device._id, '采集链接已重新生成');
            return { url: captureUrl(device) };
        }
        case 'settings': {
            const previous = settings;
            settings = normalizeCaptureSettings(payload.settings, settings);
            const now = Date.now();
            if (!settings.enabled) for (const id of devices.keys()) relay.kickDevice(id, '本场比赛已停用画面采集，重新启用后会自动连接', 4005);
            else {
                if (JSON.stringify(captureProfile(settings)) !== JSON.stringify(captureProfile(previous))) relay.configureDevices(contestKey, { ...captureProfile(settings), stunPort });
                if (streamAllowed('screen', 'overlay', previous, contest, now) && !streamAllowed('screen', 'overlay', settings, contest, now)) relay.endOverlayScreens(contestKey);
            }
            return { settings };
        }
        default: throw new CaptureError('未知操作');
        }
    }

    const json = (response: ServerResponse, status: number, body: unknown) => response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));

    async function handle(request: IncomingMessage, response: ServerResponse, url: URL, readBody: (request: IncomingMessage) => Promise<any>) {
        const uploadMatch = /^\/contest\/demo\/live-capture\/([a-f\d]{24})\/([\w-]+)\/segments$/.exec(url.pathname);
        const ownUpload = url.pathname === base + '/live-capture/me/segments';
        const uploadDevice = ownUpload ? participantDevice(asTeam(url)) : uploadMatch ? devices.get(uploadMatch[1]) : undefined;
        if ((ownUpload || uploadMatch) && (!uploadDevice || (uploadMatch && !captureSecretMatches(uploadMatch[2], uploadDevice.secret)))) {
            json(response, 403, { error: '无效的采集链接' }); return true;
        }
        if (await recording.handle(request, response, url, readBody, uploadDevice)) return true;
        if (url.pathname === `${base}/live/capture`) {
            if (request.method === 'POST') {
                const body = await readBody(request);
                try {
                    json(response, 200, operate(String(body.operation), body.payload ? JSON.parse(body.payload) : {}));
                } catch (error) {
                    json(response, error instanceof CaptureError ? error.status : 500, { error: (error as Error).message });
                }
                return true;
            }
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(env.render('xcpcio_live_capture.html', {
                codeBase, tdoc: { title: contest.title },
                runtimeJson: toScriptJson({
                    base: `${base}/live/capture`, dataUrl: `${base}/live/capture/data`, contestUrl: `${base}/scoreboard/xcpcio-plus`,
                    viewerWs: `${base}/live/ws/capture`, title: contest.title,
                }),
            }));
            return true;
        }
        // The director console's 画面采集 page.
        if (url.pathname === `${base}/live/api/admin/capture`) {
            const now = Date.now();
            const teams = options.teams();
            const bySeat = new Map(teams.filter((team) => team.seat).map((team) => [team.seat.toLowerCase(), team]));
            json(response, 200, {
                available: true, enabled: settings.enabled, webcam: settings.webcam, screenOnAir: streamAllowed('screen', 'overlay', settings, contest, now),
                devices: [...devices.values()].sort((a, b) => a.seat.localeCompare(b.seat, 'zh-CN', { numeric: true })).map((device) => {
                    const team = device.teamUid !== null ? teams.find((item) => item.uid === device.teamUid) : bySeat.get(device.seat.toLowerCase());
                    const online = isCaptureOnline(device, now);
                    return { id: device._id, name: device.name, seat: device.seat, teamId: team ? String(team.uid) : null, teamName: team?.name || '', online, streams: online ? device.streams : [] };
                }),
            });
            return true;
        }
        if (url.pathname === `${base}/live/capture/data`) {
            json(response, 200, data());
            return true;
        }
        if (url.pathname === `${base}/live-capture/me`) {
            const device = participantDevice(asTeam(url));
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(env.render('xcpcio_live_capture_device.html', {
                codeBase, title: `画面采集 · ${contest.title}`,
                runtimeJson: toScriptJson({ ws: `${base}/live-capture/me/ws${url.search}`, name: device.name, seat: device.seat, contest: contest.title, channel: 'xcpcio-capture-demo', window: true }),
            }));
            return true;
        }
        // A stand-in for a Hydro contest page of a contestant: the prompt that opens the capture window.
        if (url.pathname === `${base}/problems`) {
            const info = settings.enabled && settings.prompt
                ? { url: `${base}/live-capture/me${url.search}`, channel: 'xcpcio-capture-demo', contest: contest.title, screenPublic: settings.screenDuringContest, webcam: settings.webcam, recording: settings.recording.clips.enabled || settings.recording.archive.enabled } : null;
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>比赛题目 · ${contest.title}</title></head>
<body style="font-family:sans-serif;padding:24px"><h1>${contest.title}</h1><p>（预览：参赛选手看到的比赛页面${info ? '' : '。本场比赛未启用画面采集或未开启弹窗提示，所以没有提示'}）</p><p><a href="${base}/problems${url.search}">换一页</a></p>
<script type="module">import { installCapturePrompt } from '/preview-frontend/capture-prompt.js'; const info = ${JSON.stringify(info)}; if (info) installCapturePrompt(info);</script></body></html>`);
            return true;
        }
        if (url.pathname === '/preview-frontend/capture-prompt.js') {
            response.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' })
                .end(await fs.readFile(path.join(__dirname, '../frontend/capture-prompt.js'), 'utf8'));
            return true;
        }
        const page = /^\/contest\/demo\/live-capture\/([a-f\d]{24})\/([\w-]+)$/.exec(url.pathname);
        if (page) {
            const device = devices.get(page[1]);
            if (!device || !captureSecretMatches(page[2], device.secret)) { response.writeHead(404).end('采集链接无效或已重新生成'); return true; }
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(env.render('xcpcio_live_capture_device.html', {
                codeBase, title: `${device.name} · 画面采集`,
                runtimeJson: toScriptJson({ ws: `${captureUrl(device)}/ws`, name: device.name, seat: device.seat, contest: contest.title }),
            }));
            return true;
        }
        return false;
    }

    /** Hydro's websocket layer, briefly: text ping/pong, JSON messages. */
    function keepAlive(ws: WebSocket, onMessage: (message: unknown) => void) {
        ws.on('message', (raw) => {
            const text = raw.toString();
            if (text === 'ping') { ws.send('pong'); return; }
            if (text === 'pong') return;
            try { onMessage(JSON.parse(text)); } catch { /* not JSON */ }
        });
    }

    /** Takes the capture websockets; false when the address is not one of them. */
    function upgrade(request: IncomingMessage, socket: Duplex, head: Buffer, server: WebSocketServer) {
        const url = new URL(request.url || '/', 'http://localhost');
        const deviceMatch = /^\/contest\/demo\/live-capture\/([a-f\d]{24})\/([\w-]+)\/ws$/.exec(url.pathname);
        const own = url.pathname === `${base}/live-capture/me/ws`;
        const overlayMatch = /^\/contest\/demo\/live-overlay\/([^/]+)\/ws\/capture$/.exec(url.pathname);
        const staff = url.pathname === `${base}/live/ws/capture`;
        if (!deviceMatch && !overlayMatch && !staff && !own) return false;
        server.handleUpgrade(request, socket, head, (ws) => {
            if (deviceMatch || own) {
                let device: CaptureDevice | undefined;
                try { device = own ? participantDevice(asTeam(url)) : devices.get(deviceMatch![1]); } catch { device = undefined; }
                if (!device || (deviceMatch && !captureSecretMatches(deviceMatch[2], device.secret)) || !settings.enabled) {
                    ws.close(4000, `CaptureError: ${!settings.enabled ? '本场比赛尚未启用画面采集，启用后会自动连接' : '采集链接无效或已重新生成，请向管理员获取新的链接'}`);
                    return;
                }
                const connection = `${relay.instance}/${Math.random()}`;
                const endpoint = { contestKey, connection, send: (message: unknown) => ws.send(JSON.stringify(message)), close: (code: number, reason: string) => ws.close(code, reason) };
                relay.attachDevice(device._id, endpoint);
                Object.assign(device, { connection, lastSeen: new Date(), streams: [], client: { agent: String(request.headers['user-agent'] || ''), ip: '127.0.0.1', screen: '' } });
                relay.devicesChanged(contestKey);
                ws.send(JSON.stringify({ type: 'config', name: device.name, seat: device.seat, deviceId: device._id, teamUid: recording.uidOf(device) ?? null, serverTime: Date.now(), beginAt: +contest.beginAt, endAt: +contest.endAt, ...captureProfile(settings), stunPort }));
                const statusTimer = setInterval(() => endpoint.send({ type: 'requestStatus' }), 15_000);
                let reported = '';
                keepAlive(ws, (message) => {
                    const input = message as Record<string, unknown>;
                    if (device.connection !== connection || recording.message(device, input)) return;
                    if (input?.type === 'status') {
                        if (device.connection !== connection) return;
                        device.lastSeen = new Date();
                        device.streams = (Array.isArray(input.streams) ? input.streams : []).filter((stream): stream is CaptureStream => captureStreams.includes(stream as CaptureStream));
                        if (device.client) device.client.screen = String(input.screen || '').slice(0, 40);
                        const key = `${[...device.streams].sort().join(',')}|${device.client?.screen || ''}`;
                        if (key !== reported) relay.devicesChanged(contestKey);
                        reported = key;
                        return;
                    }
                    relay.fromDevice(device._id, message);
                });
                ws.on('close', () => {
                    clearInterval(statusTimer);
                    relay.detachDevice(device._id, endpoint);
                    if (device.connection === connection) Object.assign(device, { connection: null, streams: [] });
                    relay.devicesChanged(contestKey);
                });
                return;
            }
            if (overlayMatch && overlayMatch[1] !== options.overlayToken()) { ws.close(4004, '直播链接已作废'); return; }
            const kind = staff ? 'staff' as const : 'overlay' as const;
            const viewer = relay.attachViewer({
                contestKey, kind, token: overlayMatch?.[1] || '',
                send: (message) => ws.send(JSON.stringify(message)),
                close: (code, reason) => ws.close(code, reason),
                allow: async (id, stream) => {
                    const device = devices.get(id);
                    if (!device) return '设备不存在';
                    if (!settings.enabled) return '本场比赛未启用画面采集';
                    if (!streamAllowed(stream, kind, settings, contest, Date.now())) return '比赛结束前不提供屏幕画面';
                    if (!isCaptureOnline(device, Date.now())) return '设备未在线';
                    if (!device.streams.includes(stream)) return stream === 'screen' ? '该设备没有在采集屏幕' : '该设备没有在采集摄像头';
                    return true;
                },
            });
            ws.send(JSON.stringify({ type: 'config', iceServers: settings.iceServers, stunPort }));
            keepAlive(ws, (message) => { relay.fromViewer(viewer, message).catch(() => null); });
            ws.on('close', () => relay.detachViewer(viewer));
        });
        return true;
    }

    return {
        handle, upgrade, medias, activeRecordingTeams: recording.activeTeams, judged: recording.judged,
        revoke: (token: string) => relay.closeViewers(contestKey, 4004, '直播链接已作废', (endpoint) => endpoint.kind !== 'overlay' || endpoint.token === token),
    };
}
