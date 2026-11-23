// /manage user configuration: accounts and Hydro 5.1 teams, edit and (batch) delete; seats and IP login.
import {
    $, adminPassword, el, field, formatTime, get, input, notify, openDialog, post, randomPassword, runtime,
} from './hydro-manage-common.js';
import { createSeatsPanel } from './hydro-manage-seats.js';

const hashTabs = { '#teams': 'teams', '#seats': 'seats' };
const state = { tab: hashTabs[location.hash] || 'users', q: '', page: 1, total: 0, pageSize: 50, rows: [], selected: new Map() };
const labels = { users: '用户', teams: '队伍', seats: '座位与 IP' };

const status = el('p', { class: 'resolver-muted', role: 'status', hidden: true });
const search = input({ type: 'search', placeholder: '账号、显示名、邮箱、学校、学号或 UID', 'aria-label': '搜索' });
const deleteButton = el('button', { class: 'button manage-danger', type: 'button', text: '删除', disabled: true });
const tabs = el('div', { class: 'manage-tabs', role: 'tablist' });
const table = el('table', { class: 'data-table' });
const pager = el('div', { class: 'manage-pager' });

for (const tab of ['users', 'teams', 'seats']) {
    tabs.append(el('button', {
        type: 'button', role: 'tab', text: labels[tab], 'data-tab': tab,
        onclick: () => {
            if (state.tab === tab) return;
            state.tab = tab;
            state.page = 1;
            state.q = '';
            search.value = '';
            state.selected.clear();
            notify(status, '');
            history.replaceState(null, '', tab === 'users' ? location.pathname + location.search : `#${tab}`);
            load();
        },
    }));
}

// Results follow the search box as it is typed in.
let searchTimer = 0;
search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
        if (state.q === search.value.trim()) return;
        notify(status, '');
        state.q = search.value.trim();
        state.page = 1;
        load();
    }, 300);
});

const root = $('manage-root');
const accounts = el('div', {},
    el('div', { class: 'manage-toolbar' }, search, el('span', { class: 'manage-spacer' }), deleteButton),
    status,
    el('div', { class: 'manage-scroll' }, table),
    pager);
const seats = createSeatsPanel();
root.replaceChildren(tabs, accounts, seats.node);

function updateSelection() {
    const count = state.selected.size;
    deleteButton.disabled = !count;
    deleteButton.textContent = count ? `删除 ${count} ${state.tab === 'teams' ? '支队伍' : '个用户'}` : '删除';
    for (const row of table.querySelectorAll('tbody tr[data-id]')) row.classList.toggle('is-selected', state.selected.has(Number(row.dataset.id)));
    const boxes = [...table.querySelectorAll('tbody input[type=checkbox]:not(:disabled)')];
    const all = table.querySelector('thead input[type=checkbox]');
    if (all) {
        all.checked = boxes.length > 0 && boxes.every((box) => box.checked);
        all.indeterminate = !all.checked && boxes.some((box) => box.checked);
    }
}

function checkbox(row, disabledReason) {
    const box = el('input', { type: 'checkbox', 'aria-label': `选择 ${row.uname}`, disabled: !!disabledReason, title: disabledReason || undefined });
    box.checked = state.selected.has(row._id);
    box.addEventListener('change', () => {
        if (box.checked) state.selected.set(row._id, row);
        else state.selected.delete(row._id);
        updateSelection();
    });
    return el('td', { class: 'col-check' }, box);
}

function headCheckbox() {
    const all = el('input', { type: 'checkbox', 'aria-label': '选择本页全部' });
    all.addEventListener('change', () => {
        for (const box of table.querySelectorAll('tbody input[type=checkbox]:not(:disabled)')) {
            box.checked = all.checked;
            box.dispatchEvent(new Event('change'));
        }
    });
    return el('th', { class: 'col-check' }, all);
}

const person = (member) => member.uname
    ? `${member.displayName || member.uname}${member.displayName && member.displayName !== member.uname ? `（${member.uname}）` : ''}`
    : `UID ${member._id}（已删除）`;

function renderUsers() {
    table.replaceChildren(
        el('thead', {}, el('tr', {}, headCheckbox(), ...['UID', '账号', '显示名', '邮箱', '学校', '学号', '最近登录'].map((text) => el('th', { text })), el('th', { class: 'col-actions', text: '操作' }))),
        el('tbody', {}, ...state.rows.length ? state.rows.map((row) => el('tr', { 'data-id': row._id },
            checkbox(row, row.undeletable),
            el('td', { class: 'manage-nowrap', text: row._id }),
            el('td', {}, row.uname, row.judge ? el('span', { class: 'manage-tag', text: '评测机' }) : null, row.locked ? el('span', { class: 'manage-tag', text: '受保护', title: row.locked }) : null),
            el('td', { text: row.displayName || '—' }),
            el('td', { text: row.mail }),
            el('td', { text: row.school || '—' }),
            el('td', { text: row.studentId || '—' }),
            el('td', { class: 'manage-nowrap manage-small', text: formatTime(row.loginat) }),
            el('td', { class: 'col-actions' }, el('button', { class: 'button', type: 'button', text: '编辑', disabled: !!row.locked, title: row.locked || undefined, onclick: () => editUser(row) })),
        )) : [el('tr', {}, el('td', { class: 'manage-empty', colspan: 9, text: state.q ? '没有匹配的用户' : '暂无用户' }))]),
    );
}

function renderTeams() {
    table.replaceChildren(
        el('thead', {}, el('tr', {}, headCheckbox(), ...['ID', '队名', '队员', '待接受邀请', '报名比赛', '创建时间'].map((text) => el('th', { text })), el('th', { class: 'col-actions', text: '操作' }))),
        el('tbody', {}, ...state.rows.length ? state.rows.map((row) => el('tr', { 'data-id': row._id },
            checkbox(row, null),
            el('td', { class: 'manage-nowrap', text: row._id }),
            el('td', {}, row.displayName || row.uname, el('div', { class: 'manage-dim manage-small', text: row.uname })),
            el('td', {}, ...row.members.length ? row.members.map((member) => el('span', { class: 'manage-tag', text: person(member) })) : [el('span', { class: 'manage-dim', text: '无' })]),
            el('td', {}, ...row.invite.length ? row.invite.map((member) => el('span', { class: 'manage-tag', text: person(member) })) : [el('span', { class: 'manage-dim', text: '—' })]),
            el('td', { text: row.contests }),
            el('td', { class: 'manage-nowrap manage-small', text: formatTime(row.regat) }),
            el('td', { class: 'col-actions' }, el('button', { class: 'button', type: 'button', text: '编辑', onclick: () => editTeam(row) })),
        )) : [el('tr', {}, el('td', { class: 'manage-empty', colspan: 8, text: state.q ? '没有匹配的队伍' : '暂无队伍。Hydro 5.1 起选手可在“比赛 → 我的队伍”中组队。' }))]),
    );
}

function renderPager() {
    const pages = Math.max(1, Math.ceil(state.total / state.pageSize));
    const go = (page) => { state.page = page; load(); };
    pager.replaceChildren(
        el('span', { class: 'resolver-muted', text: `共 ${state.total} ${state.tab === 'teams' ? '支队伍' : '个用户'} · 第 ${state.page} / ${pages} 页` }),
        el('span', { class: 'manage-toolbar' },
            el('button', { class: 'button', type: 'button', text: '上一页', disabled: state.page <= 1, onclick: () => go(state.page - 1) }),
            el('button', { class: 'button', type: 'button', text: '下一页', disabled: state.page >= pages, onclick: () => go(state.page + 1) })),
    );
}

async function load() {
    for (const tab of tabs.children) tab.setAttribute('aria-selected', String(tab.dataset.tab === state.tab));
    accounts.hidden = state.tab === 'seats';
    if (state.tab === 'seats') { seats.show(); return; }
    seats.hide();
    search.placeholder = state.tab === 'teams' ? '搜索队名或队伍账号' : '搜索账号、显示名、邮箱、学校、学号或 UID';
    try {
        const data = await get({ tab: state.tab, q: state.q, page: state.page });
        state.total = data.total;
        state.pageSize = data.pageSize;
        state.rows = state.tab === 'teams' ? data.teams : data.users;
        if (state.tab === 'teams') renderTeams(); else renderUsers();
        renderPager();
        updateSelection();
    } catch (error) { notify(status, error.message, true); }
}

function passwordInput(placeholder) {
    const box = input({ type: 'text', autocomplete: 'new-password', placeholder, minlength: 6, maxlength: 255 });
    const generate = el('button', { class: 'button', type: 'button', text: '随机生成', onclick: () => { box.value = randomPassword(); } });
    return { box, wrap: el('div', { class: 'manage-password' }, box, generate) };
}

function editUser(row) {
    const displayName = input({ value: row.displayName, maxlength: 64 });
    const mail = input({ type: 'email', value: row.mail, required: true, maxlength: 254 });
    const school = input({ value: row.school, maxlength: 128 });
    const studentId = input({ value: row.studentId, maxlength: 64 });
    const password = passwordInput('留空则不修改');
    const operator = adminPassword();
    operator.required = false;
    const dialog = openDialog({
        extra: [deleteAction(row, false, () => dialog.close())],
        title: `编辑用户 ${row.uname}`,
        confirm: '保存',
        body: [el('div', { class: 'resolver-fields resolver-two' },
            field('UID', el('div', { class: 'manage-readonly', text: row._id })),
            field('账号', el('div', { class: 'manage-readonly', text: row.uname })),
            field('显示名', displayName, `当前域（${runtime.domainId}）的显示名`),
            field('邮箱', mail),
            field('学校', school),
            field('学号', studentId)),
        el('div', { class: 'resolver-fields' }, field('新密码', password.wrap, '修改后该用户已登录的会话会退出'),
            row.admin ? field('管理员密码', operator, `${row.uname} 是系统管理员：修改其密码或邮箱需要输入当前登录管理员的密码`) : null)],
        submit: async () => {
            const edit = { displayName: displayName.value, mail: mail.value, school: school.value, studentId: studentId.value };
            if (password.box.value) edit.password = password.box.value;
            const signIn = !!edit.password || edit.mail.trim().toLowerCase() !== String(row.mail).toLowerCase();
            if (row.admin && signIn && !operator.value) { operator.focus(); throw new Error('请输入管理员密码'); }
            await post('update_user', { uid: row._id, edit, ...row.admin && signIn ? { adminPassword: operator.value } : {} });
            notify(status, `已保存用户 ${row.uname}${edit.password ? '，新密码已生效' : ''}`);
            await load();
        },
    });
}

const splitNames = (value) => value.split(/[\s,，;；]+/).map((item) => item.trim()).filter(Boolean);
const accountName = (member) => member.uname || String(member._id);

function editTeam(row) {
    const displayName = input({ value: row.displayName, required: true, maxlength: 64 });
    const members = el('textarea', { class: 'textbox', rows: 2 });
    members.value = row.members.filter((member) => member.uname).map(accountName).join(', ');
    const invite = el('textarea', { class: 'textbox', rows: 2 });
    invite.value = row.invite.filter((member) => member.uname).map(accountName).join(', ');
    const password = passwordInput('留空则不修改');
    const sync = el('input', { type: 'checkbox', checked: true });
    const dialog = openDialog({
        extra: [deleteAction(row, true, () => dialog.close())],
        title: `编辑队伍 ${row.displayName || row.uname}`,
        confirm: '保存',
        body: [el('div', { class: 'resolver-fields resolver-two' },
            field('ID', el('div', { class: 'manage-readonly', text: row._id })),
            field('队伍账号', el('div', { class: 'manage-readonly', text: row.uname }))),
        el('div', { class: 'resolver-fields' },
            field('队名', displayName),
            field('队员（账号名或 UID）', members),
            field('待接受邀请', invite),
            field('重置全体队员密码', password.wrap, 'Hydro 队伍本身没有密码，选手用各自账号登录；填写后所有队员改用此密码登录'),
            el('label', { class: 'checkbox' }, sync, '同步队名与队员到该队已报名的比赛')),
        ],
        submit: async () => {
            const edit = { displayName: displayName.value, members: splitNames(members.value), invite: splitNames(invite.value) };
            if (password.box.value) edit.memberPassword = password.box.value;
            const result = await post('update_team', { uid: row._id, edit, sync: sync.checked });
            const notes = [];
            if (result.synced) notes.push(`已同步 ${result.synced} 场比赛`);
            if (result.passwords) notes.push(`已重置 ${result.passwords} 名队员的密码`);
            notify(status, `已保存队伍 ${edit.displayName}${notes.length ? `，${notes.join('，')}` : ''}`);
            await load();
        },
    });
}

/** Deletes the given rows after the administrator's password: the batch button and each edit dialog. */
function confirmDelete(rows, teams) {
    const password = adminPassword();
    const extra = el('input', { type: 'checkbox' });
    const names = rows.slice(0, 20).map((row) => el('li', { text: teams ? `${row.displayName || row.uname}（${row._id}）` : `${row.uname}${row.displayName ? `（${row.displayName}）` : ''}` }));
    if (rows.length > 20) names.push(el('li', { text: `……共 ${rows.length} 项` }));
    openDialog({
        title: rows.length === 1 ? `删除${teams ? '队伍' : '用户'} ${teams ? rows[0].displayName || rows[0].uname : rows[0].uname}` : `删除 ${rows.length} ${teams ? '支队伍' : '个用户'}`,
        confirm: '确认删除',
        body: [
            el('p', { text: teams ? '队伍删除后队员账号保留，无法恢复。' : '账号删除后无法恢复，其登录会话、域成员身份、用户组和队伍成员身份会一并移除。' }),
            el('ul', { class: 'manage-list' }, ...names),
            el('label', { class: 'checkbox' }, extra, teams ? '同时取消这些队伍的比赛报名（从榜单中移除）' : '同时删除其提交记录与比赛报名'),
            el('div', { class: 'resolver-fields' }, field('管理员密码', password)),
        ],
        submit: async () => {
            const payload = { uids: rows.map((row) => row._id), password: password.value };
            if (teams) payload.withStatus = extra.checked; else payload.purge = extra.checked;
            const result = await post(teams ? 'delete_teams' : 'delete_users', payload);
            for (const row of rows) state.selected.delete(row._id);
            const skipped = result.skipped?.length ? `；跳过 ${result.skipped.length} 项：${result.skipped.join('；')}` : '';
            notify(status, `已删除 ${result.deleted.length} ${teams ? '支队伍' : '个用户'}${skipped}`, !!result.skipped?.length);
            await load();
        },
    });
    password.focus();
}

/** The edit dialog's own delete button: closes the edit, then asks for the password. */
function deleteAction(row, teams, close) {
    const reason = teams ? null : row.undeletable;
    return el('button', {
        class: 'button manage-danger', type: 'button', text: teams ? '删除队伍' : '删除用户', disabled: !!reason, title: reason || undefined,
        onclick: () => { close(); confirmDelete([row], teams); },
    });
}

deleteButton.addEventListener('click', () => confirmDelete([...state.selected.values()], state.tab === 'teams'));

load();
