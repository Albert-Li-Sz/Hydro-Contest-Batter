// Public OBS pages report their own dimensions and acknowledge staff controls.
const runtime = window.__HYDRO_LIVE__;
const address = new URL(runtime.controlWs, location.href);
address.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const query = new URLSearchParams(location.search);
const storageKey = 'hydro.live.overlay.client';
function pageId() {
    const id = typeof crypto.randomUUID === 'function' ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
    try {
        // Opening a new window can copy its opener's sessionStorage. Only a reload keeps the number.
        const previous = sessionStorage.getItem(storageKey);
        if (performance.getEntriesByType('navigation')[0]?.type === 'reload' && /^[\w-]{8,64}$/.test(previous || '')) return previous;
        sessionStorage.setItem(storageKey, id);
    } catch { /* Storage may be disabled in a browser source. */ }
    return id;
}
const clientId = pageId();
function clientInfo() {
    return {
        width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scene: query.get('scene'),
        onlyWidgets: query.get('onlyWidgets'), noStatus: query.has('noStatus'), version: runtime.version, ua: navigator.userAgent,
    };
}

let badge;
let hideBadge;
function identify(number) {
    if (!badge?.isConnected) {
        badge = document.createElement('div');
        badge.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;pointer-events:none;' +
            'background:rgba(0,0,0,.55);color:white;font:bold 40vh/1 system-ui;text-shadow:0 1px 8px black';
        document.body.append(badge);
    }
    badge.dataset.hydroIdentify = String(number);
    badge.textContent = String(number);
    clearTimeout(hideBadge);
    hideBadge = setTimeout(() => badge.remove(), 5000);
}

let socket;
let retry;
let delay = 1000;
let resize;
let stopped = false;
function send(message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
}
function connect() {
    socket = new WebSocket(address);
    socket.addEventListener('open', () => {
        delay = 1000;
        send({ type: 'hello', clientId, client: clientInfo() });
    });
    socket.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.type === 'requestStatus') send({ type: 'status', client: clientInfo() });
        if (message.type !== 'command') return;
        try {
            if (message.kind === 'identify') identify(message.number);
            else if (message.kind === 'reload') setTimeout(() => location.reload(), 300);
            else throw new Error('未知操作');
            send({ type: 'ack', id: message.id, ok: true });
        } catch (error) {
            send({ type: 'ack', id: message.id, ok: false, message: error.message });
        }
    });
    socket.addEventListener('close', event => {
        if (stopped || event.code === 4004) return;
        retry = setTimeout(connect, delay);
        delay = Math.min(delay * 2, 30000);
    });
}
addEventListener('resize', () => {
    clearTimeout(resize);
    resize = setTimeout(() => send({ type: 'status', client: clientInfo() }), 500);
});
addEventListener('pagehide', () => {
    stopped = true;
    clearTimeout(retry);
    clearTimeout(resize);
    socket.close();
});
addEventListener('pageshow', event => {
    if (event.persisted) { stopped = false; connect(); }
});
connect();
