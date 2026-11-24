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
import { editLayout } from './hydro-reaction-layout.js';
const tabs = [
    ['videos', '视频'],
    ['queue', '渲染队列'],
    ['layouts', '版式'],
    ['workers', '媒体机'],
    ['public', '公开设置'],
];
const states = { waiting: '等待', rendering: '渲染中', ready: '已完成', failed: '失败', stale: '已过期', removed: '已清理' };
const filters = {};
let data,
    tab = runtime.tab || 'videos',
    page = 1;
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
    document.getElementById('rx-tabs').replaceChildren(
        ...tabs.map(([id, label]) => {
            const b = button(label, () => {
                tab = id;
                page = 1;
                notify();
                return refresh();
            });
            b.setAttribute('aria-current', String(id === tab));
            return b;
        }),
    );
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
            el('p', { text: `最近一小时完成 ${done} 条，失败率 ${done + fail ? Math.round((fail * 100) / (done + fail)) : 0}%` }),
            el('p', {
                text:
                    '待处理 ' +
                    (data.stats?.waiting ?? videos.filter((v) => ['waiting', 'stale'].includes(v.state)).length) +
                    ' 条 · 渲染中 ' +
                    (data.stats?.rendering ?? videos.filter((v) => v.state === 'rendering').length) +
                    ' 条',
            }),
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
        root.append(el('p', { text: '暂无符合条件的视频' }));
        return;
    }
    const maxPage = data.paging?.pages ?? Math.max(1, Math.ceil(rows.length / 40));
    page = Math.min(maxPage, page);
    for (const v of data.paging ? videos : rows.slice((page - 1) * 40, page * 40)) {
        root.append(
            el(
                'div',
                { class: 'rx-row' },
                el(
                    'div',
                    {},
                    el('strong', { text: v.team + ' · ' + v.problem + ' · ' + v.verdict }),
                    el('small', { text: formatTime(v.submittedAt) }),
                ),
                el(
                    'div',
                    {},
                    el('span', { text: v.layoutName + ' · ' + (states[v.state] || v.state) + (v.hidden ? ' · 已撤下' : '') }),
                    v.error ? el('small', { class: 'rx-error', text: v.error }) : null,
                ),
                el(
                    'div',
                    {},
                    v.url ? button('预览', () => play(v, true, false)) : null,
                    v.url ? el('a', { href: v.url + '?download=1', text: '下载' }) : null,
                    button('重渲染', () => save('retry', { id: v.id })),
                    button(v.hidden ? '恢复' : '撤下', () => save(v.hidden ? 'restore' : 'hide', { id: v.id })),
                ),
            ),
        );
    }
    if (maxPage > 1)
        root.append(
            pageControls(page, maxPage, (number) => {
                page = number;
                return data.paging ? refresh() : render();
            }),
        );
}
function workers() {
    const url = location.origin + runtime.base + '-api/' + data.token;
    root.append(
        el('h2', { text: '媒体机接入' }),
        el(
            'div',
            { class: 'rx-actions' },
            button(data.token ? '更换令牌' : '生成令牌', async () => {
                if (data.token && !confirm('更换令牌会使现有媒体机链接立即失效。继续更换？')) return;
                await save('token', {});
            }),
            data.token
                ? button('复制接口地址', async () => {
                      if (!(await copyText(url))) throw new Error('请从下方命令复制地址');
                      notify('接口地址已复制');
                  })
                : null,
        ),
    );
    if (data.token)
        root.append(
            el('p', { text: '在媒体机上运行以下命令。Docker 将拉取公共镜像并连接本场比赛。' }),
            el('pre', {
                class: 'rx-code',
                text:
                    'docker run --rm -v "$PWD/out:/app/out" ghcr.io/albert-li-sz/reactions-generator-hydro:1.21.0 all "' +
                    url +
                    '" --hydro-upload',
            }),
            el('h3', { text: '本机运行' }),
            el('pre', { class: 'rx-code', text: 'poetry install\npoetry run main all "' + url + '" --hydro-upload' }),
        );
    root.append(el('h2', { text: '媒体机心跳' }), button('刷新', load));
    for (const w of data.workers)
        root.append(
            el(
                'div',
                { class: 'rx-row' },
                el('strong', { text: w.name + ' · ' + w.version }),
                el('span', { text: '分区 ' + w.partition + ' · ' + (Date.now() - w.lastSeen < 60000 ? '在线' : '离线') }),
                el('span', { text: formatTime(w.lastSeen) + ' · 队列 ' + w.queue }),
            ),
        );
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
        fields,
        el('p', { text: '学校隐藏时，已烧录学校名称或 Logo 的版式也会隐藏。' }),
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
    if (tab === 'queue' || tab === 'workers') load().catch((e) => notify(e.message, true));
}, 15000);
