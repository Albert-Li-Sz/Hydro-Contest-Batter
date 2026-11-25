// 画面采集 on a contestant computer: captures the screen and the webcam once, and sends them to
// whoever Hydro lets watch (the OBS overlay, the director, the management page). The video goes
// straight to the viewer over WebRTC; Hydro only passes the handshake.
const runtime = JSON.parse(document.getElementById('capture-runtime').textContent);
const $ = (id) => document.getElementById(id);
const socketUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${runtime.ws}`;
const mediaDevices = navigator.mediaDevices;
const screenSupported = typeof mediaDevices?.getDisplayMedia === 'function';
const webcamSupported = typeof mediaDevices?.getUserMedia === 'function';
const blocked = !window.isSecureContext
    ? '画面采集需要受浏览器信任的 HTTPS 地址。请向比赛工作人员获取 HTTPS 比赛链接，重新进入比赛后开启画面采集。'
    : !screenSupported && !webcamSupported ? '当前浏览器不支持屏幕共享或摄像头。请使用桌面版 Chrome 或 Edge 打开比赛。' : '';

const state = { socket: null, profile: null, screen: null, webcam: null, sessions: new Map(), stopped: false, retry: 0, connected: false };
// The contestant's own capture window (opened from the contest's prompt) tells the contest pages it is capturing.
const channel = !blocked && runtime.channel && 'BroadcastChannel' in window ? new BroadcastChannel(runtime.channel) : null;
const pageTitle = document.title;
let recorder;
const recorderOptions = {
    uploadUrl: runtime.ws.replace(/\/ws(?=[?#]|$)/, '/segments'), send, sources: () => state,
    show: ({ active, enabled, backlogBytes, backlogSeconds, error, testing, supported }) => {
        $('record-notice').hidden = !enabled;
        const sharing = !!(state.screen || state.webcam);
        const action = active ? '正在录制' : '正在采集';
        document.title = sharing ? `● ${action} · 请勿关闭 · ${pageTitle}` : pageTitle;
        $('recording-what').textContent = '● ' + action + (state.screen && state.webcam ? '屏幕和摄像头' : state.screen ? '屏幕' : '摄像头');
        const text = [active ? '录像中' : enabled ? '等待录像' : '', testing ? '设备测试中' : '',
            backlogBytes ? `待上传 ${(backlogBytes / 1048576).toFixed(1)} MB（${backlogSeconds} 秒）` : '', error || ''].filter(Boolean);
        const message = text.join(' · ');
        if ($('record-status').textContent !== message) $('record-status').textContent = message;
        $('record-test').disabled = !state.connected || !supported || testing || !(state.screen || state.webcam);
    },
};
/** The contest's STUN/TURN servers, and Hydro's own STUN server on the host this page came from. */
const iceServers = () => [...state.profile?.iceServers || [], ...state.profile?.stunPort ? [{ urls: `stun:${location.hostname}:${state.profile.stunPort}` }] : []];

$('device-name').textContent = runtime.name;
$('device-seat').textContent = runtime.seat ? `座位 ${runtime.seat}` : '';
$('device-contest').textContent = runtime.contest;

function setStatus(text, tone = '') {
    $('status').textContent = text;
    $('status').dataset.tone = tone;
    $('status').hidden = !text;
}

function announce() {
    channel?.postMessage({ type: 'alive', streams: [...state.screen ? ['screen'] : [], ...state.webcam ? ['webcam'] : []], connected: state.connected });
}
channel?.addEventListener('message', (event) => { if (event.data?.type === 'ping') announce(); });
if (channel) setInterval(announce, 2000);

function render() {
    const recording = !!state.screen || !!state.webcam;
    // The tab and the window title say it too, so it is not closed by mistake.
    $('recording').hidden = !recording;
    document.body.dataset.recording = String(recording);
    announce();
    recorder?.sync();
    $('screen-video').srcObject = state.screen;
    $('webcam-video').srcObject = state.webcam;
    $('screen-state').textContent = state.screen ? '正在采集' : '未采集';
    $('webcam-state').textContent = state.webcam ? '正在采集' : '未采集';
    $('screen-tile').dataset.on = String(!!state.screen);
    $('webcam-tile').dataset.on = String(!!state.webcam);
    // Screens only: the contest does not capture webcams.
    const wantWebcam = state.profile ? !!state.profile.webcam : true;
    $('webcam-tile').hidden = !wantWebcam;
    const canStart = (screenSupported && !state.screen) || (wantWebcam && webcamSupported && !state.webcam);
    $('start').hidden = !blocked && !canStart;
    // Nothing to start with until Hydro has sent this device's settings.
    $('start').disabled = !!blocked || !state.profile;
    $('start').textContent = state.screen || state.webcam ? '补全采集' : '开始采集';
    const watching = [...state.sessions.values()];
    const count = (stream) => watching.filter((session) => session.stream === stream).length;
    $('watching').textContent = watching.length
        ? ['屏幕', '摄像头'].map((label, index) => [label, count(index ? 'webcam' : 'screen')]).filter(([, n]) => n).map(([label, n]) => `${label} ${n} 人观看`).join(' · ')
        : '';
}

function send(message) {
    if (state.socket?.readyState !== WebSocket.OPEN) return false;
    state.socket.send(JSON.stringify(message));
    return true;
}

let lastReportedAt = 0;
function reportStatus() {
    lastReportedAt = Date.now();
    const settings = state.screen?.getVideoTracks()[0]?.getSettings();
    send({
        type: 'status',
        streams: [...state.screen ? ['screen'] : [], ...state.webcam ? ['webcam'] : []],
        screen: settings?.width ? `${settings.width}×${settings.height}` : '',
        // Chromium tells whether the machine has more than one screen (诚信复核); other browsers send nothing.
        ...typeof globalThis.screen?.isExtended === 'boolean' ? { extended: globalThis.screen.isExtended } : {},
    });
}

function useStream(kind, stream) {
    state[kind] = stream;
    stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (state[kind] !== stream) return;
        for (const track of stream.getTracks()) track.stop();
        state[kind] = null;
        const reason = kind === 'screen' ? '屏幕共享已停止' : '摄像头采集已停止';
        for (const session of [...state.sessions.values()]) if (session.stream === kind) session.end(reason);
        render();
        reportStatus();
        setStatus(reason, 'warn');
    });
    render();
    reportStatus();
}

async function captureScreen(fromClick) {
    if (!screenSupported) return '当前浏览器不支持屏幕共享';
    if (state.screen) return;
    const { screen } = state.profile;
    setStatus('请选择“整个屏幕”并点击“分享”');
    try {
        const stream = await mediaDevices.getDisplayMedia({
            video: { width: { ideal: screen.width }, height: { ideal: screen.height }, frameRate: { ideal: screen.frameRate, max: screen.frameRate }, displaySurface: 'monitor' },
            audio: false, monitorTypeSurfaces: 'include', selfBrowserSurface: 'exclude', surfaceSwitching: 'exclude', systemAudio: 'exclude',
        });
        const surface = stream.getVideoTracks()[0]?.getSettings().displaySurface;
        if (!state.profile || state.stopped || (surface && surface !== 'monitor')) {
            for (const track of stream.getTracks()) track.stop();
            if (surface && surface !== 'monitor') return '请选择“整个屏幕”，不要只共享窗口或标签页';
            return;
        }
        useStream('screen', stream);
    } catch (error) {
        if (!fromClick) return '请点击下方按钮，在弹出的窗口中选择“整个屏幕”并点击“分享”';
        return error.name === 'NotAllowedError' ? '没有共享屏幕。请再次点击按钮，在弹出的窗口中选择“整个屏幕”并点击“分享”' : '屏幕：' + (error.message || error.name);
    }
}

async function captureWebcam() {
    // A manager can disable the webcam or microphone while its browser permission prompt is open.
    while (state.profile?.webcam && !state.stopped && !state.webcam) {
        if (!webcamSupported) return '当前浏览器不支持摄像头';
        const { webcam } = state.profile;
        try {
            const stream = await mediaDevices.getUserMedia({
                video: { width: { ideal: webcam.width }, height: { ideal: webcam.height }, frameRate: { ideal: webcam.frameRate } },
                audio: webcam.audio,
            });
            if (!state.profile?.webcam || state.stopped || state.profile.webcam.audio !== webcam.audio) {
                for (const track of stream.getTracks()) track.stop();
                continue;
            }
            useStream('webcam', stream);
        } catch (error) {
            return error.name === 'NotFoundError' ? '没有找到摄像头' : '摄像头：' + (error.message || error.name);
        }
    }
}

const pendingCapture = new Map();
function acquire(kind, request) {
    if (!pendingCapture.has(kind)) pendingCapture.set(kind, request().finally(() => pendingCapture.delete(kind)));
    return pendingCapture.get(kind);
}

// Let each permitted source start recording as soon as its picker returns.
async function capture(fromClick = false) {
    if (!state.profile) return;
    const results = await Promise.all([acquire('screen', () => captureScreen(fromClick)), acquire('webcam', captureWebcam)]);
    if (!state.profile || state.stopped) return;
    const problems = results.filter(Boolean);
    render();
    reportStatus();
    setStatus(problems.join('；'), problems.length ? 'warn' : '');
    navigator.wakeLock?.request('screen').catch(() => {});
}

/** New quality settings for what is already being captured; the webcam is opened again when its sound is turned on or off. */
async function applyProfile(previous) {
    const { screen, webcam } = state.profile;
    const video = (settings) => ({ width: { ideal: settings.width }, height: { ideal: settings.height }, frameRate: { ideal: settings.frameRate, max: settings.frameRate } });
    await state.screen?.getVideoTracks()[0]?.applyConstraints(video(screen)).catch(() => {});
    // Screens only now, or the webcam's sound turned on or off: close the webcam (opened again by capture() if still wanted).
    if (state.webcam && (!webcam || previous.webcam?.audio !== webcam.audio)) {
        for (const session of [...state.sessions.values()]) if (session.stream === 'webcam') session.end(webcam ? '摄像头设置已更新' : '本场比赛不再采集摄像头');
        for (const track of state.webcam.getTracks()) track.stop();
        state.webcam = null;
    } else if (webcam) await state.webcam?.getVideoTracks()[0]?.applyConstraints(video(webcam)).catch(() => {});
}

async function answer(message) {
    const source = message.stream === 'screen' ? state.screen : state.webcam;
    if (!source) {
        send({ type: 'ended', session: message.session, reason: message.stream === 'screen' ? '该设备没有在采集屏幕' : '该设备没有在采集摄像头' });
        return;
    }
    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const session = {
        stream: message.stream, pc, incomingIce: [],
        end: (reason) => {
            if (!state.sessions.has(message.session)) return;
            state.sessions.delete(message.session);
            pc.close();
            send({ type: 'ended', session: message.session, reason });
            render();
        },
    };
    state.sessions.set(message.session, session);
    render();
    pc.onicecandidate = (event) => send({ type: 'ice', session: message.session, candidate: event.candidate ? event.candidate.toJSON() : null });
    pc.onconnectionstatechange = () => {
        if (pc.connectionState === 'failed' || pc.connectionState === 'closed') session.end('点对点连接失败');
    };
    try {
        await pc.setRemoteDescription({ type: 'offer', sdp: message.sdp });
        for (const candidate of session.incomingIce.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
        for (const transceiver of pc.getTransceivers()) {
            const kind = transceiver.receiver.track?.kind;
            const track = kind === 'audio' ? source.getAudioTracks()[0] : source.getVideoTracks()[0];
            if (track) {
                await transceiver.sender.replaceTrack(track);
                transceiver.direction = 'sendonly';
            } else transceiver.direction = 'inactive';
        }
        const local = await pc.createAnswer();
        await pc.setLocalDescription(local);
        send({ type: 'answer', session: message.session, sdp: local.sdp });
        // Screens are text: a steady bitrate keeps code readable; the webcam needs less.
        for (const sender of pc.getSenders()) {
            if (sender.track?.kind !== 'video') continue;
            const parameters = sender.getParameters();
            if (!parameters.encodings?.length) continue;
            parameters.encodings[0].maxBitrate = message.stream === 'screen' ? (state.profile.screen.height >= 1080 ? 3_000_000 : 1_800_000) : 900_000;
            if (message.stream === 'screen') parameters.degradationPreference = 'maintain-resolution';
            sender.setParameters(parameters).catch(() => {});
        }
    } catch (error) {
        session.end(`无法开始传输：${error.message || error}`);
    }
}

function connect() {
    if (state.stopped) return;
    const socket = new WebSocket(socketUrl);
    state.socket = socket;
    setStatus('正在连接 Hydro…');
    socket.onopen = () => { state.retry = 0; state.connected = true; announce(); };
    socket.onmessage = async (event) => {
        if (event.data === 'ping') { socket.send('pong'); return; }
        if (event.data === 'pong') return;
        let message;
        try { message = JSON.parse(event.data); } catch { return; }
        if (['clock', 'test-start', 'clip-request', 'record-error'].includes(message.type)) {
            recorder.message(message).catch((error) => recorder.warn(error));
            return;
        }
        if (message.type === 'record-config') { await recorder.config({ ...state.profile, ...message }); return; }
        if (message.type === 'requestStatus') { reportStatus(); return; }
        if (message.type === 'config') {
            // On connecting (with the device's name), and again whenever a manager changes the settings.
            const previous = state.profile;
            state.profile = { ...previous, ...message };
            if (typeof message.name === 'string') $('device-name').textContent = message.name;
            if (typeof message.seat === 'string') $('device-seat').textContent = message.seat ? `座位 ${message.seat}` : '';
            await recorder.config(state.profile);
            if (previous) await applyProfile(previous);
            await capture();
        } else if (message.type === 'offer') {
            await answer(message);
        } else if (message.type === 'ice' && message.candidate) {
            const peer = state.sessions.get(message.session);
            if (peer?.pc.remoteDescription) await peer.pc.addIceCandidate(message.candidate).catch(() => {});
            else if (peer && peer.incomingIce.length < 64) peer.incomingIce.push(message.candidate);
        } else if (message.type === 'stop') {
            const session = state.sessions.get(message.session);
            if (session) { state.sessions.delete(message.session); session.pc.close(); render(); }
        }
    };
    socket.onclose = (event) => {
        state.connected = false;
        for (const session of state.sessions.values()) session.pc.close();
        state.sessions.clear();
        render();
        const reason = String(event.reason || '').replace(/^\w*Error:\s*/, '');
        // 4004: the link was regenerated, the device deleted or capture turned off; 4009: opened elsewhere.
        if ([4000, 4004, 4005, 4009].includes(event.code)) {
            recorder.reset();
            state.profile = null;
            for (const kind of ['screen', 'webcam']) {
                for (const track of state[kind]?.getTracks() || []) track.stop();
                state[kind] = null;
            }
            render();
        }
        if (event.code === 4004 || event.code === 4009) {
            state.stopped = true;
            setStatus(reason || '采集链接已失效，请向管理员获取新的链接', 'bad');
            return;
        }
        // 4000: refused when connecting (invalid link, capture off, or a server error); 4005: capture
        // turned off for the contest. Both retry slowly, so the page reconnects once it is back on.
        const waiting = event.code === 4000 || event.code === 4005;
        state.retry = waiting ? 6 : Math.min(state.retry + 1, 6);
        setStatus(`${reason || '与 Hydro 的连接已断开'}，${state.retry * 5} 秒后重试…`, waiting ? 'bad' : 'warn');
        setTimeout(connect, state.retry * 5000);
    };
}

if (runtime.window) document.body.classList.add('capture-window');
render();
if (blocked) {
    $('start').disabled = true;
    setStatus(blocked, 'bad');
} else {
    $('record-test').addEventListener('click', () => {
        if (send({ type: 'test-request' })) $('record-status').textContent = '已请求设备自检，等待 Hydro 下发测试。';
    });
    $('start').addEventListener('click', () => capture(true));
    setInterval(() => {
        if (state.socket?.readyState !== WebSocket.OPEN) return;
        state.socket.send('ping');
        if (Date.now() - lastReportedAt >= 20_000) reportStatus();
    }, 15000);
    // The browser asks before closing the window while it is recording.
    window.addEventListener('beforeunload', (event) => {
        if (state.screen || state.webcam) { event.preventDefault(); event.returnValue = '画面采集中，关闭后将中断'; }
    });
    window.addEventListener('pagehide', () => {
        send({ type: 'record-status', closed: true });
        channel?.postMessage({ type: 'closed' });
    });
    import('./hydro-capture-recorder.js').then(({ CaptureRecorder }) => {
        recorder = new CaptureRecorder(recorderOptions);
        connect();
    }).catch((error) => setStatus('无法加载录制器：' + error.message, 'bad'));
}
