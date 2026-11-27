import { ceremonyPlayer } from './ceremony-player.js';
import { printableImage, imageData } from './image-upload.js';
import { inkOn } from './ink.js';
import { readJSONResponse } from './http.js';

const runtime = JSON.parse(document.querySelector('#ceremony-runtime').textContent);
const byId = id => document.getElementById(id);
const form = byId('ceremony-form');
const fields = form.elements;
const status = byId('ceremony-status');
let config = runtime.config;
let deck;
let background = runtime.background;
let ink = '#ffffff';
let requestId = 0;
let debounce;
let player;
let boardKey = '';
const submit = async (url, data, multipart = false) => {
    const body = multipart ? new FormData() : JSON.stringify(data);
    if (multipart) for (const [key, value] of Object.entries(data)) body.append(key, value);
    const response = await fetch(url, { method: 'POST', headers: multipart ? { Accept: 'application/json' } :
        { 'Content-Type': 'application/json', Accept: 'application/json' }, body });
    return readJSONResponse(response);
};
for (const item of runtime.sources) fields.source.add(new Option(item.name, item.id));
for (const [key, label] of Object.entries(runtime.themes)) fields.theme.add(new Option(label, key));
for (const [key, value] of Object.entries(config)) {
    if (key === 'boards') continue;
    if (fields[key].type === 'checkbox') fields[key].checked = value;
    else fields[key].value = key === 'reverse' ? (value ? 'reverse' : '') : value;
}
function readConfig() {
    const result = { ...config };
    for (const key of Object.keys(result)) {
        const field = fields[key];
        if (key === 'boards') continue;
        result[key] = field.type === 'checkbox' ? field.checked : field.type === 'number' ? field.valueAsNumber :
            key === 'reverse' ? !!field.value : field.value;
    }
    if (boardKey) result.boards = [...form.querySelectorAll('[name=board]:checked')].map(input => input.value);
    return result;
}
function boardOptions(boards) {
    const key = JSON.stringify(boards);
    if (key === boardKey) return;
    boardKey = key;
    byId('ceremony-boards').replaceChildren(...boards.map(board => {
        const label = document.createElement('label'), input = document.createElement('input');
        input.type = 'checkbox'; input.name = 'board'; input.value = board.id; input.checked = config.boards.includes(board.id);
        label.append(input, ' ' + board.name); return label;
    }));
}
function show() {
    if (!deck) return;
    const appearance = { ...config, background, ink };
    if (player) player.update(deck, appearance);
    else player = ceremonyPlayer(byId('ceremony-stage'), deck, appearance, (i, n) => {
        byId('ceremony-count').textContent = n ? (i + 1) + ' / ' + n : '0 / 0';
        byId('ceremony-prev').disabled = i <= 0;
        byId('ceremony-next').disabled = i >= n - 1;
        for (const id of ['ceremony-play', 'ceremony-export']) byId(id).disabled = !n;
    });
}
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
    ++requestId; clearTimeout(debounce); debounce = setTimeout(refresh, 120);
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
        const appearance = { ...config, ink, background: background ? await asset(background) : '' };
        const urls = new Set(offline.slides.flatMap(slide => slide.teams.map(team => team.logo)).filter(Boolean));
        appearance.embeddedLogos = {};
        for (const url of urls) appearance.embeddedLogos[url] = await asset(url);
        const json = value => JSON.stringify(value).replace(/</g, '\\u003c');
        const css = await asset(byId('ceremony-css').href, true);
        const html = `<!DOCTYPE html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>颁奖幻灯片</title><style>${css}</style><body class="ceremony-offline"><main class="ceremony-stage" tabindex="0" aria-label="颁奖幻灯片播放"></main><script>(${ceremonyPlayer.toString()})(document.querySelector('main'),${json(offline)},${json(appearance)});<\/script></body></html>`;
        const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
        status.textContent = blob.size > 30 * 1024 ** 2 ? '离线网页超过 30 MB，可缩小背景图片或减少榜单后重新下载。' : '离线网页已生成';
        const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = offline.title + '·颁奖.html';
        link.click(); setTimeout(() => URL.revokeObjectURL(link.href), 30000);
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
};
refresh();
