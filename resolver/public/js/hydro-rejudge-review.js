// 重测复核: submissions whose result a rejudge changed, what that did to the teams, and resolver sessions built
// before it. The new results stand; the jury may restore the original results of the submissions it picks.
import { $, el, formatTime, get, notify, openDialog, post, runtime } from './hydro-manage-common.js';

const kinds = [['lostAccept', 'AC → 非 AC'], ['gainedAccept', '非 AC → AC'], ['other', '其他变化']];
const states = [['kept', '采用新结果'], ['restored', '已恢复原结果'], ['moved', '之后又有变化']];
const filter = { pids: new Set(), kinds: new Set(), states: new Set(), affecting: false };
const selected = new Set();
const status = el('p', { class: 'resolver-muted', role: 'status', hidden: true });
let data = null;

const clock = (seconds) => `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
const tag = (text, tone = '') => el('span', { class: `manage-tag ${tone}`, text });

function chip(text, active, onclick) {
    return el('button', { type: 'button', class: `manage-filter${active ? ' is-active' : ''}`, 'aria-pressed': active ? 'true' : 'false', text, onclick });
}

function toggle(set, value) {
    if (set.has(value)) set.delete(value); else set.add(value);
    selected.clear();
    load();
}

async function load() {
    try {
        data = await get({ pids: [...filter.pids].join(','), kinds: [...filter.kinds].join(','), states: [...filter.states].join(','), affecting: filter.affecting ? 'true' : '' });
        render();
    } catch (error) { notify(status, error.message, true); }
}

function impactText(impact) {
    if (!impact) return '—';
    const rank = (value) => value || '*';
    const awards = (list) => (list.length ? list.join('、') : '无奖项');
    return `${rank(impact.rankBefore)} → ${rank(impact.rankAfter)} · ${awards(impact.awardsBefore)} → ${awards(impact.awardsAfter)}`;
}

function changesTable() {
    if (!data.changes.length) return el('p', { class: 'resolver-muted', text: data.total ? '没有符合条件的提交。' : '重测没有改变任何提交的结果。' });
    const all = el('input', { type: 'checkbox', 'aria-label': '全选', checked: data.changes.every((change) => selected.has(change.rid)) });
    all.addEventListener('change', () => { for (const change of data.changes) { if (all.checked) selected.add(change.rid); else selected.delete(change.rid); } render(); });
    return el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' },
        el('thead', {}, el('tr', {}, el('th', {}, all), ...['提交', '队伍', '题目', '提交时间', '原结果', '重测结果', '现在', '名次 · 奖项（原 → 现）'].map((text) => el('th', { text })))),
        el('tbody', {}, ...data.changes.map((change) => {
            const box = el('input', { type: 'checkbox', 'aria-label': `选择提交 ${change.rid}`, checked: selected.has(change.rid) });
            box.addEventListener('change', () => { if (box.checked) selected.add(change.rid); else selected.delete(change.rid); renderActions(); });
            const state = states.find(([value]) => value === change.state)[1];
            return el('tr', { class: change.impact?.changed ? 'manage-row--warn' : '' },
                el('td', {}, box),
                el('td', {}, el('a', { href: `/d/${encodeURIComponent(runtime.domainId)}/record/${change.rid}`, text: change.rid.slice(-8) })),
                el('td', { text: change.teamName }),
                el('td', { text: change.label }),
                el('td', { text: clock(Math.max(0, change.time)) }),
                el('td', { text: change.originalName }),
                el('td', { text: change.rejudgedName }),
                el('td', {}, el('span', { text: change.currentName }), ' ', tag(state, change.state === 'restored' ? 'manage-tag--warn' : change.state === 'moved' ? '' : 'manage-tag--ok')),
                el('td', { text: impactText(change.impact) }));
        }))));
}

const actions = el('div', { class: 'manage-toolbar' });
function renderActions() {
    const picked = data.changes.filter((change) => selected.has(change.rid));
    const restorable = picked.filter((change) => change.state !== 'restored').map((change) => change.rid);
    const reapplicable = picked.filter((change) => change.state === 'restored').map((change) => change.rid);
    actions.replaceChildren(
        el('span', { class: 'resolver-muted', text: `已选 ${picked.length} 条` }),
        el('button', { class: 'button', type: 'button', text: `恢复原结果${restorable.length ? `（${restorable.length}）` : ''}`, disabled: !runtime.canRestore || !restorable.length,
            onclick: () => confirmApply(restorable, true) }),
        el('button', { class: 'button', type: 'button', text: `改回重测结果${reapplicable.length ? `（${reapplicable.length}）` : ''}`, disabled: !runtime.canRestore || !reapplicable.length,
            onclick: () => confirmApply(reapplicable, false) }),
    );
}

function confirmApply(rids, restore) {
    openDialog({
        title: restore ? '恢复原结果' : '改回重测结果', confirm: restore ? '恢复' : '改回',
        body: [el('p', { text: `${rids.length} 条提交的结果将${restore ? '恢复为重测前' : '改回重测后'}的结果，榜单与成绩随之更新。操作前会保存一份成绩快照。` })],
        submit: async () => {
            const result = await post('restore', { rids, restore });
            selected.clear();
            notify(status, `已更新 ${result.updated} 条提交`);
            await load();
        },
    });
}

function sessionsBlock() {
    if (!data.sessions.length) return el('p', { class: 'resolver-muted', text: '还没有滚榜会话。' });
    const stale = data.sessions.filter((session) => session.stale);
    const rebuild = el('button', { class: 'button', type: 'button', text: `用当前成绩重建过期会话（${stale.length}）`, disabled: !stale.length, onclick: async () => {
        rebuild.disabled = true;
        try {
            const result = await post('rebuild', { ids: stale.map((session) => session.id) });
            notify(status, `已新建 ${result.created.length} 个滚榜会话，原会话保留`);
            await load();
        } catch (error) { notify(status, error.message, true); rebuild.disabled = false; }
    } });
    return el('div', {},
        el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' },
            el('thead', {}, el('tr', {}, ...['创建时间', '分榜', '创建者', '状态'].map((text) => el('th', { text })))),
            el('tbody', {}, ...data.sessions.map((session) => el('tr', {},
                el('td', {}, session.own ? el('a', { href: `${runtime.contestUrl}/resolver/sessions/${session.id}`, text: formatTime(session.createdAt) }) : formatTime(session.createdAt)),
                el('td', { text: session.board === 'all' ? '主榜' : session.board }),
                el('td', { text: session.owner }),
                el('td', {}, session.stale ? tag('基于旧结果', 'manage-tag--warn') : tag('最新', 'manage-tag--ok'), session.rehearsal ? ' 彩排' : '')))))),
        el('div', { class: 'manage-toolbar' }, rebuild));
}

function render() {
    const filters = el('div', { class: 'manage-group' },
        el('div', { class: 'manage-chips' }, ...data.problems.map((problem) => chip(problem.label, filter.pids.has(problem.pid), () => toggle(filter.pids, problem.pid)))),
        el('div', { class: 'manage-chips' }, ...kinds.map(([value, text]) => chip(text, filter.kinds.has(value), () => toggle(filter.kinds, value))),
            ...states.map(([value, text]) => chip(text, filter.states.has(value), () => toggle(filter.states, value))),
            chip('影响名次或奖项', filter.affecting, () => { filter.affecting = !filter.affecting; selected.clear(); load(); })));
    renderActions();
    const summary = [
        data.jobs.length ? `${data.jobs.length} 次重测` : '本场比赛没有批量重测记录',
        data.total ? `${data.total} 条提交结果有变化` : '',
        data.pending ? `${data.pending} 条仍在评测` : '',
    ].filter(Boolean).join(' · ');
    $('manage-root').replaceChildren(
        status,
        el('p', { text: summary }),
        el('div', { class: 'manage-group' }, el('h3', { text: '结果变化' }), filters, actions, changesTable()),
        el('div', { class: 'manage-group' }, el('h3', { text: '滚榜会话' }), sessionsBlock()),
    );
}

load();
