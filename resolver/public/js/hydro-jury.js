// 裁判操作: results held from the public while the jury checks a problem, time credited to a team that lost it,
// and results set by hand. Every action needs a reason and is kept in the log below.
import { $, el, formatTime, get, notify, openDialog, post, runtime } from './hydro-manage-common.js';

const root = $('manage-root');
const status = el('p', { class: 'resolver-muted', role: 'status', hidden: true });
let data = null;
let filter = '';

const clock = (seconds) => `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
/** "1:30", "1:30:15" or "90" (minutes) as seconds from the contest start. */
function parseClock(text) {
    const parts = String(text).trim().split(':').map((part) => Number(part));
    if (!parts.length || parts.some((part) => !Number.isFinite(part) || part < 0)) return NaN;
    if (parts.length === 1) return Math.round(parts[0] * 60);
    const [h, m, s = 0] = parts;
    return h * 3600 + m * 60 + s;
}
const group = (title, ...children) => el('section', { class: 'manage-group' }, el('h3', { text: title }), ...children);
const field = (label, input) => el('label', { class: 'resolver-field' }, el('span', { text: label }), input);

async function load() {
    try { data = await get(); render(); } catch (error) { notify(status, error.message, true); }
}

async function act(operation, payload, message) {
    await post(operation, payload);
    notify(status, message);
    await load();
}

function reasonDialog(title, confirm, extra, submit) {
    const reason = el('input', { class: 'textbox', type: 'text', maxlength: 200, required: true, 'aria-label': '原因' });
    openDialog({ title, confirm, body: [...extra, field('原因', reason)], submit: async () => {
        if (!reason.value.trim()) throw new Error('请填写原因');
        await submit(reason.value.trim());
    } });
}

function holdsGroup() {
    const problem = el('select', { class: 'select', 'aria-label': '题目' }, ...data.problems.map((item) => new Option(`${item.label} 题`, item.pid)));
    const since = el('input', { class: 'textbox', type: 'text', value: '0:00', 'aria-label': '暂缓起点', placeholder: '0:00' });
    const rows = data.holds.map((hold) => el('tr', {},
        el('td', { text: `${hold.label} 题` }),
        el('td', { text: hold.since ? `${clock(hold.since)} 起` : '整道题' }),
        el('td', { text: hold.reason }),
        el('td', { class: 'manage-small', text: `${hold.operator} · ${formatTime(hold.at)}` }),
        el('td', { class: 'col-actions' }, el('button', { class: 'button primary', type: 'button', text: '公布', onclick: () => reasonDialog(`公布 ${hold.label} 题的结果`, '公布', [],
            (reason) => act('release', { id: hold.id, reason }, `${hold.label} 题已恢复公布`)) }))));
    return group('暂缓公布',
        rows.length ? el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' },
            el('thead', {}, el('tr', {}, ...['题目', '范围', '原因', '操作人', ''].map((text) => el('th', { text })))), el('tbody', {}, ...rows))) : null,
        el('div', { class: 'manage-toolbar' }, problem, field('比赛时间起点', since),
            el('button', { class: 'button', type: 'button', text: '暂缓公布', onclick: () => {
                const seconds = parseClock(since.value);
                if (!Number.isFinite(seconds) || seconds > data.duration) { notify(status, '请填写比赛时间内的起点，例如 3:20', true); return; }
                reasonDialog('暂缓公布', '暂缓', [el('p', { text: `${problem.selectedOptions[0].textContent}自 ${clock(seconds)} 起的结果对外显示为评测中，气球同步暂缓。` })],
                    (reason) => act('hold', { pid: Number(problem.value), since: seconds, reason }, '已暂缓公布'));
            } })));
}

function creditsGroup() {
    const team = el('select', { class: 'select', 'aria-label': '队伍' }, ...data.teams.map((item) => new Option(item.school ? `${item.name} · ${item.school}` : item.name, item.id)));
    const from = el('input', { class: 'textbox', type: 'text', placeholder: '2:15', 'aria-label': '停机开始' });
    const minutes = el('input', { class: 'textbox', type: 'number', min: 1, step: 1, value: 5, 'aria-label': '停机分钟' });
    const rows = data.credits.map((credit) => el('tr', {},
        el('td', { text: credit.team }),
        el('td', { text: `${clock(credit.from)} 起 ${credit.minutes} 分钟` }),
        el('td', { text: credit.reason }),
        el('td', { class: 'manage-small', text: `${credit.operator} · ${formatTime(credit.at)}` }),
        el('td', { class: 'col-actions' }, el('button', { class: 'button', type: 'button', text: '撤销', onclick: () => reasonDialog(`撤销 ${credit.team} 的计时补偿`, '撤销', [],
            (reason) => act('uncredit', { id: credit.id, reason }, '已撤销补偿')) }))));
    return group('计时补偿',
        rows.length ? el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' },
            el('thead', {}, el('tr', {}, ...['队伍', '停机', '原因', '操作人', ''].map((text) => el('th', { text })))), el('tbody', {}, ...rows))) : null,
        el('div', { class: 'manage-toolbar' }, team, field('停机开始（比赛时间）', from), field('停机分钟', minutes),
            el('button', { class: 'button', type: 'button', text: '补偿', onclick: () => {
                const seconds = parseClock(from.value);
                const length = Number(minutes.value);
                if (!Number.isFinite(seconds) || seconds >= data.duration) { notify(status, '请填写比赛时间内的停机开始时间，例如 2:15', true); return; }
                if (!Number.isInteger(length) || length < 1) { notify(status, '停机分钟应为正整数', true); return; }
                reasonDialog('计时补偿', '补偿', [el('p', { text: `${team.selectedOptions[0].textContent}在 ${clock(seconds)} 之后的提交时间各减去最多 ${length} 分钟，罚时随之减少；比赛结束时间不变。` })],
                    (reason) => act('credit', { teamId: team.value, from: seconds, minutes: length, reason }, '已补偿'));
            } })));
}

function verdictDialog(run) {
    const verdict = el('select', { class: 'select', 'aria-label': '改判为' }, ...runtime.verdicts.map(([code, short, name]) => new Option(`${short} · ${name}`, code)));
    const password = el('input', { class: 'textbox', type: 'password', autocomplete: 'current-password', required: true, 'aria-label': '当前账号密码' });
    reasonDialog(`改判 ${run.team} 的 ${run.label} 题提交`, '改判', [
        el('p', { text: `${clock(run.time)} 提交，当前结果 ${run.status}。改判前会自动拍一份成绩快照。` }), field('改判为', verdict), field('当前账号密码', password),
    ], (reason) => act('verdict', { rid: run.rid, status: Number(verdict.value), reason, password: password.value }, '已改判'));
}

function verdictsGroup() {
    if (!runtime.canVerdict) return null;
    const search = el('input', { class: 'textbox', type: 'search', value: filter, placeholder: '队伍、题号或提交编号', 'aria-label': '筛选提交', oninput: (event) => { filter = event.target.value; renderTable(); } });
    const host = el('div', { class: 'manage-scroll' });
    const renderTable = () => {
        const needle = filter.trim().toLowerCase();
        const runs = data.submissions.filter((run) => !needle || `${run.team} ${run.label} ${run.rid}`.toLowerCase().includes(needle)).slice(0, 200);
        host.replaceChildren(runs.length ? el('table', { class: 'data-table' },
            el('thead', {}, el('tr', {}, ...['时间', '队伍', '题目', '结果', '提交', ''].map((text) => el('th', { text })))),
            el('tbody', {}, ...runs.map((run) => el('tr', {},
                el('td', { class: 'manage-nowrap', text: clock(run.time) }), el('td', { text: run.team }), el('td', { text: run.label }), el('td', { text: run.status }),
                el('td', {}, el('a', { href: `${runtime.recordBase}${run.rid}`, target: '_blank', rel: 'noopener', text: run.rid.slice(-6) })),
                el('td', { class: 'col-actions' }, el('button', { class: 'button', type: 'button', text: '改判', onclick: () => verdictDialog(run) }))))))
            : el('p', { class: 'manage-empty', text: '没有符合条件的提交。' }));
    };
    renderTable();
    return group('人工改判', el('div', { class: 'manage-toolbar' }, search, el('a', { class: 'button', href: runtime.reviewUrl, text: '重测复核' })), host);
}

const actionNames = { hold: '暂缓公布', release: '恢复公布', credit: '计时补偿', uncredit: '撤销补偿', verdict: '人工改判' };
function logGroup() {
    return group('操作记录', data.log.length ? el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' },
        el('thead', {}, el('tr', {}, ...['时间', '操作', '内容', '原因', '操作人'].map((text) => el('th', { text })))),
        el('tbody', {}, ...data.log.map((entry) => el('tr', {},
            el('td', { class: 'manage-nowrap manage-small', text: formatTime(entry.at) }), el('td', { text: actionNames[entry.action] || entry.action }),
            el('td', { text: entry.text }), el('td', { text: entry.reason }), el('td', { text: entry.operator }))))))
        : el('p', { class: 'manage-empty', text: '还没有裁判操作。' }));
}

function render() {
    root.replaceChildren(status, holdsGroup(), creditsGroup(), verdictsGroup() || '', logGroup());
}

load();
