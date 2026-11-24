/**
 * 画面采集: contestants' screens and webcams over WebRTC, managed by Hydro. Hydro registers the
 * capture devices (one per seat), checks who may watch what, and passes the WebRTC handshake
 * between a device's capture page and the viewers (the OBS overlay, the director's preview, the
 * management page); the video itself goes directly between the two browsers. Pure, so it is
 * tested without Hydro; lib/live/capture-routes.ts connects it to Hydro.
 */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { MediaType } from './types';

export class CaptureError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
        this.name = 'CaptureError';
    }
}

export const captureStreams = ['screen', 'webcam'] as const;
export type CaptureStream = typeof captureStreams[number];

export interface IceServer {
    urls: string[];
    username?: string;
    credential?: string;
}

export interface CaptureSettings {
    /** Off until a contest manager turns it on: capture pages wait, and the overlay gets no team video. */
    enabled: boolean;
    /**
     * Screens on the OBS overlay while the contest runs (they show code). On by default, so the
     * director can put screens on air; turn off when contestants can watch the broadcast.
     */
    screenDuringContest: boolean;
    /** Capture the webcam too; off: screens only, and no webcam permission is asked for. */
    webcam: boolean;
    /** Contestants are asked to start capturing when they open the contest (a capture window opens). */
    prompt: boolean;
    /** Capture the webcam's microphone too. */
    webcamAudio: boolean;
    screenHeight: 720 | 1080;
    screenFps: 5 | 10 | 15 | 30;
    webcamHeight: 360 | 480 | 720;
    /** STUN/TURN servers; none is enough when the OBS computer and the contestants share a network. */
    iceServers: IceServer[];
}

export const defaultCaptureSettings = (): CaptureSettings => ({
    enabled: false, screenDuringContest: true, webcam: true, prompt: true, webcamAudio: false, screenHeight: 720, screenFps: 15, webcamHeight: 480, iceServers: [],
});

function pick<T>(value: unknown, allowed: readonly T[], label: string, fallback: T): T {
    if (value === undefined || value === null) return fallback;
    const number = typeof allowed[0] === 'number' ? Number(value) : value;
    if (!allowed.includes(number as T)) throw new CaptureError(`${label}无效`);
    return number as T;
}

/** STUN/TURN servers from the settings form: one per line, `url [username credential]`. */
export function parseIceServers(input: unknown): IceServer[] {
    const lines = Array.isArray(input) ? input : String(input ?? '').split('\n');
    const servers: IceServer[] = [];
    for (const raw of lines) {
        if (raw && typeof raw === 'object') {
            const item = raw as Record<string, unknown>;
            const urls = (Array.isArray(item.urls) ? item.urls : [item.urls]).map(String);
            servers.push(checkServer({ urls, username: item.username === undefined ? undefined : String(item.username), credential: item.credential === undefined ? undefined : String(item.credential) }));
            continue;
        }
        const line = String(raw).trim();
        if (!line || line.startsWith('#')) continue;
        const [url, username, credential] = line.split(/\s+/);
        servers.push(checkServer({ urls: [url], ...username ? { username } : {}, ...credential ? { credential } : {} }));
    }
    if (servers.length > 10) throw new CaptureError('STUN/TURN 服务器最多 10 个');
    return servers;
}

function checkServer(server: IceServer): IceServer {
    if (!server.urls.length || server.urls.some((url) => !/^(stun|stuns|turn|turns):[^\s]{1,200}$/i.test(url))) {
        throw new CaptureError('STUN/TURN 地址应以 stun: 或 turn: 开头，例如 stun:192.168.1.10:3478');
    }
    if (server.urls.some((url) => /^turns?:/i.test(url)) && (!server.username || !server.credential)) {
        throw new CaptureError('TURN 服务器需要填写用户名和密码，例如 turn:192.168.1.10:3478 live secret');
    }
    for (const field of [server.username, server.credential]) if (field !== undefined && field.length > 200) throw new CaptureError('TURN 用户名或密码过长');
    return server;
}

export function normalizeCaptureSettings(input: unknown, base = defaultCaptureSettings()): CaptureSettings {
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const settings: CaptureSettings = { ...base };
    for (const key of ['enabled', 'screenDuringContest', 'webcam', 'prompt', 'webcamAudio'] as const) if (typeof raw[key] === 'boolean') settings[key] = raw[key] as boolean;
    settings.screenHeight = pick(raw.screenHeight, [720, 1080] as const, '屏幕分辨率', settings.screenHeight);
    settings.screenFps = pick(raw.screenFps, [5, 10, 15, 30] as const, '屏幕帧率', settings.screenFps);
    settings.webcamHeight = pick(raw.webcamHeight, [360, 480, 720] as const, '摄像头分辨率', settings.webcamHeight);
    if (raw.iceServers !== undefined) settings.iceServers = parseIceServers(raw.iceServers);
    return settings;
}

/** What a capture page is told to capture (`webcam: null` for screens only). */
export function captureProfile(settings: CaptureSettings) {
    return {
        screen: { height: settings.screenHeight, width: Math.round((settings.screenHeight * 16) / 9), frameRate: settings.screenFps },
        webcam: settings.webcam ? { height: settings.webcamHeight, width: Math.round((settings.webcamHeight * 16) / 9), frameRate: 15, audio: settings.webcamAudio } : null,
        iceServers: settings.iceServers,
    };
}

// ---------------------------------------------------------------- Devices

export interface CaptureDevice {
    _id: string;
    contestKey: string;
    /** Shown in the list; usually the seat. */
    name: string;
    /** Matched against the seat onsite-toolkit imports for each team. */
    seat: string;
    /** A team bound by hand, when the seat does not identify one. */
    teamUid: number | null;
    /** In the capture link. Kept readable, like the overlay token, so managers can copy links again. */
    secret: string;
    /** When the secret was last regenerated (the creation time before that). */
    secretAt?: Date;
    createdAt: Date;
    lastSeen: Date | null;
    /** The connection (process and socket) the device is on, null when it is not connected. */
    connection: string | null;
    /** What the capture page has captured right now. */
    streams: CaptureStream[];
    client: { agent: string; ip: string; screen: string } | null;
}

export const newCaptureSecret = () => randomBytes(24).toString('base64url');

/**
 * The device a contestant's own capture window uses when no device covers their seat yet: one per
 * team, with a fixed id so that two Hydro processes creating it at once end up with the same one.
 */
export const participantDeviceId = (contestKey: string, teamUid: number) => createHash('sha256').update(`capture\n${contestKey}\n${teamUid}`).digest('hex').slice(0, 24);
export function captureSecretMatches(given: string, stored: string) {
    const a = Buffer.from(String(given));
    const b = Buffer.from(String(stored));
    return a.length === b.length && timingSafeEqual(a, b);
}

/** A device that has not been heard from for this long counts as offline, also when a process died. */
export const CAPTURE_ONLINE_MS = 45_000;
export const isCaptureOnline = (device: Pick<CaptureDevice, 'connection' | 'lastSeen'>, now: number) => !!device.connection
    && !!device.lastSeen && now - new Date(device.lastSeen).getTime() < CAPTURE_ONLINE_MS;

export function normalizeDeviceInput(input: unknown, base?: Pick<CaptureDevice, 'name' | 'seat' | 'teamUid'>) {
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const device = base ? { ...base } : { name: '', seat: '', teamUid: null as number | null };
    if (raw.seat !== undefined) device.seat = String(raw.seat).trim().slice(0, 32);
    if (raw.name !== undefined) device.name = String(raw.name).trim().slice(0, 40);
    if (!device.name) device.name = device.seat;
    if (!device.name) throw new CaptureError('请填写座位号或设备名称');
    if (raw.teamUid !== undefined) {
        if (raw.teamUid === null || raw.teamUid === '') device.teamUid = null;
        else {
            const uid = Number(raw.teamUid);
            if (!Number.isSafeInteger(uid) || uid === 0) throw new CaptureError('绑定的队伍无效');
            device.teamUid = uid;
        }
    }
    return device;
}

/** The board still hides the end of the contest: frozen, and not yet unlocked (Hydro keeps the freeze after the end). */
export const boardSealed = (contest: { lockAt?: Date | null; unlocked?: boolean }) => !!contest.lockAt && !contest.unlocked;

/**
 * Whether a viewer may watch a stream. Contest staff always; the OBS overlay sees screens during the contest only
 * when allowed, otherwise from the end on, and with a freeze only once the board is unlocked: a screen must not
 * show the results before the resolver does.
 */
export function streamAllowed(stream: CaptureStream, viewer: 'staff' | 'overlay', settings: CaptureSettings,
    contest: { endAt: Date; lockAt?: Date | null; unlocked?: boolean }, now: number) {
    if (!settings.enabled) return false;
    if (stream === 'webcam') return settings.webcam;
    if (viewer === 'staff') return true;
    return settings.screenDuringContest || (now >= contest.endAt.getTime() && !boardSealed(contest));
}

/** A team's camera and screen in the overlay: devices bound to it by hand first, then by seat. */
export function captureMedias(
    teams: { teamId: string; uid: number; seat: string }[],
    devices: Pick<CaptureDevice, '_id' | 'seat' | 'teamUid'>[],
    screens: boolean,
    webcams = true,
): Record<string, Record<string, MediaType[]>> {
    const bySeat = new Map<string, string>();
    const byTeam = new Map<number, string>();
    for (const device of devices) {
        if (device.teamUid !== null) { if (!byTeam.has(device.teamUid)) byTeam.set(device.teamUid, device._id); }
        else if (device.seat && !bySeat.has(device.seat.toLowerCase())) bySeat.set(device.seat.toLowerCase(), device._id);
    }
    const result: Record<string, Record<string, MediaType[]>> = {};
    for (const team of teams) {
        const device = byTeam.get(team.uid) ?? (team.seat ? bySeat.get(team.seat.trim().toLowerCase()) : undefined);
        if (!device) continue;
        const media = (stream: CaptureStream): MediaType => ({ type: 'HydroCapture', url: '', device, stream });
        const entry: Record<string, MediaType[]> = {};
        // The screen first: the director's team views and featured runs take it by default.
        if (screens) entry.screen = [media('screen')];
        if (webcams) entry.camera = [media('webcam')];
        if (Object.keys(entry).length) result[team.teamId] = entry;
    }
    return result;
}

// ---------------------------------------------------------------- Signalling

/** What goes over the bus between Hydro processes (PM2 cluster). */
export interface CaptureEnvelope {
    origin: string;
    /** `contest`: every device or viewer of a contest (`id` is the contest), e.g. new settings. */
    to: 'device' | 'viewer' | 'contest';
    id: string;
    message: Record<string, unknown>;
}

interface Endpoint {
    send: (message: Record<string, unknown>) => void;
    close: (code: number, reason: string) => void;
}

export interface ViewerEndpoint extends Endpoint {
    contestKey: string;
    /** Contest staff, or the OBS overlay with the overlay link's token. */
    kind: 'staff' | 'overlay';
    token: string;
    /** Resolves whether this viewer may watch a device's stream (checks the device's contest too). */
    allow: (device: string, stream: CaptureStream) => Promise<boolean | string>;
}

export interface DeviceEndpoint extends Endpoint {
    contestKey: string;
    connection: string;
}

const SDP_MAX = 64 * 1024;
/** Streams one viewer connection may watch at once: each costs the contestant computer upload bandwidth. */
export const MAX_VIEWER_SESSIONS = 16;
const text = (value: unknown, max: number) => (typeof value === 'string' && value.length <= max ? value : null);
const sessionPattern = /^[\w-]{1,64}$/;

/**
 * Routes the WebRTC handshake. A viewer asks for a device's stream with an offer; the device's
 * capture page answers; both trickle ICE candidates. Sessions are named per viewer connection,
 * so nobody can address another viewer's session, and each side only reaches the sessions it
 * opened or was offered. Connections may sit in different processes: then the message goes over
 * the bus to the process that holds the other side.
 */
export class CaptureRelay {
    readonly instance = randomUUID();
    private devices = new Map<string, DeviceEndpoint>();
    private viewers = new Map<string, ViewerEndpoint>();
    /** session -> its viewer and device, in the processes the session's messages pass through. */
    private viewerSessions = new Map<string, { viewer: string; device: string; stream: CaptureStream }>();
    private deviceSessions = new Map<string, { viewer: string; device: string }>();

    constructor(private bus: (envelope: CaptureEnvelope) => void) {}

    /** A new connection of a device replaces the one it had (in any process). */
    attachDevice(id: string, endpoint: DeviceEndpoint) {
        const previous = this.devices.get(id);
        if (previous) {
            previous.close(4009, '该设备已在其他页面开始采集');
            this.detachDevice(id, previous);
        }
        this.devices.set(id, endpoint);
        this.bus({ origin: this.instance, to: 'device', id, message: { type: 'replaced', connection: endpoint.connection } });
    }

    detachDevice(id: string, endpoint: DeviceEndpoint) {
        if (this.devices.get(id) !== endpoint) return;
        this.devices.delete(id);
        for (const [session, entry] of this.deviceSessions) {
            if (entry.device !== id) continue;
            this.deviceSessions.delete(session);
            this.toViewer(entry.viewer, { type: 'ended', session, reason: '采集页已断开' });
        }
    }

    /**
     * Drop a device's connection wherever it is. 4004: for good (deleted, link regenerated); 4005:
     * capture turned off for the contest, the page waits and connects again once it is back on.
     */
    kickDevice(id: string, reason: string, code: 4004 | 4005 = 4004) {
        const endpoint = this.devices.get(id);
        if (endpoint) { endpoint.close(code, reason); this.detachDevice(id, endpoint); }
        this.bus({ origin: this.instance, to: 'device', id, message: { type: 'kick', reason, code } });
    }

    attachViewer(endpoint: ViewerEndpoint) {
        const id = randomUUID();
        this.viewers.set(id, endpoint);
        return id;
    }

    detachViewer(id: string) {
        this.viewers.delete(id);
        for (const [session, entry] of this.viewerSessions) {
            if (entry.viewer !== id) continue;
            this.viewerSessions.delete(session);
            this.toDevice(entry.device, { type: 'stop', session });
        }
    }

    /** Viewer connections of a contest, e.g. to close them when the overlay token is revoked. */
    closeViewers(contestKey: string, code: number, reason: string, keep?: (endpoint: ViewerEndpoint) => boolean) {
        for (const [id, endpoint] of this.viewers) {
            if (endpoint.contestKey === contestKey && !keep?.(endpoint)) { endpoint.close(code, reason); this.detachViewer(id); }
        }
    }

    async fromViewer(viewer: string, input: unknown) {
        const endpoint = this.viewers.get(viewer);
        if (!endpoint || !input || typeof input !== 'object') return;
        const message = input as Record<string, unknown>;
        const local = text(message.session, 64);
        if (!local || !sessionPattern.test(local)) return;
        const session = `${viewer}:${local}`;
        if (message.type === 'watch') {
            const device = text(message.device, 64);
            const stream = captureStreams.includes(message.stream as CaptureStream) ? message.stream as CaptureStream : null;
            const sdp = text(message.sdp, SDP_MAX);
            if (!device || !stream || !sdp) { endpoint.send({ type: 'error', session: local, message: '请求格式无效' }); return; }
            if (this.viewerSessions.has(session)) { endpoint.send({ type: 'error', session: local, message: '会话名重复' }); return; }
            let open = 0;
            for (const entry of this.viewerSessions.values()) if (entry.viewer === viewer) open++;
            if (open >= MAX_VIEWER_SESSIONS) { endpoint.send({ type: 'error', session: local, message: `同时观看的画面不能超过 ${MAX_VIEWER_SESSIONS} 个` }); return; }
            const allowed = await endpoint.allow(device, stream).catch(() => false);
            if (allowed !== true) {
                endpoint.send({ type: 'error', session: local, message: typeof allowed === 'string' ? allowed : '没有观看该画面的权限' });
                return;
            }
            // The viewer may have left while the check ran.
            if (!this.viewers.has(viewer)) return;
            this.viewerSessions.set(session, { viewer, device, stream });
            this.toDevice(device, { type: 'offer', session, viewer, stream, sdp });
            return;
        }
        const entry = this.viewerSessions.get(session);
        if (!entry || entry.viewer !== viewer) return;
        if (message.type === 'ice') this.toDevice(entry.device, { type: 'ice', session, candidate: candidateOf(message.candidate) });
        else if (message.type === 'stop') {
            this.viewerSessions.delete(session);
            this.toDevice(entry.device, { type: 'stop', session });
        }
    }

    fromDevice(device: string, input: unknown) {
        if (!this.devices.has(device) || !input || typeof input !== 'object') return;
        const message = input as Record<string, unknown>;
        const session = text(message.session, 200);
        const entry = session ? this.deviceSessions.get(session) : undefined;
        if (!session || !entry || entry.device !== device) return;
        if (message.type === 'answer') {
            const sdp = text(message.sdp, SDP_MAX);
            if (sdp) this.toViewer(entry.viewer, { type: 'answer', session, sdp });
        } else if (message.type === 'ice') this.toViewer(entry.viewer, { type: 'ice', session, candidate: candidateOf(message.candidate) });
        else if (message.type === 'ended') {
            this.deviceSessions.delete(session);
            this.toViewer(entry.viewer, { type: 'ended', session, reason: text(message.reason, 200) || '画面已停止' });
        }
    }

    /** New capture settings for a contest's devices (resolution, frame rate, audio), in every process. */
    configureDevices(contestKey: string, config: Record<string, unknown>) {
        const message = { type: 'config', ...config };
        this.deliverToContest(contestKey, message);
        this.bus({ origin: this.instance, to: 'contest', id: contestKey, message });
    }

    /**
     * A device of the contest connected, left or changed what it captures: contest staff watching the
     * contest (the management page, the director console) reload their device list, in every process.
     */
    devicesChanged(contestKey: string) {
        const message = { type: 'devices' };
        this.deliverToContest(contestKey, message);
        this.bus({ origin: this.instance, to: 'contest', id: contestKey, message });
    }

    /** Screens are no longer allowed for the OBS overlay: end the screens it is watching, in every process. */
    endOverlayScreens(contestKey: string) {
        const message = { type: 'end-overlay-screens' };
        this.deliverToContest(contestKey, message);
        this.bus({ origin: this.instance, to: 'contest', id: contestKey, message });
    }

    private deliverToContest(contestKey: string, message: Record<string, unknown>) {
        if (message.type === 'config') {
            for (const endpoint of this.devices.values()) if (endpoint.contestKey === contestKey) endpoint.send(message);
        } else if (message.type === 'devices') {
            for (const endpoint of this.viewers.values()) if (endpoint.contestKey === contestKey && endpoint.kind === 'staff') endpoint.send(message);
        } else if (message.type === 'end-overlay-screens') {
            for (const [session, entry] of this.viewerSessions) {
                const endpoint = this.viewers.get(entry.viewer);
                if (!endpoint || endpoint.contestKey !== contestKey || endpoint.kind !== 'overlay' || entry.stream !== 'screen') continue;
                this.deliverToViewer(entry.viewer, { type: 'ended', session, reason: '比赛结束前不提供屏幕画面' });
                this.viewerSessions.delete(session);
                this.toDevice(entry.device, { type: 'stop', session });
            }
        }
    }

    /** An envelope from another process. */
    receive(envelope: CaptureEnvelope) {
        if (envelope.origin === this.instance) return;
        if (envelope.to === 'device') this.deliverToDevice(envelope.id, envelope.message);
        else if (envelope.to === 'contest') this.deliverToContest(envelope.id, envelope.message);
        else this.deliverToViewer(envelope.id, envelope.message);
    }

    private toDevice(device: string, message: Record<string, unknown>) {
        if (!this.deliverToDevice(device, message)) this.bus({ origin: this.instance, to: 'device', id: device, message });
    }

    private toViewer(viewer: string, message: Record<string, unknown>) {
        if (!this.deliverToViewer(viewer, message)) this.bus({ origin: this.instance, to: 'viewer', id: viewer, message });
    }

    private deliverToDevice(device: string, message: Record<string, unknown>) {
        const endpoint = this.devices.get(device);
        if (message.type === 'replaced') {
            if (endpoint && endpoint.connection !== message.connection) {
                endpoint.close(4009, '该设备已在其他页面开始采集');
                this.detachDevice(device, endpoint);
            }
            return true;
        }
        if (message.type === 'kick') {
            if (endpoint) { endpoint.close(message.code === 4005 ? 4005 : 4004, String(message.reason || '采集已停止')); this.detachDevice(device, endpoint); }
            return true;
        }
        // Not connected to this process: the bus finds the process that has it.
        if (!endpoint) return false;
        const session = String(message.session);
        if (message.type === 'offer') this.deviceSessions.set(session, { viewer: String(message.viewer), device });
        else if (!this.deviceSessions.has(session)) return true;
        if (message.type === 'stop') this.deviceSessions.delete(session);
        const { viewer: _viewer, ...forward } = message;
        endpoint.send(forward);
        return true;
    }

    private deliverToViewer(viewer: string, message: Record<string, unknown>) {
        const endpoint = this.viewers.get(viewer);
        if (!endpoint) return false;
        const session = String(message.session);
        const entry = this.viewerSessions.get(session);
        if (!entry || entry.viewer !== viewer) return true;
        if (message.type === 'ended') this.viewerSessions.delete(session);
        // The viewer knows its session by the name it chose.
        endpoint.send({ ...message, session: session.slice(viewer.length + 1) });
        return true;
    }
}

function candidateOf(value: unknown) {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    const candidate = text(raw.candidate, 2000);
    if (candidate === null) return null;
    return {
        candidate,
        sdpMid: text(raw.sdpMid, 64),
        sdpMLineIndex: Number.isSafeInteger(raw.sdpMLineIndex) ? raw.sdpMLineIndex as number : null,
        usernameFragment: text(raw.usernameFragment, 256),
    };
}
