import { ratioMeter } from './hydro-ui.js';
import { ResolverStage, rendererKind } from './render/renderer.js';
import { actionIndicesFor, startIndexFor } from './playback-model.js';

const runtime = JSON.parse(document.getElementById('resolver-runtime').textContent);
const form = document.getElementById('resolver-form');
const message = document.getElementById('message');
const startButton = document.getElementById('start-btn');
const previewStatus = document.getElementById('preview-status');
let view;
let previewStage;
let game;
let actions = [];
let position = 0;
let requestNumber = 0;
let previewController;
let debounceTimer;
let lastFrame = performance.now();

function showError(error) {
    message.textContent = error.message || String(error);
    message.hidden = false;
}

async function request(url, options = {}) {
    const response = await fetch(url, { cache: 'no-store', ...options });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
        const detail = typeof data.error === 'string' ? data.error : data.error?.message;
        throw new Error(detail || `请求失败（${response.status}），请检查登录状态`);
    }
    return data;
}

function readConfig() {
    const result = {};
    for (const [key, initial] of Object.entries(runtime.config)) {
        if (key === 'freezeAtSeconds') {
            // Entered as "the last N minutes"; the server works with seconds from the start.
            const minutes = form.elements.freezeMinutes.value;
            result[key] = form.elements.freezeMode.value === 'custom' && minutes !== ''
                ? Math.round(runtime.durationSeconds - Number(minutes) * 60) : null;
            continue;
        }
        const field = form.elements.namedItem(key);
        if (!field) continue;
        if (field.type === 'checkbox') result[key] = field.checked;
        else if (field.type === 'number') result[key] = field.value === '' ? null : Number(field.value);
        else result[key] = field.value ?? initial;
    }
    return result;
}

function updateFreeze() {
    const custom = form.elements.freezeMode.value === 'custom';
    const field = form.elements.freezeMinutes;
    const total = Math.floor(runtime.durationSeconds / 60);
    const contestMinutes = runtime.contestFreezeAtSeconds === null ? null
        : Math.round((runtime.durationSeconds - runtime.contestFreezeAtSeconds) / 6) / 10;
    // The contest's own freeze time is named in the menu; the minutes field is only for a custom one.
    form.elements.freezeMode.options[0].text = contestMinutes === null ? '比赛设置（未设封榜）' : `比赛设置（最后 ${contestMinutes} 分钟）`;
    form.elements.freezeMode.options[0].disabled = contestMinutes === null;
    document.getElementById('freeze-minutes-field').hidden = !custom;
    field.disabled = !custom;
    field.required = custom;
    field.max = total;
    field.placeholder = `1 – ${total}`;
    // Speed and the medal stop only matter while playing by itself.
    document.getElementById('autoplay-fields').hidden = !form.elements.autoplay.checked;
    form.elements.autoplaySpeed.disabled = !form.elements.autoplay.checked;
    document.getElementById('rehearsal-note').hidden = runtime.ended && !form.elements.rehearsal.checked;
}

function clock(seconds) {
    const total = Math.max(0, Math.round(seconds));
    return [Math.floor(total / 3600), Math.floor(total / 60) % 60, total % 60].map((part) => String(part).padStart(2, '0')).join(':');
}

/** `config`: the effective configuration the server returned, whose counts come from the final results. */
function updateAwards(board, config) {
    if (!board) return;
    const rules = board.awards;
    const summary = document.getElementById('resolver-award-summary');
    summary.replaceChildren();
    const ratio = rules.medalBasis === 'ratio';
    const multiple = rules.medalBasis === 'multiple';
    for (const tier of ['gold', 'silver', 'bronze']) {
        const item = document.createElement('div');
        const count = config ? config[`${tier}Count`] : ratio || multiple ? board.medalCounts?.[tier] : board.medals[tier];
        // 按比例设奖: the share and what it comes to.
        item.textContent = rules[`${tier}Citation`] + ' · ' + (count ?? '—') + ' 名';
        if (ratio || (multiple && tier === 'gold')) item.append(' ', ratioMeter('奖牌名额比例', board.medals[tier]));
        else if (multiple) item.append(` · 金牌的 ${board.medals[tier]} 倍`);
        summary.append(item);
    }
    const base = { solved: '至少过一题', submitted: '至少提交一次', registered: '全部' }[rules.medalBase || 'solved'];
    const pool = board.pool ? board.pool[rules.medalBase || 'solved'] : board.eligible;
    document.getElementById('resolver-award-policy').dataset.help = [
        (ratio || multiple) && `按队伍比例设奖（${base}的正式队 ${pool ?? '—'} 支，${multiple ? '金牌向上取整，银铜为金牌倍数' : rules.medalRounding === 'cumulative' ? '累计向上取整' : '各档分别向上取整'}）`,
        rules.honors?.enabled && `Honors：第 ${rules.honors.highest}、${rules.honors.high}、${rules.honors.standard} 名为界，按 WF place`,
        { icpc: '同分规则：ICPC 区域赛（罚时按分钟，再比最后一题通过时间）', ccpc: '同分规则：CCPC（罚时按分钟，同题数同用时并列）' }[rules.tieBreak] || '同分规则：Hydro（罚时精确到秒）',
        rules.medalRanking === 'school' ? '奖牌按学校名次' : rules.medalSameScore ? '并列同奖' : '按名额授奖',
        rules.firstSolve && (rules.unofficialFirstSolve ? '一血奖含打星选手' : '一血奖仅限正式选手'),
        rules.podiumEnabled && `${(rules.podiumNames || ['冠军', '亚军', '季军']).join('、')}${rules.podiumBasis === 'school' ? '按学校名次' : ''}${rules.podiumTie === 'shared' ? '，并列共享' : '，并列看最晚通过时间'}`,
    ].filter(Boolean).join(' · ');
}

const selectedBoard = () => runtime.boards.find((item) => item.id === form.elements.boardId.value);
function updateSelectedAwards() {
    updateAwards(selectedBoard());
}

function updateStats(overview) {
    for (const [id, key] of Object.entries({ teams: 'teamCount', official: 'officialCount', problems: 'problemCount', pending: 'pendingCount' })) {
        document.getElementById(`stat-${id}`).textContent = overview[key] ?? '—';
    }
}

function updateOverview(overview) {
    updateStats(overview);
    const snapshot = document.getElementById('snapshot-time');
    snapshot.textContent = `开赛后 ${clock(overview.freezeAtSeconds)} 封榜 · 数据读取于 ${new Date(overview.capturedAt).toLocaleString('zh-CN')}`;
    snapshot.hidden = false;
    const warning = document.getElementById('unjudged-note');
    warning.hidden = !overview.unjudgedCount;
    warning.textContent = `本次彩排忽略 ${overview.unjudgedCount} 条尚未完成评测的提交`;
    document.getElementById('rehearsal-note').hidden = !overview.rehearsal;
}

function showPreviewPosition() {
    document.getElementById('preview-progress').textContent = game ? `${position + 1} / ${actions.length}` : '';
    document.getElementById('preview-prev').disabled = !game || position <= 0;
    document.getElementById('preview-next').disabled = !game || position >= actions.length - 1;
    document.getElementById('preview-reset').disabled = !game;
}

function resetPreview() {
    if (!game || !view) return;
    const index = rendererKind(game.options.renderer) !== '2d' ? startIndexFor(game)
        : game.steps.findIndex((step) => step.type === 'presentation' && step.screen === 'scoreboard');
    position = Math.max(0, actions.indexOf(index));
    view.seek(game.steps, actions[position]);
    showPreviewPosition();
}

function clearPreview() {
    game = null;
    previewStage?.dispose();
    previewStage = view = null;
    const canvas = document.getElementById('preview-screen');
    canvas.width = canvas.width;
    showPreviewPosition();
}

/** Why no freeze point can be worked out from the form yet, or null when there is one. */
function missingFreeze() {
    const total = Math.floor(runtime.durationSeconds / 60);
    if (form.elements.freezeMode.value !== 'custom') {
        return runtime.contestFreezeAtSeconds === null ? '比赛尚未设置封榜时间，请在“封榜时间来源”中选择“本场滚榜自定义”并填写封榜时长' : null;
    }
    const minutes = form.elements.freezeMinutes.value;
    return minutes !== '' && Number(minutes) > 0 && Number(minutes) <= total ? null : `请填写封榜时长（1 至 ${total} 分钟）后生成预览`;
}

async function refreshPreview() {
    const number = ++requestNumber;
    previewController?.abort();
    previewController = new AbortController();
    startButton.disabled = true;
    const missing = missingFreeze();
    if (missing) {
        // Nothing to preview yet: say what is needed instead of asking the server for an error.
        message.hidden = true;
        previewStatus.textContent = missing;
        previewStatus.dataset.state = 'idle';
        clearPreview();
        return;
    }
    previewStatus.textContent = '正在读取比赛数据…';
    previewStatus.dataset.state = 'loading';
    message.hidden = true;
    try {
        const data = await request(`${runtime.base}/preview`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: JSON.stringify(readConfig()) }), signal: previewController.signal,
        });
        if (number !== requestNumber) return;
        updateOverview(data.overview);
        if (data.config) updateAwards(selectedBoard(), data.config);
        clearPreview();
        game = data.game;
        actions = actionIndicesFor(game.steps);
        position = 0;
        let fallback = '';
        previewStage = new ResolverStage(document.getElementById('preview-screen'), game,
            () => ({ steps: game.steps, index: actions[position] ?? -1 }), (_surface, installed, reason) => {
                view = installed;
                fallback = reason;
                if (reason) previewStatus.textContent = reason;
            });
        await previewStage.select(game.options.renderer);
        if (number !== requestNumber) return;
        await view.ready();
        if (number !== requestNumber) return;
        resetPreview();
        previewStatus.textContent = fallback || '预览已更新';
        previewStatus.dataset.state = 'ready';
        startButton.disabled = false;
    } catch (error) {
        if (error.name === 'AbortError' || number !== requestNumber) return;
        previewStatus.textContent = error.message;
        previewStatus.dataset.state = 'error';
        clearPreview();
    }
}

async function loadSessions() {
    const list = document.getElementById('session-list');
    try {
        const data = await request(`${runtime.base}/sessions`);
        list.replaceChildren();
        if (!data.sessions.length) {
            list.textContent = '还没有滚榜会话';
            return;
        }
        for (const session of data.sessions) {
            const row = document.createElement('div');
            row.className = 'resolver-session';
            const info = document.createElement('div');
            info.className = 'resolver-session-info';
            const title = document.createElement('strong');
            const board = runtime.boards.find((item) => item.id === session.config.boardId);
            title.textContent = `${board?.name || session.config.boardId} · ${session.config.rehearsal ? '彩排' : '正式滚榜'}`;
            const detail = document.createElement('small');
            detail.textContent = `${new Date(session.createdAt).toLocaleString('zh-CN')} · ${session.overview.teamCount} 支队伍 · ${session.config.mode === 'official' ? '分榜正式，其余非正式' : '仅滚所选榜单'}`;
            info.append(title, detail);
            const link = document.createElement('a');
            link.className = 'button';
            link.href = `${runtime.base}/sessions/${session.id}`;
            link.textContent = '继续滚榜';
            const remove = document.createElement('button');
            remove.type = 'button';
            remove.className = 'button';
            remove.textContent = '删除';
            remove.setAttribute('aria-label', `删除 ${title.textContent}`);
            remove.addEventListener('click', async () => {
                const dialog = document.getElementById('resolver-delete-confirm');
                dialog.returnValue = '';
                const confirmed = new Promise((resolve) => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'delete'), { once: true }));
                dialog.showModal();
                if (!await confirmed) return;
                remove.disabled = true;
                try {
                    await request(`${runtime.base}/sessions/${session.id}/delete`, {
                        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
                    });
                    await loadSessions();
                } catch (error) { showError(error); remove.disabled = false; }
            });
            row.append(info, link, remove);
            list.append(row);
        }
    } catch (error) { showError(error); }
}

document.getElementById('contest-title').textContent = runtime.title;
document.getElementById('back-link').href = runtime.contestUrl;
const select = form.elements.boardId;
for (const board of runtime.boards) select.add(new Option(board.name, board.id));
document.getElementById('session-retention').dataset.help = runtime.sessionDays > 0
    ? `会话连续 ${runtime.sessionDays} 天没有打开或推进后会自动删除。` : '会话永久保留，可由创建者手动删除。';
for (const [key, value] of Object.entries(runtime.config)) {
    const field = form.elements.namedItem(key);
    if (!field) continue;
    if (field.type === 'checkbox') field.checked = value;
    else field.value = value ?? '';
}
// Without a contest freeze time the only workable source is a freeze point for this resolve.
if (runtime.contestFreezeAtSeconds === null) form.elements.freezeMode.value = 'custom';
if (!runtime.ended) {
    form.elements.rehearsal.disabled = true;
    document.getElementById('rehearsal-hint').textContent = '（比赛结束前只能彩排）';
    document.getElementById('rehearsal-hint').hidden = false;
}
updateFreeze();
updateStats(runtime.initialStats || {});
updateSelectedAwards();
form.addEventListener('input', (event) => {
    if (event.target.name === 'boardId') updateSelectedAwards();
    updateFreeze();
    clearTimeout(debounceTimer);
    startButton.disabled = true;
    debounceTimer = setTimeout(refreshPreview, 300);
});
form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;
    clearTimeout(debounceTimer);
    previewController?.abort();
    ++requestNumber;
    startButton.disabled = true;
    startButton.textContent = '正在创建…';
    message.hidden = true;
    try {
        const data = await request(`${runtime.base}/sessions`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ config: JSON.stringify(readConfig()) }),
        });
        updateOverview(data.overview);
        if (data.config) updateAwards(selectedBoard(), data.config);
        location.assign(data.url);
    } catch (error) {
        showError(error);
        startButton.disabled = false;
        startButton.textContent = '开始滚榜';
    }
});
document.getElementById('refresh-preview').addEventListener('click', refreshPreview);
document.getElementById('refresh-sessions').addEventListener('click', loadSessions);
document.getElementById('preview-reset').addEventListener('click', resetPreview);
document.getElementById('preview-prev').addEventListener('click', () => {
    if (!view || position <= 0) return;
    view.seek(game.steps, actions[--position]);
    showPreviewPosition();
});
document.getElementById('preview-next').addEventListener('click', () => {
    if (!view || position >= actions.length - 1) return;
    view.applyStep(game.steps[actions[++position]]);
    showPreviewPosition();
});
function frame(now) {
    if (view) {
        view.update(Math.min(64, now - lastFrame));
        view.render(now);
    }
    lastFrame = now;
    requestAnimationFrame(frame);
}
window.addEventListener('pagehide', () => { previewController?.abort(); previewStage?.dispose(); });
showPreviewPosition();
refreshPreview();
loadSessions();
requestAnimationFrame(frame);

import { matchPhoto } from './photo-matching.js';
import { cropBox, imageData, photoFocus, printableImage } from './image-upload.js';

const photos = runtime.photos || {};
const photoTeams = document.getElementById('photo-teams');
const photoProgress = document.getElementById('photo-progress');
const unmatched = document.getElementById('photo-unmatched');
// Team photos are 4:3 landscape: batch uploads are framed on the faces (or above the middle), a single one by hand.
const PHOTO_ASPECT = 4 / 3;
async function savePhoto(uid, file, focus = 'auto') {
    const image = file ? await imageData(await printableImage(file, 1600, 'image/jpeg', 1024 ** 2, { aspect: PHOTO_ASPECT, focus })) : undefined;
    const result = await request(`${runtime.base}/photos`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ uid, image }),
    });
    photos[uid] = result.url;
    renderPhotos();
}
function renderPhotos() {
    photoTeams.replaceChildren();
    for (const team of runtime.teams || []) {
        const row = document.createElement('div');
        row.className = 'resolver-session';
        const name = document.createElement('strong');
        name.textContent = team.name;
        name.className = 'resolver-session-info';
        if (photos[team.uid]) {
            const img = new Image(64, 48);
            img.style.objectFit = 'contain';
            img.alt = `${team.name}的照片`; img.src = photos[team.uid]; img.loading = 'lazy';
            row.append(img);
        }
        const upload = document.createElement('label');
        upload.className = 'button'; upload.textContent = photos[team.uid] ? '替换' : '选择照片';
        const input = document.createElement('input');
        input.type = 'file'; input.accept = 'image/*'; input.className = 'resolver-file-input';
        input.setAttribute('aria-label', `为${team.name}选择照片`);
        input.onchange = () => {
            const file = input.files[0];
            input.value = '';
            if (file) framePhoto(team, file).then(focus => focus && savePhoto(team.uid, file, focus)).then(refreshPreview).catch(showError);
        };
        upload.append(input); row.append(name, upload);
        if (photos[team.uid]) {
            const remove = document.createElement('button');
            remove.className = 'button'; remove.textContent = '删除照片';
            remove.onclick = () => savePhoto(team.uid, null).then(refreshPreview).catch(showError);
            row.append(remove);
        }
        photoTeams.append(row);
    }
}
// Drag (or move with the arrow keys) the 4:3 frame; resolves with its centre, or null when cancelled.
async function framePhoto(team, file) {
    const dialog = document.getElementById('photo-crop');
    const canvas = document.getElementById('photo-crop-canvas');
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
        document.getElementById('photo-crop-title').textContent = team.name;
        const fit = Math.min(1, 720 / bitmap.width, 480 / bitmap.height);
        canvas.width = Math.round(bitmap.width * fit); canvas.height = Math.round(bitmap.height * fit);
        let box = cropBox(bitmap.width, bitmap.height, PHOTO_ASPECT, await photoFocus(bitmap));
        const ctx = canvas.getContext('2d');
        const draw = () => {
            ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
            ctx.fillStyle = '#000a';
            ctx.beginPath(); ctx.rect(0, 0, canvas.width, canvas.height);
            ctx.rect(box.x * fit, box.y * fit, box.width * fit, box.height * fit); ctx.fill('evenodd');
            ctx.strokeStyle = '#fff'; ctx.lineWidth = 2; ctx.strokeRect(box.x * fit + 1, box.y * fit + 1, box.width * fit - 2, box.height * fit - 2);
        };
        const move = (dx, dy) => {
            box = { ...box, x: Math.max(0, Math.min(bitmap.width - box.width, box.x + dx)), y: Math.max(0, Math.min(bitmap.height - box.height, box.y + dy)) };
            draw();
        };
        let drag = null;
        canvas.onpointerdown = (event) => { drag = { x: event.clientX, y: event.clientY }; canvas.setPointerCapture(event.pointerId); };
        canvas.onpointermove = (event) => {
            if (!drag) return;
            const scale = bitmap.width / canvas.getBoundingClientRect().width;
            move((event.clientX - drag.x) * scale, (event.clientY - drag.y) * scale);
            drag = { x: event.clientX, y: event.clientY };
        };
        canvas.onpointerup = canvas.onpointercancel = () => { drag = null; };
        canvas.onkeydown = (event) => {
            const step = (event.shiftKey ? 0.1 : 0.02) * Math.max(bitmap.width, bitmap.height);
            const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
            if (delta) { event.preventDefault(); move(...delta); }
        };
        draw();
        dialog.returnValue = '';
        dialog.showModal();
        canvas.focus();
        await new Promise(resolve => dialog.addEventListener('close', resolve, { once: true }));
        if (dialog.returnValue !== 'confirm') return null;
        return { x: (box.x + box.width / 2) / bitmap.width, y: (box.y + box.height / 2) / bitmap.height };
    } finally { bitmap.close(); }
}
renderPhotos();
document.getElementById('photo-files').addEventListener('change', async ({ target }) => {
    const files = Array.from(target.files);
    target.disabled = true;
    unmatched.replaceChildren();
    let saved = 0;
    try {
        for (const [index, file] of files.entries()) {
            photoProgress.textContent = `正在处理 ${index + 1} / ${files.length} · ${file.name}`;
            const uid = matchPhoto(file.name, runtime.teams);
            try {
                if (!uid) throw new Error('未匹配到唯一队伍');
                await savePhoto(uid, file);
                saved++;
            } catch (error) {
                const item = document.createElement('li');
                item.textContent = `${file.name} · ${error.message}`; unmatched.append(item);
            }
        }
        photoProgress.textContent = `已上传 ${saved} / ${files.length} 张照片`;
        if (saved) await refreshPreview();
    } finally { target.disabled = false; target.value = ''; }
});
