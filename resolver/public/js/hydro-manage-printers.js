// /manage print servers: PCs running the print client, their printers (as each PC reports them),
// which contests and seats each PC prints for, the print queue, and how printouts look.
import {
    $, adminPassword, copyText, el, field, formatTime, get, input, listen, notify, openDialog, post, runtime,
} from './hydro-manage-common.js';

const state = { servers: [], contests: [], clients: [], queue: {}, recent: [], settings: null, selected: new Set() };
const printerStates = {
    idle: ['空闲', 'manage-tag--ok'], printing: ['打印中', 'manage-tag--ok'], paused: ['已暂停', 'manage-tag--warn'], error: ['故障', 'manage-tag--bad'],
    offline: ['离线', 'manage-tag--bad'], missing: ['未找到', 'manage-tag--warn'],
};
const taskStates = { pending: ['待打印', 'manage-tag--warn'], printing: ['打印中', ''], printed: ['已打印', 'manage-tag--ok'], failed: ['失败', 'manage-tag--bad'] };

const status = el('p', { class: 'resolver-muted', role: 'status', hidden: true });
// Results of 重新排队所选 show beside its table, not at the top of the page.
const recentStatus = el('p', { class: 'resolver-muted', role: 'status', hidden: true });
// Whether the status line shows a failed refresh, which the next successful one clears.
let loadFailed = false;
const stats = el('div', { class: 'resolver-stats' });
const downloads = el('div', { class: 'manage-group' });
const serverList = el('div');
const recentTable = el('table', { class: 'data-table' });
const settingsBox = el('div');

$('manage-root').replaceChildren(
    stats,
    downloads,
    el('div', { class: 'manage-toolbar' }, el('h3', { text: '打印服务器', style: 'margin:0' }), el('span', { class: 'manage-spacer' }),
        el('button', { class: 'button primary', type: 'button', text: '添加打印服务器', onclick: () => create() })),
    status,
    serverList,
    el('div', { class: 'manage-group' },
        el('div', { class: 'manage-toolbar' }, el('h3', { text: '最近的打印请求', style: 'margin:0' }), el('span', { class: 'manage-spacer' }),
            el('button', { class: 'button', type: 'button', text: '重新排队所选', onclick: () => requeue() })),
        recentStatus,
        el('div', { class: 'manage-scroll' }, recentTable)),
    el('div', { class: 'manage-group' }, el('h3', { text: '打印排版' }), settingsBox),
);

const tag = ([label, tone]) => el('span', { class: `manage-tag ${tone}`, text: label });

function renderStats() {
    const online = state.servers.filter((server) => server.online);
    const printers = online.flatMap((server) => server.printers).filter((printer) => !['offline', 'missing'].includes(printer.status));
    const receipts = printers.filter((printer) => printer.preference.kind === 'receipt');
    stats.replaceChildren(...[
        [`${online.length} / ${state.servers.length}`, '在线打印服务器'],
        [printers.length - receipts.length, '在线打印机'],
        [receipts.length, '在线小票机'],
        [state.queue.pending || 0, '待打印'],
        [state.queue.printing || 0, '打印中'],
        [state.queue.failed || 0, '打印失败'],
    ].map(([value, label]) => el('div', {}, el('strong', { text: value }), el('span', { text: label }))));
}

function renderDownloads() {
    downloads.replaceChildren(
        el('h3', { text: '打印客户端' }),
        el('p', { class: 'resolver-muted manage-small', text: 'macOS 和 Linux 需使用 CUPS。首次运行时粘贴打印服务器的连接信息。' }),
        state.clients.length
            ? el('div', { class: 'manage-toolbar' }, ...state.clients.map((client) => el('a', { class: 'button', href: client.url, download: client.name, text: `${client.label}（${(client.size / 1048576).toFixed(1)} MB）` })))
            : el('p', { class: 'manage-alert', text: '此安装包未包含打印客户端。请从插件的 GitHub Release 下载 hydro-print-client，或用 pnpm build:print-client 构建。' }),
    );
}

const contestOf = (key) => state.contests.find((contest) => contest.key === key);
function binding(server) {
    const contests = server.contests.length
        ? server.contests.map((key) => {
            const contest = contestOf(key);
            return el('span', { class: `manage-tag${contest && !contest.allowPrint ? ' manage-tag--warn' : ''}`, title: contest && !contest.allowPrint ? '这场比赛没有开启“允许打印”，选手无法提交打印请求' : key,
                text: contest ? contest.title : `已删除的比赛 ${key}` });
        })
        : [el('span', { class: 'manage-tag', text: '全部比赛' })];
    const seats = server.seatPrefixes.length
        ? server.seatPrefixes.map((prefix) => el('span', { class: 'manage-tag', text: `${prefix}*` }))
        : [el('span', { class: 'manage-dim', text: '其他打印服务器未认领的座位' })];
    return el('div', { class: 'manage-binding' },
        el('div', {}, el('b', { text: '服务比赛 ' }), ...contests),
        el('div', {}, el('b', { text: '座位范围 ' }), ...seats));
}

function serverCard(server) {
    const state_ = !server.enabled ? ['已停用', 'manage-tag--warn'] : server.online ? ['在线', 'manage-tag--ok'] : server.lastSeen ? ['离线', 'manage-tag--bad'] : ['尚未连接', 'manage-tag--warn'];
    const client = server.client ? [server.client.host, server.client.os, server.client.version && `客户端 ${server.client.version}`, server.client.ip].filter(Boolean).join(' · ') : '';
    const small = 'width:auto;margin:0';
    const printers = el('table', { class: 'data-table' },
        el('thead', {}, el('tr', {}, ...['打印机', '状态', '排队', '类型', '参与打印', '权重 / 小票', '已打印'].map((text) => el('th', { text })), el('th', { class: 'col-actions', text: '' }))),
        el('tbody', {}, ...server.printers.length ? server.printers.map((printer) => {
            const preference = printer.preference;
            const receipt = preference.kind === 'receipt';
            const save = (change) => savePrinter(server, printer, { ...preference, ...change, receipt: { ...preference.receipt, ...change.receipt } });
            const enabled = el('input', { type: 'checkbox', checked: preference.enabled, 'aria-label': `${printer.name} ${receipt ? '打印气球小票' : '参与打印'}` });
            enabled.addEventListener('change', () => save({ enabled: enabled.checked }));
            // 小票机: thermal receipt printers that print only balloon tickets (气球配送), never code.
            const kind = el('select', { class: 'select', 'aria-label': `${printer.name} 类型`, style: small },
                new Option('普通打印机', 'document', false, !receipt), new Option('小票机', 'receipt', false, receipt));
            kind.addEventListener('change', () => save({ kind: kind.value }));
            let options;
            if (receipt) {
                const width = el('select', { class: 'select', 'aria-label': `${printer.name} 纸宽`, style: small },
                    new Option('80 mm', '80', false, preference.receipt.width === 80), new Option('58 mm', '58', false, preference.receipt.width === 58));
                width.addEventListener('change', () => save({ receipt: { width: Number(width.value) } }));
                const mode = el('select', { class: 'select', 'aria-label': `${printer.name} 输出方式`, style: small,
                    title: 'ESC/POS：直接发送小票机指令，适用于绝大多数热敏小票机（含中文）；系统驱动：通过系统打印驱动绘制，适合不支持 ESC/POS 的打印机' },
                new Option('ESC/POS 指令', 'escpos', false, preference.receipt.mode === 'escpos'), new Option('系统驱动', 'driver', false, preference.receipt.mode === 'driver'));
                mode.addEventListener('change', () => save({ receipt: { mode: mode.value } }));
                const cut = el('input', { type: 'checkbox', checked: preference.receipt.cut, 'aria-label': `${printer.name} 自动切纸` });
                cut.addEventListener('change', () => save({ receipt: { cut: cut.checked } }));
                options = el('div', { class: 'manage-toolbar', style: 'margin:0' }, width, mode, el('label', { class: 'checkbox manage-small' }, cut, ' 切纸'));
            } else {
                options = el('select', { class: 'select', 'aria-label': `${printer.name} 权重`, style: small },
                    ...Array.from({ length: 10 }, (_, index) => new Option(String(index + 1), String(index + 1), false, preference.weight === index + 1)));
                options.addEventListener('change', () => save({ weight: Number(options.value) }));
            }
            return el('tr', {},
                el('td', {}, printer.name, printer.isDefault ? el('span', { class: 'manage-tag', text: '默认' }) : null,
                    printer.message ? el('div', { class: 'manage-dim manage-small', text: printer.message }) : null),
                el('td', {}, tag(printerStates[printer.status] || [printer.status, ''])),
                el('td', { text: printer.queue }),
                el('td', {}, kind),
                el('td', {}, enabled),
                el('td', {}, options),
                el('td', { text: receipt ? `${printer.tickets || 0} 张小票` : printer.printed }),
                el('td', { class: 'col-actions' }, el('button', { class: 'button', type: 'button', text: receipt ? '测试小票' : '测试页',
                    disabled: !server.online || (receipt && !server.receipts), onclick: () => testPage(server, printer.name) })),
            );
        }) : [el('tr', {}, el('td', { class: 'manage-empty', colspan: 8, text: server.lastSeen ? '这台电脑没有报告任何打印机' : '在打印电脑上运行客户端并粘贴连接信息后，打印机会显示在这里' }))]));
    const outdated = server.online && !server.receipts && server.printers.some((printer) => printer.preference.kind === 'receipt');
    return el('section', { class: 'manage-server' },
        el('div', { class: 'manage-toolbar' },
            el('h3', { style: 'margin:0' }, server.name, ' ', tag(state_)),
            el('span', { class: 'manage-spacer' }),
            el('button', { class: 'button', type: 'button', text: '设置', onclick: () => editServer(server) }),
            el('button', { class: 'button', type: 'button', text: '连接信息', onclick: () => regenerate(server) }),
            el('button', { class: 'button', type: 'button', text: '打印测试页', disabled: !server.online, onclick: () => testPage(server, '') }),
            el('button', { class: 'button manage-danger', type: 'button', text: '删除', onclick: () => remove(server) })),
        binding(server),
        outdated ? el('p', { class: 'manage-alert', text: '这台电脑的打印客户端版本较旧，不能打印气球小票，小票机已暂停使用。请在这台电脑上运行 1.14.0 或更新版本的客户端。' }) : null,
        el('p', { class: 'resolver-muted manage-small' },
            server.note ? `${server.note} · ` : '',
            client ? `${client} · 最近联系 ${formatTime(server.lastSeen)}` : '尚未连接',
            ` · 已打印 ${server.stats.printed}，失败 ${server.stats.failed}`,
            server.testsWaiting ? ` · ${server.testsWaiting} 张测试页等待打印` : '',
            server.lastTest ? ` · 最近测试页：${server.lastTest.status === 'printed' ? '成功' : '失败'}（${server.lastTest.printer || '自动选择'}，${formatTime(server.lastTest.at)}）${server.lastTest.message ? ` ${server.lastTest.message}` : ''}` : ''),
        el('div', { class: 'manage-scroll' }, printers));
}

function renderServers() {
    serverList.replaceChildren(...state.servers.length ? state.servers.map(serverCard) : [el('p', { class: 'manage-empty', text: '还没有打印服务器，在上方添加一台。' })]);
}

function renderRecent() {
    // A request being printed now would come out twice.
    const selectable = (task) => task.status === 'printed' || task.status === 'failed';
    recentTable.replaceChildren(
        el('thead', {}, el('tr', {}, el('th', { class: 'col-check' }), ...['请求时间', '比赛', '队伍', '座位', '文件', '状态', '打印服务器 / 打印机'].map((text) => el('th', { text })))),
        el('tbody', {}, ...state.recent.length ? state.recent.map((task) => {
            const box = el('input', { type: 'checkbox', checked: state.selected.has(task.id), disabled: !selectable(task) });
            box.addEventListener('change', () => { if (box.checked) state.selected.add(task.id); else state.selected.delete(task.id); });
            return el('tr', {},
                el('td', { class: 'col-check' }, box),
                el('td', { class: 'manage-nowrap manage-small', text: formatTime(task.time) }),
                el('td', { text: task.contest }),
                el('td', { text: task.team }),
                el('td', { class: 'manage-nowrap', text: task.seat || '—' }),
                el('td', { text: task.title || '—' }),
                el('td', {}, tag(taskStates[task.status] || [task.status, '']),
                    task.attempts ? el('div', { class: 'manage-dim manage-small', text: `已尝试 ${task.attempts} 次${task.error ? `：${task.error}` : ''}` }) : null),
                el('td', { class: 'manage-small', text: [task.server, task.printer].filter(Boolean).join(' / ') || '—' }),
            );
        }) : [el('tr', {}, el('td', { class: 'manage-empty', colspan: 8, text: '还没有打印请求。选手需要在开启了“允许打印”的比赛中提交打印请求。' }))]),
    );
}

/** Layout settings apply as they change; print requests claimed afterwards use them. */
function renderSettings() {
    const settings = state.settings;
    const saved = el('span', { class: 'resolver-muted manage-small', role: 'status' });
    let timer = null;
    const save = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
            saved.textContent = '正在保存…';
            saved.classList.remove('manage-error');
            try {
                state.settings = (await post('settings', { settings })).settings;
                saved.textContent = '已保存';
            } catch (error) { saved.textContent = error.message; saved.classList.add('manage-error'); }
        }, 400);
    };
    const box = (key, label) => {
        const node = el('input', { type: 'checkbox', checked: settings[key] });
        node.addEventListener('change', () => { settings[key] = node.checked; save(); });
        return el('label', { class: 'checkbox' }, node, label);
    };
    const fontSize = input({ type: 'number', min: 7, max: 16, step: 0.5, value: settings.fontSize });
    fontSize.addEventListener('change', () => { if (fontSize.reportValidity()) { settings.fontSize = Number(fontSize.value) || 10; save(); } });
    const header = el('div', { class: 'manage-statuses' }, ...runtime.headerFields.map(([key, label]) => {
        const node = el('input', { type: 'checkbox', checked: settings.header.includes(key) });
        node.addEventListener('change', () => {
            settings.header = runtime.headerFields.map(([fieldName]) => fieldName).filter((fieldName) => (fieldName === key ? node.checked : settings.header.includes(fieldName)));
            save();
        });
        return el('label', {}, node, el('span', { text: label }));
    }));
    settingsBox.replaceChildren(
        el('div', { class: 'resolver-checks' }, box('highlight', '代码高亮'), box('lineNumbers', '显示行号')),
        el('div', { class: 'resolver-fields resolver-two', style: 'margin-top:12px' }, field('代码字号（磅）', fontSize)),
        el('h3', { text: '页眉' }), header,
        saved,
    );
}

async function load() {
    try {
        const data = await get();
        Object.assign(state, { servers: data.servers, contests: data.contests, clients: data.clients, queue: data.queue, recent: data.recent });
        // Only what is listed and still finished stays selected, so requeue never takes a hidden row.
        const finished = new Set(data.recent.filter((task) => task.status === 'printed' || task.status === 'failed').map((task) => task.id));
        for (const id of [...state.selected]) if (!finished.has(id)) state.selected.delete(id);
        if (loadFailed) { notify(status, ''); loadFailed = false; }
        const fresh = !state.settings;
        if (fresh) state.settings = data.settings;
        renderStats();
        if (fresh) { renderDownloads(); renderSettings(); }
        renderServers();
        renderRecent();
    } catch (error) { notify(status, error.message, true); loadFailed = true; }
}

function showCode(server, code, created) {
    const text = el('textarea', { class: 'textbox manage-config', readonly: true, spellcheck: 'false', style: 'min-height:96px;white-space:pre-wrap;word-break:break-all' });
    text.value = code;
    const copy = el('button', { class: 'button', type: 'button', text: '复制' });
    copy.addEventListener('click', async () => { copy.textContent = (await copyText(code)) ? '已复制' : '请手动复制'; if (copy.textContent === '请手动复制') text.select(); });
    openDialog({
        title: `${server.name} 的连接信息`,
        confirm: '完成',
        body: [
            el('p', { class: 'resolver-muted', text: '在打印电脑上运行打印客户端，粘贴以下连接信息。' }),
            text,
            el('div', { class: 'resolver-actions', style: 'justify-content:flex-start;margin-top:8px' }, copy),
            el('p', { class: created ? 'resolver-muted manage-small' : 'manage-error manage-small', text: created
                ? '只显示这一次；遗失时可重新生成。'
                : '原连接已失效，请在客户端中重新粘贴。' }),
        ],
    });
    copyText(code);
}

function create() {
    serverDialog(null);
}

function regenerate(server) {
    openDialog({
        title: `重新生成 ${server.name} 的连接信息`,
        confirm: '重新生成',
        body: [el('p', { text: server.online ? '这台电脑当前在线。重新生成后它会立即断开，需要在客户端中粘贴新的连接信息。' : '原来的连接信息会失效。' })],
        submit: async () => {
            const result = await post('regenerate', { id: server.id, origin: location.origin });
            setTimeout(() => showCode(server, result.code, false), 0);
            await load();
        },
    });
}

function editServer(server) {
    serverDialog(server);
}

/** Name, note, enabled, the contests it serves and its seat range: for adding and for 设置. */
function serverDialog(server) {
    const serverName = input({ value: server?.name || '', maxlength: 40, required: true, placeholder: '例如 打印室 A 区' });
    const serverNote = input({ value: server?.note || '', maxlength: 200, placeholder: '可选，如位置、负责人' });
    const enabled = el('input', { type: 'checkbox', checked: server ? server.enabled : true });
    const prefixes = input({ value: server?.seatPrefixes.join(', ') || '', placeholder: '例如 A, B；留空表示其他打印服务器未认领的座位' });
    const chosen = new Set(server?.contests || []);
    const scope = el('select', { class: 'select' }, new Option('服务全部比赛', 'all', false, !chosen.size), new Option('仅服务所选比赛', 'some', false, chosen.size > 0));
    const filter = input({ type: 'search', placeholder: '按比赛名称或域查找', 'aria-label': '查找比赛' });
    const onlyPrint = el('input', { type: 'checkbox', checked: true });
    const list = el('div', { class: 'manage-langs manage-contests' });
    const summary = el('p', { class: 'resolver-muted manage-small' });
    const picker = el('div', {}, el('div', { class: 'manage-toolbar' }, filter, el('label', { class: 'checkbox' }, onlyPrint, '只看开启“允许打印”的比赛')), list, summary);
    const renderList = () => {
        const text = filter.value.trim().toLowerCase();
        const rows = state.contests.filter((contest) => chosen.has(contest.key)
            || ((!onlyPrint.checked || contest.allowPrint) && (!text || `${contest.title} ${contest.domainId}`.toLowerCase().includes(text))));
        list.replaceChildren(...rows.length ? rows.map((contest) => {
            const box = el('input', { type: 'checkbox', value: contest.key, checked: chosen.has(contest.key) });
            box.addEventListener('change', () => { if (box.checked) chosen.add(contest.key); else chosen.delete(contest.key); updateSummary(); });
            return el('label', { title: contest.key }, box,
                el('span', { text: `${contest.title}（${contest.domainId} · ${formatTime(contest.beginAt)}）` }),
                contest.allowPrint ? null : el('span', { class: 'manage-tag manage-tag--warn', text: '未开启允许打印' }));
        }) : [el('span', { class: 'resolver-muted', text: onlyPrint.checked ? '没有符合条件的比赛；取消“只看开启允许打印的比赛”可查看全部' : '没有符合条件的比赛' })]);
    };
    const updateSummary = () => {
        summary.textContent = chosen.size ? `已选 ${chosen.size} 场：${[...chosen].map((key) => contestOf(key)?.title || key).join('、')}` : '尚未选择比赛';
    };
    const updateScope = () => { picker.hidden = scope.value !== 'some'; };
    filter.addEventListener('input', renderList);
    onlyPrint.addEventListener('change', renderList);
    scope.addEventListener('change', updateScope);
    renderList();
    updateSummary();
    updateScope();
    openDialog({
        title: server ? `打印服务器 ${server.name} 的设置` : '添加打印服务器',
        confirm: server ? '保存' : '添加并生成连接信息',
        body: [el('div', { class: 'resolver-fields' },
            field('名称', serverName), field('备注', serverNote),
            server ? el('label', { class: 'checkbox' }, enabled, '启用') : null,
            field('服务比赛', scope),
            picker,
            field('座位前缀', prefixes, '逗号分隔，如 A, B1。不设前缀的服务器打印其余座位。'))],
        submit: async () => {
            if (!serverName.reportValidity()) throw new Error('请填写名称');
            if (scope.value === 'some' && !chosen.size) throw new Error('请至少选择一场比赛，或改为“服务全部比赛”');
            const input = {
                name: serverName.value, note: serverNote.value, enabled: enabled.checked, seatPrefixes: prefixes.value,
                contests: scope.value === 'some' ? [...chosen] : [],
            };
            if (server) {
                await post('update', { id: server.id, server: input });
                notify(status, `已保存 ${input.name} 的设置`);
            } else {
                const result = await post('create', { ...input, origin: location.origin });
                notify(status, `已添加打印服务器 ${input.name}`);
                setTimeout(() => showCode({ name: input.name }, result.code, true), 0);
            }
            await load();
        },
    });
    serverName.focus();
}

function remove(server) {
    const password = adminPassword();
    openDialog({
        title: `删除打印服务器 ${server.name}`,
        confirm: '确认删除',
        body: [el('p', { text: '删除后这台电脑的客户端立即断开，它正在打印的请求退回队列，由其他打印服务器打印。' }), el('div', { class: 'resolver-fields' }, field('管理员密码', password))],
        submit: async () => {
            await post('delete', { id: server.id, password: password.value });
            notify(status, `已删除打印服务器 ${server.name}`);
            await load();
        },
    });
    password.focus();
}

async function savePrinter(server, printer, preference) {
    try {
        await post('printer', { id: server.id, printer: printer.name, preference });
        notify(status, `已更新 ${server.name} / ${printer.name}，几秒内同步到打印电脑`);
        await load();
    } catch (error) { notify(status, error.message, true); await load(); }
}

async function testPage(server, printer) {
    try {
        await post('test', { id: server.id, printer });
        notify(status, `已发送测试页到 ${server.name}${printer ? ` / ${printer}` : ''}，几秒内打印`);
        await load();
    } catch (error) { notify(status, error.message, true); }
}

async function requeue() {
    const tasks = [...state.selected];
    if (!tasks.length) { notify(recentStatus, '请先勾选已打印或失败的打印请求', true); return; }
    try {
        const result = await post('requeue', { tasks });
        state.selected.clear();
        notify(recentStatus, `已将 ${result.updated} 份打印请求重新排队${result.skipped ? `；${result.skipped} 份已不是已打印或失败状态，未改动` : ''}`);
        await load();
    } catch (error) { notify(recentStatus, error.message, true); }
}

load();
// The refresh rebuilds the lists: wait while a dialog is open, or for a few seconds after the
// operator last used a control in them (an open weight menu would close, keyboard focus would be lost).
let touched = 0;
for (const list of [serverList, recentTable]) {
    for (const type of ['pointerdown', 'keydown', 'focusin']) list.addEventListener(type, () => { touched = Date.now(); });
}
const busy = () => document.querySelector('dialog[open]')
    || (Date.now() - touched < 8000 && (serverList.contains(document.activeElement) || recentTable.contains(document.activeElement)));
// Changes are pushed (a new request, a claim, a result, a print server coming online); the slow
// poll notices print servers that went silent. A busy page reloads once the operator is done.
let waiting = 0;
const refresh = () => {
    clearTimeout(waiting);
    if (document.hidden) return;
    if (busy()) { waiting = setTimeout(refresh, 2000); return; }
    load();
};
listen(runtime.socket, refresh);
document.addEventListener('visibilitychange', refresh);
setInterval(refresh, 30000);
