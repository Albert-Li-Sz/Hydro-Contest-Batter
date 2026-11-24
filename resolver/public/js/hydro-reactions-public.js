import { api, button, el, field, formatTime, notify, pageControls, play, root, runtime, select } from './hydro-reaction-ui.js';
const controls = document.getElementById('rx-filters'),
    filters = {},
    shared = new URL(location.href).searchParams.get('video');
const pager = el('div');
root.after(pager);
let opened = false,
    data,
    dialog,
    page = 1,
    sequence = 0;
function render() {
    const rows = data.videos;
    const options = (key) =>
        data.paging?.options[key] ?? [...new Set(rows.map((v) => v[key]).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    function filter(key, value) {
        filters[key] = value;
        page = 1;
        return load();
    }
    controls.replaceChildren(
        ...[
            ['team', '队伍'],
            ['school', '学校'],
            ['problem', '题目'],
            ['verdict', '结果'],
        ]
            .filter(([key]) => options(key).length)
            .map(([key, name]) =>
                field(
                    name,
                    select(name, [['', '全部'], ...options(key).map((v) => [v, v])], filters[key] || '', (v) => filter(key, v)),
                ),
            ),
        field(
            '排序',
            select(
                '排序',
                [
                    ['time', '提交时间'],
                    ['problem', '题目'],
                ],
                filters.sort || 'time',
                (v) => filter('sort', v),
            ),
        ),
    );
    const selected = data.paging
        ? rows
        : rows
              .filter((v) => Object.entries(filters).every(([k, x]) => k === 'sort' || !x || v[k] === x))
              .sort(
                  (a, b) =>
                      Number(b.firstSolve) - Number(a.firstSolve) ||
                      (filters.sort === 'problem' ? a.problem.localeCompare(b.problem) : 0) ||
                      b.submittedAt - a.submittedAt,
              );
    function show(v) {
        dialog?.close();
        dialog = play(v, data.download, true);
        dialog.dataset.id = v.id;
    }
    const pages = data.paging?.pages ?? Math.max(1, Math.ceil(selected.length / 40));
    page = data.paging?.page ?? Math.min(page, pages);
    const visible = data.paging ? selected : selected.slice((page - 1) * 40, page * 40);
    root.replaceChildren(
        ...visible.map((v) =>
            el(
                'article',
                { class: 'rx-card' },
                el('small', { text: formatTime(v.submittedAt) }),
                el('h2', { text: v.team }),
                v.school ? el('p', { text: v.school }) : null,
                el('p', {}, v.firstSolve ? el('strong', { text: '一血 · ' }) : null, v.problem + ' · ' + v.verdict),
                button('播放', () => show(v)),
            ),
        ),
    );
    if (!visible.length) root.textContent = '暂无可播放的视频';
    pager.replaceChildren(
        ...(pages > 1
            ? [
                  pageControls(page, pages, (n) => {
                      page = n;
                      return load();
                  }),
              ]
            : []),
    );
    const active = dialog?.open ? dialog.dataset.id : !opened ? shared : null;
    const item = rows.find((v) => v.id === active) || (data.shared?.id === active ? data.shared : null);
    if (dialog?.open && data.lookedUp === active && !item) {
        dialog.close();
        notify('视频已撤下或当前不可公开');
    }
    if (shared && !opened) {
        opened = true;
        if (item) show(item);
        else notify('视频已撤下或当前不可公开');
    }
}
async function load() {
    const seq = ++sequence,
        lookedUp = dialog?.open ? dialog.dataset.id : !opened ? shared : null;
    const query = new URLSearchParams({ ...filters, page: String(page), ...(lookedUp ? { video: lookedUp } : {}) });
    try {
        const result = await api(runtime.base + '/data?' + query);
        if (seq !== sequence) return;
        data = { ...result, lookedUp };
        render();
    } catch (e) {
        if (seq !== sequence) return;
        dialog?.close();
        root.replaceChildren();
        controls.replaceChildren();
        pager.replaceChildren();
        notify(e.message, true);
    }
}
await load();
setInterval(load, 15000);
