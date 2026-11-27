// Contest overview screen: polls the overview data, keeps the clock on the server's time.
import { venueClock } from './venue-time.js';
import { inkOn } from './ink.js';

const runtime = JSON.parse(document.getElementById('overview-runtime').textContent);
const $ = (id) => document.getElementById(id);
let data = null;
let offset = 0; // server clock minus local clock
const shown = new Map(); // KPI id -> number currently displayed (for the count-up)
const seenAccepts = new Set(); // recent accepts already shown, so only new ones flash
let firstRender = true;

const pad = (value) => String(value).padStart(2, '0');
const clock = (ms) => {
    const total = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(total / 3600)}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
};
const minutes = (minute) => `${Math.floor(minute / 60)}:${pad(minute % 60)}`;
const thousands = (value) => Number(value).toLocaleString('zh-CN');
const timeOfDay = venueClock(runtime.timeZone, {});
const timeWithSeconds = venueClock(runtime.timeZone);
const statusText = { before: '未开始', running: '进行中', frozen: '已封榜', ended: '已结束' };
const verdictColors = { ok: '#3ddc84', wa: '#ff6b6b', tle: '#ffb547', mle: '#c084fc', re: '#f472b6', ce: '#94a3b8', other: '#64748b', pending: '#4da3ff' };

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'style') node.style.cssText = value;
        else node.setAttribute(key, value);
    }
    node.append(...children.filter((child) => child !== null && child !== undefined));
    return node;
}
const cell = (text, cls = '', title) => el('span', { class: `ov-cell ${cls}`, text, title: title || undefined });

/** Readable text on a balloon colour. */
function balloon(label, color) {
    const node = el('span', { class: 'ov-balloon', text: label });
    if (/^#[0-9a-f]{6}$/i.test(color || '')) {
        const ink = inkOn(color, '#10203a', '#ffffff');
        node.style.background = color;
        node.style.color = ink;
        if (ink !== '#ffffff') node.style.textShadow = 'none';
    }
    return node;
}

/** Count up to a new value over 0.6 s, so changes catch the eye. */
function animate(node, id, target, format) {
    const from = shown.get(id) ?? 0;
    shown.set(id, target);
    if (from === target || matchMedia('(prefers-reduced-motion: reduce)').matches) { node.textContent = format(target); return; }
    const start = performance.now();
    const step = (now) => {
        const t = Math.min(1, (now - start) / 600);
        node.textContent = format(from + (target - from) * (1 - (1 - t) ** 3));
        if (t < 1) requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
}

function kpi(id, label, value, { format = (v) => thousands(Math.round(v)), unit = '', note = '', tone = '', share } = {}) {
    let card = $(`kpi-${id}`);
    if (!card) {
        card = el('div', { class: `ov-kpi${tone ? ` ov-kpi--${tone}` : ''}`, id: `kpi-${id}` },
            el('div', { class: 'ov-kpi__label', text: label }),
            el('div', { class: 'ov-kpi__value' }, el('span'), el('small')),
            el('div', { class: 'ov-kpi__note' }));
        $('kpis').append(card);
    }
    animate(card.querySelector('.ov-kpi__value span'), id, value, format);
    card.querySelector('.ov-kpi__value small').textContent = unit;
    const detail = card.querySelector('.ov-kpi__note');
    if (Number.isFinite(share)) {
        detail.replaceChildren(el('span', { class: 'ov-share', role: 'img', title: note, 'aria-label': note },
            el('i', { style: 'width:' + Math.min(100, Math.max(0, share)) + '%' })));
    } else detail.textContent = note;
}

/**
 * Put rows into a panel, each as tall as the space allows (up to `max` lines). With `all`, the text
 * shrinks until every row fits (standings, problems); otherwise rows that do not fit are left out.
 */
function fill(container, head, rows, empty, { max = 2.4, all = false } = {}) {
    container.style.fontSize = '';
    container.replaceChildren(...(head ? [head] : []));
    if (!rows.length) { container.append(el('div', { class: 'ov-empty', text: empty })); return; }
    const MIN_LINE = 1.55;
    let font = Number.parseFloat(getComputedStyle(container).fontSize) || 16;
    const space = () => container.clientHeight - (head ? head.offsetHeight : 0);
    // The head shrinks with the text, so step the size down until every row fits.
    while (all && font > 10 && rows.length * font * MIN_LINE > space()) {
        font = Math.max(10, font - 0.5);
        container.style.fontSize = `${font}px`;
    }
    const fit = Math.max(1, Math.min(rows.length, Math.floor(space() / (font * MIN_LINE))));
    container.style.setProperty('--row', `${Math.min(font * max, space() / fit)}px`);
    container.append(...rows.slice(0, fit));
}
const head = (...labels) => el('div', { class: 'ov-row ov-row--head' }, ...labels.map(([text, cls]) => cell(text, cls)));

function rankPanel(teams) {
    const rows = teams.map((team) => el('div', { class: 'ov-row' },
        el('span', { class: 'ov-cell' }, el('span', { class: `ov-rank${team.rank <= 3 && team.solved ? ' ov-rank--top' : ''}`, text: team.rank })),
        cell(team.name, 'ov-team', team.name), cell(team.school || '—', 'ov-muted', team.school),
        cell(team.solved, 'ov-num ov-solved'), cell(thousands(team.penaltyMinutes), 'ov-num ov-muted')));
    fill($('rank'), head(['名次'], ['队伍'], ['学校'], ['题数', 'ov-num'], ['罚时', 'ov-num']), rows, '暂无正式队伍', { all: true });
}

function problemPanel(problems) {
    const rows = problems.map((problem) => {
        const accept = problem.submissions ? (problem.accepted / problem.submissions) * 100 : 0;
        const first = problem.firstSolve;
        return el('div', { class: 'ov-row' },
            el('span', { class: 'ov-cell' }, balloon(problem.label, problem.color)),
            cell(`${problem.solvedTeams} / ${problem.attemptedTeams}`, 'ov-num'),
            el('span', { class: 'ov-cell ov-ratebar' }, el('span', { class: 'ov-bar' }, el('i', { style: `width:${accept.toFixed(1)}%` })),
                el('span', { class: 'ov-num ov-muted', text: `${accept.toFixed(0)}%` })),
            first ? cell(`${minutes(first.minute)} ${first.team}`, 'ov-first', `首解 ${minutes(first.minute)} ${first.team}${first.school ? ` · ${first.school}` : ''}`)
                : cell('尚无人通过', 'ov-muted'));
    });
    fill($('problems'), head(['题目'], ['通过/尝试', 'ov-num'], ['通过率'], ['首解']), rows, '暂无题目', { all: true });
}

function schoolPanel(schools, total) {
    $('school-hint').textContent = total > schools.length ? `共 ${total} 所 · 按最好名次` : '按最好名次';
    const rows = schools.map((school) => el('div', { class: 'ov-row' },
        cell(school.name, 'ov-team', school.name), cell(school.teams, 'ov-num'), cell(school.solvedTeams, 'ov-num'),
        cell(school.solved, 'ov-num ov-solved'), cell(school.bestRank ?? '—', 'ov-num')));
    fill($('schools'), head(['学校'], ['队伍', 'ov-num'], ['过题队', 'ov-num'], ['总题数', 'ov-num'], ['最好', 'ov-num']), rows, '暂无学校信息');
}

function recentPanel(accepts) {
    const rows = accepts.map((item) => {
        const key = `${item.minute}/${item.team}/${item.problem}`;
        const fresh = !firstRender && !seenAccepts.has(key);
        seenAccepts.add(key);
        return el('div', { class: `ov-row${fresh ? ' ov-fresh' : ''}` },
            cell(minutes(item.minute), 'ov-muted'),
            el('span', { class: 'ov-cell' }, balloon(item.problem, item.color)),
            cell(`${item.team}${item.school ? ` · ${item.school}` : ''}`, '', item.team),
            el('span', { class: 'ov-cell' }, item.firstSolve ? el('span', { class: 'ov-tag', text: '首解' }) : null,
                item.unofficial ? el('span', { class: 'ov-tag ov-tag--star', text: '打星' }) : null));
    });
    fill($('recent'), null, rows, '暂无通过');
}

function histogramPanel(histogram) {
    const max = Math.max(1, ...histogram.map((item) => item.teams));
    $('histogram').replaceChildren(...histogram.map((item) => el('div', { class: 'ov-hist__col', title: `${item.solved} 题：${item.teams} 队` },
        el('span', { class: 'ov-hist__count', text: item.teams }),
        el('span', { class: `ov-hist__bar${item.teams ? '' : ' ov-hist__bar--zero'}`, style: `height:${(item.teams / max) * 72}%` }),
        el('span', { class: 'ov-hist__label', text: item.solved }))));
}

function verdictPanel(verdicts, total) {
    const rows = verdicts.filter((item) => item.count || item.key === 'ok' || item.key === 'wa');
    const chart = el('div', { class: 'ov-verdict-chart', role: 'img', 'aria-label': total ? rows.map(item => item.label + ' ' + item.count).join('，') : '暂无提交' });
    for (const item of rows) {
        if (!item.count || !total) continue;
        chart.append(el('i', { style: `width:${item.count / total * 100}%;background:${verdictColors[item.key]}`,
            title: item.label + ' ' + (item.count / total * 100).toFixed(1) + '%' }));
    }
    $('verdicts').replaceChildren(chart, ...rows.map(item => el('div', { class: 'ov-verdict' },
        el('i', { class: 'ov-dot', style: 'background:' + verdictColors[item.key] }), el('span', { text: item.label }),
        el('span', { class: 'ov-num', text: thousands(item.count) }))));
}

const bytes = (value) => {
    if (value == null) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
    return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
};
const level = (rate) => (rate == null ? '' : rate >= 90 ? 'ov-critical' : rate >= 70 ? 'ov-hot' : '');
const levelColor = (rate) => (rate >= 90 ? 'var(--ov-bad)' : rate >= 70 ? 'var(--ov-warn)' : 'var(--ov-ok)');
const percent = (rate) => (rate == null ? '—' : `${Math.round(rate)}%`);
const ago = (seconds) => (seconds < 60 ? '实时' : seconds < 3600 ? `${Math.floor(seconds / 60)} 分前` : `${Math.floor(seconds / 3600)} 时前`);
const duration = (seconds) => (seconds >= 86400 ? `${Math.floor(seconds / 86400)} 天` : `${Math.floor(seconds / 3600)} 小时`);

function meter(id, rate) {
    $(`${id}-bar`).style.width = `${Math.min(100, rate ?? 0)}%`;
    $(`${id}-bar`).style.background = levelColor(rate ?? 0);
    $(id).textContent = percent(rate);
    $(id).className = level(rate);
}

/** This server sampled live; judge machines as of their last report to Hydro. */
function systemPanel(system) {
    if (!system) return;
    const { host, judges, queue } = system;
    meter('cpu', host.cpu);
    $('cpu-note').textContent = host.load ? `负载 ${host.load[0]} / ${host.cores} 核` : `${host.cores} 核`;
    meter('mem', host.memoryRate);
    $('mem-note').textContent = `${bytes(host.memoryUsed)} / ${bytes(host.memoryTotal)}`;
    const fact = (label, value) => [label, el('b', { text: value })];
    $('sys-facts').replaceChildren(...fact('Hydro 进程 ', bytes(host.processRss)), ' · ', ...fact('评测队列 ', thousands(queue)),
        ' · ', ...fact('已运行 ', duration(host.uptimeSeconds)));
    const rows = judges.map((judge) => el('div', { class: 'ov-row' },
        cell(judge.name, '', judge.name),
        cell(percent(judge.cpu), `ov-num ${level(judge.cpu)}`), cell(percent(judge.memoryRate), `ov-num ${level(judge.memoryRate)}`),
        cell(ago(judge.reportedSecondsAgo), 'ov-num ov-muted', judge.kind === 'local' ? '与服务器同机，实时' : '评测机每 20 分钟上报一次')));
    fill($('judges'), head(['评测机'], ['CPU', 'ov-num'], ['内存', 'ov-num'], ['数据', 'ov-num']), rows, '没有评测机上报', { max: 1.9 });
}

function chart(trend, totalMinutes) {
    const svg = $('chart');
    // Drawn at the element's own pixel size, so lines and labels stay crisp at any resolution.
    const width = Math.max(240, svg.clientWidth || 1200);
    const height = Math.max(100, svg.clientHeight || 220);
    const font = Math.round(Math.min(20, Math.max(11, height / 12)));
    const padding = { left: font * 3.4, right: font * 1.2, top: font, bottom: font * 1.9 };
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
    const NS = 'http://www.w3.org/2000/svg';
    const make = (tag, attrs, text) => {
        const node = document.createElementNS(NS, tag);
        for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value));
        if (text != null) node.textContent = text;
        return node;
    };
    const max = Math.max(1, ...trend.map((point) => point.submissions));
    const x = (minute) => padding.left + (minute / Math.max(1, totalMinutes)) * (width - padding.left - padding.right);
    const y = (value) => height - padding.bottom - (value / max) * (height - padding.top - padding.bottom);
    const area = (key, cls) => {
        if (!trend.length) return null;
        const points = [[x(0), y(0)], ...trend.map((point) => [x(point.minute), y(point[key])])];
        const line = points.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(' L');
        return make('path', { d: `M${line} L${points.at(-1)[0].toFixed(1)},${y(0)} Z`, class: cls });
    };
    const nodes = [area('submissions', 'ov-area--sub'), area('accepted', 'ov-area--ok')].filter(Boolean);
    nodes.push(make('text', { x: padding.left - 8, y: padding.top + font * 0.8, class: 'ov-axis', 'font-size': font, 'text-anchor': 'end' }, thousands(max)));
    nodes.push(make('text', { x: padding.left - 8, y: height - padding.bottom, class: 'ov-axis', 'font-size': font, 'text-anchor': 'end' }, '0'));
    for (const part of [0, 0.25, 0.5, 0.75, 1]) {
        const minute = Math.round(totalMinutes * part);
        nodes.push(make('text', { x: x(minute), y: height - font * 0.4, class: 'ov-axis', 'font-size': font, 'text-anchor': part === 0 ? 'start' : part === 1 ? 'end' : 'middle' },
            minutes(minute)));
    }
    svg.replaceChildren(...nodes);
}

function render() {
    if (!data) return;
    $('title').textContent = data.title;
    document.title = `${data.title} · 赛况总览`;
    const status = $('status');
    status.hidden = false;
    status.dataset.status = data.status;
    status.textContent = statusText[data.status];
    kpi('teams', '参赛队伍', data.teams, { note: data.unofficialTeams ? `正式 ${thousands(data.officialTeams)} · 打星 ${thousands(data.unofficialTeams)}` : '全部为正式队伍' });
    kpi('schools', '参赛学校', data.schools);
    kpi('problems', '已解出题目', data.solvedProblems, { unit: `/ ${data.problems}` });
    kpi('submissions', '总提交', data.submissions, { note: data.pending ? `评测中 ${thousands(data.pending)}` : '' });
    kpi('accepted', '通过', data.accepted, { note: data.submissions ? `通过率 ${data.acceptRate.toFixed(1)}%` : '暂无提交', share: data.submissions ? data.acceptRate : null, tone: 'ok' });
    kpi('solved', '已过题队伍', data.solvedTeams, { note: data.teams ? `占参赛队伍 ${data.solvedTeamsRate.toFixed(1)}%` : '暂无队伍', share: data.teams ? data.solvedTeamsRate : null });
    kpi('average', '队均过题', data.averageSolved, { format: (v) => v.toFixed(1), unit: '题' });
    kpi('recent', '近 10 分钟提交', data.recentSubmissions, { note: `其中通过 ${thousands(data.recentAccepted)}` });
    const totalMinutes = Math.round((data.endAt - data.beginAt) / 60_000);
    rankPanel(data.topTeams);
    problemPanel(data.problemStats);
    schoolPanel(data.schoolStats, data.schools);
    recentPanel(data.recentAccepts);
    histogramPanel(data.histogram);
    verdictPanel(data.verdicts, data.submissions);
    systemPanel(data.system);
    chart(data.trend, totalMinutes);
    const freeze = $('freeze');
    const lockShown = data.lockAt && data.lockAt < data.endAt;
    freeze.hidden = !lockShown;
    $('begin-at').textContent = `开始 ${timeOfDay(data.beginAt)}`;
    $('end-at').textContent = `结束 ${timeOfDay(data.endAt)}`;
    $('lock-at').textContent = lockShown ? `封榜 ${timeOfDay(data.lockAt)}` : '';
    if (lockShown) {
        const share = (data.endAt - data.lockAt) / (data.endAt - data.beginAt);
        freeze.style.width = `${share * 100}%`;
        placeLockMark(1 - share);
    }
    $('updated').textContent = `含封榜后结果，请勿向选手展示 · 更新于 ${timeWithSeconds(data.serverTime)}`;
    firstRender = false;
}

/** Puts the freeze time under its point on the bar, kept clear of the start and end times. */
function placeLockMark(at) {
    const mark = $('lock-at');
    const marks = mark.parentElement;
    const width = marks.clientWidth;
    const half = mark.offsetWidth / 2;
    const min = $('begin-at').offsetWidth + 8 + half;
    const max = width - $('end-at').offsetWidth - 8 - half;
    const fits = width > 0 && min <= max;
    marks.classList.toggle('ov-progress__marks--stacked', !fits);
    const center = fits ? Math.min(max, Math.max(min, at * width)) : Math.min(width - half, Math.max(half, at * width));
    mark.style.left = width > 0 ? `${center}px` : `${at * 100}%`;
}

function tick() {
    const now = Date.now() + offset;
    $('now').textContent = timeWithSeconds(now);
    if (data) {
        const total = data.endAt - data.beginAt;
        if (now < data.beginAt) {
            $('clock-label').textContent = '距开始';
            $('clock').textContent = clock(data.beginAt - now);
            $('remain-label').textContent = '比赛时长';
            $('remain').textContent = clock(total);
            $('progress').style.width = '0%';
        } else {
            const elapsed = Math.min(total, now - data.beginAt);
            $('clock-label').textContent = '已进行';
            $('clock').textContent = clock(elapsed);
            $('remain-label').textContent = now >= data.endAt ? '比赛已结束' : '剩余';
            $('remain').textContent = clock(data.endAt - Math.min(now, data.endAt));
            $('progress').style.width = `${(elapsed / total) * 100}%`;
        }
        // The status changes with the clock between polls (start, freeze, end).
        const status = now < data.beginAt ? 'before' : now >= data.endAt ? 'ended' : data.lockAt && now >= data.lockAt ? 'frozen' : 'running';
        if ($('status').dataset.status !== status) { $('status').dataset.status = status; $('status').textContent = statusText[status]; }
    }
}

async function poll() {
    try {
        const response = await fetch(runtime.dataUrl, { cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(response.status === 403 || response.status === 401 ? '登录已失效，请重新登录 Hydro' : `HTTP ${response.status}`);
        data = await response.json();
        offset = data.serverTime - Date.now();
        render();
    } catch (error) {
        $('updated').textContent = `更新失败：${error.message || error}，稍后重试`;
    } finally {
        setTimeout(poll, runtime.refreshMs);
    }
}

// Fullscreen needs a user action: the button, a click on the page or F; Esc leaves.
const full = $('full');
const toggleFull = () => (document.fullscreenElement ? document.exitFullscreen?.() : document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {}));
full.addEventListener('click', (event) => { event.stopPropagation(); toggleFull(); });
document.addEventListener('click', () => { if (!document.fullscreenElement) document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }).catch(() => {}); });
window.addEventListener('keydown', (event) => { if (event.key.toLowerCase() === 'f' && !event.ctrlKey && !event.metaKey && !event.altKey) toggleFull(); });
document.addEventListener('fullscreenchange', () => {
    document.body.classList.toggle('fullscreen', !!document.fullscreenElement);
    full.textContent = document.fullscreenElement ? '退出全屏' : '全屏';
});
let idle = 0;
const active = () => { document.body.classList.remove('idle'); clearTimeout(idle); idle = setTimeout(() => document.body.classList.add('idle'), 3000); };
window.addEventListener('pointermove', active, { passive: true });
active();

// Panels fit their rows to the space, so lay them out again when the window changes size.
let resizeFrame = 0;
window.addEventListener('resize', () => { cancelAnimationFrame(resizeFrame); resizeFrame = requestAnimationFrame(render); });
setInterval(tick, 250);
tick();
poll();
