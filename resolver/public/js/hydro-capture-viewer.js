// 画面采集: watching a capture device's screen or webcam over WebRTC. Hydro passes the handshake
// (lib/live/capture.ts); the video comes straight from the contestant computer. The OBS overlay has
// its own copy of this client (live/frontend.patch, overlay/src/utils/hydroCapture.ts).
const RETRY_MS = 4000;
const ANSWER_TIMEOUT_MS = 12000;

export class CaptureViewer {
    constructor(url) {
        this.url = url;
        this.iceServers = [];
        this.sessions = new Map();
        this.counter = 0;
        this.closed = false;
        this.ready = null;
        /** Set by the page: called when the device list changed. */
        this.onDevices = null;
        this.connect();
    }

    connect() {
        if (this.closed) return;
        this.ready = new Promise((resolve) => {
            const socket = new WebSocket(this.url);
            this.socket = socket;
            socket.onmessage = (event) => {
                if (event.data === 'ping') { socket.send('pong'); return; }
                if (event.data === 'pong') return;
                let message;
                try { message = JSON.parse(event.data); } catch { return; }
                if (message.type === 'config') {
                    this.iceServers = [...Array.isArray(message.iceServers) ? message.iceServers : [],
                        // Hydro's own STUN server, on the host this page came from.
                        ...message.stunPort ? [{ urls: `stun:${location.hostname}:${message.stunPort}` }] : []];
                    resolve();
                    return;
                }
                // Contest staff hear when a device connects, leaves or changes what it captures.
                if (message.type === 'devices') { this.onDevices?.(); return; }
                this.sessions.get(message.session)?.handle(message);
            };
            socket.onclose = () => {
                for (const session of this.sessions.values()) session.fail('与 Hydro 的连接已断开');
                if (!this.closed) setTimeout(() => this.connect(), RETRY_MS);
            };
        });
        this.keepAlive ||= setInterval(() => { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send('ping'); }, 20000);
    }

    send(message) {
        if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message));
    }

    /**
     * Shows a device's stream in a <video>. `onState` hears 'connecting', 'playing' or an error
     * message; failed or ended streams are tried again until stop() is called.
     */
    watch(device, stream, video, onState = () => {}) {
        const viewer = this;
        let current = null;
        let stopped = false;
        let retry = null;
        const start = async () => {
            if (stopped) return;
            await viewer.ready;
            if (stopped) return;
            const id = `s${++viewer.counter}`;
            const pc = new RTCPeerConnection({ iceServers: viewer.iceServers });
            let timer = null;
            let answered = false;
            const outbound = [], inbound = [];
            const sendIce = (candidate) => viewer.send({ type: 'ice', session: id, candidate });
            const session = {
                handle: async (message) => {
                    if (message.type === 'answer') {
                        clearTimeout(timer);
                        try {
                            await pc.setRemoteDescription({ type: 'answer', sdp: message.sdp });
                            answered = true;
                            for (const candidate of outbound.splice(0)) sendIce(candidate);
                            for (const candidate of inbound.splice(0)) await pc.addIceCandidate(candidate).catch(() => {});
                        } catch (error) { session.fail(`连接失败：${error.message}`); }
                    } else if (message.type === 'ice' && message.candidate) {
                        if (answered) await pc.addIceCandidate(message.candidate).catch(() => {});
                        else if (inbound.length < 64) inbound.push(message.candidate);
                    } else if (message.type === 'error' || message.type === 'ended') {
                        session.fail(message.message || message.reason || '画面已停止');
                    }
                },
                fail: (reason) => {
                    if (current !== session) return;
                    current = null;
                    clearTimeout(timer);
                    viewer.sessions.delete(id);
                    pc.close();
                    video.srcObject = null;
                    onState(reason);
                    if (!stopped) retry = setTimeout(start, RETRY_MS);
                },
                close: () => {
                    clearTimeout(timer);
                    viewer.sessions.delete(id);
                    viewer.send({ type: 'stop', session: id });
                    pc.close();
                },
            };
            current = session;
            viewer.sessions.set(id, session);
            onState('connecting');
            pc.addTransceiver('video', { direction: 'recvonly' });
            if (stream === 'webcam') pc.addTransceiver('audio', { direction: 'recvonly' });
            const media = new MediaStream();
            pc.ontrack = (event) => {
                media.addTrack(event.track);
                video.srcObject = media;
                video.play?.().catch(() => {});
            };
            pc.onicecandidate = ({ candidate }) => {
                const value = candidate?.toJSON() ?? null;
                if (answered) sendIce(value);
                else outbound.push(value);
            };
            pc.onconnectionstatechange = () => {
                if (pc.connectionState === 'connected') onState('playing');
                else if (pc.connectionState === 'failed') session.fail('无法建立点对点连接，请检查网络或 STUN/TURN 设置');
                else if (pc.connectionState === 'disconnected') setTimeout(() => { if (pc.connectionState === 'disconnected') session.fail('画面连接中断'); }, 5000);
            };
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            viewer.send({ type: 'watch', session: id, device, stream, sdp: offer.sdp });
            timer = setTimeout(() => session.fail('设备没有响应'), ANSWER_TIMEOUT_MS);
        };
        start().catch((error) => onState(error.message || String(error)));
        return {
            stop() {
                stopped = true;
                clearTimeout(retry);
                current?.close();
                current = null;
                video.srcObject = null;
            },
        };
    }

    close() {
        this.closed = true;
        clearInterval(this.keepAlive);
        for (const session of this.sessions.values()) session.close();
        this.socket?.close();
    }
}

/** ws:// or wss:// like the page, for a path the server gives. */
export const socketUrl = (path) => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`;
