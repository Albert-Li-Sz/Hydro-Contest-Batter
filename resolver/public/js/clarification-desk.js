const byId = (id) => document.getElementById(`desk-${id}`);
const runtime = JSON.parse(document.getElementById('clarification-desk-runtime').textContent);
const root = document.getElementById('clarification-desk');
const states = { pending: '没有待回复的提问。', answered: '没有已回复的提问。', announcements: '暂无公告。' };
const state = { tab: 'pending', selected: null, data: null, draftId: null, settingsDirty: false, busy: false, expired: false, reads: 0 };
const tabs = [...root.querySelectorAll('[data-desk-tab]')];
const clock = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const links = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const date = (at) => at ? clock.format(at) : '—';
const duration = (ms) => {
    if (ms === null) return '—';
    const seconds = Math.floor(Math.max(0, ms) / 1000);
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
};
const element = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
};
const fragments = (rows, make) => {
    const fragment = document.createDocumentFragment();
    for (const row of rows) fragment.append(make(row));
    return fragment;
};
function fillSelect(select, leading, rows) {
    const values = [...leading, ...rows].map(([id, label]) => [String(id), label]);
    const existing = [...select.options].map((option) => [option.value, option.textContent]);
    if (JSON.stringify(values) === JSON.stringify(existing)) return;
    const previous = select.value;
    select.replaceChildren(...values.map(([id, text]) => new Option(text, id)));
    if (values.some(([id]) => id === previous)) select.value = previous;
}

let audio;
function beep() {
    if (!audio || audio.state !== 'running') return;
    const signal = audio.createOscillator();
    const level = audio.createGain();
    signal.frequency.setValueAtTime(660, audio.currentTime);
    signal.frequency.setValueAtTime(880, audio.currentTime + 0.09);
    level.gain.setValueAtTime(0.09, audio.currentTime);
    level.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.23);
    signal.connect(level).connect(audio.destination);
    signal.start();
    signal.stop(audio.currentTime + 0.24);
}
function status(text, error = false) {
    byId('status').textContent = text;
    byId('status').toggleAttribute('data-error', error);
}
byId('sound').addEventListener('click', async () => {
    if (audio?.state === 'running') {
        await audio.suspend();
        byId('sound').setAttribute('aria-pressed', 'false');
    } else {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) return status('当前浏览器不支持提示音。', true);
        audio ??= new AudioContext();
        try { await audio.resume(); } catch { return status('提示音无法播放。', true); }
        byId('sound').setAttribute('aria-pressed', 'true');
        beep();
    }
});
byId('title').textContent = runtime.title;
byId('back').href = runtime.contestUrl;
if (runtime.manager) byId('native').href = runtime.nativeUrl;
byId('public-live-label').hidden = !runtime.live;
if (runtime.manager) byId('announcement-live-label').hidden = !runtime.live;

function setTab(tab) {
    state.tab = tab;
    const questions = tab === 'pending' || tab === 'answered';
    byId('questions').hidden = !questions;
    byId('subject-label').hidden = !questions;
    byId('announcements').hidden = tab !== 'announcements';
    if (runtime.manager) byId('settings').hidden = tab !== 'settings';
    for (const button of tabs) {
        const current = button.dataset.deskTab === tab;
        button.classList.toggle('primary', current);
        button.setAttribute('aria-pressed', String(current));
    }
    if (state.data) render();
}

function rowsForTab() {
    const subject = byId('subject').value;
    return state.data[state.tab].filter((item) => !subject || String(item.subject) === subject);
}

function setPublicFields() {
    const shared = byId('public').checked;
    byId('public-fields').hidden = !shared;
    byId('public-text').required = shared;
    byId('send').textContent = shared ? '发送回复并公告' : '发送回复';
}

function showQuestion(row) {
    byId('question-detail').hidden = !row;
    byId('no-selection').hidden = !!row;
    if (!row) return;
    const { team, claim, reply } = row;
    byId('question-title').textContent = row.label;
    byId('question-meta').textContent = [team.name, team.seat ? `座位 ${team.seat}` : '', date(row.at),
        reply ? '' : `等待 ${duration(state.data.now - row.at)}`, claim ? `处理中 · ${claim.name}` : ''].filter(Boolean).join(' · ');
    byId('question-text').textContent = row.text;
    byId('existing-reply').hidden = !reply;
    byId('existing-text').textContent = reply?.text ?? '';
    byId('reply').hidden = !!reply;
    if (reply) return;
    byId('claim').hidden = !!claim;
    byId('release').hidden = !claim || (!claim.mine && !runtime.manager);
    byId('release').textContent = claim && !claim.mine ? '解除认领' : '释放认领';
    byId('send').disabled = state.busy || !!claim && !claim.mine || state.expired;
    if (state.draftId !== row.id) {
        state.draftId = row.id;
        byId('reply').reset();
        setPublicFields();
    }
}

function renderQueue() {
    const list = byId('queue');
    const filtered = rowsForTab();
    const focused = document.activeElement?.dataset?.question;
    list.replaceChildren(fragments(filtered, (row) => {
        const li = element('li');
        const button = element('button', undefined, 'desk-queue-item');
        button.type = 'button';
        button.dataset.question = row.id;
        if (row.id === state.selected) button.setAttribute('aria-current', 'true');
        const { team, claim, reply } = row;
        const time = state.data.now - row.at;
        const label = [row.label, team.name, team.seat].filter(Boolean).join(' · ');
        const meta = reply ? date(reply.at) : `等待 ${duration(time)}${claim ? ` · 处理中 · ${claim.name}` : ''}`;
        button.append(element('strong', label), element('span', row.text, 'desk-preview'),
            element('span', meta, !reply && time > 5 * 60_000 ? 'desk-delayed' : 'desk-meta'));
        li.append(button);
        return li;
    }));
    if (!filtered.length) list.append(element('li', states[state.tab], 'desk-meta'));
    if (focused) [...list.querySelectorAll('[data-question]')].find((node) => node.dataset.question === focused)?.focus({ preventScroll: true });
    showQuestion(filtered.find((row) => row.id === state.selected));
}

function renderAnnouncementList() {
    const history = byId('announcement-history');
    history.replaceChildren(fragments(state.data.announcements, (row) => {
        const li = element('li');
        li.append(element('strong', `${row.label} · ${date(row.at)}`), element('p', row.text, 'desk-message'));
        return li;
    }));
    if (!state.data.announcements.length) history.append(element('li', states.announcements, 'desk-meta'));
}

function renderLinks() {
    const target = byId('link-list');
    const items = state.data.links;
    const signature = JSON.stringify(items);
    if (target.dataset.signature === signature) return;
    target.dataset.signature = signature;
    target.replaceChildren(fragments(items, (assignment) => {
        const li = element('li');
        const subject = state.data.subjects.find((item) => item.pid === assignment.pid)?.label || `题目 #${assignment.pid} 已移出比赛`;
        const heading = element('strong', `${assignment.label} · ${subject}`);
        const actions = element('div', undefined, 'desk-actions');
        if (assignment.url) {
            const link = element('a', '打开答疑员链接', 'button');
            link.href = assignment.url;
            link.target = '_blank';
            link.rel = 'noreferrer';
            const copy = element('button', '复制链接', 'button');
            copy.type = 'button';
            copy.onclick = async () => {
                try {
                    const url = new URL(assignment.url, location.origin).href;
                    if (navigator.clipboard) await navigator.clipboard.writeText(url);
                    else {
                        const input = element('input');
                        input.value = url;
                        input.style.position = 'fixed';
                        input.style.opacity = '0';
                        actions.append(input);
                        input.select();
                        const copied = document.execCommand('copy');
                        input.remove();
                        if (!copied) throw new Error();
                    }
                    status('已复制答疑员链接。');
                } catch { status('复制失败，请右键复制答疑员链接。', true); }
            };
            const rotate = element('button', '更换链接', 'button');
            rotate.type = 'button';
            rotate.onclick = () => send({ action: 'link-rotate', id: assignment.id }, '已更换链接。');
            actions.append(link, copy, rotate);
        }
        const remove = element('button', '撤销链接', 'button');
        remove.type = 'button';
        remove.onclick = () => send({ action: 'link-remove', id: assignment.id }, '已撤销链接。');
        actions.append(remove);
        li.append(heading, actions);
        return li;
    }));
}
function render() {
    const { data } = state;
    byId('viewer').textContent = data.viewer ? ` · ${data.viewer}` : '';
    byId('pending-count').textContent = data.stats.pending;
    byId('answered-count').textContent = data.stats.answered;
    byId('response').textContent = duration(data.stats.averageResponseMs);
    byId('count-by-subject').replaceChildren(fragments(data.stats.subjects, (item) => element('span', `${item.label} · ${item.count} 条`)));
    const subjects = data.subjects.map(({ pid, label }) => [pid, label]);
    fillSelect(byId('subject'), [['', '全部分类']], subjects);
    fillSelect(byId('preset'), [['', '选择回复模板']], (data.settings?.replies ?? data.replies).map((text) => [text, text]));
    if (state.tab === 'pending' || state.tab === 'answered') renderQueue();
    if (state.tab === 'announcements') renderAnnouncementList();
    if (!runtime.manager) return;
    fillSelect(byId('announcement-subject'), [], subjects);
    fillSelect(byId('announcement-preset'), [['', '选择公告模板']], runtime.announcementTemplates.map(({ name, text }) => [text, name]));
    fillSelect(byId('link-subject'), [['', '请选择']], subjects.filter(([pid]) => pid > 0));
    if (state.tab === 'settings') {
        if (!state.settingsDirty) {
            byId('reply-templates').value = data.settings.replies.join('\n');
            byId('freeze-minutes').value = data.settings.freezeMinutes;
        }
        byId('freeze-state').textContent = data.freeze.at
            ? `当前封榜时间 ${date(data.freeze.at)}${data.freeze.sent ? ' · 已发送自动提醒' : ''}`
            : '本场比赛未设置封榜时间。';
        renderLinks();
    }
}

async function refresh({ sound = true } = {}) {
    if (state.expired || !root.isConnected) return;
    const read = ++state.reads;
    try {
        const response = await fetch(runtime.dataUrl, { headers: { Accept: 'application/json' }, cache: 'no-store' });
        if (read !== state.reads || !root.isConnected) return;
        if (response.status === 404 || response.status === 403 || response.status === 401) {
            state.expired = true;
            for (const control of root.querySelectorAll('form button, button[data-desk-tab]')) control.disabled = true;
            return status(runtime.manager ? '管理权限已失效，请刷新页面。' : '答疑员链接已失效。', true);
        }
        if (!response.ok) throw new Error();
        const next = await response.json();
        if (read !== state.reads || !root.isConnected) return;
        const previous = state.data && new Set(state.data.pending.map(({ id }) => id));
        if (sound && previous && next.pending.some(({ id }) => !previous.has(id))) beep();
        state.data = next;
        if (!state.busy) status(`已更新 ${links.format(next.now)}`);
        render();
    } catch {
        if (read === state.reads && !state.busy && root.isConnected) status('暂时无法获取答疑数据，稍后自动重试。', true);
    }
}
async function send(payload, message, onSuccess) {
    if (state.busy || state.expired) return;
    state.busy = true;
    status('正在保存…');
    try {
        const response = await fetch(runtime.dataUrl, {
            method: 'POST', headers: { Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
            body: new URLSearchParams({ payload: JSON.stringify(payload) }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok || !result.ok) throw new Error(typeof result.error === 'string' ? result.error : '操作未完成，请刷新后查看。');
        onSuccess?.();
        await refresh({ sound: false });
        status(result.warning || message, !!result.warning);
    } catch (error) {
        await refresh({ sound: false });
        if (!state.expired) status(error.message || '操作未完成，请刷新后查看。', true);
    } finally {
        state.busy = false;
        if (state.data && ['pending', 'answered'].includes(state.tab)) renderQueue();
    }
}

const tabFromHash = () => {
    const id = location.hash.slice(1);
    setTab(tabs.some(button => button.dataset.deskTab === id) ? id : 'pending');
};
for (const button of tabs) button.addEventListener('click', () => { location.hash = button.dataset.deskTab; });
addEventListener('hashchange', tabFromHash);
tabFromHash();
byId('subject').addEventListener('change', renderQueue);
byId('queue').addEventListener('click', (event) => {
    const button = event.target.closest('[data-question]');
    if (!button) return;
    state.selected = button.dataset.question;
    renderQueue();
});
byId('preset').addEventListener('change', (event) => {
    if (event.target.value) byId('reply-text').value = event.target.value;
});
byId('public').addEventListener('change', setPublicFields);
byId('claim').addEventListener('click', () => send({ action: 'claim', id: state.selected }, '已标记处理中。'));
byId('release').addEventListener('click', () => send({ action: 'release', id: state.selected }, '已释放认领。'));
byId('reply').addEventListener('submit', (event) => {
    event.preventDefault();
    const share = byId('public').checked;
    void send({
        action: 'reply', id: state.selected, text: byId('reply-text').value, public: share,
        publicText: byId('public-text').value, live: share && runtime.live && byId('public-live').checked,
    }, share ? '已发送回复并发布公告。' : '已发送回复。', () => {
        state.draftId = null;
        state.selected = null;
    });
});
if (runtime.manager) {
    byId('announcement-preset').addEventListener('change', ({ target }) => {
        if (target.value) byId('announcement-text').value = target.value
            .replace('{封榜时间}', state.data.freeze.at ? date(state.data.freeze.at) : '〔请填写封榜时间〕')
            .replace('{结束时间}', date(state.data.endAt));
    });
    byId('announcement-form').addEventListener('submit', (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        void send({
            action: 'announce', subject: Number(byId('announcement-subject').value),
            text: byId('announcement-text').value, live: runtime.live && byId('announcement-live').checked,
        }, '已向全体发布。', () => form.reset());
    });
    byId('settings-form').addEventListener('input', () => { state.settingsDirty = true; });
    byId('settings-form').addEventListener('submit', (event) => {
        event.preventDefault();
        void send({ action: 'settings', settings: {
            replies: byId('reply-templates').value.split('\n').map((line) => line.trim()).filter(Boolean),
            freezeMinutes: Number(byId('freeze-minutes').value),
        } }, '已保存设置。', () => { state.settingsDirty = false; });
    });
    byId('links-form').addEventListener('submit', (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        void send({ action: 'link-create', pid: Number(byId('link-subject').value), label: byId('link-name').value }, '已生成答疑员链接。', () => form.reset());
    });
}
void refresh();
// With the sound on, a desk left in a background tab keeps watching for new questions.
const refreshTimer = setInterval(() => {
    if (!root.isConnected || state.expired) clearInterval(refreshTimer);
    else if (!state.busy && (!document.hidden || audio?.state === 'running')) void refresh();
}, 4000);
