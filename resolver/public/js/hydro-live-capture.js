// 画面采集 management: capture devices (one per seat), their links and status, settings, and a
// preview of any device's screen or webcam for checking the setup before and during the contest.
import {
    $, copyText, el, field, formatTime, get, input, notify, openDialog, post, runtime,
} from './hydro-manage-common.js';
import { installRecordingTabs } from './hydro-recordings.js';
import { CaptureViewer, socketUrl } from './hydro-capture-viewer.js';

const state = { devices: [], teams: [], settings: null, screenNow: false, contest: null, selected: new Set(), filter: 'all', seat: '', loadFailed: false };
const previews = new Map();
let viewer = null;
const filterKey = `xcpcio-capture-filter:${runtime.base}`;
try { Object.assign(state, JSON.parse(localStorage.getItem(filterKey)) || {}); } catch { /* per-browser convenience only */ }

$('contest-title').textContent = runtime.title;
$('back-link').href = runtime.contestUrl;

const status = el('p', { class: 'resolver-muted', role: 'status', hidden: true });
const switchBox = el('div', { class: 'manage-alert capture-switch', role: 'status' });
const settingsBox = el('div');
const table = el('table', { class: 'data-table' });
const grid = el('div', { class: 'capture-grid' });
// The status counts are the filter: each says how many devices it shows.
const filters = el('div', { class: 'manage-segments', role: 'group', 'aria-label': '按状态筛选' });
const zones = el('datalist', { id: 'capture-zones' });
const seat = input({ type: 'search', placeholder: '座位前缀', list: 'capture-zones', value: state.seat, 'aria-label': '按座位前缀筛选', style: 'flex:0 1 140px' });
seat.addEventListener('input', () => { state.seat = seat.value.trim(); remember(); renderTable(); });
const deleteButton = el('button', { class: 'button manage-danger', type: 'button', onclick: () => removeSelected() });
const exportButton = el('button', { class: 'button', type: 'button', text: '导出链接', onclick: () => exportLinks() });
const previewStream = el('select', { class: 'select', 'aria-label': '预览的画面', style: 'width:auto;margin:0' });
const previewButton = el('button', { class: 'button', type: 'button', text: '全部预览', onclick: () => previewAll(previewStream.value) });
const closeButton = el('button', { class: 'button', type: 'button', text: '全部关闭', onclick: () => closeAll() });

$('manage-root').replaceChildren(
    ...window.isSecureContext ? [] : [el('p', { class: 'manage-alert manage-alert--error', role: 'alert',
        text: '当前地址不是 HTTPS，选手机无法采集。请用 HTTPS 打开比赛后再分发链接。' })],
    switchBox,
    el('div', { class: 'manage-group' },
        el('div', { class: 'manage-toolbar' }, filters, seat, zones, el('span', { class: 'manage-spacer' }),
            el('button', { class: 'button primary', type: 'button', text: '按座位添加', onclick: () => createFromSeats() }),
            el('button', { class: 'button', type: 'button', text: '添加', onclick: () => deviceDialog(null) }),
            exportButton, deleteButton),
        status,
        el('div', { class: 'manage-scroll' }, table)),
    el('div', { class: 'manage-group' },
        el('div', { class: 'manage-toolbar' }, el('h3', { text: '预览', style: 'margin:0' }), el('span', { class: 'manage-spacer' }),
            previewStream, previewButton, closeButton),
        grid),
    el('details', { class: 'manage-group' }, el('summary', { text: '采集设置' }), settingsBox),
);

const absolute = (path) => new URL(path, location.href).href;
const tag = (text, tone = '') => el('span', { class: `manage-tag ${tone}`, text });
const streamName = { screen: '屏幕', webcam: '摄像头' };
const remember = () => { try { localStorage.setItem(filterKey, JSON.stringify({ filter: state.filter, seat: state.seat })); } catch { /* ignore */ } };
/** The zone of a seat, as the floor screen groups them: `A-01` → `A`, `B1-12` → `B1`. */
const zoneOf = (value) => (value ? value.replace(/[\s_-]*\d+$/, '') : '');
const statusTests = {
    all: () => true,
    online: (device) => device.online,
    offline: (device) => !device.online,
    unbound: (device) => !device.team,
};
const statusLabels = { all: '全部', online: '在线', offline: '离线', unbound: '未对应队伍' };

function inSeat(device) {
    const prefix = state.seat.toLowerCase();
    return !prefix || (device.seat || '').toLowerCase().startsWith(prefix);
}

function visibleDevices() {
    return state.devices.filter((device) => inSeat(device) && statusTests[state.filter](device));
}

function renderFilters() {
    filters.replaceChildren(...Object.keys(statusTests).flatMap((key) => {
        const count = state.devices.filter((device) => inSeat(device) && statusTests[key](device)).length;
        if (key === 'unbound' && !count && state.filter !== key) return [];
        return el('button', {
            class: `button${state.filter === key ? ' is-active' : ''}`, type: 'button', 'aria-pressed': String(state.filter === key),
            onclick: () => { state.filter = key; remember(); renderTable(); },
        }, `${statusLabels[key]} `, el('strong', { text: count }));
    }));
    const known = [...new Set(state.devices.map((device) => zoneOf(device.seat)).filter(Boolean))].sort();
    zones.replaceChildren(...known.map((zone) => new Option(zone)));
}

/** Actions act on what the table shows: the ticked rows among the visible ones. */
function selectedVisible() {
    return visibleDevices().filter((device) => state.selected.has(device.id));
}

function renderActions() {
    const count = selectedVisible().length;
    deleteButton.textContent = count ? `删除 ${count} 台` : '删除';
    deleteButton.disabled = !count;
    exportButton.disabled = !visibleDevices().length;
    const webcam = state.settings?.webcam !== false;
    const current = previewStream.value || 'screen';
    previewStream.replaceChildren(new Option('屏幕', 'screen'), ...webcam ? [new Option('摄像头', 'webcam')] : []);
    previewStream.value = webcam || current === 'screen' ? current : 'screen';
    previewButton.disabled = !visibleDevices().some((device) => device.online && device.streams.includes(previewStream.value));
    closeButton.disabled = !previews.size;
}
previewStream.addEventListener('change', renderActions);

/** The contest's on/off switch: off by default, so nothing is captured until a manager decides to. */
function renderSwitch() {
    const enabled = state.settings.enabled;
    const toggle = el('button', { class: `button${enabled ? ' manage-danger' : ' primary'}`, type: 'button', text: enabled ? '停用' : '启用' });
    toggle.addEventListener('click', () => {
        const apply = async () => {
            await post('settings', { settings: { enabled: !enabled } });
            notify(status, enabled ? '已停用，采集页已断开' : '已启用，打开的采集页将在半分钟内连接');
            await load();
        };
        if (!enabled) { apply().catch((error) => notify(status, error.message, true)); return; }
        openDialog({
            title: '停用画面采集',
            confirm: '停用',
            body: [el('p', { text: '采集页立即断开，导播台和直播中的队伍画面随之停止。设备和链接保留。' })],
            submit: apply,
        });
    });
    switchBox.classList.toggle('manage-alert--error', !enabled);
    switchBox.replaceChildren(el('strong', { text: enabled ? '画面采集已启用' : '画面采集未启用' }), toggle);
}

/** Settings apply as they change; the text box of servers when it loses focus. */
function renderSettings() {
    const saved = el('span', { class: 'resolver-muted manage-small', role: 'status' });
    const save = async (patch) => {
        saved.textContent = '正在保存…';
        saved.classList.remove('manage-error');
        try {
            const { enabled: _enabled, ...rest } = state.settings;
            const result = await post('settings', { settings: { ...rest, iceServers: ice.value, ...patch } });
            state.settings = result.settings;
            saved.textContent = '已保存';
            await load();
        } catch (error) { saved.textContent = error.message; saved.classList.add('manage-error'); }
    };
    const box = (key, label) => {
        const node = el('input', { type: 'checkbox', checked: state.settings[key] });
        node.addEventListener('change', () => save({ [key]: node.checked }));
        return el('label', { class: 'checkbox' }, node, label);
    };
    const choice = (key, options) => {
        const node = el('select', { class: 'select' }, ...options.map(([value, label]) => new Option(label, String(value), false, state.settings[key] === value)));
        node.addEventListener('change', () => save({ [key]: Number(node.value) }));
        return node;
    };
    const ice = el('textarea', { class: 'textbox', rows: 3, placeholder: 'stun:192.168.1.10:3478\nturn:192.168.1.10:3478 用户名 密码', spellcheck: 'false' });
    ice.value = state.settings.iceServers.map((server) => [server.urls[0], server.username, server.credential].filter(Boolean).join(' ')).join('\n');
    ice.addEventListener('change', () => save({}));
    settingsBox.replaceChildren(
        el('div', { class: 'resolver-checks' },
            box('prompt', '选手进入比赛时提示开启'),
            box('webcam', '采集摄像头'),
            box('webcamAudio', '摄像头采集声音'),
            box('screenDuringContest', '比赛中直播可用屏幕（选手能看到直播时请关闭）')),
        el('div', { class: 'resolver-fields resolver-two', style: 'margin-top:12px' },
            field('屏幕', choice('screenHeight', [[720, '720p'], [1080, '1080p']])),
            field('帧率', choice('screenFps', [[5, '5 帧'], [10, '10 帧'], [15, '15 帧'], [30, '30 帧']])),
            field('摄像头', choice('webcamHeight', [[360, '360p'], [480, '480p'], [720, '720p']])),
            field('STUN / TURN（每行一个）', ice, '同一局域网可留空。内置 STUN 需放行插件配置中的 UDP 端口（默认 3478）。')),
        saved,
    );
}

function renderTable() {
    const rows = visibleDevices();
    renderFilters();
    const all = el('input', { type: 'checkbox', 'aria-label': '全选', checked: rows.length > 0 && rows.every((device) => state.selected.has(device.id)) });
    all.addEventListener('change', () => {
        for (const device of rows) if (all.checked) state.selected.add(device.id); else state.selected.delete(device.id);
        renderTable();
    });
    table.replaceChildren(
        el('thead', {}, el('tr', {}, el('th', { class: 'col-check' }, all),
            ...['设备', '队伍', '状态', '最近联系', '客户端'].map((text) => el('th', { text })), el('th', { class: 'col-actions', text: '' }))),
        el('tbody', {}, ...rows.length ? rows.map((device) => {
            const box = el('input', { type: 'checkbox', checked: state.selected.has(device.id), 'aria-label': `选择 ${device.name}` });
            const row = el('tr', { class: state.selected.has(device.id) ? 'is-selected' : undefined });
            box.addEventListener('change', () => {
                if (box.checked) state.selected.add(device.id); else state.selected.delete(device.id);
                row.classList.toggle('is-selected', box.checked);
                renderActions();
            });
            row.append(
                el('td', { class: 'col-check' }, box),
                el('td', { class: 'manage-nowrap' }, device.seat || device.name,
                    device.seat && device.name !== device.seat ? el('span', { class: 'manage-dim', text: ` ${device.name}` }) : null),
                el('td', {}, device.team ? device.team.name : el('span', { class: 'manage-dim', text: '—' }),
                    device.teamUid !== null ? tag('手动') : null),
                el('td', {}, ...device.online
                    ? (device.streams.length ? device.streams.map((stream) => tag(streamName[stream], 'manage-tag--ok')) : [tag('在线', 'manage-tag--ok')])
                    : [tag(device.lastSeen ? '离线' : '未打开', device.lastSeen ? 'manage-tag--bad' : '')],
                    device.online && device.recordingStatus?.backlogBytes > 0 ? tag(`待传 ${(device.recordingStatus.backlogBytes / 1048576).toFixed(1)} MB · ${device.recordingStatus.backlogSeconds || 0} 秒`) : null,
                    device.online && device.recordingStatus?.failures > 0 ? tag(`上传失败 ${device.recordingStatus.failures} 次`, 'manage-tag--bad') : null),
                el('td', { class: 'manage-nowrap manage-small', text: formatTime(device.lastSeen) }),
                el('td', { class: 'manage-small', text: device.client ? [device.client.ip, device.client.screen].filter(Boolean).join(' · ') : '—' }),
                el('td', { class: 'col-actions manage-nowrap' },
                    el('button', { class: 'button', type: 'button', text: previews.has(device.id) ? '关闭预览' : '预览', disabled: !device.online && !previews.has(device.id),
                        onclick: () => (previews.has(device.id) ? closePreview(device.id) : openPreview(device, device.streams.includes(previewStream.value) ? previewStream.value : device.streams[0] || 'screen')) }),
                    el('button', { class: 'button', type: 'button', text: '复制链接', onclick: () => copyLink(device) }),
                    el('button', { class: 'button', type: 'button', text: '设置', onclick: () => deviceDialog(device) })),
            );
            return row;
        }) : [el('tr', {}, el('td', { class: 'manage-empty', colspan: 7, text: state.devices.length ? '没有符合条件的设备' : '还没有采集设备' }))]),
    );
    renderActions();
}

async function load() {
    try {
        const data = await get();
        Object.assign(state, { devices: data.devices, teams: data.teams, screenNow: data.screenNow, contest: data.contest });
        const fresh = !state.settings;
        state.settings = data.settings;
        for (const id of [...state.selected]) if (!state.devices.some((device) => device.id === id)) state.selected.delete(id);
        if (state.loadFailed) { notify(status, ''); state.loadFailed = false; }
        renderSwitch();
        if (fresh) renderSettings();
        renderTable();
    } catch (error) { notify(status, error.message, true); state.loadFailed = true; }
}

async function copyLink(device) {
    const url = absolute(device.url);
    notify(status, (await copyText(url)) ? `已复制 ${device.name} 的采集链接` : `请手动复制：${url}`);
}

function exportLinks() {
    const lines = ['座位,名称,队伍,采集链接', ...visibleDevices().map((device) => [device.seat, device.name, device.team?.name || '', absolute(device.url)]
        .map((value) => `"${String(value).replace(/"/g, '""')}"`).join(','))];
    const blob = new Blob([`\ufeff${lines.join('\n')}\n`], { type: 'text/csv;charset=utf-8' });
    const link = el('a', { href: URL.createObjectURL(blob), download: `${runtime.title}-采集链接${state.seat ? `-${state.seat}` : ''}.csv` });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function createFromSeats() {
    try {
        const result = await post('create_from_seats', {});
        notify(status, result.created ? `已添加 ${result.created} 台（共 ${result.seats} 个座位）` : `${result.seats} 个座位都已有设备`);
        await load();
    } catch (error) { notify(status, error.message, true); }
}

function deviceDialog(device) {
    const seatBox = input({ value: device?.seat || '', maxlength: 32, placeholder: 'A-01' });
    const name = input({ value: device?.name || '', maxlength: 40, placeholder: '默认同座位号' });
    const team = el('select', { class: 'select' }, new Option('按座位', ''),
        ...state.teams.map((item) => new Option(`${item.name}${item.seat ? `（${item.seat}）` : ''}`, String(item.uid), false, device?.teamUid === item.uid)));
    const dialog = openDialog({
        title: device ? device.name : '添加采集设备',
        confirm: device ? '保存' : '添加',
        body: [el('div', { class: 'resolver-fields' }, field('座位号', seatBox), field('名称', name), field('队伍', team))],
        extra: device ? [el('button', { class: 'button manage-danger', type: 'button', text: '重新生成链接', onclick: () => { dialog.close(); regenerate(device); } })] : [],
        submit: async () => {
            const payload = { seat: seatBox.value, name: name.value, teamUid: team.value ? Number(team.value) : null };
            if (device) await post('update', { id: device.id, device: payload });
            else await post('create', payload);
            notify(status, `${device ? '已保存' : '已添加'} ${payload.name || payload.seat}`);
            await load();
        },
    });
    seatBox.focus();
}

function regenerate(device) {
    openDialog({
        title: `重新生成 ${device.name} 的链接`,
        confirm: '重新生成',
        body: [el('p', { text: device.online ? '这台选手机在线，采集页会立即断开，需要打开新链接。' : '原链接将失效。' })],
        submit: async () => {
            const result = await post('regenerate', { id: device.id });
            notify(status, (await copyText(absolute(result.url))) ? `已复制 ${device.name} 的新链接` : `新链接：${absolute(result.url)}`);
            await load();
        },
    });
}

function removeSelected() {
    const ids = selectedVisible().map((device) => device.id);
    if (!ids.length) return;
    openDialog({
        title: `删除 ${ids.length} 台采集设备`,
        confirm: '删除',
        body: [el('p', { text: '这些选手机的采集页立即断开，链接失效。' })],
        submit: async () => {
            const result = await post('delete', { ids });
            for (const id of ids) { closePreview(id); state.selected.delete(id); }
            notify(status, `已删除 ${result.deleted} 台`);
            await load();
        },
    });
}

// ---------------------------------------------------------------- Preview

function ensureViewer() {
    viewer ||= new CaptureViewer(socketUrl(runtime.viewerWs));
    return viewer;
}

function openPreview(device, stream) {
    if (previews.has(device.id)) closePreview(device.id);
    if (previews.size >= 12) { notify(status, '同时最多预览 12 路，请先关闭一些', true); return; }
    const video = el('video', { muted: true, autoplay: true, playsinline: true });
    video.muted = true;
    const stateLine = el('div', { class: 'capture-state', text: '正在连接…' });
    const switcher = el('select', { class: 'select', style: 'width:auto;margin:0;height:auto;padding:0 4px;font-size:12px' },
        ...['screen', ...state.settings.webcam ? ['webcam'] : []].map((value) => new Option(streamName[value], value, false, value === stream)));
    switcher.addEventListener('change', () => openPreview(device, switcher.value));
    const close = el('button', { class: 'link', type: 'button', text: '关闭', style: 'color:#fff', onclick: () => closePreview(device.id) });
    const tile = el('div', { class: 'capture-preview' }, video, stateLine,
        el('div', { class: 'capture-caption' }, el('span', { text: `${device.name}${device.team ? ` · ${device.team.name}` : ''}` }), el('span', {}, switcher, ' ', close)));
    grid.append(tile);
    const handle = ensureViewer().watch(device.id, stream, video, (value) => {
        stateLine.textContent = value === 'playing' ? '' : value === 'connecting' ? '正在连接…' : value;
        stateLine.hidden = value === 'playing';
    });
    previews.set(device.id, { tile, handle });
    renderTable();
}

function closePreview(id) {
    const preview = previews.get(id);
    if (!preview) return;
    preview.handle.stop();
    preview.tile.remove();
    previews.delete(id);
    renderTable();
}

function closeAll() {
    for (const preview of previews.values()) { preview.handle.stop(); preview.tile.remove(); }
    previews.clear();
    renderTable();
}

function previewAll(stream) {
    const online = visibleDevices().filter((device) => device.online && device.streams.includes(stream));
    for (const device of online.slice(0, 12)) openPreview(device, stream);
    if (online.length > 12) notify(status, `同时最多预览 12 路，已打开前 12 台`);
}

window.addEventListener('beforeunload', () => { closeAll(); viewer?.close(); });
// The list follows the devices as they change (pushed over the preview socket); the slow poll
// catches devices that go silent without disconnecting.
let pushed = 0;
const refresh = () => { if (!document.hidden && !document.querySelector('dialog[open]')) load(); };
ensureViewer().onDevices = () => { clearTimeout(pushed); pushed = setTimeout(refresh, 300); };
// A tab coming back reloads at once instead of waiting for the next poll.
document.addEventListener('visibilitychange', refresh);
installRecordingTabs(state, load);
load();
setInterval(refresh, 20000);
