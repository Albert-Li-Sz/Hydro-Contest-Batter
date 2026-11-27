const fields = new Map([['school', '学校'], ['name', '队名'], ['members', '队员'], ['coaches', '教练'], ['seat', '座位']]);
const empty = { match: 'any', action: 'pin', rules: [] };
let active = empty;
let compiled = [];
let revision;

// The board's Vue module supplies its own ref, so filters update only the rendered lists.
export function filterRevision(ref) {
    return revision ||= ref(0);
}

function validate(value) {
    if (!value || !['any', 'all'].includes(value.match) || !['pin', 'only'].includes(value.action)
        || !Array.isArray(value.rules)) throw new Error('筛选格式无效');
    return { match: value.match, action: value.action, rules: value.rules.map((rule, index) => {
        if (!fields.has(rule?.field) || typeof rule.pattern !== 'string' || !rule.pattern.trim()) {
            throw new Error(`第 ${index + 1} 条规则需要匹配字段和正则表达式`);
        }
        try { new RegExp(rule.pattern, 'iu'); } catch { throw new Error(`第 ${index + 1} 条正则表达式无效`); }
        return { field: rule.field, pattern: rule.pattern };
    }) };
}

function activate(value) {
    active = validate(value);
    compiled = active.rules.map(({ field, pattern }) => ({ field, regex: new RegExp(pattern, 'iu') }));
    if (revision) revision.value++;
}

const label = (value) => value?.getOrDefault?.('zh-CN') ?? String(value || '');
function values(team, field) {
    if (field === 'name') return [label(team.name)];
    if (field === 'school') return [label(team.organization?.name)];
    if (field === 'seat') return [team.location || ''];
    return (team[field] || []).map((person) => label(person.name));
}

export function visibleTeams(teams, revisionNumber, auxiliary = false) {
    if (!compiled.length || (auxiliary && active.action === 'pin')) return teams;
    const matched = [];
    const rest = [];
    for (const entry of teams) {
        const team = entry.team ?? entry;
        const test = ({ field, regex }) => values(team, field).some((value) => regex.test(value));
        const matches = active.match === 'all' ? compiled.every(test) : compiled.some(test);
        if (matches) matched.push(entry);
        else if (active.action === 'pin') rest.push(entry);
    }
    return matched.concat(rest);
}

export function mountBoardFilter(panel) {
    if (!panel) return;
    const key = 'xcpcio:board-filter:' + (location.pathname.match(/^.*?\/contest\/[^/]+/)?.[0] || location.pathname);
    const byId = (id) => panel.querySelector('#xp-filter-' + id);
    const list = byId('rules');
    const message = byId('message');
    const transfer = byId('transfer');
    try {
        const saved = localStorage.getItem(key);
        if (saved) activate(JSON.parse(saved));
    } catch { /* Ignore obsolete browser preferences. */ }
    function addRule(field = 'school', pattern = '') {
        const row = document.createElement('div');
        row.className = 'xp-filter-rule';
        const select = document.createElement('select');
        select.className = 'select'; select.setAttribute('aria-label', '匹配字段');
        for (const [id, name] of fields) select.add(new Option(name, id, false, id === field));
        const input = document.createElement('input');
        input.className = 'textbox'; input.placeholder = '正则表达式';
        input.setAttribute('aria-label', '正则表达式'); input.value = pattern;
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'button'; remove.textContent = '移除';
        remove.addEventListener('click', () => row.remove());
        row.append(select, input, remove); list.append(row);
        return input;
    }
    function populate() {
        byId('match').value = active.match; byId('action').value = active.action;
        list.replaceChildren();
        if (!active.rules.length) addRule();
        for (const rule of active.rules) addRule(rule.field, rule.pattern);
        panel.querySelector('summary').textContent = active.rules.length ? `高级筛选（${active.rules.length} 条已启用）` : '高级筛选';
    }
    function read() {
        return validate({ match: byId('match').value, action: byId('action').value,
            rules: [...list.children].map((row) => ({ field: row.querySelector('select').value, pattern: row.querySelector('input').value }))
                .filter((rule) => rule.pattern.trim()) });
    }
    function save(value) {
        activate(value);
        try { localStorage.setItem(key, JSON.stringify(active)); } catch { /* Still applied in this tab. */ }
        populate();
    }
    byId('add').onclick = () => addRule().focus();
    byId('apply').onclick = () => {
        try { save(read()); message.textContent = active.rules.length ? '筛选已应用' : '已显示全部队伍'; }
        catch (error) { message.textContent = error.message; }
    };
    byId('clear').onclick = () => { save(empty); message.textContent = '已显示全部队伍'; };
    byId('export').onclick = () => {
        try { transfer.hidden = false; transfer.value = JSON.stringify(read(), null, 2); transfer.focus(); transfer.select(); message.textContent = '可复制已选中的规则文本'; }
        catch (error) { message.textContent = error.message; }
    };
    byId('import').onclick = () => {
        if (transfer.hidden || !transfer.value.trim()) {
            transfer.hidden = false; transfer.focus(); message.textContent = '粘贴规则文本后，再点导入'; return;
        }
        try { save(JSON.parse(transfer.value)); message.textContent = '已导入并应用筛选'; }
        catch (error) { message.textContent = error instanceof SyntaxError ? '规则文本必须是 JSON' : error.message; }
    };
    populate();
}
