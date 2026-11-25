import {
    api,
    action,
    button,
    copyText,
    el,
    field,
    formatTime,
    notify,
    pageControls,
    play,
    root,
    runtime,
    select,
} from './hydro-reaction-ui.js';
import { helpTip, ratioMeter } from './hydro-ui.js';
import { editLayout } from './hydro-reaction-layout.js';
const tabs = [
    ['videos', '视频'],
    ['queue', '渲染队列'],
    ['layouts', '版式'],
    ['workers', '媒体机'],
    ['public', '公开设置'],
];
document.getElementById('rx-config').href = runtime.base.replace(/\/reactions$/, '/control#media');
const states = { waiting: '等待', rendering: '渲染中', ready: '已完成', failed: '失败', stale: '已过期', removed: '已清理' };
const filters = {};
let data,
    tab = selectedTab(),
    page = 1;
function selectedTab() {
    const hash = location.hash.slice(1);
    return tabs.some(([id]) => id === hash) ? hash : runtime.tab || 'videos';
}
function selectTab() {
    const next = selectedTab();
    if (tab === next) return;
    if (tab === 'workers') justIssued = null;
    tab = next;
    page = 1;
    notify();
    refresh();
}
window.addEventListener('hashchange', selectTab);
let latestRequest = 0;
async function load() {
    const sequence = ++latestRequest,
        query = new URLSearchParams({ ...filters, page: String(page), tab });
    const result = await api(runtime.base + '/manage/data?' + query);
    if (sequence !== latestRequest) return;
    data = result;
    if (data.paging) page = data.paging.page;
    render();
}
function refresh() {
    return load().catch((e) => notify(e.message, true));
}
async function save(name, payload) {
    const r = await action(name, payload);
    await load();
    notify('已保存');
    return r;
}
function render() {
    const nav = document.getElementById('rx-tabs');
    if (!nav.childElementCount) nav.append(...tabs.map(([id, label]) => el('a', { href: '#' + id, text: label })));
    for (const link of nav.children) {
        if (link.hash === '#' + tab) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
    }
    root.setAttribute('aria-busy', 'false');
    root.replaceChildren();
    if (tab === 'layouts') {
        editLayout(root, data, load);
        return;
    }
    if (tab === 'workers') {
        workers();
        return;
    }
    if (tab === 'public') {
        publication();
        return;
    }
    const videos = data.videos || [],
        hour = Date.now() - 3600000;
    if (tab === 'queue') {
        const done = data.stats?.done ?? videos.filter((v) => v.readyAt >= hour && v.state === 'ready').length,
            fail = data.stats?.fail ?? videos.filter((v) => v.state === 'failed' && v.updatedAt >= hour).length;
        root.append(
            el('dl', { class: 'rx-metrics' }, ...[
                ['待处理', data.stats?.waiting ?? videos.filter((v) => ['waiting', 'stale'].includes(v.state)).length],
                ['渲染中', data.stats?.rendering ?? videos.filter((v) => v.state === 'rendering').length],
                ['一小时内完成', done],
                ['一小时失败率', ratioMeter('渲染失败率', done + fail ? fail / (done + fail) * 100 : null, { shape: 'ring', tone: fail ? 'bad' : 'ok' })],
            ].map(([name, value]) => el('div', {}, el('dt', { text: name }), el('dd', {}, value)))),
            ...data.workers
                .filter((w) => w.current && Date.now() - w.lastSeen < 60000)
                .map((w) => el('p', { text: `${w.name} · ${w.current.runId} / ${w.current.layoutId}` })),
        );
    }
    const options = (key) => (data.paging?.options[key] ?? [...new Set(videos.map((v) => v[key]).filter(Boolean))]).map((v) => [v, v]);
    const controls = el('div', { class: 'rx-tools' });
    for (const [k, label, opts] of [
        ['team', '队伍', options('team')],
        ['problem', '题目', options('problem')],
        ['verdict', '结果', options('verdict')],
        ['layoutId', '版式', data.layouts.map((l) => [l.id, l.name])],
        ['state', '状态', [...Object.entries(states), ['hidden', '已撤下']]],
    ]) {
        controls.append(
            field(
                label,
                select(label, [['', '全部'], ...opts], filters[k] || '', (v) => {
                    filters[k] = v;
                    page = 1;
                    refresh();
                }),
            ),
        );
    }
    controls.append(button('刷新', load));
    root.append(controls);
    let rows = videos.filter((v) =>
        Object.entries(filters).every(([k, val]) => !val || (k === 'state' && val === 'hidden' ? v.hidden : v[k] === val)),
    );
    rows =
        tab === 'queue'
            ? rows
                  .filter((v) => ['waiting', 'stale', 'rendering', 'failed'].includes(v.state))
                  .sort((a, b) => a.priority - b.priority || a.submittedAt - b.submittedAt)
            : rows.sort((a, b) => b.submittedAt - a.submittedAt);
    if (!rows.length) {
        root.append(el('p', { class: 'rx-empty', text: tab === 'queue' ? '渲染队列为空' : '暂无符合条件的视频' }));
        return;
    }
    const maxPage = data.paging?.pages ?? Math.max(1, Math.ceil(rows.length / 40));
    page = Math.min(maxPage, page);
    const list = el('div', { class: 'rx-library' },
        el('div', { class: 'rx-video-row rx-list-head', 'aria-hidden': true },
            ...['提交', '版式', '状态', '操作'].map((text) => el('span', { text }))));
    for (const v of data.paging ? videos : rows.slice((page - 1) * 40, page * 40)) {
        const more = el('details', { class: 'rx-more' }, el('summary', { 'aria-label': v.team + '的更多操作' }, '更多'),
            el('div', {}, v.url ? el('a', { href: v.url + '?download=1', text: '下载 MP4' }) : null,
                button('重渲染', () => save('retry', { id: v.id })),
                button(v.hidden ? '恢复' : '撤下', () => save(v.hidden ? 'restore' : 'hide', { id: v.id }))));
        list.append(el('article', { class: 'rx-video-row' },
            el('div', {}, el('strong', { text: v.team }), el('small', { text: v.problem + ' · ' + v.verdict + ' · ' + formatTime(v.submittedAt) })),
            el('span', { class: 'rx-video-layout', text: v.layoutName }),
            el('div', {}, el('span', { class: 'rx-state', 'data-state': v.hidden ? 'hidden' : v.state,
                text: v.hidden ? '已撤下' : states[v.state] || v.state }), v.error ? el('small', { class: 'rx-error', text: v.error }) : null),
            el('div', { class: 'rx-video-actions' }, v.url ? button('预览', () => play(v, true, false)) : null, more)));
    }
    root.append(list);
    if (maxPage > 1)
        root.append(
            pageControls(page, maxPage, (number) => {
                page = number;
                return data.paging ? refresh() : render();
            }),
        );
}
let justIssued = null;
function workers() {
    const name = el('input', { type: 'text', maxlength: 80, placeholder: '例如：赛场媒体机 A', 'aria-label': '媒体机名称' });
    async function issue(kind, params) {
        const result = await action(kind, { ...params, origin: location.origin });
        justIssued = { id: result.id, revision: result.revision, code: result.code };
        await load();
        notify('连接码已生成，请复制到这台媒体机');
    }
    const create = button('创建连接', async () => {
        const value = name.value.trim();
        if (!value) {
            name.focus();
            throw new Error('请填写媒体机名称');
        }
        create.disabled = true;
        try {
            await issue('createConnection', { name: value });
        } finally {
            create.disabled = false;
        }
    });
    root.append(el('h2', { text: '媒体机连接' }), el('div', { class: 'rx-tools' }, field('媒体机名称', name), create));
    for (const c of data.connections || []) {
        root.append(
            el(
                'div',
                { class: 'rx-row' },
                el('strong', { text: c.name }),
                el('span', { text: '签发于 ' + formatTime(c.issuedAt) }),
                el(
                    'div',
                    { class: 'rx-actions' },
                    button('更换密钥', async () => {
                        if (confirm('更换「' + c.name + '」的密钥后，需要在这台媒体机更新连接码。继续？'))
                            await issue('rotateConnection', { id: c.id, revision: c.revision });
                    }),
                    button('撤销连接', async () => {
                        if (confirm('撤销「' + c.name + '」的连接后，这台媒体机将失去本场访问权。继续？')) {
                            if (justIssued?.id === c.id) justIssued = null;
                            await save('revokeConnection', { id: c.id, revision: c.revision });
                        }
                    }),
                ),
            ),
        );
    }
    if (justIssued && data.connections?.some((c) => c.id === justIssued.id && c.revision === justIssued.revision)) {
        const code = justIssued.code,
            box = el('textarea', { readonly: true, rows: 3, spellcheck: false, 'aria-label': '新签发的媒体机连接码', style: 'width:100%' });
        box.value = code;
        const copy = async (text) => {
            if (!(await copyText(text))) {
                box.focus();
                box.select();
                throw new Error('请手动复制已选中的连接码');
            }
            notify('已复制');
        };
        root.append(
            el('h3', { text: '新签发的连接码' }),
            el('p', { text: '离开此页后，如需重新取得连接码，请更换该连接的密钥。' }),
            box,
            el(
                'div',
                { class: 'rx-actions' },
                button('复制连接码', () => copy(code)),
                button('复制 .env 配置', () => copy('HYDRO_MEDIA_CONNECTION=' + code)),
                button('收起连接码', () => {
                    justIssued = null;
                    render();
                }),
            ),
        );
    } else {
        justIssued = null;
    }
    if (data.legacyEnabled)
        root.append(
            el(
                'div',
                { class: 'rx-actions' },
                el('span', { text: '旧版媒体机链接仍可使用。' }),
                button('撤销旧版链接', async () => {
                    if (confirm('撤销后，使用旧版接口地址的媒体机将断开。继续？')) await save('revokeLegacy', {});
                }),
            ),
        );
    root.append(
        el('div', { class: 'rx-actions' },
            el('a', { href: 'https://albert-li-sz.github.io/Hydro-Contest-Better/media-worker.compose.yaml', text: '下载 Compose 配置' }),
            el('a', { href: 'https://albert-li-sz.github.io/Hydro-Contest-Better/media-worker.html#install', target: '_blank', rel: 'noopener', text: '媒体机安装图解' }),
            helpTip('Compose 部署', '将 compose.yaml 与含连接码的 .env 放在同一目录，运行 docker compose up -d。')),
        el('h2', { text: '媒体机心跳' }),
        button('刷新', load),
    );
    const connections = new Map((data.connections || []).map((c) => [c.id, c]));
    for (const w of data.workers) {
        const registered = connections.get(w.connectionId);
        const valid = w.connectionId ? registered && w.connectionRevision === registered.revision : data.legacyEnabled;
        root.append(
            el(
                'div',
                { class: 'rx-row' },
                el('strong', { text: [registered?.name, w.name, w.version].filter(Boolean).join(' · ') }),
                el('span', {
                    text:
                        '分区 ' +
                        w.partition +
                        ' · ' +
                        (!valid ? (registered ? '密钥已更换' : '连接已撤销') : Date.now() - w.lastSeen < 60000 ? '在线' : '离线'),
                }),
                el('span', { text: formatTime(w.lastSeen) + ' · 队列 ' + w.queue }),
            ),
        );
    }
    if (!data.workers.length) root.append(el('p', { text: '尚未收到媒体机心跳' }));
}
function publication() {
    const c = { ...data.config },
        fields = el('div', { class: 'rx-fields' });
    function flag(k, title) {
        const input = el('input', {
            type: 'checkbox',
            checked: c[k],
            onchange: (e) => {
                c[k] = e.target.checked;
            },
        });
        fields.append(field(title, input));
    }
    function choice(k, title, options) {
        fields.append(
            field(
                title,
                select(title, options, c[k], (v) => {
                    c[k] = v;
                }),
            ),
        );
    }
    flag('enabled', '开启公开页');
    choice('scope', '公开范围', [
        ['first', '仅一血'],
        ['accepted', '通过'],
        ['all', '所有已完成视频'],
    ]);
    choice('timing', '公开时机', [
        ['unlock', '解除封榜后'],
        ['end', '比赛结束后'],
        ...(!data.ccpc ? [['live', '比赛中仅封榜前提交']] : []),
    ]);
    choice('screen', '比赛中屏幕', [
        ['none', '仅无屏幕版式'],
        ['capture', '沿用直播屏幕设置'],
    ]);
    choice(
        'layoutId',
        '公开版式',
        data.layouts.map((l) => [l.id, l.name]),
    );
    choice('school', '学校', [
        ['board', '跟随公开榜单'],
        ['show', '显示'],
        ['hide', '隐藏'],
    ]);
    flag('download', '允许下载');
    root.append(
        el('h2', { text: '观众访问' }), fields,
        helpTip('学校隐私', '隐藏学校时，含学校名称或 Logo 的成品也会从公开页隐藏。'),
        el(
            'div',
            { class: 'rx-actions' },
            button('保存公开设置', () => save('public', { settings: c })),
            data.config.enabled ? el('a', { href: runtime.base, text: '打开公开页', target: '_blank', rel: 'noopener' }) : null,
        ),
    );
}
load().catch((e) => notify(e.message, true));
setInterval(() => {
    if (tab === 'queue' || (tab === 'workers' && !root.contains(document.activeElement))) load().catch((e) => notify(e.message, true));
}, 15000);
