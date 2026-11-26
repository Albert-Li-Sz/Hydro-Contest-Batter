// 画面采集 on the contest pages: asks the contestant to open the capture window, shows whether it is
// recording, and warns at once when it was closed. The capture window (live-capture/me) reports
// itself over a BroadcastChannel; a contest page cannot hold the recording itself, since every page
// change would end it.
const STYLE_ID = 'xcpcio-capture-style';
const LATER_MS = 10 * 60_000;
const SILENT_MS = 6000;

const css = `
.xcpcio-capture-chip { position: fixed; right: 16px; bottom: 16px; z-index: 2000; display: flex; align-items: center; gap: 6px; padding: 8px 14px; border: 0; border-radius: 999px; font: 13px/1.4 inherit; color: #fff; background: #d9534f; box-shadow: 0 4px 14px rgba(0,0,0,.25); cursor: pointer; }
.xcpcio-capture-chip[data-state="recording"] { background: #3c9d4f; }
.xcpcio-capture-chip[data-state="waiting"] { background: #e6a23c; }
.xcpcio-capture-chip[role="status"] { max-width: calc(100vw - 32px); cursor: default; }
.xcpcio-capture-chip[role="status"] a { color: inherit; text-decoration: underline; }
.xcpcio-capture-chip.xcpcio-capture-toast { bottom: 64px; background: #37475a; }
.xcpcio-capture-mask { position: fixed; inset: 0; z-index: 2001; display: flex; align-items: center; justify-content: center; padding: 16px; background: rgba(0,0,0,.55); }
.xcpcio-capture-dialog { max-width: 520px; width: 100%; padding: 24px 26px; border-radius: 10px; color: #222; background: #fff; box-shadow: 0 12px 40px rgba(0,0,0,.35); font-size: 15px; line-height: 1.7; }
.xcpcio-capture-dialog h2 { margin: 0 0 10px; font-size: 20px; }
.xcpcio-capture-dialog[data-tone="bad"] h2 { color: #c9302c; }
.xcpcio-capture-dialog ol { margin: 8px 0 12px; padding-left: 20px; }
.xcpcio-capture-dialog .xcpcio-capture-actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 10px; margin-top: 16px; }
.xcpcio-capture-dialog button { font: inherit; padding: 7px 18px; border-radius: 4px; border: 1px solid #c8c8c8; background: #f5f5f5; color: #333; cursor: pointer; }
.xcpcio-capture-dialog button.primary { border-color: #3b82c4; background: #3b82c4; color: #fff; }
.xcpcio-capture-dialog .xcpcio-capture-hint { margin-top: 8px; font-size: 13px; color: #c9302c; }
@media (prefers-color-scheme: dark) { .xcpcio-capture-dialog { color: #e8e8e8; background: #2b2f33; } .xcpcio-capture-dialog button { background: #3a3f44; color: #eee; border-color: #555; } }
`;

function element(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'text') node.textContent = value;
        else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
        else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
}

export function installCapturePrompt(info) {
    if (!document.getElementById(STYLE_ID)) document.head.append(element('style', { id: STYLE_ID }, css));
    if (!window.isSecureContext) {
        const notice = element('div', { class: 'xcpcio-capture-chip', role: 'status',
            text: '画面采集需要 HTTPS 地址，请向工作人员确认。' });
        try {
            const secureUrl = new URL(document.querySelector('link[rel="canonical"]')?.href);
            if (secureUrl.protocol === 'https:' && !secureUrl.username && !secureUrl.password) {
                secureUrl.pathname = location.pathname;
                secureUrl.search = '';
                secureUrl.hash = '';
                notice.replaceChildren('画面采集需要 HTTPS。', element('a', { href: secureUrl.href, text: '用 HTTPS 重新进入' }));
            }
        } catch { /* A site without a configured HTTPS URL keeps the instructions above. */ }
        document.body.append(notice);
        return () => notice.remove();
    }
    const channel = 'BroadcastChannel' in window ? new BroadcastChannel(info.channel) : null;
    const laterKey = `${info.channel}:later`;
    const seenKey = `${info.channel}:seen`;
    const state = { lastAlive: 0, streams: [], connected: false, interrupted: false, dialog: null };
    const storage = (method, key, value) => { try { return sessionStorage[method](key, value); } catch { return null; } };

    const chip = element('button', { type: 'button', class: 'xcpcio-capture-chip', 'aria-live': 'polite' });
    chip.addEventListener('click', () => (state.lastAlive && state.streams.length ? focusWindow() : showDialog()));
    document.body.append(chip);

    // The capture window this page opened, which it may bring to the front itself.
    let captureWindow = null;
    let toast = null;

    function notice(text) {
        toast?.remove();
        toast = element('div', { class: 'xcpcio-capture-chip xcpcio-capture-toast', role: 'status', text });
        document.body.append(toast);
        const shown = toast;
        setTimeout(() => { if (toast === shown) { toast.remove(); toast = null; } }, 6000);
    }

    function focusWindow() {
        if (captureWindow && !captureWindow.closed) { captureWindow.focus(); return; }
        // Look it up by name while the click lasts: only a click may raise another window.
        let found = null;
        try { found = window.open('', info.channel); } catch { found = null; }
        let blank = false;
        try { blank = !!found && found.location.href === 'about:blank'; } catch { blank = false; }
        if (found && !blank) { captureWindow = found; found.focus(); return; }
        // It runs in a window this tab cannot reach. Loading the capture page in the blank window would start
        // a second capture and stop the first (4009), so close it and say where the running one is.
        found?.close();
        channel?.postMessage({ type: 'focus' });
        notice('采集窗口在其他窗口中运行，请切换到“画面采集”窗口');
    }

    function openWindow(hint) {
        const opened = window.open(info.url, info.channel, 'popup=yes,width=620,height=780');
        if (!opened) {
            hint.replaceChildren('浏览器拦截了弹窗，',
                element('a', { href: info.url, target: info.channel, rel: 'opener', text: '点此打开采集窗口' }));
            return;
        }
        captureWindow = opened;
        opened.focus();
        storage('setItem', seenKey, '1');
        closeDialog();
    }

    function closeDialog() {
        state.dialog?.remove();
        state.dialog = null;
    }

    function showDialog() {
        closeDialog();
        const interrupted = state.interrupted;
        const hint = element('p', { class: 'xcpcio-capture-hint' });
        const open = element('button', { type: 'button', class: 'primary', text: interrupted ? '重新开启' : '开启画面采集', onclick: () => openWindow(hint) });
        const later = element('button', { type: 'button', text: '稍后', onclick: () => { storage('setItem', laterKey, String(Date.now())); closeDialog(); } });
        const dialog = element('div', { class: 'xcpcio-capture-dialog', role: 'alertdialog', 'aria-modal': 'true', 'aria-labelledby': 'xcpcio-capture-title', 'data-tone': interrupted ? 'bad' : '' },
            element('h2', { id: 'xcpcio-capture-title', text: interrupted ? '画面采集已中断' : `本场比赛${info.recording ? '录制' : '采集'}${info.webcam === false ? '屏幕' : '屏幕和摄像头'}` }),
            element('ol', {},
                element('li', { text: `在弹出的窗口中点击“开始采集”，选择“整个屏幕”并分享${info.webcam === false ? '' : '，允许使用摄像头'}。` }),
                element('li', { text: '保持该窗口打开，可以最小化。' })),
            ...(info.recording ? [element('p', { text: '本场按赛事设置录制比赛画面，供工作人员回看。反应视频公开范围及录像保存期限见本场参赛须知。' })] : []),
            hint,
            element('div', { class: 'xcpcio-capture-actions' }, ...interrupted ? [] : [later], open));
        state.dialog = element('div', { class: 'xcpcio-capture-mask' }, dialog);
        document.body.append(state.dialog);
        open.focus();
    }

    function render() {
        const alive = state.lastAlive && Date.now() - state.lastAlive < SILENT_MS;
        const recording = alive && state.streams.length > 0;
        chip.dataset.state = recording ? 'recording' : alive ? 'waiting' : 'off';
        chip.textContent = recording
            ? `● 画面采集中（${state.streams.map((stream) => (stream === 'screen' ? '屏幕' : '摄像头')).join('、')}）`
            : alive ? '请在采集窗口中点击开始' : state.interrupted ? '⚠ 画面采集已中断' : '开启画面采集';
        if (recording && state.dialog) closeDialog();
    }

    function interrupted() {
        if (state.interrupted) return;
        state.interrupted = true;
        render();
        showDialog();
    }

    channel?.addEventListener('message', (event) => {
        const message = event.data || {};
        if (message.type === 'alive') {
            const wasRecording = state.lastAlive && state.streams.length > 0;
            state.lastAlive = Date.now();
            state.streams = Array.isArray(message.streams) ? message.streams : [];
            state.connected = !!message.connected;
            if (state.streams.length) { state.interrupted = false; storage('setItem', seenKey, '1'); }
            // Sharing stopped inside a window that is still open.
            else if (wasRecording) interrupted();
            render();
        } else if (message.type === 'closed') {
            state.lastAlive = 0;
            if (state.streams.length) interrupted();
            state.streams = [];
            render();
        }
    });

    const watchdog = setInterval(() => {
        if (state.lastAlive && Date.now() - state.lastAlive >= SILENT_MS) {
            const was = state.streams.length > 0;
            state.lastAlive = 0;
            state.streams = [];
            if (was) interrupted();
        }
        render();
    }, 2000);

    channel?.postMessage({ type: 'ping' });
    render();
    // No window answered: ask, unless the contestant chose 稍后 a few minutes ago. A window that
    // recorded before in this browser session and is gone now counts as an interruption.
    const first = setTimeout(() => {
        if (state.lastAlive) return;
        if (storage('getItem', seenKey)) { interrupted(); return; }
        const later = Number(storage('getItem', laterKey) || 0);
        if (Date.now() - later > LATER_MS) showDialog();
    }, 1500);

    return () => {
        clearInterval(watchdog);
        clearTimeout(first);
        channel?.close();
        chip.remove();
        toast?.remove();
        closeDialog();
    };
}
