import { decorationBox } from './certificate-frame.js';
import { el } from './hydro-manage-common.js';

export const artworkKey = (item) => `art:${item.id}`;
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const mm = (n) => Math.round(n * 10) / 10;

function position(item, page, changes) {
    const old = decorationBox(page, item);
    const w = clamp(changes.width ?? old.width, Math.min(1, page.height * item.aspect), Math.min(page.width, page.height * item.aspect));
    item.width = w / page.width;
    item.x = clamp(changes.x ?? old.x, 0, page.width - w) / page.width;
    item.y = clamp(changes.y ?? old.y, 0, page.height - w / item.aspect) / page.height;
}

export function artworkNode(item, page, selected, src, { select, save, showPosition }) {
    const node = el('div', { class: 'certificate-artwork' + (selected ? ' is-selected' : ''), tabindex: 0, role: 'button',
        'aria-label': `移动装饰图 ${item.label}`, 'data-id': artworkKey(item) },
    el('img', { alt: '', src, draggable: 'false' }), el('span', { class: 'certificate-resize', title: '拖动缩放', 'aria-hidden': 'true' }));
    const paint = () => {
        const { x, y, width, height } = decorationBox(page, item);
        Object.assign(node.style, { left: `${x/page.width*100}%`, top: `${y/page.height*100}%`,
            width: `${width/page.width*100}%`, height: `${height/page.height*100}%` });
    };
    paint();
    node.addEventListener('focus', () => select(node));
    node.addEventListener('keydown', (e) => {
        const delta = { ArrowLeft: [-1,0], ArrowRight: [1,0], ArrowUp: [0,-1], ArrowDown: [0,1] }[e.key];
        if (!delta) return;
        e.preventDefault();
        const box = decorationBox(page, item); const step = e.shiftKey ? 5 : 1;
        position(item, page, { x: box.x + delta[0]*step, y: box.y + delta[1]*step });
        paint(); showPosition(); save();
    });
    node.addEventListener('pointerdown', (e) => {
        if (!e.isPrimary || e.button !== 0) return;
        e.preventDefault();
        if (document.activeElement === node) select(node);
        else node.focus({ preventScroll: true });
        const start = decorationBox(page, item);
        const before = { x: item.x, y: item.y, width: item.width };
        const scale = node.parentElement.getBoundingClientRect().width / page.width;
        const resizing = e.target.classList.contains('certificate-resize');
        const move = (event) => {
            const dx = (event.clientX - e.clientX) / scale, dy = (event.clientY - e.clientY) / scale;
            // Project a corner drag onto the original image diagonal, including for very tall artwork.
            const width = start.width + (dx + dy/item.aspect) / (1 + 1/(item.aspect*item.aspect));
            position(item, page, resizing ? { x: start.x, y: start.y, width: Math.min(width, page.width-start.x, (page.height-start.y)*item.aspect) }
                : { x: start.x + dx, y: start.y + dy });
            paint(); showPosition();
        };
        node.setPointerCapture(e.pointerId);
        const end = (event) => {
            node.removeEventListener('pointermove', move);
            node.removeEventListener('lostpointercapture', end);
            node.removeEventListener('pointerup', end);
            node.removeEventListener('pointercancel', end);
            if (event.type !== 'pointerup') { Object.assign(item, before); paint(); showPosition(); }
            else if (before.x !== item.x || before.y !== item.y || before.width !== item.width) save();
        };
        node.addEventListener('pointermove', move);
        node.addEventListener('pointerup', end);
        node.addEventListener('pointercancel', end);
        node.addEventListener('lostpointercapture', end);
    });
    return node;
}

export function showArtworkPosition(host, item, page) {
    const box = decorationBox(page, item);
    for (const input of host.querySelectorAll('[data-art-mm]')) input.value = mm(box[input.dataset.artMm]);
}

export function artworkProps(item, page, { redraw, save, remove }) {
    const input = (label, key, min, max) => {
        const control = el('input', { class: 'textbox', type: 'number', 'data-art-mm': key, min, max, step: 'any',
            value: mm(decorationBox(page, item)[key]), 'aria-label': label });
        let dirty = false;
        control.addEventListener('input', () => {
            if (!Number.isFinite(control.valueAsNumber) || !control.checkValidity()) return;
            position(item, page, { [key]: control.valueAsNumber });
            dirty = true;
            redraw();
        });
        const commit = () => {
            const host = control.closest('.certificate-props');
            if (host) showArtworkPosition(host, item, page);
            if (dirty) { dirty = false; save(); }
        };
        control.addEventListener('change', commit);
        control.addEventListener('blur', commit);
        control.addEventListener('keydown', (event) => { if (event.key === 'Enter') control.blur(); });
        return el('label', { class: 'resolver-field' }, el('span', { text: label }), control);
    };
    return el('div', { class: 'certificate-props' }, el('strong', { text: item.label }),
        el('p', { class: 'resolver-muted', text: '拖动图片可移动，拖动右下角可等比缩放。位置和尺寸自动保存。' }),
        el('div', { class: 'certificate-row' }, input('图片距左（mm）', 'x', 0, page.width), input('图片距上（mm）', 'y', 0, page.height)),
        input('图片宽度（mm）', 'width', 0.01, page.width), el('button', { class: 'button', type: 'button', text: '移除装饰图', onclick: remove }));
}
