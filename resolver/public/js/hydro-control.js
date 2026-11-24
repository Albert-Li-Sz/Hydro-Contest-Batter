// 赛事中控: the contest-day settings of the board, awards, balloons, printing and capture on one page. Every
// change saves at once through the module it belongs to; the page then reads the saved state back.
import { $, el, formatTime, get, notify, openDialog, post } from './hydro-manage-common.js';

const status = el('p', { class: 'resolver-muted', role: 'status', hidden: true });
const phases = { before: ['未开始', ''], running: ['进行中', 'manage-tag--ok'], frozen: ['封榜中', 'manage-tag--warn'], sealed: ['已结束 · 封榜中', 'manage-tag--warn'], ended: ['已结束', ''] };
let data = null;

async function load() {
    try {
        data = await get();
        render();
    } catch (error) { notify(status, error.message, true); }
}

async function save(operation, payload, message = '已保存') {
    try {
        await post(operation, payload);
        notify(status, message);
        await load();
    } catch (error) {
        notify(status, error.message, true);
        await load();
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
const link = (label, href) => (href ? el('a', { class: 'button', href, text: label }) : null);
const group = (title, ...children) => el('section', { class: 'manage-group control-group' }, el('h3', { text: title }), ...children);
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
        el('span', { text: `${formatTime(contest.beginAt)} – ${formatTime(contest.endAt)}` }),
        contest.lockAt ? el('span', { class: 'resolver-muted', text: `封榜 ${formatTime(contest.lockAt)}` }) : null,
        unlock);
}

function render() {
    const { board, balloons, capture, review, links } = data;
    const medals = el('div', { class: 'control-row' }, ...[['gold', '金'], ['silver', '银'], ['bronze', '铜']].map(([tier, name]) => number(
        board.medalBasis === 'ratio' ? `${name}（%）` : name, board.medals[tier], (value) => save('board', { medals: { ...board.medals, [tier]: value } }),
        { max: board.medalBasis === 'ratio' ? 100 : 100000 })));
    $('manage-root').replaceChildren(
        status,
        contestBlock(),
        group('赛制', presetBar(),
            row(choose('同分规则', board.tieBreak, [['hydro', 'Hydro（罚时按秒）'], ['icpc', 'ICPC（按分钟，再比最后通过）'], ['ccpc', 'CCPC（按分钟，同分并列）']],
                (value) => save('board', { tieBreak: value }))),
            row(check('封榜前隐藏题号', board.ccpcBoard.enabled, (value) => save('board', { ccpcBoard: { enabled: value } })),
                check('过题后忽略再次提交', board.ignoreAfterAccept, (value) => save('board', { ignoreAfterAccept: value }))),
            board.ccpcBoard.enabled ? row(
                number('过题达到', board.ccpcBoard.reveal, (value) => save('board', { ccpcBoard: { reveal: value } }), { min: 1, max: board.ccpcBoard.revealBasis === 'percent' ? 100 : 100000 }),
                choose('单位', board.ccpcBoard.revealBasis, [['count', '队'], ['percent', '% 队伍']], (value) => save('board', { ccpcBoard: { revealBasis: value, reveal: value === 'percent' ? 20 : 50 } })),
                el('span', { class: 'resolver-muted control-suffix', text: '显示题号' })) : null),
        group('奖项',
            medals,
            row(choose('奖牌依据', board.medalRanking, [['team', '队伍名次'], ['school', '学校名次']], (value) => save('board', { medalRanking: value })),
                check('并列同奖', board.medalSameScore, (value) => save('board', { medalSameScore: value }))),
            row(check('奖杯', board.podiumEnabled, (value) => save('board', { podiumEnabled: value })),
                check('一血奖', board.firstSolve, (value) => save('board', { firstSolve: value })),
                check('打星队可获一血', board.unofficialFirstSolve, (value) => save('board', { unofficialFirstSolve: value }), { disabled: !board.firstSolve })),
            board.podiumEnabled ? row(
                choose('奖杯依据', board.podiumBasis, [['team', '队伍名次'], ['school', '学校名次']], (value) => save('board', { podiumBasis: value })),
                choose('奖杯并列', board.podiumTie, [['lastAccept', '最晚通过早者得'], ['shared', '共享']], (value) => save('board', { podiumTie: value })),
                text('奖杯名称', board.podiumNames.join('、'), (value) => save('board', { podiumNames: value.split(/[、,，;；\s]+/).filter(Boolean) }))) : null,
            row(link(`特别奖 ${board.specialAwards} · 各榜奖项`, `${links.settings}#special-awards`))),
        group('封榜与公开',
            row(choose('封榜后的气球', balloons.afterFreeze, [['hold', '暂缓，解除封榜后再发'], ['continue', '继续发放']], (value) => save('balloons', { afterFreeze: value })),
                capture ? check('比赛中公开选手屏幕', capture.screenDuringContest, (value) => save('capture', { screenDuringContest: value }), { disabled: !capture.enabled }) : null),
            row(check('公开榜单', board.publicAccess, (value) => save('board', { publicAccess: value })),
                check('向所有观众显示学校', board.showIdentity, (value) => save('board', { showIdentity: value })),
                check('开放 CCS API', board.ccsApi, (value) => save('board', { ccsApi: value })))),
        group('分榜',
            row(check('按学校', board.schoolBoards, (value) => save('board', { schoolBoards: value })),
                check('按正式 / 打星', board.participationBoards, (value) => save('board', { participationBoards: value })),
                link(`手动分榜 ${board.manualBoards}`, links.settings))),
        group('气球',
            row(check('气球配送', balloons.enabled, (value) => save('balloons', { enabled: value })),
                check('小票', balloons.tickets, (value) => save('balloons', { tickets: { enabled: value } }), { disabled: !balloons.enabled }),
                check('每队各自配色', balloons.teamColors, (value) => save('balloons', { teamColors: value }), { disabled: !balloons.enabled })),
            row(choose('一血气球', balloons.first.style, [['problem', '题目颜色，标记一血'], ['uniform', '统一的一血气球'], ['sequence', '统一，按全场顺序编号']],
                (value) => save('balloons', { first: { style: value } }), { disabled: !balloons.enabled }), link('气球配送', links.balloons))),
        group('打印',
            row(check('允许选手打印', data.contest.allowPrint, (value) => save('print', { allowPrint: value })), link('打印服务器', links.printers))),
        capture ? group('画面采集',
            row(check('画面采集', capture.enabled, (value) => save('capture', { enabled: value })),
                check('摄像头', capture.webcam, (value) => save('capture', { webcam: value }), { disabled: !capture.enabled }),
                el('span', { text: `提交片段${capture.clips ? '开启' : '关闭'} · 全程留档${capture.archive ? '开启' : '关闭'}` }),
                link('采集设备', links.capture), link('直播', links.live))) : null,
        data.reactions ? group('反应视频', row(
            el('span', { text: `已完成 ${data.reactions.ready} · 等待 ${data.reactions.waiting} · 失败 ${data.reactions.failed}` }),
            check('公开反应视频', data.reactions.publicEnabled, (enabled) => save('reactions', { enabled })),
            link('管理视频和版式', links.reactions))) : null,
        group('重测复核',
            row(el('span', { text: review ? [`${review.changes} 条提交结果有变化`, review.pending ? `${review.pending} 条评测中` : '', review.stale ? `${review.stale} 个滚榜会话基于旧结果` : ''].filter(Boolean).join(' · ') : '—' }),
                link('重测复核', links.review), link('批量重测', links.rejudge))),
        group('页面', el('div', { class: 'control-links' },
            link('榜单', links.board), link('公开榜单', links.publicBoard), link('滚榜', links.resolver), link('大屏', links.screens),
            link('机位监控', links.presence), link('评测监控', links.monitor), link('赛况总览', links.overview), link('答疑台', links.desk),
            link('成绩与导出', links.results), link('比赛设置', links.edit))),
    );
}

load();
