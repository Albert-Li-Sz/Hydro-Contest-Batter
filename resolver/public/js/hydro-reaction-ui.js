import { el, runtime, formatTime, copyText } from './hydro-manage-common.js';
export { el, runtime, formatTime, copyText };
export const root = document.getElementById('rx-root'),
    status = document.getElementById('rx-status');
export const notify = (msg = '', bad = false) => {
    status.textContent = msg;
    status.classList.toggle('rx-error', bad);
};
export const button = (label, fn) =>
    el('button', {
        type: 'button',
        text: label,
        onclick: () =>
            Promise.resolve()
                .then(fn)
                .catch((e) => notify(e.message, true)),
    });
export const field = (label, input) => el('label', {}, label, input);
export function select(label, options, value, change) {
    const control = el('select', { 'aria-label': label }, ...options.map(([v, n]) => el('option', { value: v, text: n })));
    control.value = value;
    if (change) control.addEventListener('change', () => change(control.value));
    return control;
}
export async function api(url, body) {
    const form = body instanceof FormData;
    const r = await fetch(url, {
        method: body === undefined ? 'GET' : 'POST',
        credentials: 'same-origin',
        headers: { Accept: 'application/json', ...(!form && body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: form ? body : JSON.stringify(body) } : {}),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok || data.error) throw new Error(typeof data.error === 'string' ? data.error : data.error?.message || '请求失败');
    return data;
}
export const action = (name, data = {}) => api(runtime.base + '/manage', { action: name, ...data });
export function play(v, download, share) {
    const d = el('dialog', { class: 'rx-dialog' }),
        copy = button('复制分享链接', async () => {
            const u = new URL(runtime.base, location.origin);
            u.searchParams.set('video', v.id);
            if (!(await copyText(u.href))) throw new Error('请在地址栏复制分享链接');
            notify('链接已复制');
        });
    const video = el('video', {
        controls: true,
        autoplay: true,
        playsinline: true,
        src: v.url,
        controlslist: download ? undefined : 'nodownload',
    });
    d.append(
        el('h2', { text: v.team + ' · ' + v.problem + ' · ' + v.verdict }),
        video,
        el(
            'div',
            { class: 'rx-actions' },
            download ? el('a', { href: v.url + '?download=1', download: true, text: '下载 MP4' }) : null,
            share ? copy : null,
            button('关闭', () => d.close()),
        ),
    );
    document.body.append(d);
    d.addEventListener('close', () => {
        video.pause();
        d.remove();
    });
    d.showModal();
    return d;
}

export function pageControls(page, pages, change) {
    const move = (label, number) => {
        const control = button(label, () => change(number));
        control.disabled = number === page;
        return control;
    };
    const input = el('input', { type: 'number', min: 1, max: pages, value: page, 'aria-label': '跳至页码', style: 'width:5em' });
    const jump = () => {
        const n = Number(input.value);
        if (Number.isSafeInteger(n) && n >= 1 && n <= pages) return change(n);
        input.reportValidity();
    };
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') jump();
    });
    return el(
        'nav',
        { class: 'rx-actions', 'aria-label': '视频分页' },
        move('首页', 1),
        move('上一页', Math.max(1, page - 1)),
        `${page} / ${pages}`,
        move('下一页', Math.min(page + 1, pages)),
        move('末页', pages),
        input,
        button('跳转', jump),
    );
}
