import { el, openDialog, post } from './hydro-manage-common.js';
import { eventEmblem, eventLetterhead, eventSignatures, eventTrophy, signatureFile, signatureSlots } from './certificate-event.js';
import { BLACK } from './certificate-colors.js';
import { inkPicker } from './certificate-color-picker.js';

const master = (name) => new URL('./certificate-event/' + name, import.meta.url).href;
const imageUrl = (base, slot, saved, design) => saved ? base + '/' + saved.id + '?v=' + saved.revision : master(signatureFile(design, slot));

export function eventArtwork(template, saved, assetBase, page, emblem) {
    const placed = (box, src, label) => el('img', { class: 'certificate-event-art', src, alt: label, draggable: 'false',
        style: `left:${box.x / page.width * 100}%;top:${box.y / page.height * 100}%;width:${box.width / page.width * 100}%;height:${box.height / page.height * 100}%` });
    const images = [];
    const design = template.frame;
    if (design === 'event-zh') {
        if (!template.background) images.push(placed(eventTrophy, master(eventTrophy.file), '奖章'));
        if (emblem?.mode !== 'none') images.push(placed(eventEmblem, emblem?.mode === 'custom'
            ? assetBase + '/' + emblem.id + '?v=' + emblem.revision : master(eventEmblem.file), emblem?.mode === 'custom' ? emblem.label : 'ICPC 原标'));
    } else if (!template.background) images.push(placed(eventLetterhead, master(eventLetterhead.file), 'Certificate of Achievement · ICPC'));
    signatureSlots(design).forEach((box, slot) => {
        const item = saved.find((s) => s.slot === slot && (s.design || 'event') === design);
        if (!item?.hidden) images.push(placed(box, imageUrl(assetBase, slot, item, design), box.label));
    });
    return images;
}

const png = (canvas) => new Promise((resolve, reject) => canvas.toBlob(
    (blob) => blob ? resolve(blob) : reject(new Error('签名图片生成失败')), 'image/png'));
const canvasOf = (width, height) => el('canvas', { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) });

// Preserve the colour of the strokes, remove white paper and crop the empty margin of an uploaded scan.
async function handwriting(blob) {
    if (!['image/png', 'image/jpeg'].includes(blob.type) || blob.size > 6 * 1024 * 1024) throw new Error('请选择 6 MB 以内的 PNG 或 JPEG 签名');
    const bitmap = await createImageBitmap(blob);
    try {
        if (bitmap.width * bitmap.height > 40_000_000) throw new Error('签名图片尺寸过大');
        const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
        const source = canvasOf(bitmap.width * scale, bitmap.height * scale);
        const ctx = source.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(bitmap, 0, 0, source.width, source.height);
        const pixels = ctx.getImageData(0, 0, source.width, source.height);
        let left = source.width, top = source.height, right = -1, bottom = -1;
        for (let y = 0; y < source.height; y++) for (let x = 0; x < source.width; x++) {
            const i = (y * source.width + x) * 4;
            const white = Math.min(pixels.data[i], pixels.data[i + 1], pixels.data[i + 2]) >= 246;
            if (white || pixels.data[i + 3] < 12) { pixels.data[i + 3] = 0; continue; }
            left = Math.min(left, x); right = Math.max(right, x);
            top = Math.min(top, y); bottom = Math.max(bottom, y);
        }
        if (right < left) throw new Error('签名图片中没有可见笔迹，请重新选择');
        ctx.putImageData(pixels, 0, 0);
        const w = right - left + 1, h = bottom - top + 1;
        const fit = Math.min(1, 1080 / w, 270 / h);
        const ink = canvasOf(w * fit, h * fit);
        ink.getContext('2d').drawImage(source, left, top, w, h, 0, 0, ink.width, ink.height);
        return ink;
    } finally { bitmap.close(); }
}

function drawSignature(canvas, slot, ink, name, role, captionColor) {
    const box = eventSignatures[slot];
    const mm = 25.4 / 72;
    const factor = canvas.width / (box.width / mm);
    const top = box.y / mm, w = box.width / mm;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(factor, 0, 0, factor, 0, 0);
    ctx.clearRect(0, 0, w, canvas.height / factor);
    const rule = 539 - top;
    const fit = Math.min((w - 12) / ink.width, (rule - 5) / ink.height);
    const iw = ink.width * fit, ih = ink.height * fit;
    ctx.drawImage(ink, (w - iw) / 2, rule - ih - 1, iw, ih);
    ctx.fillStyle = '#003d6c';
    ctx.fillRect(4, rule - .5, w - 8, 1);
    ctx.fillStyle = captionColor;
    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
    for (const [i, text] of [name, role].entries()) {
        if (!text) continue;
        ctx.font = '11.05px Arial, "Microsoft YaHei", sans-serif';
        const width = ctx.measureText(text).width;
        if (width > w - 6) ctx.font = `${11.05 * (w - 6) / width}px Arial, "Microsoft YaHei", sans-serif`;
        ctx.fillText(text, w / 2, (i ? 563.33 : 550.61) - top);
    }
}

export function signaturePanel(design, saved, assetBase, encode, onChange, report) {
    const cards = signatureSlots(design).map((box, slot) => {
        const original = saved.find((s) => s.slot === slot && (s.design || 'event') === design);
        const revision = original?.revision || 0;
        const save = async (action, value = {}) => {
            const result = await post('signature', { action, design, slot, revision, ...value });
            onChange(slot, result);
        };
        const download = (href) => el('a', { class: 'button', text: '下载 PNG', 'aria-label': '下载' + box.label + '图片', href, download: box.label + '.png' });
        function edit() {
            const name = el('input', { class: 'textbox', 'aria-label': '署名第一行', type: 'text', maxlength: 120, value: original?.name ?? box.name });
            const role = el('input', { class: 'textbox', 'aria-label': '署名第二行', type: 'text', maxlength: 120, value: original?.role ?? box.role });
            const file = el('input', { type: 'file', accept: 'image/png,image/jpeg', 'aria-label': '上传手写签名' });
            const canvas = canvasOf(box.width / (25.4 / 72) * 5, box.height / (25.4 / 72) * 5);
            canvas.className = 'certificate-signature-preview';
            canvas.setAttribute('aria-label', box.label + '合成预览');
            const error = el('p', { class: 'manage-error', role: 'alert', hidden: true });
            let ink, pending, captionColor = original?.captionColor || BLACK;
            const draw = () => { if (ink) drawSignature(canvas, slot, ink, name.value.trim(), role.value.trim(), captionColor); };
            const colors = inkPicker('署名颜色', captionColor, (value) => { captionColor = value; draw(); });
            function load(source) {
                ink = null; error.hidden = true;
                canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
                const work = source.then(handwriting);
                pending = work;
                work.then((value) => { if (pending === work) { ink = value; draw(); } },
                    (failure) => { if (pending === work) { error.textContent = failure.message; error.hidden = false; } });
            }
            file.addEventListener('change', () => { if (file.files[0]) load(Promise.resolve(file.files[0])); });
            name.addEventListener('input', draw); role.addEventListener('input', draw);
            if (!original?.hidden) {
                const src = original ? imageUrl(assetBase, slot, original, design) + '&part=ink' : master('ink-' + slot + '.png');
                load(fetch(src).then((r) => { if (!r.ok) throw new Error('读取签名失败'); return r.blob(); }));
            }
            const previewPng = el('button', { type: 'button', class: 'button', text: '下载预览 PNG', onclick: async () => {
                try {
                    await pending; if (!ink) throw new Error('请先上传手写签名');
                    const url = URL.createObjectURL(await png(canvas));
                    const a = download(url); a.click(); setTimeout(() => URL.revokeObjectURL(url), 30000);
                } catch (e) { error.textContent = e.message; error.hidden = false; }
            } });
            const label = (title, control) => el('label', { class: 'resolver-field' }, title, control);
            openDialog({ title: '编辑' + box.label, confirm: '生成并使用', extra: [previewPng],
                body: [el('div', { class: 'certificate-signature-form' }, label('手写签名（PNG 或 JPEG）', file),
                    label('第一行署名', name), label('第二行署名', role), colors, canvas, error)],
                submit: async () => {
                    await pending; if (!ink) throw new Error('请先上传手写签名');
                    const [data, source] = await Promise.all([png(canvas).then(encode), png(ink).then(encode)]);
                    await save('save', { data, ink: source, name: name.value.trim(), role: role.value.trim(), captionColor });
                },
            });
        }
        const action = (text, fn) => el('button', { type: 'button', class: 'button', text, 'aria-label': box.label + text,
            onclick: async (e) => { e.currentTarget.disabled = true; try { await fn(); } catch (err) { report(err.message); } finally { if (e.target.isConnected) e.target.disabled = false; } } });
        const src = imageUrl(assetBase, slot, original, design);
        return el('section', { class: 'certificate-signature-card' }, el('h5', { text: box.label }),
            original?.hidden ? el('p', { class: 'resolver-muted', text: '此处留白' }) : el('img', { src, alt: box.label + '成图' }),
            el('div', { class: 'certificate-logo-actions' }, el('button', { type: 'button', class: 'button', text: '编辑签名', 'aria-label': '编辑' + box.label, onclick: edit }),
                original?.hidden ? null : download(src), original?.hidden ? null : action('留白', () => save('clear')),
                original ? action('恢复原样', () => save('reset')) : null));
    });
    return el('fieldset', { class: 'certificate-logos certificate-signatures' }, el('legend', { text: design === 'event-zh' ? '中文赛事模板签名' : '赛事模板签名' }), ...cards);
}
