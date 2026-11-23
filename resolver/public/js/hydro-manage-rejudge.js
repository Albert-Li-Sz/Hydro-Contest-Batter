// /manage batch rejudge: a contest, chosen problems (searched by number, id or title) or a whole
// domain, filtered by results, with accepted submissions optionally kept.
import { $, adminPassword, el, field, formatTime, get, input, notify, openDialog, post, runtime } from './hydro-manage-common.js';

const statusLabel = new Map(runtime.statuses.map(([code, short, label]) => [code, `${short} ${label}`]));
const state = { domain: runtime.domainId, scope: 'contest', contests: [], problems: [], picked: new Map() };
const scopes = [['contest', '按比赛'], ['problems', '按题目'], ['domain', '整个域']];

const status = el('p', { class: 'resolver-muted', role: 'status', hidden: true });
const domain = input({ value: runtime.domainId, 'aria-label': '域 ID', required: true });
const contest = el('select', { class: 'select', 'aria-label': '比赛' });
const skipAccepted = el('input', { type: 'checkbox', checked: true });
const statuses = el('div', { class: 'manage-statuses' }, ...runtime.statuses.map(([code, short, label]) => el('label', {},
    el('input', { type: 'checkbox', value: code }), el('span', { text: `${short} ${label}` }))));
const result = el('div');
const history = el('div');

// Scope: contest problems, searched problems, or everything in the domain.
const scopeBox = el('div', { class: 'manage-tabs', role: 'radiogroup', 'aria-label': '重测范围' });
const contestPanel = el('div');
const problemPanel = el('div');
const domainPanel = el('div', { class: 'manage-alert manage-alert--error' },
    el('strong', { text: '将重测整个域的全部提交' }),
    el('div', { text: '包括比赛内外的提交，仍按下方结果类型筛选；评测队列会被长时间占用。' }));
const contestProblems = el('div');
const search = input({ type: 'search', placeholder: '题号、题目 ID 或标题', 'aria-label': '搜索题目', autocomplete: 'off' });
const searchResults = el('ul', { class: 'manage-search', role: 'listbox', hidden: true });
const picked = el('div', { class: 'manage-picked' });

for (const [value, label] of scopes) {
    scopeBox.append(el('button', { type: 'button', role: 'radio', text: label, 'data-scope': value, onclick: () => setScope(value) }));
}

const quick = (text, codes) => el('button', {
    class: 'link', type: 'button', text,
    onclick: () => { for (const box of statuses.querySelectorAll('input')) box.checked = codes.includes(Number(box.value)); syncAccepted(); },
});

contestPanel.append(
    el('div', { class: 'resolver-fields' }, field('比赛', contest)),
    el('h3', {}, '题目',
        el('span', { class: 'manage-quick' },
            el('button', { class: 'link', type: 'button', text: '全选', onclick: () => checkProblems(true) }),
            el('button', { class: 'link', type: 'button', text: '清空', onclick: () => checkProblems(false) }))),
    contestProblems,
);
problemPanel.append(
    el('div', { class: 'manage-search-box' }, search, searchResults),
    picked,
);

$('manage-root').replaceChildren(
    el('div', { class: 'manage-group' }, el('h3', { text: '域' }),
        el('form', { class: 'manage-toolbar', onsubmit: (event) => { event.preventDefault(); loadContests(); } },
            domain, el('button', { class: 'button', type: 'submit', text: '切换域' }))),
    el('div', { class: 'manage-group' }, el('h3', { text: '范围' }), scopeBox, contestPanel, problemPanel, domainPanel),
    el('div', { class: 'manage-group' }, el('h3', {}, '评测结果',
        el('span', { class: 'manage-quick' },
            quick('常见错误', [2, 3, 4, 5, 6]), quick('TLE / MLE', [3, 4]), quick('系统错误', [8, 10]), quick('清空（全部结果）', []))),
        statuses,
        el('label', { class: 'checkbox', style: 'margin-top:12px' }, skipAccepted, 'AC 不参与重测')),
    status,
    el('div', { class: 'resolver-actions' },
        el('button', { class: 'button', type: 'button', text: '预览数量', onclick: () => preview() }),
        el('button', { class: 'button primary', type: 'button', text: '开始重测', onclick: () => run() })),
    result,
    el('div', { class: 'manage-group', style: 'margin-top:28px' }, history),
);

function setScope(scope) {
    state.scope = scope;
    for (const button of scopeBox.children) {
        button.setAttribute('aria-checked', String(button.dataset.scope === scope));
        button.setAttribute('aria-selected', String(button.dataset.scope === scope));
    }
    contestPanel.hidden = scope !== 'contest';
    problemPanel.hidden = scope !== 'problems';
    domainPanel.hidden = scope !== 'domain';
    result.replaceChildren();
    notify(status, '');
}

function syncAccepted() {
    const accepted = statuses.querySelector('input[value="1"]');
    if (accepted.checked && skipAccepted.checked) skipAccepted.checked = false;
}
statuses.querySelector('input[value="1"]').addEventListener('change', syncAccepted);
skipAccepted.addEventListener('change', () => { if (skipAccepted.checked) statuses.querySelector('input[value="1"]').checked = false; });

function checkProblems(checked) {
    for (const box of contestProblems.querySelectorAll('input[type=checkbox]')) box.checked = checked;
}

function renderContestProblems() {
    if (!contest.value) {
        contestProblems.replaceChildren(el('p', { class: 'resolver-muted', text: state.contests.length ? '请选择比赛' : `域 ${state.domain} 中没有比赛，可改为“按题目”或“整个域”` }));
        return;
    }
    contestProblems.replaceChildren(
        el('div', { class: 'manage-problems' }, ...state.problems.map((problem) => el('label', { title: problem.title },
            el('input', { type: 'checkbox', value: problem.pid }), el('strong', { text: problem.label }), el('span', { text: problem.title })))),
    );
}

const problemName = (problem) => `${problem.pid || `#${problem.docId}`} ${problem.title}`;

function renderPicked() {
    picked.replaceChildren(...state.picked.size ? [...state.picked.values()].map((problem) => el('span', { class: 'manage-tag manage-chip' },
        el('span', { text: problemName(problem) }),
        el('button', { type: 'button', class: 'manage-chip__remove', 'aria-label': `移除 ${problemName(problem)}`, text: '×', onclick: () => { state.picked.delete(problem.docId); renderPicked(); renderResults(lastResults); } })))
        : [el('span', { class: 'resolver-muted manage-small', text: '尚未选择题目' })]);
}

let lastResults = [];
function renderResults(problems) {
    lastResults = problems;
    searchResults.hidden = !search.value.trim();
    searchResults.replaceChildren(...problems.length ? problems.map((problem, index) => {
        const chosen = state.picked.has(problem.docId);
        return el('li', {
            role: 'option', 'aria-selected': String(chosen), tabindex: '-1', 'data-index': index, class: chosen ? 'is-picked' : undefined,
            onmousedown: (event) => event.preventDefault(),
            onclick: () => toggle(problem),
        }, el('strong', { text: problem.pid || `#${problem.docId}` }), el('span', { text: problem.title }), el('small', { text: chosen ? '已选' : `#${problem.docId}` }));
    }) : [el('li', { class: 'manage-dim', text: '没有匹配的题目' })]);
}

function toggle(problem) {
    if (state.picked.has(problem.docId)) state.picked.delete(problem.docId);
    else state.picked.set(problem.docId, problem);
    renderPicked();
    renderResults(lastResults);
}

let searchTimer = 0;
let searchSeq = 0;
search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    if (!search.value.trim()) { renderResults([]); return; }
    searchTimer = setTimeout(async () => {
        const seq = ++searchSeq;
        try {
            const data = await get({ domain: state.domain, search: search.value.trim() });
            if (seq === searchSeq) renderResults(data.problems);
        } catch (error) { notify(status, error.message, true); }
    }, 200);
});
search.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
        event.preventDefault();
        if (lastResults.length) toggle(lastResults[0]);
    } else if (event.key === 'Escape') { search.value = ''; renderResults([]); }
});
search.addEventListener('blur', () => { setTimeout(() => { searchResults.hidden = true; }, 150); });
search.addEventListener('focus', () => { if (search.value.trim()) searchResults.hidden = false; });

async function loadContests() {
    if (!domain.reportValidity()) return;
    try {
        const data = await get({ domain: domain.value.trim() });
        const changed = data.domainId !== state.domain;
        state.domain = data.domainId;
        state.contests = data.contests;
        contest.replaceChildren(new Option(data.contests.length ? '请选择比赛' : '（没有比赛）', ''), ...data.contests.map((tdoc) => new Option(
            `${tdoc.title} · ${tdoc.rule.toUpperCase()} · ${formatTime(tdoc.beginAt)} · ${tdoc.problems} 题`, tdoc.id)));
        state.problems = [];
        if (changed) { state.picked.clear(); renderPicked(); search.value = ''; renderResults([]); }
        renderContestProblems();
        notify(status, '');
    } catch (error) { notify(status, error.message, true); }
}

contest.addEventListener('change', async () => {
    state.problems = [];
    if (contest.value) {
        try { state.problems = (await get({ domain: state.domain, contest: contest.value })).problems; } catch (error) { notify(status, error.message, true); }
    }
    renderContestProblems();
});

function selection() {
    const body = {
        domain: state.domain, scope: state.scope,
        statuses: [...statuses.querySelectorAll('input:checked')].map((box) => Number(box.value)),
        skipAccepted: skipAccepted.checked,
    };
    if (state.scope === 'contest') {
        body.contest = contest.value || null;
        body.pids = [...contestProblems.querySelectorAll('input:checked')].map((box) => Number(box.value));
    } else if (state.scope === 'problems') body.pids = [...state.picked.keys()];
    return body;
}

const scopeName = () => (state.scope === 'contest' ? contest.selectedOptions[0]?.textContent.split(' · ')[0] : state.scope === 'domain' ? `整个域 ${state.domain}` : `域 ${state.domain} 的所选题目`);

function describe(summary, title) {
    const statusRows = Object.entries(summary.byStatus).sort((a, b) => b[1] - a[1]);
    const shown = summary.byProblem.slice(0, 60);
    return el('div', { class: 'manage-group', style: 'margin-top:18px' },
        el('h3', { text: title }),
        el('div', { class: 'resolver-stats' },
            el('div', {}, el('strong', { text: summary.total }), el('span', { text: '提交' })),
            el('div', {}, el('strong', { text: summary.byProblem.length }), el('span', { text: '题目' }))),
        summary.total ? el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' },
            el('thead', {}, el('tr', {}, el('th', { text: '按结果' }), el('th', { text: '数量' }))),
            el('tbody', {}, ...statusRows.map(([code, count]) => el('tr', {}, el('td', { text: statusLabel.get(Number(code)) || `状态 ${code}` }), el('td', { text: count })))))) : null,
        shown.length ? el('p', { class: 'resolver-muted' }, '按题目：', ...shown.map((problem) => el('span', { class: 'manage-tag', title: problem.title || undefined, text: `${problem.label} × ${problem.count}` })),
            summary.byProblem.length > shown.length ? el('span', { text: `……共 ${summary.byProblem.length} 题` }) : null) : null,
    );
}

async function preview() {
    try {
        const summary = await post('preview', selection());
        notify(status, '');
        result.replaceChildren(describe(summary, `将要重测 · ${scopeName()}`));
        return summary;
    } catch (error) {
        notify(status, error.message, true);
        result.replaceChildren();
        return null;
    }
}

async function run() {
    const summary = await preview();
    if (!summary) return;
    if (!summary.total) { notify(status, '没有符合条件的提交', true); return; }
    const whole = state.scope === 'domain';
    const password = whole ? adminPassword() : null;
    openDialog({
        title: whole ? '确认重测整个域' : '确认重测',
        confirm: `重测 ${summary.total} 条提交`,
        body: [
            el('p', { text: `将重测 ${scopeName()} 中 ${summary.byProblem.length} 道题的 ${summary.total} 条提交。原评测结果会被清空并重新排队，期间这些提交显示为等待评测。` }),
            whole ? el('div', { class: 'resolver-fields' }, field('管理员密码', password)) : null,
        ],
        submit: async () => {
            const done = await post('run', whole ? { ...selection(), password: password.value } : selection());
            result.replaceChildren(describe(done, `已加入评测队列 ${done.queued} 条`));
            if (done.job) openJob(done.job); else loadHistory();
            notify(status, done.failed.length ? `部分题目已跳过：${done.failed.join('；')}` : `已提交重测 ${done.queued} 条，可在“评测机控制”或评测记录中查看进度`, !!done.failed.length);
        },
    });
    password?.focus();
}

// ---------------------------------------------------------------- History: every run and how results moved.

const historyState = { view: 'list', page: 1, job: null, jobPage: 1, changedOnly: true, pending: 0 };
/** replaceChildren without the empty entries optional parts leave. */
const fill = (node, ...children) => node.replaceChildren(...children.filter((child) => child !== null && child !== undefined && child !== false));
const tone = (code) => (code === 1 ? 'manage-tag--ok' : code === 8 || code === 10 ? 'manage-tag--warn' : code === null ? '' : 'manage-tag--bad');
const statusTag = (code) => el('span', { class: `manage-tag ${tone(code)}`, text: code === null ? '评测中' : statusShortName(code), title: code === null ? undefined : statusLabel.get(code) });
const shortNames = { 0: 'WAIT', 1: 'AC', 2: 'WA', 3: 'TLE', 4: 'MLE', 5: 'OLE', 6: 'RE', 7: 'CE', 8: 'SE', 9: 'CANCELED', 10: 'UKE', 11: 'HACKED', 30: 'IGN', 31: 'PE' };
const statusShortName = (code) => shortNames[code] ?? `#${code}`;

function pager(page, size, total, go) {
    const pages = Math.max(1, Math.ceil(total / size));
    return el('div', { class: 'manage-pager' },
        el('span', { class: 'resolver-muted', text: `共 ${total} 条 · 第 ${page} / ${pages} 页` }),
        el('span', { class: 'manage-toolbar' },
            el('button', { class: 'button', type: 'button', text: '上一页', disabled: page <= 1, onclick: () => go(page - 1) }),
            el('button', { class: 'button', type: 'button', text: '下一页', disabled: page >= pages, onclick: () => go(page + 1) })));
}

async function loadHistory() {
    historyState.view = 'list';
    try {
        const data = await get({ page: historyState.page }, runtime.historyUrl);
        historyState.pending = data.jobs.reduce((sum, job) => sum + job.pending, 0);
        fill(history,
            el('h3', { text: '重测记录' }),
            el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' },
                el('thead', {}, el('tr', {}, ...['时间', '操作人', '范围', '提交', '结果变化', '进度'].map((text) => el('th', { text })), el('th', { class: 'col-actions', text: '' }))),
                el('tbody', {}, ...data.jobs.length ? data.jobs.map((job) => el('tr', {},
                    el('td', { class: 'manage-nowrap manage-small', text: formatTime(job.createdAt) }),
                    el('td', { text: job.operator }),
                    el('td', {}, job.description, job.failed ? el('span', { class: 'manage-tag manage-tag--warn', text: `${job.failed} 题跳过` }) : null),
                    el('td', { text: job.total }),
                    el('td', {}, job.changed ? el('span', { class: 'manage-tag manage-tag--bad', text: `${job.changed} 条变化` }) : el('span', { class: 'manage-dim', text: job.pending ? '—' : '无变化' })),
                    el('td', { class: 'manage-nowrap', text: job.pending ? `评测中 ${job.total - job.pending} / ${job.total}` : '已完成' }),
                    el('td', { class: 'col-actions' }, el('button', { class: 'button', type: 'button', text: '查看变化', onclick: () => openJob(job._id) })),
                )) : [el('tr', {}, el('td', { class: 'manage-empty', colspan: 7, text: '还没有重测记录' }))]))),
            data.total > data.pageSize ? pager(data.page, data.pageSize, data.total, (page) => { historyState.page = page; loadHistory(); }) : null,
        );
    } catch (error) { history.replaceChildren(el('p', { class: 'manage-error', text: error.message })); }
}

function openJob(id) {
    historyState.view = 'job';
    historyState.job = id;
    historyState.jobPage = 1;
    loadJob();
    history.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

async function loadJob() {
    try {
        const data = await get({ job: historyState.job, changed: historyState.changedOnly ? 'true' : 'false', page: historyState.jobPage }, runtime.historyUrl);
        const { job, stats } = data;
        historyState.pending = stats.pending;
        const only = el('input', { type: 'checkbox', checked: historyState.changedOnly });
        only.addEventListener('change', () => { historyState.changedOnly = only.checked; historyState.jobPage = 1; loadJob(); });
        fill(history,
            el('div', { class: 'manage-toolbar' },
                el('button', { class: 'button', type: 'button', text: '← 全部重测记录', onclick: () => loadHistory() }),
                el('span', { class: 'manage-spacer' }),
                el('span', { class: 'resolver-muted manage-small', text: `${formatTime(job.createdAt)} · ${job.domainId}` })),
            el('h3', { text: job.description }),
            el('div', { class: 'resolver-stats' },
                el('div', {}, el('strong', { text: stats.total }), el('span', { text: '重测提交' })),
                el('div', {}, el('strong', { text: stats.changed, class: stats.changed ? 'manage-error' : undefined }), el('span', { text: '结果变化' })),
                el('div', {}, el('strong', { text: stats.unchanged }), el('span', { text: '结果不变' })),
                el('div', {}, el('strong', { text: stats.pending }), el('span', { text: '仍在评测' }))),
            job.failed?.length ? el('p', { class: 'manage-error manage-small', text: `已跳过：${job.failed.join('；')}` }) : null,
            stats.transitions.length ? el('div', { class: 'manage-transitions' }, ...stats.transitions.map((row) => el('span', {
                class: `manage-transition${row.changed ? ' is-changed' : ''}`,
            }, statusTag(row.before), el('span', { class: 'manage-arrow', text: '→' }), statusTag(row.after), el('strong', { text: `× ${row.count}` })))) : null,
            el('label', { class: 'checkbox', style: 'margin:12px 0' }, only, '只看结果变化的提交'),
            el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' },
                el('thead', {}, el('tr', {}, ...['提交', '题目', '用户', '重测前', '', '重测后', '评测完成'].map((text) => el('th', { text })))),
                el('tbody', {}, ...data.items.length ? data.items.map((item) => el('tr', { class: item.after !== null && item.after !== item.before ? 'is-selected' : undefined },
                    el('td', {}, el('a', { href: item.url, target: '_blank', rel: 'noopener', text: item.rid.slice(-8), title: item.rid })),
                    el('td', { title: item.title }, el('strong', { text: item.problem }), item.title ? el('span', { class: 'manage-dim', text: ` ${item.title}` }) : null),
                    el('td', { text: item.displayName ? `${item.displayName}（${item.user}）` : item.user }),
                    el('td', {}, statusTag(item.before), item.beforeScore !== null ? el('span', { class: 'manage-dim manage-small', text: ` ${item.beforeScore} 分` }) : null),
                    el('td', { class: 'manage-arrow', text: '→' }),
                    el('td', {}, statusTag(item.after), item.after !== null && item.afterScore !== null ? el('span', { class: 'manage-dim manage-small', text: ` ${item.afterScore} 分` }) : null),
                    el('td', { class: 'manage-nowrap manage-small', text: formatTime(item.judgedAt) }),
                )) : [el('tr', {}, el('td', { class: 'manage-empty', colspan: 7, text: historyState.changedOnly ? (stats.pending ? '暂无结果变化，仍有提交在评测' : '没有结果变化的提交') : '没有记录' }))]))),
            data.total > data.pageSize ? pager(data.page, data.pageSize, data.total, (page) => { historyState.jobPage = page; loadJob(); }) : null,
        );
    } catch (error) { history.replaceChildren(el('p', { class: 'manage-error', text: error.message })); }
}

// While records are still being judged, follow their new results.
setInterval(() => {
    if (document.hidden || !historyState.pending || document.querySelector('dialog[open]')) return;
    if (historyState.view === 'job') loadJob(); else loadHistory();
}, 5000);

setScope('contest');
renderPicked();
loadContests();
loadHistory();
