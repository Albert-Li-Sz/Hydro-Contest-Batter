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
const isResolver = runtime.type === 'resolver';
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
            resolver = { view: new ResolverView(canvas, data.game), session: data.session };
        }
        resolver.view.seek(steps, steps.length - 1);
    }
    Object.assign(resolver, { steps, playback: next });
}

async function poll() {
    let delay = isResolver ? 1000 : 3000;
    try {
        const url = new URL(runtime.dataUrl, location.href);
        if (isResolver && resolver) {
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
        offset = data.serverTime - Date.now();
        if (isResolver) {
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
        if (key !== itemKey) { itemKey = key; itemStartedAt = performance.now(); }
        failures = 0;
        status('');
    } catch {
        // Keep the last picture; only mention the problem when it persists.
        if (++failures >= 3) status('连接中断，保留当前画面并持续重试');
        delay = Math.min(15000, 1000 * 2 ** Math.min(failures, 4));
    } finally {
        setTimeout(poll, delay);
    }
}

function frame(now) {
    const dt = Math.min(64, Math.max(0, now - lastFrame));
    lastFrame = now;
    requestAnimationFrame(frame);
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
        const elapsed = Math.max(0, now - itemStartedAt);
        if (paintedState !== state || now >= nextContentFrame) {
            paintedState = state;
            nextContentFrame = now + 250;
            const custom = extras.show(state, elapsed);
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
            elapsed, locale: state.locale,
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
