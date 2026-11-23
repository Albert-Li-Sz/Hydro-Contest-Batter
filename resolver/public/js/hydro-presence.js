// 机位监控: every team's computer by room, its state from the reports of its contest pages, and alerts.
const runtime = JSON.parse(document.getElementById('presence-runtime').textContent);
const $ = (id) => document.getElementById(id);

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (value === undefined || value === null || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value);
        else if (value === true) node.setAttribute(key, '');
        else node.setAttribute(key, value);
    }
    node.append(...children.filter((child) => child !== null && child !== undefined && child !== false));
    return node;
}

const labels = { online: '在线', background: '后台', weak: '可能离线', offline: '离线', never: '未登录' };
const loud = new Set(['sharedIp', 'ipMismatch', 'offline']);

const ago = (ms) => {
    const seconds = Math.max(0, Math.round(ms / 1000));
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    return minutes < 60 ? `${minutes} 分` : `${Math.floor(minutes / 60)} 时 ${minutes % 60} 分`;
};
const clock = (value) => (value ? new Date(value).toLocaleTimeString('zh-CN', { hour12: false }) : '—');

$('contest-title').textContent = runtime.title;
$('back-link').href = runtime.contestUrl;

// ---------------------------------------------------------------- Sound for new alerts

const sound = $('sound');
let soundOn = false;
try { soundOn = localStorage.getItem('xcpcio-presence-sound') === '1'; } catch { /* stays off */ }
let audio = null;
const renderSound = () => { sound.setAttribute('aria-pressed', String(soundOn)); sound.classList.toggle('is-on', soundOn); };
sound.addEventListener('click', () => {
    soundOn = !soundOn;
    try { localStorage.setItem('xcpcio-presence-sound', soundOn ? '1' : '0'); } catch { /* this page only */ }
    renderSound();
    if (soundOn) beep();
});
renderSound();
function beep() {
    try {
        audio ||= new AudioContext();
        const tone = audio.createOscillator();
        const gain = audio.createGain();
        tone.frequency.value = 880;
        gain.gain.setValueAtTime(0.18, audio.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.5);
        tone.connect(gain).connect(audio.destination);
        tone.start();
        tone.stop(audio.currentTime + 0.5);
    } catch { /* no audio */ }
}

// ---------------------------------------------------------------- Rendering

let known = null;
let last = null;

function counts(data) {
    const chips = [];
    if (data.phase === 'before') chips.push(el('span', { class: 'presence-count is-checkin' }, el('b', { text: `${data.checkedIn} / ${data.total}` }), '签到'));
    for (const state of ['online', 'background', 'weak', 'offline', 'never']) {
        if (!data.counts[state] && state !== 'online') continue;
        chips.push(el('span', { class: `presence-count state-${state}` }, el('i'), el('b', { text: data.counts[state] }), data.phase === 'before' && state === 'never' ? '未签到' : labels[state]));
    }
    if (data.phase === 'ended') chips.push(el('span', { class: 'presence-count is-ended', text: '比赛已结束' }));
    $('counts').replaceChildren(...chips);
}

function note(team, now) {
    if (team.state === 'online') return '';
    if (team.state === 'background') return team.hiddenAt ? `后台 ${ago(now - team.hiddenAt)}` : '后台';
    if (team.state === 'never') return '';
    return `${ago(now - team.lastSeen)}前`;
}

function tile(team, now, phase) {
    const classes = ['presence-seat', `state-${team.state}`];
    if (team.alerts.length) classes.push('has-alert');
    if (phase === 'before' && team.state === 'never') classes.push('is-missing');
    return el('button', {
        type: 'button', class: classes.join(' '), 'data-uid': team.uid,
        'aria-label': `${team.seat || '无座位'} ${team.name} ${labels[team.state]}`, onclick: () => details(team.uid),
    },
    el('span', { class: 'presence-seat__seat', text: team.seat || '—' }),
    el('span', { class: 'presence-seat__name', text: team.name }),
    el('span', { class: 'presence-seat__note' }, note(team, now),
        team.capture === false && team.state !== 'never' ? el('span', { class: 'presence-mark is-capture', title: '画面采集未连接' }) : null,
        team.alerts.length ? el('span', { class: 'presence-mark is-alert', text: team.alerts.length }) : null));
}

function map(data) {
    $('map').replaceChildren(...data.zones.map((zone) => el('section', { class: 'presence-zone' },
        el('h2', { text: zone.zone === null ? '无座位' : zone.zone || '—' }),
        el('div', { class: 'presence-grid' }, ...zone.teams.map((team) => tile(team, data.now, data.phase))))));
    if (!data.zones.length) $('map').replaceChildren(el('p', { class: 'resolver-muted', text: '暂无参赛队伍' }));
}

function alerts(data) {
    $('alerts').replaceChildren(...data.alerts.map((alert) => el('li', { class: `presence-alert kind-${alert.kind}` },
        el('button', { type: 'button', onclick: () => details(alert.uid) },
            el('span', { class: 'presence-alert__seat', text: alert.seat || '—' }),
            el('span', { class: 'presence-alert__name', text: alert.name }),
            el('span', { class: 'presence-alert__text', text: alert.since ? `${alert.text} ${ago(data.now - alert.since)}` : alert.text })))));
    $('alerts').closest('aside').classList.toggle('is-empty', !data.alerts.length);
}

function details(uid) {
    const team = last?.zones.flatMap((zone) => zone.teams).find((item) => item.uid === uid);
    if (!team) return;
    const rows = [
        ['状态', `${labels[team.state]}${team.lastSeen && team.state !== 'online' ? ` · ${clock(team.lastSeen)}` : ''}`],
        team.members.length ? ['队员', team.members.join('、')] : null,
        ['IP', team.ip || '—'],
        team.mapped.length ? ['IP 登录', team.mapped.join('、')] : null,
        team.recent.length > 1 ? ['10 分钟内', team.recent.join('、')] : null,
        team.browser?.name ? ['浏览器', `${team.browser.name} ${team.browser.version}`] : null,
        team.firstSeen ? ['首次上线', new Date(team.firstSeen).toLocaleString('zh-CN', { hour12: false })] : null,
        team.capture === null ? null : ['画面采集', team.capture ? '已连接' : '未连接'],
    ].filter(Boolean);
    const issues = (last.alerts || []).filter((alert) => alert.uid === uid);
    const dialog = el('dialog', { class: 'presence-dialog' }, el('form', { method: 'dialog' },
        el('h2', { text: `${team.seat || '无座位'} · ${team.name}` }),
        issues.length ? el('ul', { class: 'presence-issues' }, ...issues.map((alert) => el('li', { class: `kind-${alert.kind}`, text: alert.text }))) : null,
        el('dl', {}, ...rows.flatMap(([term, value]) => [el('dt', { text: term }), el('dd', { text: value })])),
        el('div', { class: 'resolver-actions' }, runtime.seatsUrl ? el('a', { class: 'button', href: runtime.seatsUrl, text: '座位与 IP' }) : null, el('button', { class: 'button primary', text: '关闭' }))));
    document.getElementById('hydro-resolver-config').append(dialog);
    dialog.addEventListener('close', () => dialog.remove());
    dialog.showModal();
}

async function refresh() {
    try {
        const response = await fetch(runtime.dataUrl, { credentials: 'same-origin', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        last = data;
        counts(data);
        map(data);
        alerts(data);
        // A beep for alerts that are new since the last refresh (none on the first load).
        const keys = new Set(data.alerts.filter((alert) => loud.has(alert.kind)).map((alert) => `${alert.kind}:${alert.uid}`));
        if (known && soundOn && [...keys].some((key) => !known.has(key))) beep();
        known = keys;
        $('updated').textContent = `${clock(data.now)} 更新`;
        $('updated').classList.remove('presence-stale');
    } catch (error) {
        $('updated').textContent = `更新失败：${error.message}`;
        $('updated').classList.add('presence-stale');
    }
}

refresh();
// With the sound on, a monitor left in a background tab keeps watching.
setInterval(() => { if (soundOn || document.visibilityState === 'visible') refresh(); }, runtime.refreshMs || 5000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });
