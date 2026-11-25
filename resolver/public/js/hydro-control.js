import { clarificationIcon } from './hydro-clarification-icon.js';
// Quick settings save through their owning modules. The recording editor shares its explicit save
// action with the capture page so staff can review both sources and their combined bandwidth.
import { helpTip } from './hydro-ui.js';
import { mountRecordingSettings } from './hydro-recordings.js';
import { $, el, formatTime, get, notify, openDialog, post } from './hydro-manage-common.js';

const status = $('control-status');
const focusLabel = node => node?.getAttribute('aria-label') || node?.closest('label')?.textContent;
const root = $('manage-root');
const recording = $('control-recording');
let recordingMounted = false;
const phases = { before: ['未开始', ''], running: ['进行中', 'manage-tag--ok'], frozen: ['封榜中', 'manage-tag--warn'], sealed: ['已结束 · 封榜中', 'manage-tag--warn'], ended: ['已结束', ''] };
let data = null;

async function load() {
    try {
        data = await get();
        if (status.textContent === '加载中…') status.hidden = true;
        render();
    } catch (error) { notify(status, error.message, true); }
}

async function save(operation, payload, message = '已保存') {
    if (root.inert) return;
    const previous = focusLabel(document.activeElement);
    root.inert = true;
    root.setAttribute('aria-busy', 'true');
    try {
        await post(operation, payload);
        notify(status, message);
    } catch (error) { notify(status, error.message, true); }
    try { await load(); }
    finally {
        root.inert = false;
        root.removeAttribute('aria-busy');
        if (previous && document.activeElement === document.body) {
            [...root.querySelectorAll('input, select')].find(node => focusLabel(node) === previous)?.focus({ preventScroll: true });
        }
    }
}

const check = (text, checked, onchange, attrs = {}) => {
    const box = el('input', { type: 'checkbox', checked, ...attrs });
    box.addEventListener('change', () => onchange(box.checked));
    return el('label', { class: 'control-check' }, box, el('span', { text }));
};
const choose = (label, value, options, onchange, attrs = {}) => {
    const select = el('select', { class: 'select', 'aria-label': label, ...attrs }, ...options.map(([key, text]) => new Option(text, key, false, key === value)));
    select.addEventListener('change', () => onchange(select.value));
    return el('label', { class: 'control-field' }, label, select);
};
const number = (label, value, onchange, attrs = {}) => {
    const input = el('input', { class: 'textbox', type: 'number', step: 1, min: 0, value, 'aria-label': label, ...attrs });
    input.addEventListener('change', () => { if (input.checkValidity()) onchange(Number(input.value)); else input.reportValidity(); });
    return el('label', { class: 'control-field control-field--short' }, label, input);
};
const text = (label, value, onchange, attrs = {}) => {
    const input = el('input', { class: 'textbox', type: 'text', value, 'aria-label': label, ...attrs });
    input.addEventListener('change', () => onchange(input.value));
    return el('label', { class: 'control-field' }, label, input);
};
const link = (label, href, icon = null) => href ? el('a', { href }, icon, icon ? ' ' + label : label) : null;
const related = (...links) => el('div', { class: 'control-links' }, ...links);
const group = (title, ...children) => el('section', { class: 'manage-group control-group' }, el('h3', {}, title), ...children);
const row = (...children) => el('div', { class: 'control-row' }, ...children);

function presetBar() {
    const bar = el('div', { class: 'manage-tabs', role: 'radiogroup', 'aria-label': '赛制' });
    for (const preset of data.presets) {
        bar.append(el('button', {
            type: 'button', role: 'radio', 'aria-checked': data.preset === preset.id ? 'true' : 'false', 'data-active': data.preset === preset.id ? '' : undefined,
            text: preset.name, onclick: () => {
                if (data.preset === preset.id) return;
                openDialog({ title: `改用 ${preset.name} 赛制`, confirm: '改用',
                    body: [el('p', { text: preset.id === 'ccpc'
                        ? '同分规则改为 CCPC；封榜前隐藏题号，过题后忽略再次提交；奖杯按学校名次；一血奖含打星队；封榜后暂缓气球，一血用统一气球，每队各自配色。奖牌名额、分榜和公开设置不变。'
                        : `同分规则改为 ${preset.name}；关闭隐藏题号和按队配色，一血气球用题目颜色。奖牌名额、分榜和公开设置不变。` })],
                    submit: async () => { await post('preset', { id: preset.id }); notify(status, `已改用 ${preset.name} 赛制`); await load(); } });
            },
        }));
    }
    return bar;
}

const sameDay = (a, b) => new Date(a).toDateString() === new Date(b).toDateString();
const shortTime = (value, withDate) => new Date(value).toLocaleString('zh-CN', {
    ...(withDate ? { month: 'numeric', day: 'numeric' } : {}), hour: '2-digit', minute: '2-digit', hour12: false,
});

function contestBlock() {
    const { contest } = data;
    const [phase, tone] = phases[contest.phase];
    const unlock = contest.phase === 'sealed' ? el('button', { class: 'button primary', type: 'button', text: '解除封榜', onclick: () => openDialog({
        title: '解除封榜', confirm: '解除封榜',
        body: [el('p', { text: '所有观众立即看到最终榜单，公开的选手屏幕和暂缓的气球随之放行。' })],
        submit: async () => { await post('unlock', {}); notify(status, '已解除封榜'); await load(); },
    }) }) : null;
    return el('div', { class: 'control-status' },
        el('span', { class: `manage-tag ${tone}`, text: phase }),
        el('span', { title: formatTime(contest.beginAt) + ' – ' + formatTime(contest.endAt),
            text: shortTime(contest.beginAt, true) + ' – ' + shortTime(contest.endAt, !sameDay(contest.beginAt, contest.endAt)) }),
        contest.lockAt ? el('span', { class: 'resolver-muted', title: formatTime(contest.lockAt), text: '封榜 ' + shortTime(contest.lockAt, !sameDay(contest.beginAt, contest.lockAt)) }) : null,
        unlock);
}


function medalTemplateBar() {
    const bar = el('div', { class: 'manage-tabs', role: 'radiogroup', 'aria-label': '奖牌模板' });
    for (const template of data.medalTemplates || []) {
        const active = data.medalTemplate === template.id;
        bar.append(el('button', {
            type: 'button', role: 'radio', 'aria-checked': active ? 'true' : 'false', 'data-active': active ? '' : undefined, text: template.name,
            onclick: () => { if (!active) save('board', template.board, `已套用${template.name}奖牌名额`); },
        }));
    }
    return bar;
}

function rules({ board, links }) {
    const ratio = board.medalBasis === 'ratio';
    const multiple = board.medalBasis === 'multiple';
    const honors = board.honors || { enabled: false, highest: 25, high: 50, standard: 100 };
    const unit = (key) => (ratio || (multiple && key === 'gold') ? '（%）' : multiple ? '（倍）' : '');
    const limit = (key) => (ratio || (multiple && key === 'gold') ? 100 : multiple ? 20 : 100000);
    return [
        group('赛制与同分规则', presetBar(),
            row(choose('同分规则', board.tieBreak, [['hydro', 'Hydro（罚时按秒）'], ['icpc', 'ICPC（按分钟，再比最后通过）'], ['ccpc', 'CCPC（按分钟，同分并列）']],
                (value) => save('board', { tieBreak: value }))),
            row(check('封榜前隐藏题号', board.ccpcBoard.enabled, (enabled) => save('board', { ccpcBoard: { enabled } })),
                check('过题后忽略再次提交', board.ignoreAfterAccept, (value) => save('board', { ignoreAfterAccept: value }))),
            board.ccpcBoard.enabled ? row(number('过题达到', board.ccpcBoard.reveal, (reveal) => save('board', { ccpcBoard: { reveal } }),
                { min: 1, max: board.ccpcBoard.revealBasis === 'percent' ? 100 : 100000 }),
                choose('单位', board.ccpcBoard.revealBasis, [['count', '队'], ['percent', '% 队伍']],
                    (value) => save('board', { ccpcBoard: { revealBasis: value, reveal: value === 'percent' ? 20 : 50 } })),
                el('span', { class: 'resolver-muted', text: '显示题号' })) : null),
        group('奖牌与奖杯', medalTemplateBar(),
            row(choose('奖牌名额', board.medalBasis, [['count', '固定数量'], ['ratio', '按队伍比例'], ['multiple', '金牌比例，银铜为倍数']], (value) => save('board', { medalBasis: value })),
                board.medalBasis !== 'count' ? choose('比例的分母', board.medalBase, [['solved', '至少过一题的正式队'], ['submitted', '至少提交一次的正式队'], ['registered', '全部正式队']],
                    (value) => save('board', { medalBase: value })) : null,
                ratio ? choose('取整', board.medalRounding, [['tier', '各档分别向上取整'], ['cumulative', '累计向上取整']], (value) => save('board', { medalRounding: value })) : null,
                choose('奖牌依据', board.medalRanking, [['team', '队伍名次'], ['school', '学校名次']], (value) => save('board', { medalRanking: value }))),
            row(...[['gold', '金牌'], ['silver', '银牌'], ['bronze', '铜牌']].map(([key, title]) =>
                number(title + unit(key), board.medals[key], (value) => save('board', { medals: { [key]: value } }), { max: limit(key) }))),
            row(check('Honors（按 WF place）', honors.enabled, (enabled) => save('board', { honors: { enabled } })),
                ...honors.enabled ? [['highest', 'Highest Honors 至第'], ['high', 'High Honors 至第'], ['standard', 'Honors 至第']].map(([key, title]) =>
                    number(title, honors[key], (value) => save('board', { honors: { [key]: value } }), { min: 1 })) : []),
            row(check('并列同奖', board.medalSameScore, (v) => save('board', { medalSameScore: v })),
                check('奖杯', board.podiumEnabled, (v) => save('board', { podiumEnabled: v })),
                check('一血奖', board.firstSolve, (v) => save('board', { firstSolve: v })),
                check('打星队可获一血', board.unofficialFirstSolve, (v) => save('board', { unofficialFirstSolve: v }), { disabled: !board.firstSolve })),
            board.podiumEnabled ? row(choose('奖杯依据', board.podiumBasis, [['team', '队伍名次'], ['school', '学校名次']], (v) => save('board', { podiumBasis: v })),
                choose('奖杯并列', board.podiumTie, [['lastAccept', '最晚通过早者得'], ['shared', '共享']], (v) => save('board', { podiumTie: v })),
                text('奖杯名称', board.podiumNames.join('、'), (v) => save('board', { podiumNames: v.split(/[、,，;；\s]+/).filter(Boolean) }))) : null,
            related(link('各榜奖项', links.settings + '#board-awards'), link('特别奖', links.settings + '#special-awards'))),
        group('分榜', row(check('按学校', board.schoolBoards, (v) => save('board', { schoolBoards: v })),
            check('按正式 / 打星', board.participationBoards, (v) => save('board', { participationBoards: v }))),
            related(link('编辑手动分榜', links.settings + '#manual-boards'))),
    ];
}

function access({ board, capture, links, reactions }) {
    return [
        group('榜单与接口', row(check('公开榜单', board.publicAccess, (v) => save('board', { publicAccess: v })),
            check('向所有观众显示学校', board.showIdentity, (v) => save('board', { showIdentity: v })),
            check('开放 CCS API', board.ccsApi, (v) => save('board', { ccsApi: v }))),
            related(link('公开榜单地址', links.publicBoard), link('访问地址与最终结果', links.settings + '#board-access'))),
        capture || reactions ? group('画面与视频',
            capture ? row(check('比赛中公开选手屏幕', capture.screenDuringContest, (v) => save('capture', { screenDuringContest: v }), { disabled: !capture.enabled }),
                helpTip('公开选手屏幕', '启用后，导播可在比赛期间播出选手屏幕。')) : null,
            reactions ? row(check('公开反应视频', reactions.publicEnabled, (enabled) => save('reactions', { enabled })),
                link('视频公开与下载权限', links.reactions + '#public')) : null) : null,
    ];
}

function venue({ balloons, contest, links }) {
    return [
        group('气球与小票',
            row(check('气球配送', balloons.enabled, (enabled) => save('balloons', { enabled })),
                check('小票', balloons.tickets, (enabled) => save('balloons', { tickets: { enabled } }), { disabled: !balloons.enabled }),
                check('每队各自配色', balloons.teamColors, (teamColors) => save('balloons', { teamColors }), { disabled: !balloons.enabled })),
            row(choose('一血气球', balloons.first.style, [['problem', '题目颜色，标记一血'], ['uniform', '统一的一血气球'], ['sequence', '统一，按全场顺序编号']],
                (style) => save('balloons', { first: { style } }), { disabled: !balloons.enabled }),
                choose('封榜后的气球', balloons.afterFreeze, [['hold', '解除封榜后发放'], ['continue', '继续发放'], ['encourage', '只给气球较少的队伍']], (afterFreeze) => save('balloons', { afterFreeze })),
                balloons.afterFreeze === 'encourage' ? number('不足几个时继续发', balloons.encourageCount ?? 3, (encourageCount) => save('balloons', { encourageCount }), { min: 1, max: 20 }) : null),
            related(link('气球颜色与小票分单', links.balloons + '#settings'))),
        group('选手打印', row(check('允许选手打印', contest.allowPrint, (allowPrint) => save('print', { allowPrint }))), related(link('打印设备与队列', links.printers))),
        group('答疑与考场', related(link('答疑分工与封榜提醒', links.desk + '#settings'), link('座位、登录与清理', links.seats))),
    ];
}

function media({ capture, reactions, links }) {
    return [
        capture ? group('屏幕与摄像头',
            row(check('画面采集', capture.enabled, (enabled) => save('capture', { enabled })),
                check('摄像头', capture.webcam, (webcam) => save('capture', { webcam }), { disabled: !capture.enabled })),
            related(link('采集设备与网络', links.capture + '#network'), link('试录与压力测试', links.capture + '#tests'))) : null,
        reactions ? group('反应视频', related(link('视频版式', links.reactions + '#layouts'), link('媒体机连接', links.reactions + '#workers'))) : null,
        group('现场画面', related(link('大屏画面与链接', links.screens), link('直播导播与 OBS', links.live), link('滚榜预演与播放', links.resolver))),
    ];
}

function work({ review, links }) {
    return [
        group('赛场运行', related(link('机位签到与监控', links.presence), link('答疑与公告', links.desk, clarificationIcon()),
            link('气球配送', links.balloons + '#deliver'), link('评测队列与监控', links.monitor))),
        group('成绩与复核', review ? el('p', { text: '结果变更 ' + review.changes + ' · 评测中 ' + review.pending + ' · 待更新会话 ' + review.stale }) : null,
            related(link('重测复核', links.review), link('批量重测', links.rejudge), link('成绩快照与导出', links.results), link('证书', links.certificates), link('裁判操作', links.jury), link('诚信复核', links.integrity))),
        group('观看比赛', related(link('比赛榜单', links.board), link('赛况总览', links.overview),
            link('录像回看', links.capture && links.capture + '#recordings'), link('反应视频与渲染', data.reactions && links.reactions))),
        group('比赛管理', related(link('编辑比赛', links.edit), link('评测机与调度', links.judges))),
    ];
}

const sections = [
    ['rules', '赛制与奖项', rules], ['access', '公开与访问', access], ['venue', '现场服务', venue],
    ['media', '采集与播出', media], ['recording', '录制与存储'], ['work', '赛事工作台', work],
];
function render() {
    if (!data) return;
    const available = sections.filter(([key]) => key !== 'recording' || data.links.capture);
    const [key, , content] = available.find(([id]) => '#' + id === location.hash) || available[0];
    const nav = $('control-nav');
    if (!nav.childElementCount) {
        nav.replaceChildren(...available.map(([id, label]) => el('a', { href: '#' + id, text: label })));
    }
    for (const a of nav.children) {
        if (a.hash === '#' + key) a.setAttribute('aria-current', 'page');
        else a.removeAttribute('aria-current');
    }
    $('control-phase').replaceChildren(contestBlock());
    root.hidden = key === 'recording';
    recording.hidden = !root.hidden;
    if (root.hidden) {
        if (!recordingMounted) {
            recordingMounted = true;
            mountRecordingSettings(recording, data.links.capture);
        }
    } else {
        root.replaceChildren(...content(data).filter(Boolean));
    }
}

addEventListener('hashchange', () => {
    render();
    const panel = root.hidden ? recording : root;
    panel.classList.remove('control-enter');
    requestAnimationFrame(() => panel.classList.add('control-enter'));
});
load();
