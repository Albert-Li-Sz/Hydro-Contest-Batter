// 气球配送: the balloons a contest owes, by room (seat prefix) and problem, for contest managers
// (with the settings: colours, receipt tickets) and for volunteers on a no-login link.
import { $, copyText, el, get, notify, openDialog, post, runtime } from './hydro-manage-common.js';

const manager = runtime.mode === 'manager';
const storageKey = `xcpcio-balloons:${runtime.mode}:${runtime.base.replace(/\/balloon-desk\/.*$/, '')}`;
const saved = (() => { try { return JSON.parse(localStorage.getItem(storageKey) || '{}'); } catch { return {}; } })();
const view = {
    tab: manager && saved.tab === 'settings' ? 'settings' : 'deliver',
    zones: new Set(Array.isArray(saved.zones) ? saved.zones : []),
    problems: new Set(Array.isArray(saved.problems) ? saved.problems : []),
    status: ['pending', 'delivered', 'held', 'revoked', 'all'].includes(saved.status) ? saved.status : 'pending',
    layout: saved.layout === 'time' ? 'time' : 'teams',
    query: '',
    by: typeof saved.by === 'string' ? saved.by : '',
    selected: new Set(),
};
const remember = () => {
    try {
        localStorage.setItem(storageKey, JSON.stringify({ tab: view.tab, zones: [...view.zones], problems: [...view.problems], status: view.status, layout: view.layout, by: view.by }));
    } catch { /* private window */ }
};

let data = null;
let draft = null;
let dirty = false;
const root = $('balloon-root');
const heading = $('balloon-heading-actions');
const status = el('p', { class: 'resolver-muted', role: 'status', hidden: true });

// ---------------------------------------------------------------- Helpers

const statusLabels = { pending: '待配送', delivered: '已送达', held: '封榜暂缓', revoked: '已撤销', all: '全部' };
const ticketLabels = { none: '—', pending: '待打印', printing: '打印中', printed: '已打印', failed: '打印失败' };
const ticketTones = { pending: 'manage-tag--warn', printing: '', printed: 'manage-tag--ok', failed: 'manage-tag--bad' };

function ink(hex) {
    const match = /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
    if (!match) return '#000';
    const [r, g, b] = match.slice(1).map((part) => parseInt(part, 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? '#111' : '#fff';
}
const clock = (at) => {
    const seconds = Math.max(0, Math.floor((new Date(at) - new Date(data.contest.beginAt)) / 1000));
    return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
const wall = (at) => new Date(at).toLocaleTimeString('zh-CN', { hour12: false });
const naturally = new Intl.Collator('zh-CN', { numeric: true });
const zoneKey = (team) => (team?.seat ? team.zone || '（无前缀）' : '（未导入座位）');
const stateOf = (balloon) => (balloon.state === 'revoked' ? 'revoked' : balloon.delivered ? 'delivered' : balloon.held ? 'held' : 'pending');
const tag = (text, tone = '', title) => el('span', { class: `manage-tag ${tone}`, text, title });

function lookups() {
    const teams = new Map(data.teams.map((team) => [team.uid, team]));
    const problems = new Map(data.problems.map((problem) => [problem.pid, problem]));
    return { teams, problems };
}

function pill(problem, balloon, onclick) {
    const color = problem?.color?.hex || '';
    const state = balloon ? stateOf(balloon) : 'pending';
    const node = el(onclick ? 'button' : 'span', {
        class: `balloon-pill balloon-pill--${state}${balloon?.first ? ' balloon-pill--first' : ''}`, type: onclick ? 'button' : undefined,
        title: [`${problem?.label || '?'} 题`, problem?.color?.name || '未设颜色', balloon ? statusLabels[state] : '', balloon?.first ? '一血' : '',
            balloon?.delivered ? `${balloon.delivered.by} ${wall(balloon.delivered.at)} 送达` : ''].filter(Boolean).join(' · '),
        onclick,
    }, el('b', { text: problem?.label || '?' }), problem?.color?.name ? el('span', { text: problem.color.name }) : null,
    balloon?.first ? el('i', { text: '★', 'aria-label': '一血' }) : null);
    if (color) { node.style.setProperty('--balloon', color); node.style.setProperty('--balloon-ink', ink(color)); }
    return node;
}

async function act(name, payload, done) {
    try {
        const result = await post(name, payload);
        if (done) notify(status, done(result));
        await refresh(true);
    } catch (error) { notify(status, error.message, true); }
}
const deliver = (ids, undo = false) => act('deliver', { ids, undo, by: view.by }, (result) => `${undo ? '已撤销送达' : '已标记送达'} ${result.updated} 个气球`);
const reprint = (payload) => act('reprint', payload, (result) => `已加入打印队列 ${result.updated} 张小票`);

// ---------------------------------------------------------------- Delivery view

function filtered() {
    const { teams, problems } = lookups();
    const query = view.query.trim().toLowerCase();
    return data.balloons.filter((balloon) => {
        const team = teams.get(balloon.uid);
        const state = stateOf(balloon);
        if (view.status !== 'all' && state !== view.status) return false;
        if (view.zones.size && !view.zones.has(zoneKey(team))) return false;
        if (view.problems.size && !view.problems.has(balloon.pid)) return false;
        if (query && ![team?.name, team?.seat, team?.school, `#${balloon.seq}`, problems.get(balloon.pid)?.label].some((text) => String(text || '').toLowerCase().includes(query))) return false;
        return true;
    });
}

function renderStats() {
    const counts = { pending: 0, delivered: 0, held: 0, revoked: 0 };
    const tickets = { pending: 0, printing: 0, failed: 0 };
    for (const balloon of data.balloons) {
        counts[stateOf(balloon)]++;
        if (balloon.state === 'active' && !balloon.delivered && tickets[balloon.ticket.status] !== undefined) tickets[balloon.ticket.status]++;
    }
    const items = [[counts.pending, '待配送'], [counts.delivered, '已送达']];
    if (counts.held) items.push([counts.held, '封榜暂缓']);
    if (counts.revoked) items.push([counts.revoked, '重测撤销']);
    if (data.tickets) items.push([tickets.pending + tickets.printing, '小票待打印'], [tickets.failed, '小票打印失败']);
    return el('div', { class: 'resolver-stats balloon-stats' }, ...items.map(([value, label]) => el('div', {}, el('strong', { text: value }), el('span', { text: label }))));
}

/** Waiting balloons per room and problem: how many of which colour each room needs. */
function renderMatrix() {
    const { teams } = lookups();
    const pending = data.balloons.filter((balloon) => stateOf(balloon) === 'pending');
    const zones = [...new Set([...data.teams.map(zoneKey), ...pending.map((balloon) => zoneKey(teams.get(balloon.uid)))])].sort(naturally.compare);
    const count = new Map();
    for (const balloon of pending) {
        const key = `${zoneKey(teams.get(balloon.uid))}\n${balloon.pid}`;
        count.set(key, (count.get(key) || 0) + 1);
    }
    const pick = (zone, pid) => {
        if (zone !== null) { view.zones = new Set([zone]); }
        if (pid !== null) { view.problems = new Set([pid]); }
        view.status = 'pending';
        remember(); renderDeliver();
    };
    const header = el('tr', {}, el('th', { text: '考场' }),
        ...data.problems.map((problem) => el('th', { class: 'balloon-matrix-problem' }, el('button', { type: 'button', class: 'balloon-link', onclick: () => pick(null, problem.pid), title: problem.title },
            pill(problem, null)))), el('th', { text: '合计' }));
    const rows = zones.map((zone) => {
        const cells = data.problems.map((problem) => count.get(`${zone}\n${problem.pid}`) || 0);
        const total = cells.reduce((sum, value) => sum + value, 0);
        return el('tr', { class: total ? '' : 'manage-dim' }, el('th', {}, el('button', { type: 'button', class: 'balloon-link', text: zone, onclick: () => pick(zone, null) })),
            ...cells.map((value, index) => el('td', { class: value ? 'balloon-matrix-hot' : '' },
                value ? el('button', { type: 'button', class: 'balloon-link', text: String(value), onclick: () => pick(zone, data.problems[index].pid) }) : '·')),
            el('td', { text: total || '·' }));
    });
    const totals = data.problems.map((problem) => pending.filter((balloon) => balloon.pid === problem.pid).length);
    rows.push(el('tr', { class: 'balloon-matrix-total' }, el('th', { text: '合计' }), ...totals.map((value) => el('td', { text: value || '·' })), el('td', { text: pending.length })));
    return el('details', { class: 'manage-group balloon-matrix', open: saved.matrix !== false, ontoggle: (event) => {
        saved.matrix = event.target.open;
        try { localStorage.setItem(storageKey, JSON.stringify({ ...JSON.parse(localStorage.getItem(storageKey) || '{}'), matrix: saved.matrix })); } catch { /* ignore */ }
    } }, el('summary', { text: '各考场待配送（点击数字筛选）' }), el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' }, el('thead', {}, header), el('tbody', {}, ...rows))));
}

function renderFilters() {
    const { teams } = lookups();
    const zones = [...new Set(data.teams.map(zoneKey))].sort(naturally.compare);
    const pendingIn = (zone) => data.balloons.filter((balloon) => stateOf(balloon) === 'pending' && zoneKey(teams.get(balloon.uid)) === zone).length;
    const chip = (label, active, onclick, extra) => el('button', { type: 'button', class: `balloon-chip${active ? ' is-active' : ''}`, 'aria-pressed': active ? 'true' : 'false', onclick }, label, extra);
    const toggle = (set, value) => { if (set.has(value)) set.delete(value); else set.add(value); view.selected.clear(); remember(); renderDeliver(); };
    const search = el('input', { class: 'textbox', type: 'search', placeholder: '搜索队伍、座位、学校或编号', value: view.query, 'aria-label': '搜索' });
    search.addEventListener('input', () => { view.query = search.value; renderList(); });
    const statusSelect = el('select', { class: 'select', 'aria-label': '状态' }, ...Object.entries(statusLabels).map(([value, label]) => new Option(label, value, false, view.status === value)));
    statusSelect.addEventListener('change', () => { view.status = statusSelect.value; view.selected.clear(); remember(); renderDeliver(); });
    const layout = el('div', { class: 'manage-tabs balloon-layout', role: 'radiogroup', 'aria-label': '视图' },
        ...[['teams', '按队伍'], ['time', '按时间']].map(([value, label]) => el('button', { type: 'button', role: 'radio', 'aria-checked': view.layout === value ? 'true' : 'false', text: label,
            onclick: () => { view.layout = value; remember(); renderDeliver(); } })));
    return el('div', { class: 'balloon-filters' },
        el('div', { class: 'balloon-filter-row' }, el('b', { text: '考场' }),
            chip('全部', !view.zones.size, () => { view.zones.clear(); remember(); renderDeliver(); }),
            ...zones.map((zone) => {
                const waiting = pendingIn(zone);
                return chip(zone, view.zones.has(zone), () => toggle(view.zones, zone), waiting ? el('small', { text: waiting }) : null);
            })),
        el('div', { class: 'balloon-filter-row' }, el('b', { text: '题目' }),
            chip('全部', !view.problems.size, () => { view.problems.clear(); remember(); renderDeliver(); }),
            ...data.problems.map((problem) => chip(pill(problem, null), view.problems.has(problem.pid), () => toggle(view.problems, problem.pid)))),
        el('div', { class: 'manage-toolbar balloon-filter-tools' }, statusSelect, search, layout));
}

let listBox = null;
function renderList() {
    if (!listBox) return;
    const { teams, problems } = lookups();
    const list = filtered();
    const actionsFor = (balloon) => {
        const state = stateOf(balloon);
        return [
            state === 'pending' || state === 'held' ? el('button', { class: 'button primary', type: 'button', text: '送达', onclick: () => deliver([balloon.id]) }) : null,
            state === 'delivered' ? el('button', { class: 'button', type: 'button', text: '撤销送达', onclick: () => deliver([balloon.id], true) }) : null,
            data.tickets && balloon.state === 'active' && !balloon.delivered ? el('button', { class: 'button', type: 'button', text: '补打', title: '再打印一张小票', onclick: () => reprint({ ids: [balloon.id] }) }) : null,
        ];
    };
    const ticket = (balloon) => (balloon.ticket.status === 'none' ? el('span', { class: 'manage-dim', text: '—' })
        : tag(`${ticketLabels[balloon.ticket.status]}${balloon.ticket.prints > 1 ? ` ×${balloon.ticket.prints}` : ''}`, ticketTones[balloon.ticket.status],
            [balloon.ticket.server, balloon.ticket.printer, balloon.ticket.error].filter(Boolean).join(' · ') || undefined));
    if (!list.length) {
        listBox.replaceChildren(el('p', { class: 'manage-empty', text: data.balloons.length ? '没有符合筛选条件的气球' : '还没有气球：队伍首次通过题目后会出现在这里' }));
        return;
    }
    if (view.layout === 'time') {
        // Waiting ones oldest first (delivery order); otherwise the newest on top.
        const rows = [...list].sort((a, b) => (view.status === 'pending' ? a.seq - b.seq : b.seq - a.seq));
        const all = el('input', { type: 'checkbox', 'aria-label': '全选', checked: rows.length > 0 && rows.every((balloon) => view.selected.has(balloon.id)) });
        all.addEventListener('change', () => { for (const balloon of rows) { if (all.checked) view.selected.add(balloon.id); else view.selected.delete(balloon.id); } renderList(); });
        const selected = rows.filter((balloon) => view.selected.has(balloon.id));
        listBox.replaceChildren(
            el('div', { class: 'manage-toolbar' },
                el('span', { class: 'resolver-muted', text: `共 ${rows.length} 个${selected.length ? `，已选 ${selected.length} 个` : ''}` }), el('span', { class: 'manage-spacer' }),
                el('button', { class: 'button', type: 'button', text: '所选标记送达', disabled: !selected.length, onclick: () => deliver(selected.map((balloon) => balloon.id)) }),
                data.tickets ? el('button', { class: 'button', type: 'button', text: '补打所选小票', disabled: !selected.length, onclick: () => reprint({ ids: selected.map((balloon) => balloon.id) }) }) : null),
            el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table balloon-table' },
                el('thead', {}, el('tr', {}, el('th', { class: 'col-check' }, all), ...['编号', '通过时间', '座位', '队伍', '题目', '状态'].map((text) => el('th', { text })),
                    data.tickets ? el('th', { text: '小票' }) : null, el('th', { class: 'col-actions', text: '' }))),
                el('tbody', {}, ...rows.map((balloon) => {
                    const team = teams.get(balloon.uid);
                    const check = el('input', { type: 'checkbox', checked: view.selected.has(balloon.id), 'aria-label': `选择气球 #${balloon.seq}` });
                    check.addEventListener('change', () => { if (check.checked) view.selected.add(balloon.id); else view.selected.delete(balloon.id); renderList(); });
                    const state = stateOf(balloon);
                    return el('tr', { class: view.selected.has(balloon.id) ? 'is-selected' : '' },
                        el('td', { class: 'col-check' }, check),
                        el('td', { class: 'manage-nowrap', text: `#${balloon.seq}` }),
                        el('td', { class: 'manage-nowrap', title: wall(balloon.at), text: clock(balloon.at) }),
                        el('td', { class: 'manage-nowrap balloon-seat', text: team?.seat || '—' }),
                        el('td', {}, el('div', { text: `${team?.name || `UID ${balloon.uid}`}${team?.unofficial ? '（打星）' : ''}` }), team?.school ? el('div', { class: 'manage-dim manage-small', text: team.school }) : null),
                        el('td', {}, pill(problems.get(balloon.pid), balloon)),
                        el('td', {}, tag(statusLabels[state], state === 'delivered' ? 'manage-tag--ok' : state === 'revoked' ? 'manage-tag--bad' : state === 'held' ? '' : 'manage-tag--warn',
                            balloon.delivered ? `${balloon.delivered.by} ${wall(balloon.delivered.at)}` : state === 'revoked' ? '重测后不再通过；已送出的请收回' : undefined)),
                        data.tickets ? el('td', {}, ticket(balloon)) : null,
                        el('td', { class: 'col-actions' }, ...actionsFor(balloon)));
                })))));
        return;
    }
    // By team: one card per team, in seat order.
    const byTeam = new Map();
    for (const balloon of list) {
        if (!byTeam.has(balloon.uid)) byTeam.set(balloon.uid, []);
        byTeam.get(balloon.uid).push(balloon);
    }
    const order = [...byTeam.keys()].sort((a, b) => naturally.compare(teams.get(a)?.seat || '~', teams.get(b)?.seat || '~') || naturally.compare(teams.get(a)?.name || '', teams.get(b)?.name || ''));
    listBox.replaceChildren(el('div', { class: 'balloon-cards' }, ...order.map((uid) => {
        const team = teams.get(uid);
        const owed = byTeam.get(uid).sort((a, b) => data.problems.findIndex((p) => p.pid === a.pid) - data.problems.findIndex((p) => p.pid === b.pid));
        const waiting = owed.filter((balloon) => stateOf(balloon) === 'pending');
        // Everything the team has, so a runner sees which balloons should already be at the desk.
        const has = data.balloons.filter((balloon) => balloon.uid === uid && balloon.state === 'active').length;
        return el('article', { class: `balloon-card${waiting.length ? ' balloon-card--waiting' : ''}` },
            el('header', {}, el('strong', { class: 'balloon-card-seat', text: team?.seat || '未导入座位' }),
                el('span', { class: 'manage-dim manage-small', text: `共 ${has} 题` })),
            el('div', { class: 'balloon-card-team', text: `${team?.name || `UID ${uid}`}${team?.unofficial ? '（打星）' : ''}` }),
            team?.school ? el('div', { class: 'manage-dim manage-small', text: team.school }) : null,
            el('div', { class: 'balloon-card-pills' }, ...owed.map((balloon) => {
                const state = stateOf(balloon);
                return pill(lookups().problems.get(balloon.pid), balloon, () => {
                    if (state === 'pending' || state === 'held') deliver([balloon.id]);
                    else if (state === 'delivered') openDialog({ title: '撤销送达', confirm: '撤销', body: [el('p', { text: `把 ${team?.seat || ''} ${team?.name || ''} 的 ${lookups().problems.get(balloon.pid)?.label} 题气球改回待配送？` })],
                        submit: async () => { await post('deliver', { ids: [balloon.id], undo: true, by: view.by }); await refresh(true); } });
                });
            })),
            el('footer', {},
                waiting.length > 1 ? el('button', { class: 'button primary', type: 'button', text: `全部送达（${waiting.length}）`, onclick: () => deliver(waiting.map((balloon) => balloon.id)) }) : null,
                data.tickets && waiting.length ? el('span', { class: 'manage-small manage-dim' }, ...waiting.map((balloon) => (balloon.ticket.status === 'failed' ? tag(`#${balloon.seq} 小票失败`, 'manage-tag--bad', balloon.ticket.error) : null))) : null));
    })));
}

function renderDeliver() {
    if (!data || view.tab !== 'deliver') return;
    if (!data.enabled) {
        root.replaceChildren(status, manager ? intro() : el('p', { class: 'manage-alert', text: '这场比赛的气球配送已关闭。' }));
        return;
    }
    listBox = el('div', { class: 'balloon-list' });
    const notes = [];
    if (data.afterFreeze === 'hold' && data.contest.locked) notes.push('已封榜：封榜后的通过暂缓配送，解除封榜后自动转为待配送。');
    if (!data.teams.some((team) => team.seat)) notes.push('还没有导入座位号：气球无法按考场分组。可用 onsite-toolkit 导入座位后刷新。');
    root.replaceChildren(status, ...notes.map((text) => el('p', { class: 'manage-alert', text })), renderStats(), renderMatrix(), renderFilters(), listBox);
    renderList();
}

function intro() {
    return el('div', { class: 'manage-group balloon-intro' },
        el('h3', { text: '开启气球配送' }),
        el('p', { text: '为每支队伍首次通过的每道题生成一个气球，按考场和题目配送。' }),
        el('button', { class: 'button primary', type: 'button', text: '开启气球配送', onclick: () => act('enable', { enabled: true }, () => '已开启气球配送') }));
}

// ---------------------------------------------------------------- Settings (managers)

function renderSettings() {
    if (!data || view.tab !== 'settings') return;
    if (!draft) draft = structuredClone(data.settings);
    const markDirty = () => { dirty = true; saveButton.disabled = false; discard.hidden = false; };
    const saveButton = el('button', { class: 'button primary', type: 'button', text: '保存设置', disabled: !dirty, onclick: async () => {
        try {
            await post('settings', { settings: draft });
            dirty = false;
            draft = null;
            notify(status, '设置已保存');
            await refresh(true);
        } catch (error) { notify(status, error.message, true); }
    } });
    const discard = el('button', { class: 'button', type: 'button', text: '放弃修改', hidden: !dirty, onclick: () => { dirty = false; draft = null; renderSettings(); } });

    // Basics
    const afterFreeze = el('select', { class: 'select' },
        new Option('继续发放（现场可从气球看出封榜后的通过）', 'continue', false, draft.afterFreeze === 'continue'),
        new Option('暂缓，解除封榜后再发', 'hold', false, draft.afterFreeze === 'hold'));
    afterFreeze.addEventListener('change', () => { draft.afterFreeze = afterFreeze.value; markDirty(); });
    const desk = el('input', { class: 'textbox', readonly: true, value: new URL(data.deskUrl, location.href).href, 'aria-label': '配送员链接' });
    const basics = el('section', { class: 'manage-group' },
        el('h3', { text: '基本' }),
        el('div', { class: 'resolver-fields resolver-two' },
            el('label', {}, '气球配送', el('div', { class: 'balloon-inline' }, tag(data.enabled ? '已开启' : '已关闭', data.enabled ? 'manage-tag--ok' : 'manage-tag--warn'),
                el('button', { class: 'button', type: 'button', text: data.enabled ? '关闭' : '开启', onclick: () => {
                    if (!data.enabled) { act('enable', { enabled: true }, () => '已开启气球配送'); return; }
                    openDialog({ title: '关闭气球配送', confirm: '关闭', body: [el('p', { text: '关闭后不再生成新气球、不再打印小票，配送员链接暂停使用；已有的气球和送达记录保留，重新开启后继续。' })],
                        submit: async () => { await post('enable', { enabled: false }); await refresh(true); } });
                } }))),
            el('label', {}, '封榜之后的通过', afterFreeze)),
        el('label', {}, '配送员链接（免登录，可查看并标记气球；请只发给志愿者）'),
        el('div', { class: 'manage-toolbar' }, desk,
            el('button', { class: 'button', type: 'button', text: '复制', onclick: async (event) => { event.target.textContent = await copyText(desk.value) ? '已复制' : '请手动复制'; } }),
            el('button', { class: 'button', type: 'button', text: '作废并重新生成', onclick: () => openDialog({ title: '作废配送员链接', confirm: '作废并重新生成',
                body: [el('p', { text: '旧链接立即失效，已打开的配送员页面需要换用新链接。' })],
                submit: async () => { await post('resetToken', {}); await refresh(true); } }) })));

    // Colours
    const presets = el('datalist', { id: 'balloon-color-names' }, ...['红', '橙', '黄', '绿', '浅绿', '青', '蓝', '浅蓝', '紫', '粉', '白', '黑', '灰', '棕', '金', '银'].map((name) => el('option', { value: name })));
    const colorRows = data.problems.map((problem, index) => {
        const current = draft.colors[problem.pid] || null;
        const hydro = data.hydroColors[index];
        const hydroHex = typeof hydro === 'string' ? hydro : hydro?.color;
        const picker = el('input', { type: 'color', value: current?.hex || problem.color?.hex || '#cccccc', 'aria-label': `${problem.label} 题颜色` });
        const name = el('input', { class: 'textbox', list: 'balloon-color-names', maxlength: 12, placeholder: problem.color?.name || '颜色名', value: current?.name || '', 'aria-label': `${problem.label} 题颜色名称` });
        const update = () => { draft.colors[problem.pid] = { hex: picker.value, name: name.value.trim() }; markDirty(); };
        picker.addEventListener('input', update);
        name.addEventListener('input', update);
        const clear = el('button', { class: 'button', type: 'button', text: '恢复默认', disabled: !current, onclick: () => { delete draft.colors[problem.pid]; markDirty(); renderSettings(); } });
        return el('tr', {},
            el('td', {}, pill({ ...problem, color: current ? { hex: current.hex, name: current.name } : problem.color }, null)),
            el('td', { text: problem.title }),
            el('td', {}, picker), el('td', {}, name),
            el('td', { class: 'manage-small' }, hydroHex ? el('span', { class: 'balloon-swatch', style: `background:${hydroHex}` }) : null, hydroHex ? ` ${hydroHex}` : el('span', { class: 'manage-dim', text: '未设置' })),
            el('td', { class: 'col-actions' }, clear));
    });
    const colors = el('section', { class: 'manage-group' },
        el('div', { class: 'manage-toolbar' }, el('h3', { text: '气球颜色', style: 'margin:0' }), el('span', { class: 'manage-spacer' }),
            el('button', { class: 'button', type: 'button', text: '从 Hydro 气球颜色导入', onclick: () => {
                data.problems.forEach((problem, index) => {
                    const hydro = data.hydroColors[index];
                    const hex = typeof hydro === 'string' ? hydro : hydro?.color;
                    if (hex && /^#?[\da-f]{3,6}$/i.test(hex)) draft.colors[problem.pid] = { hex: hex.startsWith('#') ? hex : `#${hex}`, name: '' };
                });
                markDirty(); renderSettings();
            } })),
        presets,
        el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' },
            el('thead', {}, el('tr', {}, ...['题目', '标题', '颜色', '名称', 'Hydro 颜色'].map((text) => el('th', { text })), el('th', { class: 'col-actions', text: '' }))),
            el('tbody', {}, ...colorRows))));

    // Tickets
    const printers = data.printers;
    const printerLabel = (printer) => `${printer.serverName} · ${printer.printer}`;
    const printerState = (printer) => (printer.usable ? tag('可用', 'manage-tag--ok') : !printer.online ? tag('离线', 'manage-tag--bad')
        : !printer.capable ? tag('客户端需更新', 'manage-tag--warn', '请在这台电脑上运行 1.14.0 或更新版本的打印客户端') : tag(printer.status === 'missing' ? '未找到' : '不可用', 'manage-tag--warn'));
    const check = (label, checked, onchange) => {
        const box = el('input', { type: 'checkbox', checked });
        box.addEventListener('change', () => { onchange(box.checked); markDirty(); });
        return el('label', { class: 'checkbox' }, box, el('span', { text: label }));
    };
    const knownZones = [...new Set(data.teams.map((team) => team.zone).filter(Boolean))].sort(naturally.compare);
    const ruleCards = draft.tickets.rules.map((rule, index) => {
        const name = el('input', { class: 'textbox', value: rule.name, maxlength: 40, 'aria-label': '规则名称' });
        name.addEventListener('input', () => { rule.name = name.value; markDirty(); });
        const zones = el('input', { class: 'textbox', value: rule.zones.join(' '), placeholder: '所有考场', 'aria-label': '考场前缀' });
        zones.addEventListener('input', () => { rule.zones = zones.value.split(/[\s,，;；]+/).filter(Boolean); markDirty(); });
        const zoneHints = knownZones.length ? el('div', { class: 'balloon-hints' }, el('span', { class: 'manage-dim manage-small', text: '已导入的考场：' }),
            ...knownZones.map((zone) => el('button', { type: 'button', class: 'balloon-chip', text: zone, onclick: () => {
                if (!rule.zones.includes(zone)) { rule.zones.push(zone); zones.value = rule.zones.join(' '); markDirty(); }
            } }))) : null;
        const problems = el('div', { class: 'balloon-hints' }, el('span', { class: 'manage-dim manage-small', text: '题目（不选 = 所有题目）：' }),
            ...data.problems.map((problem) => {
                const on = rule.problems.includes(problem.pid);
                return el('button', { type: 'button', class: `balloon-chip${on ? ' is-active' : ''}`, 'aria-pressed': on ? 'true' : 'false', onclick: () => {
                    rule.problems = on ? rule.problems.filter((pid) => pid !== problem.pid) : [...rule.problems, problem.pid];
                    markDirty(); renderSettings();
                } }, pill(problem, null));
            }));
        const targets = el('div', { class: 'balloon-printer-picks' }, ...printers.length ? printers.map((printer) => {
            const on = rule.printers.some((ref) => ref.server === printer.server && ref.printer === printer.printer);
            const box = el('input', { type: 'checkbox', checked: on });
            box.addEventListener('change', () => {
                rule.printers = box.checked ? [...rule.printers, { server: printer.server, printer: printer.printer }]
                    : rule.printers.filter((ref) => !(ref.server === printer.server && ref.printer === printer.printer));
                markDirty();
            });
            return el('label', { class: 'checkbox' }, box, el('span', { text: printerLabel(printer) }), printerState(printer));
        }) : [el('span', { class: 'manage-dim', text: '还没有小票机' })]);
        const missing = rule.printers.filter((ref) => !printers.some((printer) => printer.server === ref.server && printer.printer === ref.printer));
        const move = (delta) => {
            const rules = draft.tickets.rules;
            const target = index + delta;
            if (target < 0 || target >= rules.length) return;
            [rules[index], rules[target]] = [rules[target], rules[index]];
            markDirty(); renderSettings();
        };
        return el('div', { class: 'manage-server balloon-rule' },
            el('div', { class: 'manage-toolbar' }, el('b', { text: `规则 ${index + 1}` }), name, el('span', { class: 'manage-spacer' }),
                el('button', { class: 'button', type: 'button', text: '上移', disabled: index === 0, onclick: () => move(-1) }),
                el('button', { class: 'button', type: 'button', text: '下移', disabled: index === draft.tickets.rules.length - 1, onclick: () => move(1) }),
                el('button', { class: 'button manage-danger', type: 'button', text: '删除', onclick: () => { draft.tickets.rules.splice(index, 1); markDirty(); renderSettings(); } })),
            el('label', {}, '考场前缀（座位号以这些开头）', zones), zoneHints, problems,
            el('div', {}, el('b', { class: 'manage-small', text: '打印到（选多台时按气球分摊）' }), targets),
            missing.length ? el('p', { class: 'manage-alert', text: `有 ${missing.length} 台已选的小票机已不存在或不再是小票机：${missing.map((ref) => ref.printer).join('、')}` }) : null);
    });
    const tickets = el('section', { class: 'manage-group' },
        el('h3', { text: '小票打印' }),
        data.gbk ? null : el('p', { class: 'manage-alert', text: '当前 Node.js 不支持 GBK 编码，ESC/POS 小票中的中文会打印为问号。请使用带完整 ICU 的官方 Node.js，或把小票机设为“系统驱动”输出。' }),
        el('div', { class: 'resolver-checks' },
            check('开启小票打印：每出现一个新气球，自动在分配的小票机上打印一张配送小票', draft.tickets.enabled, (value) => { draft.tickets.enabled = value; }),
            check('小票上列出该队已通过的全部题目', draft.tickets.solvedList, (value) => { draft.tickets.solvedList = value; }),
            check('小票上显示队员', draft.tickets.members, (value) => { draft.tickets.members = value; })),
        el('h4', { text: '小票机' }),
        printers.length ? el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' },
            el('thead', {}, el('tr', {}, ...['打印服务器', '小票机', '状态', '纸张与输出', '服务座位'].map((text) => el('th', { text })))),
            el('tbody', {}, ...printers.map((printer) => el('tr', {},
                el('td', { text: printer.serverName }), el('td', { text: printer.printer }), el('td', {}, printerState(printer)),
                el('td', { text: `${printer.config.width} mm · ${printer.config.mode === 'escpos' ? 'ESC/POS' : '系统驱动'}${printer.config.cut ? ' · 切纸' : ''}` }),
                el('td', { text: printer.seatPrefixes.length ? printer.seatPrefixes.map((prefix) => `${prefix}*`).join(' ') : '其他座位' })))))) :
            el('p', { class: 'manage-alert' }, '还没有小票机。系统管理员在 ', el('a', { href: runtime.printersUrl, text: '打印服务器管理' }), ' 中把连接在打印电脑上的热敏打印机的类型设为“小票机”。'),
        el('h4', { text: '分配方案' }),
        ...ruleCards,
        el('div', { class: 'manage-toolbar' },
            el('button', { class: 'button', type: 'button', text: '＋ 添加规则', onclick: () => {
                draft.tickets.rules.push({ id: `rule-${Date.now().toString(36)}`, name: `规则 ${draft.tickets.rules.length + 1}`, zones: [], problems: [], printers: [] });
                markDirty(); renderSettings();
            } }),
            el('span', { class: 'manage-spacer' }),
            el('button', { class: 'button', type: 'button', text: '为未送达的气球补打小票', disabled: !data.tickets, title: data.tickets ? '' : '保存开启小票打印后可用',
                onclick: () => openDialog({ title: '补打小票', confirm: '补打', body: [el('p', { text: '为所有还没有小票或打印失败、且尚未送达的气球打印小票。' })],
                    submit: async () => { const result = await post('reprint', { all: true }); notify(status, `已加入打印队列 ${result.updated} 张小票`); await refresh(true); } }) })));

    root.replaceChildren(status, basics, colors, tickets, el('div', { class: 'xp-savebar balloon-savebar' }, saveButton, discard,
        el('span', { class: 'resolver-muted manage-small', text: dirty ? '有未保存的更改' : '' })));
}

// ---------------------------------------------------------------- Page

function renderHeading() {
    if (manager) {
        const tabs = el('div', { class: 'manage-tabs balloon-tabs', role: 'tablist' },
            ...[['deliver', '配送'], ['settings', '设置']].map(([value, label]) => el('button', { type: 'button', role: 'tab', 'aria-selected': view.tab === value ? 'true' : 'false', text: label,
                onclick: () => {
                    if (view.tab === value) return;
                    if (dirty && !confirm('设置有未保存的更改，离开设置页将丢失。继续？')) return;
                    if (dirty) { dirty = false; draft = null; }
                    view.tab = value; remember(); renderHeading(); render();
                } })));
        heading.replaceChildren(tabs, el('a', { class: 'button', href: runtime.contestUrl, text: '返回比赛' }));
        return;
    }
    const name = el('input', { class: 'textbox', value: view.by, maxlength: 20, placeholder: '你的名字（记录谁送达）', 'aria-label': '配送员姓名' });
    name.addEventListener('change', () => { view.by = name.value.trim(); remember(); });
    heading.replaceChildren(name);
}

function render() {
    if (view.tab === 'settings') renderSettings();
    else renderDeliver();
}

let refreshing = false;
async function refresh(force = false) {
    if (refreshing && !force) return;
    refreshing = true;
    try {
        const response = await get(force || !data ? {} : { rev: data.revision });
        if (response.unchanged) return;
        data = response;
        // The settings form keeps what is being edited; everything else follows the server.
        if (view.tab === 'settings') { if (!dirty && !root.contains(document.activeElement)) { draft = null; renderSettings(); } }
        else renderDeliver();
    } catch (error) {
        notify(status, `刷新失败：${error.message}`, true);
        if (!data) root.replaceChildren(status);
    } finally { refreshing = false; }
}

addEventListener('beforeunload', (event) => { if (dirty) event.preventDefault(); });
renderHeading();
refresh(true);
setInterval(() => { if (!document.hidden) refresh(); }, 3000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
