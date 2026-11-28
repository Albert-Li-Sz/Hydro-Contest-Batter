import { el, field, get, input, openDialog, post } from './hydro-manage-common.js';
import { prefixFor, printSlips, readPasswordSlips } from './seat-import-forms.js';

export function seatTools(reload, report) {
    let scope = null, roster = null, selected = '', generation = 0;
    const button = (text, action) => el('button', { type: 'button', class: 'button', text, onclick: action });
    const toolbar = el('div', { class: 'manage-toolbar' });
    const details = el('div', { class: 'manage-scroll seat-coverage' });
    const section = el('section', { 'aria-label': '参赛队伍 IP 覆盖率' }, toolbar, details);
    const quick = button('快速补录 IP', enterMissing);
    const print = button('打印密码条', passwordSheet);
    const batch = button('批量导入', () => {
        const mode = el('select', { class: 'select', 'aria-label': '导入类型' }, new Option('座位', 'seat'), new Option('IP', 'ip'));
        const text = el('textarea', { class: 'textbox', rows: 8, required: true, placeholder: 'team01\tA-01' });
        mode.onchange = () => { text.placeholder = mode.value === 'seat' ? 'team01\tA-01' : 'team01\t192.168.1.11'; };
        openDialog({ title: '批量导入座位或 IP', confirm: '导入',
            body: [mode, field('每行填写账号和座位或 IP，用制表符分隔', text)],
            submit: () => importText(mode.value, text.value) });
    });
    async function importText(mode, text) {
        const result = await post('import_seats', { mode, text, contest: scope?.key || '' });
        report(`已导入 ${mode === 'ip' ? result.ips + ' 条 IP' : result.seats + ' 个座位'}，可从备份恢复`);
        await reload();
    }
    function render() {
        toolbar.replaceChildren(batch);
        details.replaceChildren();
        if (!scope || !roster) return;
        const missing = roster.teams.length - roster.bound;
        const chips = [
            ['bound', `已录 IP ${roster.bound} / ${roster.teams.length} 队`],
            ['missing', `${missing} 队没录 IP`],
            ['outside', `${roster.unmatched.length} 条 IP 没对应队伍`],
        ];
        const actions = chips.map(([value, text]) => el('button', { type: 'button', class: 'button', text,
            'aria-pressed': String(selected === value), onclick: () => { selected = selected === value ? '' : value; render(); } }));
        quick.disabled = !missing;
        toolbar.append(quick, print, ...actions);
        if (!selected) return;
        const unmatched = selected === 'outside';
        const headers = unmatched ? ['IP', '账号 UID'] : ['座位', '队伍', '登录账号', 'IP'];
        const rows = unmatched ? roster.unmatched.map(item => [item.ip, item.uid]) : roster.teams
            .filter(team => (team.ips.length > 0) === (selected === 'bound'))
            .map(team => [team.seat, team.name, team.accounts.join('、'), team.ips.join('、')]);
        details.append(el('table', { class: 'data-table' },
            el('thead', {}, el('tr', {}, ...headers.map(text => el('th', { text })))),
            el('tbody', {}, ...rows.length ? rows.map(values => el('tr', {}, ...values.map(value => el('td', { text: value || '—' })))) :
                [el('tr', {}, el('td', { colspan: headers.length, text: '没有符合条件的记录' }))])));
    }
    function enterMissing() {
        const fields = roster.teams.filter(team => !team.ips.length && team.accounts.length).map(team => {
            const name = el('select', { class: 'select', 'aria-label': '登录账号' }, ...team.accounts.map(account => new Option(account, account)));
            const prefix = input({ value: prefixFor(roster.teams, team), 'aria-label': '网段前缀', placeholder: '192.168.1.' });
            const last = input({ inputmode: 'numeric', pattern: '[0-9]{1,3}', maxlength: 3, 'aria-label': `${team.name} 的 IP 末段` });
            const node = el('div', { class: 'seat-quick-row' }, el('span', { text: [team.seat, team.name].filter(Boolean).join(' · ') }), name, prefix, last);
            return { node, prefix, last, name };
        });
        if (!fields.length) { report('没有可补录的登录账号'); return; }
        for (const [i, item] of fields.entries()) item.last.onkeydown = event => {
            if (event.key === 'Enter') { event.preventDefault(); if (i + 1 < fields.length) fields[i + 1].last.focus(); else dialog.querySelector('[type=submit]').focus(); }
        };
        const { dialog } = openDialog({ title: '快速补录 IP', confirm: '保存 IP', body: [el('div', { class: 'seat-quick' }, ...fields.map(item => item.node))],
            submit: async () => {
                const lines = fields.filter(item => item.last.value).map(({ name, prefix, last }) => {
                    const parts = prefix.value.trim().replace(/\.$/, '').split('.');
                    if (parts.length !== 3 || [...parts, last.value].some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) throw new Error('请检查网段前缀和末段（0 至 255）');
                    return `${name.value}\t${[...parts, last.value].map(Number).join('.')}`;
                });
                if (!lines.length) throw new Error('请至少填写一个 IP 末段');
                await importText('ip', lines.join('\n'));
            } });
        fields[0].last.focus();
    }
    function passwordSheet() {
        const file = el('input', { type: 'file', accept: '.csv,.tsv,text/csv,text/tab-separated-values', required: true });
        const title = scope.title, teams = roster.teams;
        openDialog({ title: '打印密码条', confirm: '打印 A4 密码条',
            body: [field('选择含「账号、口令」两列的 CSV 或 TSV，口令仅在本机读取', file)],
            submit: async () => {
                const chosen = file.files[0];
                if (!chosen) throw new Error('请选择文件');
                const slips = readPasswordSlips(await chosen.text(), teams);
                printSlips(title, slips);
            } });
    }
    async function refresh(contest, force = true) {
        if (!force && scope?.key === contest?.key && roster) return;
        const version = ++generation;
        if (scope?.key !== contest?.key) { selected = ''; roster = null; }
        scope = contest;
        render();
        if (!scope) return;
        const data = await get({ tab: 'seat-roster', contest: contest.key });
        if (version === generation) { roster = data; render(); }
    }
    render();
    return { section, refresh };
}
