import { ceremonyPlayer } from './ceremony-player.js';
import { printableImage, imageData } from './image-upload.js';
import { inkOn } from './ink.js';
import { readJSONResponse } from './http.js';

const runtime = JSON.parse(document.querySelector('#ceremony-runtime').textContent);
const byId = id => document.getElementById(id);
const form = byId('ceremony-form');
const fields = form.elements;
const status = byId('ceremony-status');
const strip = byId('ceremony-strip');
let config = runtime.config;
let deck;
let background = runtime.background;
let ink = '#ffffff';
let requestId = 0;
let debounce;
let player;
let boardKey = '';
let thumbs = [];
let thumbJob = 0;
const submit = async (url, data, multipart = false) => {
    const body = multipart ? new FormData() : JSON.stringify(data);
    if (multipart) for (const [key, value] of Object.entries(data)) body.append(key, value);
    const response = await fetch(url, { method: 'POST', headers: multipart ? { Accept: 'application/json' } :
        { 'Content-Type': 'application/json', Accept: 'application/json' }, body });
    return readJSONResponse(response);
};
const element = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'text') node.textContent = value;
        else if (key === 'class') node.className = value;
        else if (key in node && typeof value !== 'string') node[key] = value;
        else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
};

for (const item of runtime.sources) fields.source.add(new Option(item.name, item.id));
byId('ceremony-themes').append(...Object.entries(runtime.themes).map(([key, label]) => element('label', { class: 'ce-theme' },
    element('input', { type: 'radio', name: 'theme', value: key, 'aria-label': label }),
    element('span', { class: 'ce-chip cs-theme', 'data-theme': key }), label)));
for (const holder of form.querySelectorAll('[data-zones]')) {
    holder.append(...['左', '中', '右'].map((label, i) => element('label', { class: 'ce-zone' },
        element('input', { type: 'checkbox', name: holder.dataset.zones, value: String(i), 'aria-label': label }), element('span', { text: label }))));
}
function writeForm() {
    fields.source.value = config.source;
    fields.reverse.value = config.reverse ? 'reverse' : '';
    for (const key of ['withinOrder', 'target', 'tolerance', 'columns', 'header', 'footer']) fields[key].value = String(config[key]);
    for (const key of ['cover', 'showTitle', 'showSchool', 'showMembers']) fields[key].checked = config[key];
    for (const input of form.querySelectorAll('[name=theme]')) input.checked = input.value === config.theme;
    for (const name of ['headerZones', 'footerZones']) {
        for (const input of form.querySelectorAll(`[name=${name}]`)) input.checked = !!config[name][Number(input.value)];
    }
}
function readConfig() {
    const zones = name => [0, 1, 2].map(i => !!form.querySelector(`[name=${name}][value="${i}"]`)?.checked);
    const result = {
        ...config, source: fields.source.value, reverse: !!fields.reverse.value, withinOrder: fields.withinOrder.value,
        target: fields.target.valueAsNumber, tolerance: fields.tolerance.valueAsNumber, columns: Number(fields.columns.value),
        header: fields.header.valueAsNumber, footer: fields.footer.valueAsNumber, headerZones: zones('headerZones'), footerZones: zones('footerZones'),
        theme: form.querySelector('[name=theme]:checked')?.value || config.theme,
    };
    for (const key of ['cover', 'showTitle', 'showSchool', 'showMembers']) result[key] = fields[key].checked;
    if (boardKey) result.boards = [...form.querySelectorAll('[name=board]:checked')].map(input => input.value);
    return result;
}
writeForm();
function boardOptions(boards) {
    const key = JSON.stringify(boards);
    if (key === boardKey) return;
    boardKey = key;
    byId('ceremony-boards').replaceChildren(...boards.map(board => element('label', { class: 'ce-check' },
        element('input', { type: 'checkbox', name: 'board', value: board.id, checked: config.boards.includes(board.id) }), board.name)));
}
const appearance = () => ({ ...config, background, ink });

function pageChanged(i, n) {
    byId('ceremony-count').textContent = n ? (i + 1) + ' / ' + n : '0 / 0';
    byId('ceremony-prev').disabled = i <= 0;
    byId('ceremony-next').disabled = i >= n - 1;
    for (const id of ['ceremony-play', 'ceremony-export']) byId(id).disabled = !n;
    thumbs.forEach((thumb, index) => thumb.setAttribute('aria-current', String(index === i)));
    thumbs[i]?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}
function drawStrip() {
    const job = ++thumbJob;
    thumbs = deck.slides.map((_, i) => element('button', { type: 'button', class: 'ce-thumb', 'aria-label': `第 ${i + 1} 页`, onclick: () => player.go(i) }));
    strip.replaceChildren(...thumbs);
    let next = 0;
    const batch = () => {
        if (job !== thumbJob) return;
        for (const end = Math.min(thumbs.length, next + 6); next < end; next++) {
            player.renderInto(thumbs[next], next);
            thumbs[next].append(element('b', { text: String(next + 1) }));
        }
        if (next < thumbs.length) requestAnimationFrame(batch);
        else pageChanged(player.index, deck.slides.length);
    };
    requestAnimationFrame(batch);
}
function drawList() {
    const cards = [];
    let card = null, key = '';
    deck.slides.forEach((slide, page) => {
        if (slide.kind !== 'award') return;
        const id = slide.board + '\u0000' + slide.award;
        if (id !== key) {
            key = id;
            const count = deck.slides.filter(s => s.kind === 'award' && s.board === slide.board && s.award === slide.award).reduce((n, s) => n + s.teams.length, 0);
            card = { node: element('article', { class: 'ce-award cs-theme', 'data-tier': slide.tier, 'data-theme': config.theme }), list: element('ol') };
            card.node.append(element('header', {}, element('strong', { text: slide.award }),
                ...slide.subtitle.toLowerCase() === slide.award.trim().toLowerCase() ? [] : [element('em', { text: slide.subtitle })],
                element('span', { text: `${slide.board} · ${count} 队` })), card.list);
            cards.push(card.node);
        }
        for (const team of slide.teams) {
            card.list.append(element('li', {}, element('button', { type: 'button', onclick: () => { showTab('preview'); player.go(page); } },
                element('small', { text: team.rank ? String(team.rank) : '*' }),
                element('span', {}, team.name, ...team.school ? [' ', element('small', { text: team.school })] : []),
                element('i', { text: `第 ${page + 1} 页` }))));
        }
    });
    byId('ceremony-list').replaceChildren(...cards);
}
function show() {
    if (!deck) return;
    if (player) player.update(deck, appearance());
    else player = ceremonyPlayer(byId('ceremony-stage'), deck, appearance(), pageChanged);
    drawStrip();
    drawList();
}
function showTab(tab) {
    for (const button of document.querySelectorAll('.ce-tabs [data-tab]')) button.setAttribute('aria-selected', String(button.dataset.tab === tab));
    for (const panel of document.querySelectorAll('[data-panel]')) panel.hidden = panel.dataset.panel !== tab;
}
for (const button of document.querySelectorAll('.ce-tabs [data-tab]')) button.onclick = () => showTab(button.dataset.tab);

async function refresh(save = false) {
    const id = ++requestId;
    if (!form.reportValidity()) return;
    const next = readConfig();
    try {
        const data = await submit(runtime.base, { config: JSON.stringify(next), save });
        if (id !== requestId) return;
        config = next; deck = data; boardOptions(deck.boards); show();
        status.textContent = save ? '设置已保存' : '';
    } catch (error) { if (id === requestId) status.textContent = error.message; }
}
form.addEventListener('input', event => {
    if (event.target.type === 'file') return;
    ++requestId; clearTimeout(debounce); debounce = setTimeout(refresh, 150);
});
form.onsubmit = event => { event.preventDefault(); clearTimeout(debounce); refresh(true); };
byId('ceremony-prev').onclick = () => player?.prev();
byId('ceremony-next').onclick = () => player?.next();
byId('ceremony-play').onclick = () => player?.full().catch(error => { status.textContent = error.message; });

async function backgroundInk(url) {
    if (!url) return '#ffffff';
    const image = new Image(); image.src = url; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = 32; canvas.height = 18;
    const ctx = canvas.getContext('2d'); ctx.drawImage(image, 0, 0, 32, 18);
    const pixels = ctx.getImageData(0, 0, 32, 18).data;
    const sum = [0, 0, 0];
    for (let i = 0; i < pixels.length; i += 4) for (let c = 0; c < 3; c++) sum[c] += pixels[i + c];
    return inkOn('#' + sum.map(n => Math.round(n / (pixels.length / 4)).toString(16).padStart(2, '0')).join(''));
}
async function setBackground(file) {
    try {
        const image = file ? await imageData(await printableImage(file, 3840, 'image/jpeg', 6 * 1024 ** 2)) : '';
        const { at } = await submit(runtime.base + '/background', image ? { image } : {}, !!image);
        background = at ? runtime.base + '/background?v=' + at : '';
        ink = await backgroundInk(background);
        byId('clear-background').hidden = !background; show();
    } catch (error) { status.textContent = error.message; }
}
byId('ceremony-background').onchange = event => { if (event.target.files[0]) setBackground(event.target.files[0]); event.target.value = ''; };
byId('clear-background').onclick = () => setBackground(null);
byId('clear-background').hidden = !background;
if (background) backgroundInk(background).then(color => { ink = color; show(); }).catch(error => { status.textContent = error.message; });

async function asset(url, asText = false) {
    const response = await fetch(url);
    if (!response.ok) throw new Error('离线素材读取失败');
    if (asText) return response.text();
    const blob = await response.blob();
    return new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('无法嵌入素材')); reader.readAsDataURL(blob);
    });
}
byId('ceremony-export').onclick = async ({ currentTarget: button }) => {
    button.disabled = true;
    try {
        const offline = structuredClone(deck);
        const look = { ...appearance(), background: background ? await asset(background) : '' };
        const urls = new Set(offline.slides.flatMap(slide => slide.teams?.map(team => team.logo) || []).filter(Boolean));
        look.embeddedLogos = {};
        for (const url of urls) look.embeddedLogos[url] = await asset(url);
        const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
        const css = await asset(byId('ceremony-css').href, true);
        const html = `<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${offline.title.replace(/[<&]/g, c => c === '<' ? '&lt;' : '&amp;')} · 颁奖</title><style>${css.replace(/<\//g, '<\\/')}</style><body class="ceremony-offline"><main class="ceremony-stage" tabindex="0" aria-label="颁奖幻灯片播放"></main><script>(${ceremonyPlayer.toString()})(document.querySelector('main'),${json(offline)},${json(look)},undefined,{offline:true});document.querySelector('main').focus();<\/script></body></html>`;
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        status.textContent = blob.size > 30 * 1024 ** 2 ? '离线网页超过 30 MB，可缩小背景图片或减少榜单后重新下载。' : '离线网页已生成';
        const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = offline.title + '·颁奖.html';
        link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 30000);
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
};
refresh();
