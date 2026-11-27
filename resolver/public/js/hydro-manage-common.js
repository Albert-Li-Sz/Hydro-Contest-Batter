// Shared helpers of the /manage pages: DOM building (text only, no HTML), requests and dialogs.
import { helpTip } from './hydro-ui.js';

export const runtime = JSON.parse(document.getElementById('manage-runtime').textContent);
export const $ = (id) => document.getElementById(id);

export function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, value);
    }
    node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
    return node;
}

async function parse(response) {
    const data = await response.json().catch(() => ({}));
    if (typeof data.url === 'string' && /\/login(?:[/?#]|$)/.test(data.url.split('?')[0])) throw new Error('请登录后重试');
    if (!response.ok || data.error) {
        const message = typeof data.error === 'string' ? data.error : data.error?.message;
        throw new Error(message || `请求失败（${response.status}），请检查登录状态与权限`);
    }
    return data;
}

/** Hydro routes `operation` to the handler's post<Operation> method. */
export async function post(operation, payload, path = runtime.base) {
    const response = await fetch(path, {
        method: 'POST', credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ operation, payload: JSON.stringify(payload) }),
    });
    return parse(response);
}

export async function get(params = {}, path = runtime.dataUrl) {
    const url = new URL(path, location.href);
    for (const [key, value] of Object.entries(params)) if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, value);
    return parse(await fetch(url, { credentials: 'same-origin', headers: { Accept: 'application/json' } }));
}

export const formatTime = (value) => {
    if (!value) return '—';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) || date.getTime() <= 0 ? '—' : date.toLocaleString('zh-CN', { hour12: false, ...(runtime.timeZone ? { timeZone: runtime.timeZone, timeZoneName: 'shortOffset' } : {}) });
};

export function randomPassword(length = 12) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
    const bytes = crypto.getRandomValues(new Uint8Array(length));
    return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join('');
}

export async function copyText(text) {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** Status line under a toolbar; errors stand out. */
export function notify(node, message, error = false) {
    node.textContent = message;
    node.classList.toggle('manage-error', error);
    node.hidden = !message;
}

/**
 * A modal form built on <dialog>. `submit` runs on confirm; throwing keeps the dialog open
 * with the message shown, so a wrong password can be retyped.
 */
/** `extra` buttons sit at the start of the action row, apart from Cancel and the confirm button. */
export function openDialog({ title, body = [], confirm = '确定', submit, extra = [] }) {
    const error = el('p', { class: 'manage-error', role: 'alert', hidden: true });
    const ok = el('button', { class: 'button primary', type: 'submit', text: confirm });
    const cancel = el('button', { class: 'button', type: 'button', text: '取消' });
    const actions = el('div', { class: 'resolver-actions' }, ...extra, extra.length ? el('span', { class: 'manage-spacer' }) : null, cancel, ok);
    const form = el('form', { method: 'dialog' }, el('h2', { text: title }), ...body, error, actions);
    const dialog = el('dialog', {}, form);
    $('hydro-resolver-config').append(dialog);
    const close = () => { dialog.close(); dialog.remove(); };
    cancel.addEventListener('click', close);
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); close(); });
    form.addEventListener('submit', async (event) => {
        event.preventDefault();
        if (!submit) { close(); return; }
        error.hidden = true;
        ok.disabled = true;
        try {
            await submit();
            close();
        } catch (failure) {
            error.textContent = failure.message || String(failure);
            error.hidden = false;
        } finally { ok.disabled = false; }
    });
    dialog.showModal();
    return { dialog, close };
}

export function field(label, control, hint) {
    const field = el('label', {}, label, control);
    return hint ? el('div', { class: 'xc-field-help' }, field, helpTip(label, hint)) : field;
}

export function input(attrs = {}) {
    return el('input', { class: 'textbox', type: 'text', ...attrs });
}

/** The operator's own password, asked before anything is deleted. */
export function adminPassword() {
    return input({ type: 'password', autocomplete: 'current-password', required: true, placeholder: '你的 Hydro 密码' });
}

/**
 * Calls `onChange` (debounced) whenever the server says the page's data changed, over a socket
 * that reconnects by itself. Returns a function that closes it.
 */
export function listen(path, onChange) {
    let socket = null;
    let closed = false;
    let opened = false;
    let timer = 0;
    const changed = () => { clearTimeout(timer); timer = setTimeout(onChange, 300); };
    const connect = () => {
        if (closed) return;
        socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}${path}`);
        socket.onmessage = (event) => {
            if (event.data === 'ping') { socket.send('pong'); return; }
            let message;
            try { message = JSON.parse(event.data); } catch { return; }
            if (message?.type === 'changed') changed();
        };
        // After a reconnect, changes made while it was away are fetched once.
        socket.onopen = () => { if (opened) changed(); opened = true; };
        socket.onclose = () => { if (!closed) setTimeout(connect, 4000); };
    };
    connect();
    return () => { closed = true; clearTimeout(timer); socket?.close(); };
}
