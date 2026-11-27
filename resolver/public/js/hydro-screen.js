// Hydro big-screen page. Draws one program item with the ICPC Tools presentation ports from
// Resolver-Web v1.4.0 (PresentationView) or, for the resolver item, follows a resolver session
// read-only like Resolver-Web's watch.js. Data comes from the plugin's tokenised data endpoint.
import { PresentationView } from './render/presentation-view.js';
import { ResolverView } from './render/resolver-view.js';
import { HydroScreenExtras } from './hydro-screen-extras.js';

const runtime = JSON.parse(document.getElementById('screen-runtime').textContent);
const canvas = document.getElementById('screen');
const content = document.getElementById('screen-content');
const extras = new HydroScreenExtras(content);
const statusEl = document.getElementById('screen-status');
let type = runtime.type;
let scale = 1;
let pairing = !!runtime.device;
let identifyTimer;
let identifyUntil = 0;
let reloadAt = 0;
const pairPanel = document.getElementById('screen-pair');
const identify = document.getElementById('screen-identify');

let state = null;          // last presentation payload
let offset = 0;            // server clock minus local clock
let itemKey = '';
let itemStartedAt = performance.now();
let presentation = null;
let resolver = null;       // { view, session, steps, playback }
let failures = 0;
let lastFrame = performance.now();
let loaded = null;
let nextContentFrame = 0;
let paintedState = null;
// Remote keys from the device row: page offset and pause apply to the current item only.
let pageOffset = 0;
let paused = false;
let pausedElapsed = 0;
let acks = [];
const executed = new Set();
let watching = false;
let thumbAt = 0;
let thumbType = null;
let thumbBusy = false;

function status(text) {
    statusEl.textContent = text || '';
    statusEl.hidden = !text;
}

function size() {
    // Render at the physical resolution of the screen, capped at 4K.
    const ratio = Math.min(window.devicePixelRatio || 1, 3);
    const width = Math.min(3840, Math.round(window.innerWidth * ratio));
    const height = Math.round(width * window.innerHeight / window.innerWidth);
    // ResolverView sizes its own canvas from the display settings.
    if (!(resolver && !state) && (canvas.width !== width || canvas.height !== height)) {
        canvas.width = width;
        canvas.height = height;
    }
}

function noticeItem(text) {
    return { type: 'message', text };
}

function applyResolver(data) {
    if (!data.session) {
        resolver?.view.dispose?.();
        resolver = null;
        state = { item: noticeItem(data.notice || '等待滚榜开始'), data: null, locale: data.locale };
        return;
    }
    state = null;
    if (data.delta) {
        const { from, steps } = data.delta;
        if (!resolver || resolver.session !== data.session || from !== resolver.playback.index ||
            data.playback.revision !== resolver.playback.revision + 1 || steps.length !== data.playback.index - from) {
            throw new Error('观众进度不同步');
        }
        // A long forward seek can skip hundreds of frames. Rebuild once in that case.
        for (const step of steps) resolver.steps.push(step);
        if (data.playback.currentAction === resolver.playback.currentAction + 1) {
            for (const step of steps) resolver.view.applyStep(step);
        } else resolver.view.seek(resolver.steps, data.playback.index);
        resolver.playback = data.playback;
        return;
    }
    if (!data.game) {          // unchanged since the last poll
        if (resolver) resolver.playback = data.playback;
        return;
    }
    const steps = data.game.steps;
    const next = data.playback;
    if (resolver && resolver.session === data.session && next.revision === resolver.playback.revision + 1
        && steps.length > resolver.steps.length) {
        // One step forward: animate it as the presenter sees it.
        for (const step of steps.slice(resolver.steps.length)) resolver.view.applyStep(step);
    } else {
        if (!resolver || resolver.session !== data.session) {
            resolver?.view.dispose?.();
            const baseRows = data.game.options?.rowsPerScreen || 12;
            const game = scale === 1 ? data.game : { ...data.game, options: { ...data.game.options, rowsPerScreen: Math.round(baseRows / scale) } };
            resolver = { view: new ResolverView(canvas, game), session: data.session, baseRows };
        }
        resolver.view.seek(steps, steps.length - 1);
    }
    Object.assign(resolver, { steps, playback: next });
}

function releaseProgram() {
    resolver?.view.dispose();
    resolver = presentation = paintedState = state = loaded = null;
    content.querySelectorAll('video').forEach(video => { video.pause(); video.removeAttribute('src'); video.load(); });
    content.replaceChildren(); delete content.dataset.type;
    extras.key = itemKey = '';
    content.hidden = canvas.hidden = true;
    for (const key of ['session', 'index', 'revision']) delete canvas.dataset[key];
}
function applyScale(value) {
    scale = value;
    document.documentElement.style.setProperty('--screen-scale', String(scale));
    canvas.dataset.logicalWidth = String(Math.round(1920 / scale));
    if (resolver) {
        resolver.view.options.rowsPerScreen = Math.round((resolver.baseRows || 12) / scale);
        resolver.view.resize();
    }
    extras.key = ''; paintedState = null;
}
function switchDevice(data) {
    const device = data.device;
    if (type !== data.type) { releaseProgram(); type = data.type; }
    pairing = false; pairPanel.hidden = true;
    document.body.dataset.program = type;
    if (scale !== device.scale) applyScale(device.scale);
    document.title = device.name;
    if (device.identifyUntil > data.serverTime && identifyUntil !== device.identifyUntil) {
        identifyUntil = device.identifyUntil; identify.textContent = device.name; identify.hidden = false;
        clearTimeout(identifyTimer); identifyTimer = setTimeout(() => { identify.hidden = true; }, 5000);
    }
    const key = 'xcpcio-screen-reload/' + device.id;
    if (device.reloadAt && reloadAt !== device.reloadAt && sessionStorage.getItem(key) !== String(device.reloadAt)) {
        reloadAt = device.reloadAt; sessionStorage.setItem(key, String(reloadAt)); location.reload();
    }
}
async function requestPair() {
    const response = await fetch(runtime.pairUrl, { method: 'POST', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || '配对失败');
    if (data.paired) { pairing = false; return true; }
    releaseProgram(); type = null;
    identify.hidden = true; pairPanel.hidden = false;
    document.body.dataset.program = 'pair'; document.title = '大屏配对';
    document.getElementById('screen-code').textContent = data.code;
    document.getElementById('screen-site').textContent = location.host;
    status(''); failures = 0;
    return false;
}
function currentElapsed() { return paused ? pausedElapsed : Math.max(0, performance.now() - itemStartedAt); }
function remoteState() {
    const page = type !== 'resolver' && extras.page?.total > 1 ? { page: extras.page.current + 1, pages: extras.page.total } : {};
    return { ...page, paused, fullscreen: !!document.fullscreenElement };
}
async function runCommand(key) {
    if (key === 'prev' || key === 'next') {
        // A command can arrive with the poll that switched the screen: lay out the current item first.
        const custom = type !== 'resolver' && !!state && extras.show(state, currentElapsed(), pageOffset);
        if (!custom || !(extras.page?.total > 1)) return { ok: false, message: '该画面不能翻页' };
        const { total, current } = extras.page;
        pageOffset += key === 'next' ? 1 : -1;
        paintedState = null;
        return { ok: true, message: '', state: { ...remoteState(), page: ((current + (key === 'next' ? 1 : -1)) % total + total) % total + 1 } };
    }
    if (key === 'pause') {
        if (type === 'resolver') return { ok: false, message: '滚榜画面跟随主持人' };
        if (paused) { itemStartedAt = performance.now() - pausedElapsed; paused = false; }
        else { pausedElapsed = currentElapsed(); paused = true; }
        paintedState = null;
        return { ok: true, message: paused ? '已暂停' : '已继续' };
    }
    if (key === 'fullscreen') {
        if (document.fullscreenElement) return { ok: true, message: '' };
        try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); return { ok: true, message: '' }; }
        catch { return { ok: false, message: '需在大屏上点击一次' }; }
    }
    if (key === 'exit-fullscreen') {
        if (!document.fullscreenElement) return { ok: false, message: '未处于全屏' };
        try { await document.exitFullscreen(); return { ok: true, message: '' }; }
        catch { return { ok: false, message: '浏览器未退出全屏' }; }
    }
    return { ok: false, message: '未知按键' };
}
async function runCommands(commands) {
    let ran = false;
    for (const command of commands) {
        if (executed.has(command.id)) continue;
        executed.add(command.id);
        if (executed.size > 64) executed.delete(executed.values().next().value);
        const result = await runCommand(command.key);
        acks.push({ id: command.id, ok: result.ok, message: result.message, state: result.state || remoteState() });
        ran = true;
    }
    return ran;
}
// What the manager's device row shows: a frame of the canvas, or the markup of a DOM screen.
function frameData(source, width, height) {
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(width)); c.height = Math.max(1, Math.round(height));
    c.getContext('2d').drawImage(source, 0, 0, c.width, c.height);
    const webp = c.toDataURL('image/webp', 0.6);
    return webp.startsWith('data:image/webp') ? webp : c.toDataURL('image/jpeg', 0.7);
}
function snapshot() {
    const clone = content.cloneNode(true);
    clone.removeAttribute('hidden');
    clone.style.setProperty('--screen-scale', String(scale));
    // Media the manager's browser cannot load (device routes, videos) become small still images.
    const live = [...content.querySelectorAll('video, img')], copies = [...clone.querySelectorAll('video, img')];
    live.forEach((element, i) => {
        const copy = copies[i];
        const local = element.tagName === 'VIDEO' || new URL(element.currentSrc || element.src, location.href).pathname.startsWith('/xcpcio-screen/');
        if (!local) return;
        const width = element.tagName === 'VIDEO' ? element.videoWidth : element.naturalWidth, height = element.tagName === 'VIDEO' ? element.videoHeight : element.naturalHeight;
        let src = '';
        try { if (width && height) src = frameData(element, 320, 320 * height / width); } catch { src = ''; }
        const image = document.createElement('img');
        for (const name of ['class', 'style', 'alt']) if (copy.hasAttribute(name)) image.setAttribute(name, copy.getAttribute(name));
        if (src) image.src = src;
        copy.replaceWith(image);
    });
    for (const element of clone.querySelectorAll('script, iframe, frame, object, embed, form, link, meta, base, portal')) element.remove();
    for (const element of [clone, ...clone.querySelectorAll('*')]) {
        for (const { name, value } of [...element.attributes]) {
            if (/^on/i.test(name) || /^\s*javascript:/i.test(value)) element.removeAttribute(name);
        }
    }
    let html = clone.outerHTML;
    if (html.length > 96 * 1024) {
        const heading = clone.querySelector('.screen-heading');
        clone.replaceChildren(...heading ? [heading] : []);
        html = clone.outerHTML;
    }
    return html;
}
async function sendThumb() {
    if (thumbBusy || pairing || !watching) return;
    thumbBusy = true;
    try {
        let payload = null;
        if (!canvas.hidden && canvas.width) {
            payload = { kind: 'image', data: frameData(canvas, 384, 384 * canvas.height / canvas.width) };
        } else if (!content.hidden) payload = { kind: 'html', data: snapshot() };
        if (!payload) return;
        const response = await fetch(runtime.thumbUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ ...payload, width: innerWidth, height: innerHeight, type }), signal: AbortSignal.timeout(10000) });
        if (response.ok) { thumbAt = Date.now(); thumbType = type; }
    } catch { /* the next poll tries again */ } finally { thumbBusy = false; }
}
async function poll() {
    let delay = type === 'resolver' ? 1000 : 3000;
    try {
        if (pairing && !await requestPair()) return;
        const url = new URL(runtime.dataUrl, location.href);
        if (runtime.device) url.searchParams.set('client', JSON.stringify({
            width: innerWidth, height: innerHeight, screenWidth: screen.width, screenHeight: screen.height,
            dpr: devicePixelRatio, fullscreen: !!document.fullscreenElement, version: runtime.version,
        }));
        const sent = acks;
        if (sent.length) url.searchParams.set('acks', JSON.stringify(sent));
        if (type === 'resolver' && resolver) {
            url.searchParams.set('revision', resolver.playback.revision);
            url.searchParams.set('session', resolver.session);
            url.searchParams.set('index', resolver.playback.index);
        }
        const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
        if (response.status === 404) {
            resolver?.view.dispose?.();
            resolver = null;
            state = { item: noticeItem('大屏链接已作废，请向管理员获取新链接'), data: null, locale: state?.locale };
            status('大屏链接已作废，请向管理员获取新链接');
            delay = 30000;
            return;
        }
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (runtime.device) {
            acks = acks.filter(ack => !sent.includes(ack));
            if (!data.paired) { pairing = true; await requestPair(); return; }
            switchDevice(data);
            delay = type === 'resolver' ? 1000 : 3000;
        }
        offset = data.serverTime - Date.now();
        if (type === 'resolver') {
            try { applyResolver(data); }
            catch {
                resolver?.view.dispose?.();
                resolver = null;
                status('正在重新同步滚榜画面');
                return;
            }
        }
        else state = data.notice ? { item: noticeItem(data.notice), data: null, locale: data.locale } : data;
        const key = JSON.stringify([state?.item, state?.type === 'announce' ? state.data?.[0]?.id : undefined]);
        // Paging and pause from the device row apply to the item on screen; the next item starts afresh.
        if (key !== itemKey) { itemKey = key; itemStartedAt = performance.now(); pageOffset = 0; paused = false; pausedElapsed = 0; }
        failures = 0;
        status('');
        if (runtime.device) {
            const ran = await runCommands(data.device.commands || []);
            watching = !!data.device.watch;
            if (watching && (ran || thumbType !== type || Date.now() - thumbAt >= 10000)) setTimeout(sendThumb, ran ? 400 : 0);
        }
    } catch (error) {
        if (pairing) status(error.message);
        // Keep the last picture; only mention the problem when it persists.
        if (++failures >= 3 && !pairing) status('连接中断，保留当前画面并持续重试');
        delay = Math.min(15000, 1000 * 2 ** Math.min(failures, 4));
    } finally {
        setTimeout(poll, delay);
    }
}

function frame(now) {
    const dt = Math.min(64, Math.max(0, now - lastFrame));
    lastFrame = now;
    requestAnimationFrame(frame);
    if (pairing) return;
    size();
    if (resolver && !state) {
        canvas.hidden = false;
        content.hidden = true;
        try {
            resolver.view.update(dt);
            resolver.view.render(now);
            canvas.dataset.session = resolver.session;
            canvas.dataset.revision = String(resolver.playback.revision);
            canvas.dataset.index = String(resolver.playback.index);
        } catch {
            resolver.view.dispose?.();
            resolver = null;
            status('画面绘制失败，正在重新同步');
        }
    } else if (state) {
        // A frame's timestamp can precede a poll that has just restarted the item's clock.
        const elapsed = paused ? pausedElapsed : Math.max(0, now - itemStartedAt);
        if (paintedState !== state || now >= nextContentFrame) {
            paintedState = state;
            nextContentFrame = now + 250;
            const custom = extras.show(state, elapsed, pageOffset);
            content.hidden = !custom;
            canvas.hidden = custom;
            if (custom && !failures) status('');
        }
        if (canvas.hidden) return;
        presentation ||= new PresentationView();
        const ctx = canvas.getContext('2d');
        // render() returns false until the fonts (including the large Chinese font) have loaded.
        const drawn = presentation.render(ctx, state.data, state.item, {
            width: canvas.width, height: canvas.height, now: Date.now() + offset,
            elapsed, locale: state.locale, scale,
        });
        if (drawn !== loaded) { loaded = drawn; if (!failures) status(drawn ? '' : '正在加载字体…'); }
    }
}

// Browsers only allow fullscreen from a user action, so a screen cannot enter it on its own:
// a click on the picture, the button, F or a double-click does. Esc leaves it.
const fullButton = document.getElementById('screen-full');
const hint = document.getElementById('screen-hint');
const supported = !!document.documentElement.requestFullscreen && document.fullscreenEnabled !== false;
function enterFullscreen() {
    if (document.fullscreenElement || !supported) return;
    document.documentElement.requestFullscreen({ navigationUI: 'hide' })
        .catch(() => status('浏览器阻止了全屏，请使用浏览器菜单或 F11'));
}
function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen?.();
    else enterFullscreen();
}
let idleTimer = 0;
function activity() {
    document.body.classList.remove('idle');
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => document.body.classList.add('idle'), 3000);
}
function fullscreenChanged() {
    const full = !!document.fullscreenElement;
    document.body.classList.toggle('fullscreen', full);
    fullButton.textContent = full ? '退出全屏' : '全屏';
    fullButton.title = full ? '退出全屏 (Esc)' : '全屏 (F)';
    hint.hidden = full || !supported || window.self !== window.top;
    activity();
}
if (!supported) {
    fullButton.hidden = true;
    status('此浏览器不支持网页全屏，请使用浏览器的全屏或 F11');
}
fullButton.addEventListener('click', (event) => { event.stopPropagation(); toggleFullscreen(); });
canvas.addEventListener('click', enterFullscreen);
content.addEventListener('click', enterFullscreen);
canvas.addEventListener('dblclick', (event) => { if (document.fullscreenElement) { event.preventDefault(); document.exitFullscreen?.(); } });
window.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) toggleFullscreen();
    activity();
});
window.addEventListener('pointermove', activity, { passive: true });
document.addEventListener('fullscreenchange', fullscreenChanged);
fullscreenChanged();
poll();
requestAnimationFrame(frame);
