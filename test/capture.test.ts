import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import {
    MAX_VIEWER_SESSIONS, type CaptureEnvelope, captureMedias, captureProfile, CaptureRelay, captureSecretMatches, defaultCaptureSettings, isCaptureOnline,
    newCaptureSecret, normalizeCaptureSettings, normalizeDeviceInput, parseIceServers, participantDeviceId, streamAllowed,
} from '../lib/live/capture';
import { startStunServer, stunResponse } from '../lib/live/stun';

it('在 HTTP 采集页提示改用 HTTPS，并阻止开始采集', async () => {
    const makeElement = () => ({ textContent: '', dataset: {}, disabled: false, addEventListener() {} });
    const elements = new Map<string, ReturnType<typeof makeElement>>();
    const getElementById = (id: string) => {
        if (!elements.has(id)) elements.set(id, makeElement());
        return elements.get(id)!;
    };
    getElementById('capture-runtime').textContent = JSON.stringify({ ws: '/device/ws', name: 'A', contest: '测试比赛' });
    const sockets: Socket[] = [];
    class Socket {
        static readonly OPEN = 1;
        readonly readyState = Socket.OPEN;
        onmessage?: (event: { data: string }) => Promise<void>;
        constructor() { sockets.push(this); }
        send() {}
    }
    const script = readFileSync(new URL('../resolver/public/js/hydro-live-capture-device.js', import.meta.url), 'utf8');
    runInNewContext(script, {
        document: { getElementById, title: '测试比赛', body: makeElement() },
        window: { isSecureContext: false, addEventListener() {} },
        navigator: {}, location: { protocol: 'http:', host: '172.28.0.3' },
        WebSocket: Socket, setInterval() {},
    });
    await sockets[0]?.onmessage?.({ data: JSON.stringify({ type: 'config', screen: {}, webcam: {} }) });
    expect(getElementById('status').textContent).toContain('HTTPS');
    expect(getElementById('start').disabled).toBe(true);
    expect(sockets).toHaveLength(0);
});

it('摄像头权限仍在等待时先采集屏幕，关闭摄像头后释放迟到的摄像头轨道', async () => {
    const script = readFileSync(new URL('../resolver/public/js/hydro-live-capture-device.js', import.meta.url), 'utf8');
    const elements = new Map<string, any>();
    const getElementById = (id: string) => {
        if (!elements.has(id)) elements.set(id, { dataset: {}, textContent: id === 'capture-runtime' ? JSON.stringify({ ws: '/device/ws' }) : '' });
        return elements.get(id);
    };
    const makeStream = () => {
        const track = Object.assign(new EventTarget(), { getSettings: () => ({}), stop: vi.fn() });
        return { track, getVideoTracks: () => [track], getTracks: () => [track] };
    };
    const screen = makeStream(), camera = makeStream();
    let release: (value: typeof camera) => void = () => {};
    const mediaDevices = { getDisplayMedia: async () => screen,
        getUserMedia: vi.fn(() => new Promise<typeof camera>((resolve) => { release = resolve; })) };
    // This isolated DOM exercises permission callbacks without opening a live device socket.
    const page = runInNewContext(script + '\n({ state, capture })', { document: { title: '', body: { dataset: {} }, getElementById },
        window: { isSecureContext: false }, navigator: { mediaDevices }, location: { protocol: 'http:' }, WebSocket: { OPEN: 1 } });
    page.state.profile = captureProfile(defaultCaptureSettings());
    const pending = page.capture();
    await vi.waitFor(() => expect(page.state.screen).toBe(screen));
    expect(mediaDevices.getUserMedia).toHaveBeenCalledTimes(1);
    page.state.profile.webcam = null;
    release(camera);
    await pending;
    expect(page.state.webcam).toBeNull();
    expect(camera.track.stop).toHaveBeenCalledOnce();
    expect(screen.track.stop).toHaveBeenCalledTimes(0);
});

describe('画面采集设置与设备', () => {
    it('校验画质、STUN/TURN 与设备信息', () => {
        expect(normalizeCaptureSettings({ screenHeight: '1080', screenFps: 30, webcamAudio: true })).toMatchObject({ screenHeight: 1080, screenFps: 30, webcamAudio: true, enabled: false, screenDuringContest: true, webcam: true });
        expect(normalizeCaptureSettings({ enabled: true }).enabled).toBe(true);
        expect(() => normalizeCaptureSettings({ screenFps: 60 })).toThrow('屏幕帧率无效');
        expect(parseIceServers('stun:10.0.0.1:3478\n# 注释\n\nturn:10.0.0.1:3478 live secret')).toEqual([
            { urls: ['stun:10.0.0.1:3478'] }, { urls: ['turn:10.0.0.1:3478'], username: 'live', credential: 'secret' },
        ]);
        expect(() => parseIceServers('http://example.com')).toThrow('stun:');
        expect(() => parseIceServers('turn:10.0.0.1:3478')).toThrow('用户名和密码');
        expect(captureProfile(defaultCaptureSettings())).toMatchObject({ screen: { width: 1920, height: 1080, frameRate: 30 }, webcam: { width: 1920, height: 1080, frameRate: 30, audio: false } });
        expect(captureProfile(normalizeCaptureSettings({ webcamHeight: 480, webcamFps: 15, webcamAudio: true })).webcam).toMatchObject({ height: 480, frameRate: 15, audio: true });
        expect(captureProfile({ ...defaultCaptureSettings(), webcam: false })).toMatchObject({ webcam: null, recording: { clips: { webcam: null }, archive: { webcam: null } } });
        expect(normalizeDeviceInput({ seat: ' A-01 ' })).toEqual({ seat: 'A-01', name: 'A-01', teamUid: null });
        expect(normalizeDeviceInput({ name: '讲台机', teamUid: '-12' })).toEqual({ seat: '', name: '讲台机', teamUid: -12 });
        expect(() => normalizeDeviceInput({})).toThrow('请填写');
        const secret = newCaptureSecret();
        expect(captureSecretMatches(secret, secret)).toBe(true);
        expect(captureSecretMatches(`${secret}x`, secret)).toBe(false);
        expect(isCaptureOnline({ connection: 'p/1', lastSeen: new Date(1000) }, 20_000)).toBe(true);
        expect(isCaptureOnline({ connection: 'p/1', lastSeen: new Date(1000) }, 100_000)).toBe(false);
        expect(isCaptureOnline({ connection: null, lastSeen: new Date(1000) }, 2000)).toBe(false);
        // A contestant's own device: the same id in every process, a valid device id, one per team.
        expect(participantDeviceId('system/1', -5)).toBe(participantDeviceId('system/1', -5));
        expect(participantDeviceId('system/1', -5)).toMatch(/^[a-f\d]{24}$/);
        expect(participantDeviceId('system/1', -6)).not.toBe(participantDeviceId('system/1', -5));
        expect(normalizeCaptureSettings({}).prompt).toBe(true);
        expect(normalizeCaptureSettings({ prompt: false }).prompt).toBe(false);
    });

    it('屏幕在比赛结束前只给管理员，开启后直播画面也可用；摄像头随时可用', () => {
        const contest = { endAt: new Date(10_000) };
        // Screens on air during the contest are allowed by default; this checks the setting that forbids them.
        expect(defaultCaptureSettings().screenDuringContest).toBe(true);
        const settings = { ...defaultCaptureSettings(), enabled: true, screenDuringContest: false };
        expect(defaultCaptureSettings().enabled).toBe(false);
        expect(streamAllowed('webcam', 'overlay', settings, contest, 5000)).toBe(true);
        expect(streamAllowed('screen', 'overlay', settings, contest, 5000)).toBe(false);
        expect(streamAllowed('screen', 'staff', settings, contest, 5000)).toBe(true);
        expect(streamAllowed('screen', 'overlay', settings, contest, 10_000)).toBe(true);
        expect(streamAllowed('screen', 'overlay', { ...settings, screenDuringContest: true }, contest, 5000)).toBe(true);
        expect(streamAllowed('webcam', 'staff', { ...settings, enabled: false }, contest, 5000)).toBe(false);
        // Screens only: no webcam for anyone.
        expect(streamAllowed('webcam', 'staff', { ...settings, webcam: false }, contest, 5000)).toBe(false);
        expect(streamAllowed('screen', 'staff', { ...settings, webcam: false }, contest, 5000)).toBe(true);
    });

    it('按座位或手动绑定把设备对应到队伍，屏幕不可用时只提供摄像头', () => {
        const teams = [{ teamId: '7', uid: 7, seat: 'A-01' }, { teamId: '-3', uid: -3, seat: 'b-02' }, { teamId: '9', uid: 9, seat: '' }];
        const devices = [{ _id: 'd1', seat: 'A-01', teamUid: null }, { _id: 'd2', seat: 'B-02', teamUid: null }, { _id: 'd3', seat: '', teamUid: 9 }];
        const medias = captureMedias(teams, devices, false);
        expect(medias['7']).toEqual({ camera: [{ type: 'HydroCapture', url: '', device: 'd1', stream: 'webcam' }] });
        expect(medias['-3'].camera[0]).toMatchObject({ device: 'd2' });
        expect(medias['9'].camera[0]).toMatchObject({ device: 'd3' });
        expect(captureMedias(teams, devices, true)['7'].screen).toEqual([{ type: 'HydroCapture', url: '', device: 'd1', stream: 'screen' }]);
        // The screen comes first, so the director's team view takes it by default; screens only leave the camera out.
        expect(Object.keys(captureMedias(teams, devices, true)['7'])).toEqual(['screen', 'camera']);
        expect(captureMedias(teams, devices, true, false)['7']).toEqual({ screen: [{ type: 'HydroCapture', url: '', device: 'd1', stream: 'screen' }] });
        expect(captureMedias(teams, devices, false, false)).toEqual({});
        // A hand binding wins over the seat.
        expect(captureMedias(teams, [...devices, { _id: 'd4', seat: '', teamUid: 7 }], false)['7'].camera[0]).toMatchObject({ device: 'd4' });
    });
});

/** Two Hydro processes sharing a bus, as PM2 cluster workers do through Hydro's broadcast. */
function cluster() {
    const relays: CaptureRelay[] = [];
    const bus = (envelope: CaptureEnvelope) => { for (const relay of relays) relay.receive(structuredClone(envelope)); };
    relays.push(new CaptureRelay(bus), new CaptureRelay(bus));
    return relays;
}

function endpoint(contestKey = 'system/1') {
    const sent: any[] = [];
    const closed: [number, string][] = [];
    return { sent, closed, contestKey, send: (message: Record<string, unknown>) => sent.push(message), close: (code: number, reason: string) => closed.push([code, reason]) };
}

describe('画面采集的连接转交', () => {
    it('观看端与设备在不同进程时，经总线转交 offer、answer 和 ICE，观看端只看到自己的会话名', async () => {
        const [a, b] = cluster();
        const device = endpoint();
        b.attachDevice('dev1', { ...device, connection: 'b/1' });
        const viewerSide = endpoint();
        const viewer = a.attachViewer({ ...viewerSide, kind: 'overlay', token: 't', allow: async () => true });
        await a.fromViewer(viewer, { type: 'watch', session: 's1', device: 'dev1', stream: 'webcam', sdp: 'v=0 offer' });
        expect(device.sent).toEqual([{ type: 'offer', session: `${viewer}:s1`, stream: 'webcam', sdp: 'v=0 offer' }]);
        b.fromDevice('dev1', { type: 'answer', session: `${viewer}:s1`, sdp: 'v=0 answer' });
        b.fromDevice('dev1', { type: 'ice', session: `${viewer}:s1`, candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
        expect(viewerSide.sent).toEqual([
            { type: 'answer', session: 's1', sdp: 'v=0 answer' },
            { type: 'ice', session: 's1', candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.2 5000 typ host', sdpMid: '0', sdpMLineIndex: 0, usernameFragment: null } },
        ]);
        await a.fromViewer(viewer, { type: 'ice', session: 's1', candidate: null });
        await a.fromViewer(viewer, { type: 'stop', session: 's1' });
        expect(device.sent.slice(1)).toEqual([{ type: 'ice', session: `${viewer}:s1`, candidate: null }, { type: 'stop', session: `${viewer}:s1` }]);
        // After stop the device can no longer reach the viewer through that session.
        b.fromDevice('dev1', { type: 'answer', session: `${viewer}:s1`, sdp: 'late' });
        expect(viewerSide.sent).toHaveLength(2);
    });

    it('权限不足时不转交，并告诉观看端原因；设备和观看端都碰不到别人的会话', async () => {
        const [a] = cluster();
        const device = endpoint();
        a.attachDevice('dev1', { ...device, connection: 'a/1' });
        const denied = endpoint();
        const viewer = a.attachViewer({ ...denied, kind: 'overlay', token: 't', allow: async () => '比赛结束前不提供屏幕画面' });
        await a.fromViewer(viewer, { type: 'watch', session: 's1', device: 'dev1', stream: 'screen', sdp: 'x' });
        expect(denied.sent).toEqual([{ type: 'error', session: 's1', message: '比赛结束前不提供屏幕画面' }]);
        expect(device.sent).toEqual([]);
        const other = endpoint();
        const second = a.attachViewer({ ...other, kind: 'staff', token: '', allow: async () => true });
        await a.fromViewer(second, { type: 'watch', session: 's1', device: 'dev1', stream: 'screen', sdp: 'x' });
        // The first viewer cannot stop or feed ICE into the second viewer's session.
        await a.fromViewer(viewer, { type: 'stop', session: 's1' });
        expect(device.sent.map((message) => message.type)).toEqual(['offer']);
        // A different device cannot answer it either.
        const intruder = endpoint();
        a.attachDevice('dev2', { ...intruder, connection: 'a/2' });
        a.fromDevice('dev2', { type: 'answer', session: `${second}:s1`, sdp: 'fake' });
        expect(other.sent).toEqual([]);
        // Malformed requests are refused.
        await a.fromViewer(second, { type: 'watch', session: 'bad session!', device: 'dev1', stream: 'webcam', sdp: 'x' });
        await a.fromViewer(second, { type: 'watch', session: 's2', device: 'dev1', stream: 'audio', sdp: 'x' });
        expect(other.sent).toEqual([{ type: 'error', session: 's2', message: '请求格式无效' }]);
    });

    it('设备断开时通知观看端；同一设备在别处打开、被删除或链接重新生成时断开旧连接', async () => {
        const [a, b] = cluster();
        const first = endpoint();
        a.attachDevice('dev1', { ...first, connection: 'a/1' });
        const viewerSide = endpoint();
        const viewer = b.attachViewer({ ...viewerSide, kind: 'staff', token: '', allow: async () => true });
        await b.fromViewer(viewer, { type: 'watch', session: 's1', device: 'dev1', stream: 'webcam', sdp: 'x' });
        // Opened again in another process: the old page closes and the viewer hears the session end.
        const second = endpoint();
        b.attachDevice('dev1', { ...second, connection: 'b/2' });
        expect(first.closed).toEqual([[4009, '该设备已在其他页面开始采集']]);
        expect(viewerSide.sent).toEqual([{ type: 'ended', session: 's1', reason: '采集页已断开' }]);
        b.kickDevice('dev1', '采集链接已重新生成');
        expect(second.closed).toEqual([[4004, '采集链接已重新生成']]);
        // Capture turned off for the contest: a different code, so the page waits instead of giving up.
        const third = endpoint();
        a.attachDevice('dev1', { ...third, connection: 'a/3' });
        b.kickDevice('dev1', '已停用', 4005);
        expect(third.closed).toEqual([[4005, '已停用']]);
        // The overlay token reset closes overlay viewers, not staff ones.
        const overlay = endpoint();
        b.attachViewer({ ...overlay, kind: 'overlay', token: 'old', allow: async () => true });
        b.closeViewers('system/1', 4004, '直播链接已作废', (item) => item.kind !== 'overlay' || item.token === 'new');
        expect(overlay.closed).toEqual([[4004, '直播链接已作废']]);
        expect(viewerSide.closed).toEqual([]);
    });

    it('新设置推送给正在采集的设备；屏幕不再允许时结束直播画面正在看的屏幕；每个观看端的会话有上限', async () => {
        const [a, b] = cluster();
        const device = endpoint();
        a.attachDevice('dev1', { ...device, connection: 'a/1' });
        const otherContest = endpoint('system/2');
        a.attachDevice('dev9', { ...otherContest, connection: 'a/9' });
        b.configureDevices('system/1', { screen: { height: 1080 } });
        expect(device.sent).toEqual([{ type: 'config', screen: { height: 1080 } }]);
        expect(otherContest.sent).toEqual([]);
        const overlay = endpoint();
        const overlayId = b.attachViewer({ ...overlay, kind: 'overlay', token: 't', allow: async () => true });
        const staff = endpoint();
        const staffId = b.attachViewer({ ...staff, kind: 'staff', token: '', allow: async () => true });
        await b.fromViewer(overlayId, { type: 'watch', session: 's', device: 'dev1', stream: 'screen', sdp: 'x' });
        await b.fromViewer(overlayId, { type: 'watch', session: 'w', device: 'dev1', stream: 'webcam', sdp: 'x' });
        await b.fromViewer(staffId, { type: 'watch', session: 's', device: 'dev1', stream: 'screen', sdp: 'x' });
        device.sent.length = 0;
        a.endOverlayScreens('system/1');
        // Only the overlay's screen: its webcam and the staff screen go on.
        expect(overlay.sent).toEqual([{ type: 'ended', session: 's', reason: '比赛结束前不提供屏幕画面' }]);
        expect(staff.sent).toEqual([]);
        expect(device.sent).toEqual([{ type: 'stop', session: `${overlayId}:s` }]);
        // A viewer cannot open more sessions than the limit, nor reuse a session name.
        await b.fromViewer(staffId, { type: 'watch', session: 's', device: 'dev1', stream: 'webcam', sdp: 'x' });
        expect(staff.sent.at(-1)).toEqual({ type: 'error', session: 's', message: '会话名重复' });
        for (let i = 1; i < MAX_VIEWER_SESSIONS; i++) await b.fromViewer(staffId, { type: 'watch', session: `n${i}`, device: 'dev1', stream: 'webcam', sdp: 'x' });
        await b.fromViewer(staffId, { type: 'watch', session: 'over', device: 'dev1', stream: 'webcam', sdp: 'x' });
        expect(staff.sent.at(-1)).toEqual({ type: 'error', session: 'over', message: `同时观看的画面不能超过 ${MAX_VIEWER_SESSIONS} 个` });
    });

    it('设备变化时通知本场比赛的管理员（跨进程），不通知直播画面和其他比赛', () => {
        const [a, b] = cluster();
        const staff = endpoint();
        b.attachViewer({ ...staff, kind: 'staff', token: '', allow: async () => true });
        const local = endpoint();
        a.attachViewer({ ...local, kind: 'staff', token: '', allow: async () => true });
        const overlay = endpoint();
        b.attachViewer({ ...overlay, kind: 'overlay', token: 't', allow: async () => true });
        const otherContest = endpoint('system/2');
        b.attachViewer({ ...otherContest, kind: 'staff', token: '', allow: async () => true });
        a.devicesChanged('system/1');
        expect(staff.sent).toEqual([{ type: 'devices' }]);
        expect(local.sent).toEqual([{ type: 'devices' }]);
        expect(overlay.sent).toEqual([]);
        expect(otherContest.sent).toEqual([]);
    });

    it('kickDevice 带比赛作用域时不能跨比赛踢掉其他比赛的采集设备', () => {
        const [a, b] = cluster();
        const dev = endpoint('system/2');
        b.attachDevice('dev-other', { ...dev, connection: 'b/1' });
        a.kickDevice('dev-other', 'cross-contest', 4004, 'system/1');
        expect(dev.closed).toEqual([]);
        a.kickDevice('dev-other', 'same-contest', 4004, 'system/2');
        expect(dev.closed).toEqual([[4004, 'same-contest']]);
    });
});

describe('内置 STUN 服务', () => {
    const request = (extra = Buffer.alloc(0)) => {
        const message = Buffer.alloc(20 + extra.length);
        message.writeUInt16BE(0x0001, 0); message.writeUInt16BE(extra.length, 2); message.writeUInt32BE(0x2112a442, 4);
        for (let i = 8; i < 20; i++) message[i] = i * 7;
        extra.copy(message, 20);
        return message;
    };
    const decode = (response: Buffer) => {
        expect(response.readUInt16BE(0)).toBe(0x0101);
        expect(response.subarray(8, 20)).toEqual(request().subarray(8, 20));
        expect(response.readUInt16BE(20)).toBe(0x0020);
        const port = response.readUInt16BE(26) ^ 0x2112;
        if (response[25] === 1) {
            const ip = (response.readUInt32BE(28) ^ 0x2112a442) >>> 0;
            return { port, address: [ip >>> 24, (ip >> 16) & 255, (ip >> 8) & 255, ip & 255].join('.') };
        }
        const key = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), response.subarray(8, 20)]);
        const bytes = Buffer.from(response.subarray(28, 44).map((byte, index) => byte ^ key[index]));
        return { port, address: Array.from({ length: 8 }, (_, i) => bytes.readUInt16BE(i * 2).toString(16)).join(':') };
    };

    it('answers a Binding request with the sender\'s address (IPv4, v4-mapped and IPv6) and ignores anything else', () => {
        expect(decode(stunResponse(request(), '192.168.1.20', 54321)!)).toEqual({ port: 54321, address: '192.168.1.20' });
        expect(decode(stunResponse(request(), '::ffff:10.0.0.7', 3000)!)).toEqual({ port: 3000, address: '10.0.0.7' });
        expect(decode(stunResponse(request(), 'fe80::1:2', 1000)!)).toEqual({ port: 1000, address: 'fe80:0:0:0:0:0:1:2' });
        // A request with attributes (Chrome adds some) is answered too; its length must match.
        expect(stunResponse(request(Buffer.from([0x80, 0x28, 0, 4, 1, 2, 3, 4])), '10.0.0.1', 1)).not.toBeNull();
        const bad = request(); bad.writeUInt16BE(4, 2);
        expect(stunResponse(bad, '10.0.0.1', 1)).toBeNull();
        const notBinding = request(); notBinding.writeUInt16BE(0x0101, 0);
        expect(stunResponse(notBinding, '10.0.0.1', 1)).toBeNull();
        expect(stunResponse(Buffer.from('GET / HTTP/1.1'), '10.0.0.1', 1)).toBeNull();
        // Never larger than a request with attributes: no amplification.
        expect(stunResponse(request(), '10.0.0.1', 1)!.length).toBe(32);
        // Invalid UDP source ports (0 or >65535) must be ignored instead of crashing socket.send.
        expect(stunResponse(request(), '10.0.0.1', 0)).toBeNull();
        expect(stunResponse(request(), '10.0.0.1', -1)).toBeNull();
        expect(stunResponse(request(), '10.0.0.1', 70000)).toBeNull();
    });

    it('serves over UDP, and a second server on the same port stays quiet', async () => {
        const dgram = await import('node:dgram');
        const probe = dgram.createSocket('udp4');
        await new Promise<void>((resolve) => probe.bind(0, '127.0.0.1', resolve));
        const port = await new Promise<number>((resolve) => {
            const finder = dgram.createSocket('udp4');
            finder.bind(0, '127.0.0.1', () => { const { port: free } = finder.address(); finder.close(() => resolve(free)); });
        });
        const stop = startStunServer(port);
        const stopAgain = startStunServer(port);
        try {
            await new Promise((resolve) => setTimeout(resolve, 100));
            const answer = new Promise<Buffer>((resolve) => probe.once('message', resolve));
            probe.send(request(), port, '127.0.0.1');
            const response = await answer;
            expect(decode(response)).toEqual({ port: probe.address().port, address: '127.0.0.1' });
        } finally { stop(); stopAgain(); probe.close(); }
    });
});
