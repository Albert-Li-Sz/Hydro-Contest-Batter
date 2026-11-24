import { ratioMeter } from './hydro-ui.js';
// Judge monitoring page: polls the plugin's monitor data and redraws (text only, no HTML).
const runtime = JSON.parse(document.getElementById('monitor-runtime').textContent);
const $ = (id) => document.getElementById(id);
const recordBase = runtime.contestUrl.replace(/\/contest\/[^/]+$/, '/record/');

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key === 'style') node.style.cssText = value;
        else node.setAttribute(key, value);
    }
    node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
    return node;
}

const duration = (seconds) => {
    if (seconds == null) return '—';
    if (seconds < 60) return `${seconds < 10 && seconds % 1 ? seconds.toFixed(1) : Math.round(seconds)} 秒`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分 ${Math.floor(seconds % 60)} 秒`;
    const hours = Math.floor(minutes / 60);
    return hours < 48 ? `${hours} 小时 ${minutes % 60} 分` : `${Math.floor(hours / 24)} 天 ${hours % 24} 小时`;
};
const ago = (seconds) => {
    if (seconds == null) return '—';
    if (seconds < 5) return '刚刚';
    if (seconds < 60) return `${Math.floor(seconds)} 秒前`;
    if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
    return seconds < 172800 ? `${Math.floor(seconds / 3600)} 小时前` : `${Math.floor(seconds / 86400)} 天前`;
};
const bytes = (value) => {
    if (value == null) return '—';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
    return `${value >= 100 || index === 0 ? Math.round(value) : value.toFixed(1)} ${units[index]}`;
};
const percent = (value) => (value == null ? '—' : `${Math.round(value)}%`);
const level = (value, warn = 70, bad = 90) => (value == null ? '' : value >= bad ? 'bad' : value >= warn ? 'warn' : 'ok');

function card(label, value, note = '', tone = '') {
    return el('div', { class: `monitor-card${tone ? ` monitor-${tone}` : ''}` },
        el('div', { class: 'monitor-card__value', text: String(value) }),
        el('div', { class: 'monitor-card__label', text: label }),
        note ? el('div', { class: 'monitor-card__note', text: note }) : null);
}

function recordLink(id) {
    return el('a', { href: `${recordBase}${id}`, target: '_blank', rel: 'noopener', text: id.slice(-6) });
}

function rows(tbody, items, empty, columns, build) {
    tbody.replaceChildren(...(items.length ? items.map(build) : [el('tr', {}, el('td', { colspan: String(columns), class: 'resolver-muted', text: empty }))]));
}

function meter(label, value, text, tone) {
    return el('div', { class: 'monitor-meter' },
        el('span', { class: 'monitor-meter__label', text: label }),
        el('span', { class: 'monitor-meter__bar' }, el('i', { class: `monitor-fill--${tone || 'ok'}`, style: `width:${Math.min(100, Math.max(0, value ?? 0))}%` })),
        el('span', { class: `monitor-meter__value monitor-text--${tone || ''}`, text }));
}

/** Judged per minute, the last 30 minutes. */
function spark(values) {
    const max = Math.max(1, ...values);
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 300 40');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('class', 'monitor-spark');
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `最近 30 分钟每分钟评测数，最多 ${max}`);
    values.forEach((value, index) => {
        const height = value ? Math.max(2, (value / max) * 38) : 1;
        const rect = document.createElementNS(NS, 'rect');
        for (const [key, attr] of Object.entries({ x: index * 10 + 1, y: 40 - height, width: 8, height, class: value ? 'monitor-spark__bar' : 'monitor-spark__zero' })) rect.setAttribute(key, String(attr));
        const title = document.createElementNS(NS, 'title');
        title.textContent = `${30 - index} 分钟前：${value} 条`;
        rect.append(title);
        svg.append(rect);
    });
    return svg;
}

const stateText = (machine) => {
    if (machine.reportOnly) return ['未连接', 'bad'];
    if (!machine.online) return [`已断开 · ${ago(machine.disconnectedSeconds)}`, 'bad'];
    if (machine.state === 'busy') return [machine.concurrency ? `评测中 ${machine.activeCount}/${machine.concurrency}` : `评测中 ${machine.activeCount}`, 'busy'];
    return ['空闲', 'ok'];
};

function machineCard(machine) {
    const [state, tone] = stateText(machine);
    const m = machine.metrics;
    const source = !m ? '没有机器数据（评测机尚未上报）' : m.live ? '机器数据：实时采样' : `机器数据：${ago(m.reportedSecondsAgo)}上报`;
    const facts = [
        machine.kind === 'builtin' ? '内置评测（随 Hydro 运行）' : '独立评测机',
        machine.account && machine.ip ? `${machine.account} @ ${machine.ip}` : machine.account || machine.ip,
        machine.connectedSeconds != null ? `已连接 ${duration(machine.connectedSeconds)}` : null,
    ].filter(Boolean).join(' · ');
    const spec = m ? [m.model, m.cores ? `${m.cores} 核` : null, m.memoryTotal ? `内存 ${bytes(m.memoryTotal)}` : null, m.os,
        m.compilers != null ? `${m.compilers} 种语言环境` : null].filter(Boolean).join(' · ') : '';
    const stat = (label, value, cls = '', title = '') => el('div', { class: 'monitor-stat', title: title || undefined }, el('b', { class: cls }, value), el('span', { text: label }));
    const acceptRate = ratioMeter('最近 15 分钟通过率', machine.judged15 ? machine.accepted15 / machine.judged15 * 100 : null, { shape: 'ring', tone: 'ok' });
    return el('article', { class: `monitor-machine monitor-machine--${machine.online ? 'online' : 'offline'}` },
        el('header', { class: 'monitor-machine__head' },
            el('div', {}, el('h3', { text: machine.name }), el('div', { class: 'resolver-muted monitor-small', text: facts })),
            el('span', { class: `monitor-badge monitor-badge--${tone}`, text: state })),
        machine.utilization != null && machine.online
            ? meter('并发', machine.utilization, `${machine.activeCount}/${machine.concurrency}`, level(machine.utilization, 80, 100)) : null,
        meter('CPU', m?.cpu, percent(m?.cpu), level(m?.cpu)),
        meter('内存', m?.memoryRate, percent(m?.memoryRate), level(m?.memoryRate)),
        el('div', { class: 'monitor-machine__stats' },
            stat('近 1 分钟', String(machine.judged1), '', '最近 1 分钟完成的评测数'),
            stat('近 5 分钟', String(machine.judged5), '', '最近 5 分钟完成的评测数'),
            stat('近 15 分钟', String(machine.judged15), '', '最近 15 分钟完成的评测数'),
            stat('平均用时', duration(machine.averageSeconds), '', '最近 15 分钟，取题到出结果的平均用时'),
            stat('最长用时', duration(machine.maxSeconds), machine.maxSeconds > 60 ? 'monitor-text--warn' : '', '最近 15 分钟最长的一次评测'),
            stat('通过率', acceptRate, '', '最近 15 分钟评测结果中通过的比例'),
            stat('系统错误', String(machine.systemErrors15), machine.systemErrors15 ? 'monitor-text--bad' : '', '最近 15 分钟的系统错误数'),
            stat('CPU 温度', m?.temperature != null ? `${Math.round(m.temperature)}℃` : '—', level(m?.temperature, 75, 90) === 'bad' ? 'monitor-text--bad' : '', m && !m.live ? '上报值' : ''),
            stat('累计评测', String(machine.totalJudged), '', '本次连接以来（内置评测机：本次 Hydro 启动以来）'),
            stat('最近完成', ago(machine.lastFinishedSeconds))),
        el('div', { class: 'monitor-machine__spark' }, el('span', { class: 'resolver-muted monitor-small', text: '最近 30 分钟每分钟评测数' }), spark(machine.perMinute)),
        el('footer', { class: 'resolver-muted monitor-small' },
            el('div', { text: source }),
            spec ? el('div', { text: spec }) : null,
            machine.langs?.length ? el('div', { text: `只评测：${machine.langs.join('、')}` }) : null));
}

function subjectCells(item) {
    return item.inContest
        ? [el('td', {}, recordLink(item.rid)), el('td', { text: item.team }), el('td', { text: item.problem })]
        : [el('td', { class: 'resolver-muted', text: '—' }), el('td', { class: 'resolver-muted', text: '其他评测' }), el('td', { class: 'resolver-muted', text: '—' })];
}

function render(data) {
    const s = data.summary;
    $('alerts').replaceChildren(...data.alerts.map((alert) => el('li', { class: `monitor-alert monitor-${alert.level}`, text: alert.text })));
    $('cards').replaceChildren(
        card('在线评测机', `${s.judgesOnline}/${s.judgesTotal}`, '', s.judgesOnline ? '' : 'error'),
        card('正在评测 / 并发', s.capacity ? `${s.activeTasks}/${s.capacity}` : String(s.activeTasks)),
        card('评测速度', `${s.judgedPerMinute} 条/分`, `15 分钟 ${s.judged15} 条`),
        card('平均评测用时', duration(s.averageJudgeSeconds)),
        card('全站排队', s.queueLength, '', s.queueLength > 20 ? 'warning' : ''),
        card('本场待评测', s.pending, s.pending ? `最久 ${duration(s.oldestPendingSeconds)}` : '', s.oldestPendingSeconds > 180 ? 'error' : s.pending ? 'warning' : ''),
        card('提交到出结果', duration(s.averageLatencySeconds), `P95 ${duration(s.p95LatencySeconds)}`),
        card('本场系统错误', s.systemErrors, '', s.systemErrors ? 'error' : ''),
    );
    const machines = $('machines');
    machines.replaceChildren(...(data.machines.length ? data.machines.map(machineCard) : [el('p', { class: 'resolver-muted', text: '没有评测机连接到 Hydro，也没有评测机上报' })]));
    rows($('live'), data.live, '没有正在评测的任务', 8, (item) => el('tr', {},
        el('td', { text: item.judge }), ...subjectCells(item), el('td', { text: item.lang }), el('td', { text: item.status }),
        el('td', {}, item.progress == null ? String(item.casesDone) : ratioMeter('评测进度', item.progress, { caption: item.casesDone + ' 个测试点' })),
        el('td', { class: item.elapsedSeconds > 60 ? 'monitor-late' : '', text: duration(item.elapsedSeconds) })));
    rows($('finished'), data.finished, '还没有评测结果（插件启动后开始记录）', 10, (item) => el('tr', {},
        el('td', { text: ago(item.agoSeconds) }), el('td', { text: item.judge }), ...subjectCells(item), el('td', { text: item.lang }),
        el('td', { class: `monitor-result--${item.tone}`, text: item.status }), el('td', { text: duration(item.durationSeconds) }),
        el('td', { text: item.timeMs != null ? `${item.timeMs} ms` : '—' }), el('td', { text: item.memoryKb != null ? bytes(item.memoryKb * 1024) : '—' })));
    rows($('pending'), data.pending, '没有待评测的提交', 6, (item) => el('tr', {},
        el('td', {}, recordLink(item.id)), el('td', { text: item.team }), el('td', { text: item.problem }),
        el('td', { text: item.lang }), el('td', { text: item.status }),
        el('td', { class: item.ageSeconds > 180 ? 'monitor-late' : '', text: duration(item.ageSeconds) })));
    rows($('system-errors'), data.systemErrors, '没有系统错误', 4, (item) => el('tr', {},
        el('td', {}, recordLink(item.id)), el('td', { text: item.team }), el('td', { text: item.problem }), el('td', { text: item.lang })));
    $('updated').textContent = `每 ${runtime.refreshMs / 1000} 秒刷新 · 更新于 ${new Date(data.now).toLocaleTimeString('zh-CN', { hour12: false })}`;
}

async function poll() {
    try {
        const response = await fetch(runtime.dataUrl, { cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        render(await response.json());
    } catch (error) {
        $('updated').textContent = `更新失败（${error.message || error}），稍后重试`;
    } finally {
        setTimeout(poll, runtime.refreshMs);
    }
}

$('contest-title').textContent = runtime.title;
$('back-link').href = runtime.contestUrl;
poll();
