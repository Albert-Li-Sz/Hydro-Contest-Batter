// /manage user configuration, 座位与 IP tab: onsite-toolkit seats and IP login of one contest or the
// whole site, with backup, cleanup, restore and the contest's no-login links.
import { adminPassword, el, field, formatTime, get, input, notify, openDialog, post } from './hydro-manage-common.js';

const filters = [['all', '全部'], ['duplicate', '重复座位'], ['noSeat', '无座位'], ['noIp', '无 IP'], ['orphan', '失效映射']];
const warning = new Set(['duplicate', 'orphan']);
const reasons = { manual: '手动', clear: '清理前', restore: '恢复前' };

function download(name, value) {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = el('a', { href: url, download: name });
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const stamp = (value) => {
    const date = new Date(value);
    const pad = (number) => String(number).padStart(2, '0');
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
};
const day = (value) => new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' });

export function createSeatsPanel() {
    const state = { contest: '', zone: '', filter: 'all', q: '', page: 1, data: null };
    const contest = el('select', { class: 'select', 'aria-label': '范围' });
    const zone = el('select', { class: 'select', 'aria-label': '考场' });
    const search = input({ type: 'search', placeholder: '座位、账号、名称或 IP', 'aria-label': '搜索座位' });
    const backup = el('button', { class: 'button', type: 'button', text: '备份' });
    const restore = el('button', { class: 'button', type: 'button', text: '恢复' });
    const clear = el('button', { class: 'button manage-danger', type: 'button', text: '清理' });
    const chips = el('div', { class: 'manage-filters', role: 'radiogroup', 'aria-label': '筛选' });
    const status = el('p', { class: 'resolver-muted', role: 'status', hidden: true });
    const table = el('table', { class: 'data-table manage-seats' });
    const pager = el('div', { class: 'manage-pager' });
    const links = el('section', { class: 'manage-links', hidden: true, 'aria-label': '免登录链接' });
    const node = el('div', { hidden: true },
        el('div', { class: 'manage-toolbar' }, contest, zone, search, el('span', { class: 'manage-spacer' }), backup, restore, clear),
        links, chips, status, el('div', { class: 'manage-scroll' }, table), pager);

    const selection = () => ({ contest: state.contest, zone: state.zone, filter: state.filter, q: state.q });
    const reload = (reset = true) => { if (reset) state.page = 1; load(); };
    contest.addEventListener('change', () => { state.contest = contest.value; state.zone = ''; state.filter = 'all'; notify(status, ''); reload(); });
    zone.addEventListener('change', () => { state.zone = zone.value; reload(); });
    let timer = 0;
    search.addEventListener('input', () => {
        clearTimeout(timer);
        timer = setTimeout(() => { if (state.q !== search.value.trim()) { state.q = search.value.trim(); reload(); } }, 300);
    });

    function renderScope(data) {
        const groups = new Map();
        for (const item of data.contests) groups.set(item.domainId, [...groups.get(item.domainId) || [], item]);
        const option = (item) => new Option(`${item.title}（${day(item.beginAt)}）`, item.key, false, item.key === state.contest);
        contest.replaceChildren(new Option('全站', '', false, !state.contest),
            ...groups.size > 1 ? [...groups].map(([domain, list]) => el('optgroup', { label: domain }, ...list.map(option))) : data.contests.map(option));
        if (state.contest && !data.contests.some((item) => item.key === state.contest) && data.contest) contest.append(option(data.contest));
        contest.value = state.contest;
        zone.replaceChildren(new Option('全部考场', '', false, !state.zone),
            ...data.zones.map((item) => new Option(`${item.zone ? `考场 ${item.zone}` : '无考场前缀'} · ${item.count}`, item.zone || '-', false, (item.zone || '-') === state.zone)));
        zone.hidden = data.zones.length < 2 && !state.zone;
        chips.replaceChildren(...filters.filter(([id]) => id === 'all' || data.counts[id] || state.filter === id).map(([id, label]) => el('button', {
            type: 'button', role: 'radio', 'aria-checked': String(state.filter === id),
            class: warning.has(id) && data.counts[id] ? 'is-warn' : undefined,
            onclick: () => { if (state.filter !== id) { state.filter = id; reload(); } },
        }, label, el('b', { text: data.counts[id] }))));
    }

    function renderRows(data) {
        const empty = state.q || state.zone || state.filter !== 'all' ? '没有匹配的账号' : data.contest ? '该比赛暂无参赛者' : '暂无座位或 IP 登录';
        table.replaceChildren(
            el('thead', {}, el('tr', {}, ...['座位', '账号', '名称', 'IP 登录', '最近登录'].map((text) => el('th', { text })), el('th', { class: 'col-actions' }))),
            el('tbody', {}, ...data.rows.length ? data.rows.map((row) => el('tr', { class: row.missing ? 'is-missing' : undefined },
                el('td', { class: `manage-nowrap seat-cell${row.duplicate ? ' is-duplicate' : ''}`, text: row.seat || '—' }),
                el('td', {}, row.missing ? el('s', { text: `UID ${row.uid}` }) : row.uname, row.missing ? null : el('div', { class: 'manage-dim manage-small', text: row.uid })),
                el('td', {}, row.name || (row.missing ? '' : '—'), row.team ? el('div', { class: 'manage-dim manage-small', text: row.team }) : null),
                el('td', {}, ...row.ips.map((ip) => el('span', { class: 'manage-tag manage-ip', text: ip }))),
                el('td', { class: 'manage-nowrap manage-small' }, row.kind === 'user' && !row.missing ? formatTime(row.loginat) : '',
                    row.loginip ? el('div', { class: `manage-ip${row.ips.length && !row.ips.includes(row.loginip) ? ' is-elsewhere' : ' manage-dim'}`, text: row.loginip }) : null),
                el('td', { class: 'col-actions' }, row.missing ? null : el('button', { class: 'button', type: 'button', text: '编辑', onclick: () => edit(row) })),
            )) : [el('tr', {}, el('td', { class: 'manage-empty', colspan: 6, text: empty }))]),
        );
        const pages = Math.max(1, Math.ceil(data.total / data.pageSize));
        pager.replaceChildren(el('span', { class: 'resolver-muted', text: `${data.total} 个账号${pages > 1 ? ` · 第 ${state.page} / ${pages} 页` : ''}` }));
        if (pages > 1) {
            pager.append(el('span', { class: 'manage-toolbar' },
                el('button', { class: 'button', type: 'button', text: '上一页', disabled: state.page <= 1, onclick: () => { state.page--; reload(false); } }),
                el('button', { class: 'button', type: 'button', text: '下一页', disabled: state.page >= pages, onclick: () => { state.page++; reload(false); } })));
        }
        const hasRows = data.total > 0;
        backup.disabled = !hasRows;
        clear.disabled = !hasRows;
        clear.textContent = hasRows ? `清理 ${data.total}` : '清理';
    }

    function renderLinks(data) {
        links.hidden = !data.links;
        if (!data.links) return;
        // Links issued before the contest ended are the ones handed out for it; newer ones nobody has.
        const ended = new Date(data.contest.endAt).getTime();
        const handedOut = data.links.filter((item) => item.count && !(item.issuedAt && new Date(item.issuedAt).getTime() > ended));
        links.replaceChildren(
            el('span', { class: 'manage-links__title', text: '免登录链接' }),
            ...data.links.map((item) => el('span', {
                class: `manage-link${!item.count ? ' is-none' : handedOut.includes(item) ? ' is-out' : ' is-fresh'}`,
                title: item.issuedAt ? `签发于 ${formatTime(item.issuedAt)}` : undefined,
            }, item.label, item.id === 'capture' && item.count ? el('b', { text: item.count }) : null)),
            el('span', { class: 'manage-spacer' }),
            el('button', { class: 'button manage-danger', type: 'button', text: '全部更换', disabled: !data.links.some((item) => item.count), onclick: () => revoke(data) }));
    }

    async function load() {
        try {
            const data = await get({ tab: 'seats', ...selection(), page: state.page });
            state.data = data;
            if (data.contest === null && state.contest) state.contest = '';
            renderScope(data);
            renderRows(data);
            renderLinks(data);
        } catch (error) { notify(status, error.message, true); }
    }

    function edit(row) {
        const seat = input({ value: row.seat, maxlength: 64 });
        const ips = el('textarea', { class: 'textbox manage-ip', rows: 3 });
        ips.value = row.ips.join('\n');
        openDialog({
            title: `${row.name || row.uname} · ${row.uname}`,
            confirm: '保存',
            body: [el('div', { class: 'resolver-fields' }, field('座位', seat), row.kind === 'user' ? field('IP 登录', ips) : null)],
            submit: async () => {
                const result = await post('update_seat', { uid: row.uid, seat: seat.value, ips: ips.value });
                const moved = result.moved.map((item) => `${item.ip}（原属 UID ${item.uid}）`);
                notify(status, moved.length ? `已保存 ${row.uname}，${moved.join('、')} 已改绑到此账号` : `已保存 ${row.uname}`);
                await load();
            },
        });
        seat.focus();
    }

    backup.addEventListener('click', async () => {
        backup.disabled = true;
        try {
            const result = await post('backup_seats', selection());
            download(`seats-${stamp(result.file.createdAt)}.json`, result.file);
            notify(status, `已备份 ${result.seats} 个座位、${result.ips} 条 IP 登录`);
        } catch (error) { notify(status, error.message, true); } finally { backup.disabled = false; }
    });

    clear.addEventListener('click', () => {
        const data = state.data;
        const box = (label, checked = true) => {
            const control = el('input', { type: 'checkbox', checked });
            return { control, node: el('label', { class: 'checkbox' }, control, label) };
        };
        const seats = box('座位');
        const ips = box('IP 登录');
        const sessions = box('退出登录');
        const password = adminPassword();
        const scope = [contest.selectedOptions[0]?.text, state.zone ? zone.selectedOptions[0]?.text : '', state.filter !== 'all' ? filters.find(([id]) => id === state.filter)[1] : '', state.q ? `“${state.q}”` : '']
            .filter(Boolean).join(' · ');
        openDialog({
            title: `清理 ${data.total} 个账号`,
            confirm: '清理',
            body: [
                el('p', { class: 'manage-scope', text: scope }),
                el('div', { class: 'manage-statuses' }, seats.node, ips.node, sessions.node),
                el('p', { class: 'resolver-muted manage-small', text: '清理前自动备份，可在“恢复”中还原。' }),
                el('div', { class: 'resolver-fields' }, field('管理员密码', password)),
            ],
            submit: async () => {
                const result = await post('clear_seats', {
                    ...selection(), password: password.value,
                    options: { seats: seats.control.checked, ips: ips.control.checked, sessions: sessions.control.checked },
                });
                const done = [result.seats && `${result.seats} 个座位`, result.ips && `${result.ips} 条 IP 登录`, result.sessions && `${result.sessions} 个账号的登录`].filter(Boolean);
                notify(status, done.length ? `已清理 ${done.join('、')}` : '没有需要清理的内容');
                state.filter = 'all';
                await load();
            },
        });
        password.focus();
    });

    restore.addEventListener('click', async () => {
        let list;
        try { list = (await get({ tab: 'seat-backups' })).backups; } catch (error) { notify(status, error.message, true); return; }
        let picked = list[0]?._id || '';
        let file = null;
        const fileInput = el('input', { type: 'file', accept: 'application/json,.json' });
        const rows = list.map((item) => {
            const radio = el('input', { type: 'radio', name: 'seat-backup', value: item._id, checked: item._id === picked });
            radio.addEventListener('change', () => { picked = item._id; file = null; fileInput.value = ''; });
            return el('label', { class: 'manage-backup' }, radio,
                el('span', { class: 'manage-nowrap', text: formatTime(item.createdAt) }),
                el('span', { class: 'manage-backup__label', text: item.label }),
                el('span', { class: `manage-tag${item.reason === 'manual' ? '' : ' manage-dim'}`, text: reasons[item.reason] || item.reason }),
                el('span', { class: 'manage-nowrap manage-small', text: `${item.seats} 座 · ${item.ips} IP` }),
                el('button', {
                    class: 'link manage-small', type: 'button', text: '下载',
                    onclick: async (event) => {
                        event.preventDefault();
                        download(`seats-${stamp(item.createdAt)}.json`, await get({ tab: 'seat-backup', id: item._id }));
                    },
                }));
        });
        fileInput.addEventListener('change', async () => {
            file = null;
            const chosen = fileInput.files?.[0];
            if (!chosen) return;
            try { file = JSON.parse(await chosen.text()); } catch { notify(status, '备份文件不是有效的 JSON', true); return; }
            for (const radio of rows.map((row) => row.querySelector('input'))) radio.checked = false;
            picked = '';
        });
        const seats = el('input', { type: 'checkbox', checked: true });
        const ips = el('input', { type: 'checkbox', checked: true });
        const password = adminPassword();
        openDialog({
            title: '恢复座位与 IP 登录',
            confirm: '恢复',
            body: [
                rows.length ? el('div', { class: 'manage-backups' }, ...rows) : null,
                el('label', { class: 'manage-file' }, '从文件', fileInput),
                el('div', { class: 'manage-statuses' }, el('label', { class: 'checkbox' }, seats, '座位'), el('label', { class: 'checkbox' }, ips, 'IP 登录')),
                el('div', { class: 'resolver-fields' }, field('管理员密码', password)),
            ],
            submit: async () => {
                if (!picked && !file) throw new Error('请选择备份或备份文件');
                const result = await post('restore_seats', { ...picked ? { id: picked } : { data: file }, seats: seats.checked, ips: ips.checked, password: password.value });
                notify(status, `已恢复 ${result.seats} 个座位、${result.ips} 条 IP 登录${result.skipped ? `，${result.skipped} 条的账号已不存在` : ''}`, false);
                await load();
            },
        });
    });

    function revoke(data) {
        const live = data.links.filter((item) => item.count);
        openDialog({
            title: `更换 ${data.contest.title} 的免登录链接`,
            confirm: '全部更换',
            body: [el('p', { class: 'manage-links manage-links--plain' }, ...live.map((item) => el('span', { class: 'manage-link is-out' }, item.label, item.id === 'capture' ? el('b', { text: item.count }) : null)))],
            submit: async () => {
                const result = await post('revoke_links', { contest: data.contest.key });
                const failed = result.links.filter((item) => item.error);
                notify(status, failed.length ? `部分链接未能更换：${failed.map((item) => `${item.label}（${item.error}）`).join('；')}` : '已更换，旧链接打开的页面会停止', !!failed.length);
                await load();
            },
        });
    }

    return { node, show() { node.hidden = false; load(); }, hide() { node.hidden = true; } };
}
