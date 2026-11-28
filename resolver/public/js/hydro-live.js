// Hydro live (ICPC Live) settings page: links to the director's console and the OBS overlay.
const runtime = JSON.parse(document.getElementById('live-runtime').textContent);
const $ = (id) => document.getElementById(id);
const absolute = (url) => new URL(url, location.href).href;

function showOverlay(url) {
    $('overlay-link').value = absolute(`${url}?noStatus`);
    $('open-overlay').href = absolute(url);
}

function showError(error) {
    $('message').textContent = error.message || String(error);
    $('message').hidden = false;
}

$('contest-title').textContent = runtime.title;
$('back-link').href = runtime.contestUrl;
$('open-admin').href = absolute(`${runtime.admin}/controls`);
showOverlay(runtime.overlay);

$('copy-overlay').addEventListener('click', async () => {
    const button = $('copy-overlay');
    try { await navigator.clipboard.writeText($('overlay-link').value); button.textContent = '已复制'; } catch { $('overlay-link').select(); button.textContent = '请手动复制'; }
    setTimeout(() => { button.textContent = '复制链接'; }, 2000);
});

$('reset-token').addEventListener('click', () => $('reset-confirm').showModal());
$('reset-confirm').addEventListener('close', async () => {
    if ($('reset-confirm').returnValue !== 'confirm') return;
    $('message').hidden = true;
    try {
        const response = await fetch(runtime.base, {
            method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify({ operation: 'reset_token' }),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) || `请求失败（${response.status}），请检查登录状态`);
        showOverlay(data.overlay);
        await refreshClients();
        $('save-status').textContent = '已生成新链接，旧链接已失效';
    } catch (error) { showError(error); }
});

const clientList = $('overlay-clients');
const clientRows = new Map();
const pendingRequests = new Set();
const commandNames = { identify: '识别', reload: '刷新' };
let latestList = 0;

function receipt(row) {
    const pending = row.pending.at(-1);
    if (pending && (!row.ack || row.ack.at < pending.at)) {
        return Date.now() - pending.at < 15000 ? `${commandNames[pending.kind]}指令已发送，等待回执` : `${commandNames[pending.kind]}指令未收到回执`;
    }
    if (!row.ack) return '';
    const time = new Date(row.ack.at).toLocaleTimeString();
    return `${time} · ${commandNames[row.ack.kind]}${row.ack.ok ? '已确认' : '失败 ' + row.ack.message}`;
}

function renderClient(row) {
    let node = clientRows.get(row.id);
    if (!node) {
        node = $('overlay-client-row').content.firstElementChild.cloneNode(true);
        node.dataset.id = row.id;
        clientRows.set(row.id, node);
        clientList.appendChild(node);
    }
    const { width, height, dpr, scene, onlyWidgets, noStatus, ua, version } = row.client;
    node.dataset.online = String(row.online);
    node.querySelector('[data-name]').textContent = `画面 #${row.number}`;
    node.querySelector('[data-online]').textContent = row.online ? '在线' : '离线';
    node.querySelector('[data-info]').textContent = [
        `${width} × ${height} · DPR ${dpr}`, scene && `场景 ${scene}`, onlyWidgets && `组件 ${onlyWidgets}`, noStatus && '隐藏状态',
    ].filter(Boolean).join(' · ');
    node.querySelector('[data-agent]').textContent = [row.ip, ua, version && `插件 v${version}`].filter(Boolean).join(' · ');
    node.querySelector('[data-receipt]').textContent = receipt(row);
    for (const button of node.querySelectorAll('[data-action]')) button.disabled = !row.online || pendingRequests.has(row.id);
}

async function refreshClients() {
    const requestId = ++latestList;
    const status = $('overlay-list-status');
    try {
        const response = await fetch(runtime.base + '/overlays', { cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`读取失败（${response.status}）`);
        const { overlays } = await response.json();
        if (requestId !== latestList) return;
        const activeIds = new Set(overlays.map(row => row.id));
        for (const [id, node] of clientRows) if (!activeIds.has(id)) { node.remove(); clientRows.delete(id); }
        for (const row of overlays) renderClient(row);
        status.hidden = !!overlays.length;
        status.textContent = overlays.length ? '' : '暂无直播画面连接';
        $('overlay-count').textContent = `${overlays.filter(row => row.online).length} 个在线`;
    } catch (error) {
        if (requestId !== latestList) return;
        status.hidden = false;
        status.textContent = `无法读取画面列表 · ${error.message}`;
    }
}

clientList.addEventListener('click', async event => {
    const button = event.target.closest('[data-action]');
    if (!button || button.disabled) return;
    const node = button.closest('[data-id]');
    const { id } = node.dataset;
    pendingRequests.add(id);
    for (const other of node.querySelectorAll('button')) other.disabled = true;
    try {
        const response = await fetch(runtime.base + '/overlays', {
            method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ id, action: button.dataset.action }),
        });
        const result = await response.json();
        if (!response.ok || !result.command) throw new Error(result.error?.message || result.error || `请求失败（${response.status}）`);
    } catch (error) { showError(error); }
    finally { pendingRequests.delete(id); await refreshClients(); }
});

async function pollClients() {
    if (!document.hidden) await refreshClients();
    setTimeout(pollClients, 3000);
}
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refreshClients(); });
void pollClients();
