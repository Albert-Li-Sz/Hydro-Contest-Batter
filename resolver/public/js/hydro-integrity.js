// 诚信复核: programs of different teams that share their structure, each team's timeline of submissions,
// recordings and gaps, and review cases that end in a conclusion. Similarity points at what to look at; the
// jury decides.
import { $, el, formatTime, get, notify, openDialog, post, runtime } from './hydro-manage-common.js';

const root = $('manage-root');
const status = el('p', { class: 'resolver-muted', role: 'status', hidden: true });
let data = null;
let timelineTeam = '';
let timelineData = null;

const clock = (ms) => { const seconds = Math.floor(ms / 1000); return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`; };
const group = (title, ...children) => el('section', { class: 'manage-group' }, el('h3', { text: title }), ...children);
const field = (label, input) => el('label', { class: 'resolver-field' }, el('span', { text: label }), input);
const tag = (text, tone = '') => el('span', { class: `manage-tag ${tone}`, text });
const teamOf = (id) => data.teams.find((team) => team.id === id);
const teamText = (id) => { const team = teamOf(id); return team ? `${team.name}${team.school ? ` · ${team.school}` : ''}` : id; };
const statusTone = { open: 'manage-tag--warn', cleared: 'manage-tag--ok', violation: 'manage-tag--bad' };
const localInput = (date) => (date ? new Date(new Date(date).getTime() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16) : '');

async function load() {
    try { data = await get(); render(); } catch (error) { notify(status, error.message, true); }
}

async function compare(pair) {
    const [a, b] = await Promise.all([get({ rid: pair.a.rid }, `${runtime.base}/code`), get({ rid: pair.b.rid }, `${runtime.base}/code`)]);
    const side = (part, code) => el('div', {}, el('p', {}, el('strong', { text: teamText(part.teamId) }), ' ',
        el('a', { href: `${runtime.recordBase}${part.rid}`, target: '_blank', rel: 'noopener', text: part.rid.slice(-6) }), ` · ${code.lang}`), el('pre', { text: code.code }));
    const { dialog } = openDialog({ title: `${pair.label} 题 · 相似度 ${Math.round(pair.score * 100)}%`, confirm: '关闭',
        body: [el('div', { class: 'integrity-code' }, side(pair.a, a), side(pair.b, b))] });
    dialog.classList.add('integrity-wide');
}

function caseDialog(initial = {}) {
    const teams = el('select', { multiple: true, 'aria-label': '队伍' }, ...data.teams.map((team) => new Option(teamText(team.id), team.id, false, (initial.teams || []).includes(team.id))));
    const title = el('input', { class: 'textbox', type: 'text', maxlength: 120, value: initial.title || '', 'aria-label': '标题' });
    const assignee = el('input', { class: 'textbox', type: 'text', maxlength: 40, 'aria-label': '负责人' });
    const due = el('input', { class: 'textbox', type: 'datetime-local', value: localInput(new Date(Math.max(Date.now(), new Date(data.endAt).getTime()) + runtime.reviewHours * 3600_000)), 'aria-label': '复核期限' });
    const detail = el('textarea', { class: 'textbox', rows: 3, 'aria-label': '说明' });
    detail.value = initial.detail || '';
    openDialog({ title: '新建复核', confirm: '建立',
        body: [field('队伍', teams), field('标题', title), el('div', { class: 'resolver-fields resolver-two' }, field('负责人', assignee), field('复核期限', due)), field('说明', detail)],
        submit: async () => {
            await post('case', { analysisAt: initial.analysisAt, pid: initial.pid, teams: [...teams.selectedOptions].map((option) => option.value), title: title.value, assignee: assignee.value,
                due: due.value ? new Date(due.value).toISOString() : null, detail: detail.value });
            notify(status, '已建立复核'); await load();
        } });
}

function similarityGroup() {
    const problems = el('div', { class: 'manage-problems' }, ...data.problems.map((problem) => el('label', {},
        el('input', { type: 'checkbox', value: problem.pid, checked: !data.run || data.run.options.pids.includes(problem.pid) }), el('span', { text: `${problem.label} 题` }))));
    const threshold = el('input', { class: 'textbox', type: 'number', min: 30, max: 100, step: 5, value: Math.round((data.run?.options.threshold ?? 0.7) * 100), 'aria-label': '相似度门槛（%）' });
    const rejected = el('input', { type: 'checkbox', checked: !!data.run?.options.includeRejected });
    const analyze = el('button', { class: 'button primary', type: 'button', text: '分析', onclick: async () => {
        analyze.disabled = true;
        try {
            const result = await post('analyze', { pids: [...problems.querySelectorAll('input:checked')].map((box) => Number(box.value)), threshold: Number(threshold.value) / 100, includeRejected: rejected.checked });
            notify(status, `比较了 ${result.samples} 份代码，${result.pairs} 对相似`); await load();
        } catch (error) { notify(status, error.message, true); analyze.disabled = false; }
    } });
    const run = data.run;
    const groups = run?.groups.length ? el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' },
        el('thead', {}, el('tr', {}, ...['队伍', '学校', '相似对', '最高', ''].map((text) => el('th', { text })))),
        el('tbody', {}, ...run.groups.slice(0, 100).map((item) => el('tr', {},
            el('td', { text: item.teams.map((id) => teamOf(id)?.name || id).join('、') }),
            el('td', {}, item.schools.join('、'), item.schools.length === 1 && item.teams.length > 1 ? tag('同校', 'manage-tag--warn') : null),
            el('td', { text: String(item.pairs) }), el('td', { text: `${Math.round(item.top * 100)}%` }),
            el('td', { class: 'col-actions' }, el('button', { class: 'button', type: 'button', text: '建复核', onclick: () => caseDialog({ analysisAt: data.run.at, teams: item.teams,
                title: `代码相似 · ${item.teams.length} 队`, detail: `相似对 ${item.pairs}，最高 ${Math.round(item.top * 100)}%。` }) }))))))) : null;
    const pairs = run?.pairs.length ? el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' },
        el('thead', {}, el('tr', {}, ...['题目', '队伍 A', '队伍 B', '相似度', ''].map((text) => el('th', { text })))),
        el('tbody', {}, ...run.pairs.slice(0, 300).map((pair) => el('tr', {},
            el('td', { text: pair.label }), el('td', { text: teamText(pair.a.teamId) }), el('td', { text: teamText(pair.b.teamId) }),
            el('td', {}, `${Math.round(pair.score * 100)}%`, pair.sameSchool ? tag('同校', 'manage-tag--warn') : null),
            el('td', { class: 'col-actions' },
                el('button', { class: 'button', type: 'button', text: '对比', onclick: () => compare(pair).catch((error) => notify(status, error.message, true)) }),
                el('button', { class: 'button', type: 'button', text: '建复核', onclick: () => caseDialog({ analysisAt: data.run.at, pid: pair.pid, teams: [pair.a.teamId, pair.b.teamId],
                    title: `${pair.label} 题代码相似`, detail: `提交 ${pair.a.rid} 与 ${pair.b.rid}，相似度 ${Math.round(pair.score * 100)}%。` }) }))))))) : null;
    return group('代码相似度',
        problems,
        el('div', { class: 'manage-toolbar' }, field('相似度门槛（%）', threshold), el('label', { class: 'checkbox' }, rejected, el('span', { text: '没有通过的题比较最后一次提交' })), analyze),
        run ? el('p', { class: 'resolver-muted', text: `${formatTime(run.at)} · ${run.by} · 比较 ${run.samples} 份代码，${run.pairs.length} 对相似` }) : null,
        groups, pairs, run && !run.pairs.length ? el('p', { class: 'manage-empty', text: '没有达到门槛的相似代码。' }) : null);
}

function updateCase(item) {
    const state = el('select', { class: 'select', 'aria-label': '结论' }, ...Object.entries(runtime.statuses).map(([value, text]) => new Option(text, value, false, value === item.status)));
    const assignee = el('input', { class: 'textbox', type: 'text', maxlength: 40, value: item.assignee || '', 'aria-label': '负责人' });
    const due = el('input', { class: 'textbox', type: 'datetime-local', value: localInput(item.due), 'aria-label': '复核期限' });
    const conclusion = el('textarea', { class: 'textbox', rows: 4, 'aria-label': '复核结论' });
    conclusion.value = item.conclusion || '';
    openDialog({ title: item.title, confirm: '保存',
        body: [el('p', { text: item.teams.map(teamText).join('；') }), item.detail ? el('p', { class: 'resolver-muted', text: item.detail }) : null,
            el('div', { class: 'resolver-fields resolver-two' }, field('结论', state), field('负责人', assignee)), field('复核期限', due), field('复核结论', conclusion),
            el('p', { class: 'manage-small manage-dim', text: item.history.map((entry) => `${formatTime(entry.at)} ${entry.note}`).join(' · ') })],
        submit: async () => {
            const result = await post('caseUpdate', { id: item.id, status: state.value, assignee: assignee.value, due: due.value ? new Date(due.value).toISOString() : null, conclusion: conclusion.value });
            notify(status, result.snapshot && state.value === 'violation' ? '已认定，成绩快照已保存' : '已保存'); await load();
        } });
}

function casesGroup() {
    const rows = data.cases.map((item) => el('tr', {},
        el('td', { text: item.title }),
        el('td', {}, ...item.teams.map((id) => el('button', { class: 'link', type: 'button', text: teamOf(id)?.name || id, onclick: () => { timelineTeam = id; loadTimeline(); } }))),
        el('td', { text: item.assignee || '—' }),
        el('td', {}, item.due ? formatTime(item.due) : '—', item.overdue ? tag('已超期', 'manage-tag--bad') : null),
        el('td', {}, tag(runtime.statuses[item.status], statusTone[item.status])),
        el('td', { class: 'col-actions' },
            el('a', { class: 'button', href: `${runtime.base}/export?case=${item.id}`, text: '证据包' }),
            el('button', { class: 'button', type: 'button', text: '处理', onclick: () => updateCase(item) }))));
    return group('复核任务',
        el('div', { class: 'manage-toolbar' }, el('button', { class: 'button', type: 'button', text: '＋ 新建复核', onclick: () => caseDialog() }),
            el('span', { class: 'manage-spacer' }), el('a', { class: 'button', href: runtime.resultsUrl, text: '成绩快照' })),
        rows.length ? el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' },
            el('thead', {}, el('tr', {}, ...['标题', '队伍', '负责人', '期限', '状态', ''].map((text) => el('th', { text })))), el('tbody', {}, ...rows)))
            : el('p', { class: 'manage-empty', text: '没有复核任务。' }));
}

async function loadTimeline() {
    if (!timelineTeam) { timelineData = null; render(); return; }
    try { timelineData = await get({ team: timelineTeam }, `${runtime.base}/timeline`); render(); } catch (error) { notify(status, error.message, true); }
}

function track(duration, parts) {
    const box = el('div', { class: 'integrity-track' });
    for (const part of parts) {
        const left = `${Math.max(0, part.from) / duration * 100}%`;
        const width = part.to === undefined ? null : `${Math.max(0.15, (Math.min(duration, part.to) - Math.max(0, part.from)) / duration * 100)}%`;
        box.append(el('span', { class: part.className, style: `left:${left};${width ? `width:${width}` : ''}`, title: part.title }));
    }
    return box;
}

function timelineGroup() {
    const choose = el('select', { class: 'select', 'aria-label': '队伍', onchange: (event) => { timelineTeam = event.target.value; loadTimeline(); } },
        new Option('选择队伍', '', false, !timelineTeam), ...data.teams.map((team) => new Option(teamText(team.id), team.id, false, team.id === timelineTeam)));
    const body = [];
    const line = timelineData;
    if (line && line.teamId === timelineTeam) {
        const duration = line.duration;
        const marks = line.submissions.map((run) => ({ from: run.at, className: `is-mark ${run.verdict === 'AC' ? 'is-ac' : 'is-rejected'}`, title: `${clock(run.at)} ${run.label} ${run.verdict}` }));
        body.push(el('div', { class: 'integrity-row' }, el('span', { text: '提交' }), track(duration, [
            ...line.credits.map((credit) => ({ from: credit.from, to: credit.from + credit.minutes * 60_000, className: 'is-credit', title: `计时补偿 ${credit.minutes} 分钟：${credit.reason}` })),
            ...marks, ...line.signals.map((signal) => ({ from: signal.at, className: 'is-mark is-signal', title: `${clock(signal.at)} ${signal.value ? '检测到多块屏幕' : '恢复为单屏'} · ${signal.device}` })),
        ])));
        for (const stream of line.streams) {
            body.push(el('div', { class: 'integrity-row' }, el('span', { text: stream.stream === 'screen' ? '屏幕录像' : '摄像头录像' }), track(duration, [
                ...stream.covered.map((part) => ({ ...part, className: 'is-covered', title: `${clock(part.from)}–${clock(part.to)} 有录像` })),
                ...[...stream.uncovered, ...stream.reported].map((part) => ({ ...part, className: 'is-gap', title: `${clock(part.from)}–${clock(part.to)} ${part.reason || '无录像'}` })),
            ])));
        }
        body.push(el('div', { class: 'integrity-scale' }, el('span', { text: '0:00' }), el('span', { text: clock(duration / 2) }), el('span', { text: clock(duration) })));
        // Each moment with the recording that covers it, to open there.
        const at = (stream, time) => {
            const segment = line.streams.find((item) => item.stream === stream)?.segments.find((part) => part.from <= time && part.to > time);
            return segment ? el('a', { href: `${line.mediaBase}${segment.id}#t=${Math.max(0, Math.floor((time - segment.from) / 1000) - 10)}`, target: '_blank', rel: 'noopener', text: stream === 'screen' ? '屏幕' : '摄像头' }) : null;
        };
        const events = [
            ...line.submissions.map((run) => ({ at: run.at, text: `${run.label} 题 ${run.verdict}`, link: el('a', { href: `${runtime.recordBase}${run.rid}`, target: '_blank', rel: 'noopener', text: run.rid.slice(-6) }) })),
            ...line.signals.map((signal) => ({ at: signal.at, text: `${signal.value ? '检测到多块屏幕' : '恢复为单屏'}（${signal.device}）` })),
            ...line.streams.flatMap((stream) => stream.reported.map((gap) => ({ at: gap.from, text: `${stream.stream === 'screen' ? '屏幕' : '摄像头'}录像中断 ${clock(gap.to - gap.from)}：${gap.reason}` }))),
        ].sort((a, b) => a.at - b.at);
        body.push(el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' },
            el('thead', {}, el('tr', {}, ...['比赛时间', '事件', '提交', '回放'].map((text) => el('th', { text })))),
            el('tbody', {}, ...events.map((event) => el('tr', {}, el('td', { class: 'manage-nowrap', text: clock(event.at) }), el('td', { text: event.text }),
                el('td', {}, event.link || ''), el('td', {}, at('screen', event.at) || '', ' ', at('webcam', event.at) || '')))))));
        if (!line.streams.some((stream) => stream.segments.length)) body.push(el('p', { class: 'resolver-muted', text: '这支队伍没有全程留档录像。' }));
    }
    return group('队伍时间轴', el('div', { class: 'manage-toolbar' }, choose), ...body);
}

function render() {
    root.replaceChildren(status, similarityGroup(), casesGroup(), timelineGroup());
}

load();
