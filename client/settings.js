import { bulkSelection, fieldValues, filterMembers, normalize } from './member-filter.mjs';

const root = document.getElementById('xp-settings');
if (root) {
    const data = JSON.parse(document.getElementById('xp-data').textContent);
    const { teams, filterFields } = data;
    let { settings } = data;
    // A submission the server rejects leaves this page; keep what was sent so going back does not lose the edits.
    const draftKey = `xp-settings-draft:${location.pathname}`;
    const store = { get: () => { try { return sessionStorage.getItem(draftKey); } catch { return null; } },
        set: (value) => { try { sessionStorage.setItem(draftKey, value); } catch { /* storage unavailable */ } },
        clear: () => { try { sessionStorage.removeItem(draftKey); } catch { /* storage unavailable */ } } };
    let restored = false;
    if (new URLSearchParams(location.search).get('saved') === '1') store.clear();
    else {
        try {
            const draft = JSON.parse(store.get() || 'null');
            if (draft && Array.isArray(draft.manualBoards) && draft.medals) {
                settings = { ...settings, ...draft, unofficialFirstSolve: draft.unofficialFirstSolve ?? draft.unofficialAwards ?? settings.unofficialFirstSolve };
                restored = true;
            }
        } catch { store.clear(); }
    }
    const form = document.getElementById('xp-form');
    const container = document.getElementById('xp-boards');
    const medals = ['gold', 'silver', 'bronze'];
    for (const key of medals) root.querySelector(`[data-medal="${key}"]`).value = settings.medals[key];
    // 按比例设奖: the same three inputs hold percentages (labels and limits follow the choice).
    const basisLabels = { gold: '金牌', silver: '银牌', bronze: '铜牌' };
    // Percentages may not add up to more than the whole board (the server checks the same on save).
    function checkRatio(inputs, basis) {
        const sum = Object.values(inputs).reduce((total, input) => total + (Number(input.value) || 0), 0);
        inputs.gold?.setCustomValidity(basis === 'ratio' && sum > 100 ? `金银铜比例之和为 ${sum}%，不能超过 100%` : '');
    }
    function applyBasis(inputs, basis) {
        checkRatio(inputs, basis);
        for (const input of Object.values(inputs)) {
            if (!input.dataset.ratioWatched) {
                input.dataset.ratioWatched = '1';
                input.addEventListener('input', () => checkRatio(inputs, input.dataset.basis));
            }
            input.dataset.basis = basis;
        }
        for (const [tier, input] of Object.entries(inputs)) {
            const ratio = basis === 'ratio';
            input.max = ratio ? '100' : '100000';
            input.title = ratio ? '占有效队伍的百分比' : '获奖队伍数';
            const caption = input.closest('label')?.querySelector('.xp-medal-unit');
            if (caption) caption.textContent = ratio ? '（%）' : '';
            input.setAttribute('aria-label', `${basisLabels[tier] || tier}${ratio ? '比例（%）' : '数量'}`);
        }
    }
    const defaultMedalInputs = Object.fromEntries(medals.map((key) => [key, root.querySelector(`[data-medal="${key}"]`)]));
    for (const input of Object.values(defaultMedalInputs)) {
        const unit = document.createElement('small'); unit.className = 'xp-medal-unit';
        input.closest('label').querySelector('span')?.append(unit);
    }
    const medalBasis = document.getElementById('xp-medal-basis');
    medalBasis.value = settings.medalBasis === 'ratio' ? 'ratio' : 'count';
    applyBasis(defaultMedalInputs, medalBasis.value);
    medalBasis.addEventListener('change', () => applyBasis(defaultMedalInputs, medalBasis.value));
    const tieBreak = document.getElementById('xp-tie-break');
    tieBreak.value = settings.tieBreak === 'icpc' ? 'icpc' : 'hydro';
    const tieHint = document.getElementById('xp-tie-break-hint');
    const updateTieHint = () => {
        tieHint.textContent = tieBreak.value === 'icpc'
            ? '按通过题数；相同时总用时少者在前（每题通过时间取整到分钟，每次未通过的提交加 20 分钟）；仍相同时最后一题通过时间早者在前；再相同则并列，并列队伍获同等奖项。'
            : '按通过题数；相同时罚时少者在前（通过时间精确到秒，每次未通过的提交加 20 分钟）；罚时相同则并列，与 Hydro 原生榜单一致。';
    };
    tieBreak.addEventListener('change', updateTieHint); updateTieHint();
    document.getElementById('xp-schools').checked = settings.schoolBoards;
    document.getElementById('xp-participation').checked = settings.participationBoards;
    const publicAccess = document.getElementById('xp-public-access');
    publicAccess.checked = settings.publicAccess;
    document.getElementById('xp-replace-native').checked = settings.replaceNative;
    const showIdentity = document.getElementById('xp-show-identity');
    showIdentity.checked = settings.showIdentity;
    const ccsApi = document.getElementById('xp-ccs-api');
    ccsApi.checked = !!settings.ccsApi;
    const ccsLink = document.getElementById('xp-ccs-url');
    ccsLink.textContent = ccsLink.href;
    const autoFinalize = document.getElementById('xp-ccs-auto-finalize');
    autoFinalize.checked = !!settings.ccsAutoFinalize;
    const finalize = document.getElementById('xp-ccs-finalize');
    const ccsStatus = document.getElementById('xp-ccs-status');
    const updateCcsLink = () => {
        document.getElementById('xp-ccs-url-wrap').hidden = !ccsApi.checked;
        document.getElementById('xp-ccs-controls').hidden = !ccsApi.checked;
        finalize.disabled = !settings.ccsApi;
        if (!settings.ccsApi) ccsStatus.textContent = '请先保存“开放 CCS API”设置。';
    };
    ccsApi.addEventListener('change', updateCcsLink); updateCcsLink();
    const copyCcs = document.getElementById('xp-copy-ccs-url');
    copyCcs.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(ccsLink.href); copyCcs.textContent = '已复制'; } catch { copyCcs.textContent = '请手动复制'; }
        setTimeout(() => { copyCcs.textContent = '复制链接'; }, 2000);
    });
    finalize.addEventListener('click', async () => {
        if (!confirm('确认 CCS 最终结果后将保存不可变快照，并结束事件流。后续重测不会更新 CCS 数据。是否继续？')) return;
        finalize.disabled = true;
        try {
            const response = await fetch(`${ccsLink.href.replace(/\/$/, '')}/finalize`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}', credentials: 'same-origin',
            });
            const result = await response.json();
            if (!response.ok) throw new Error(result.message || '确认失败');
            ccsStatus.textContent = result.message;
        } catch (error) {
            ccsStatus.textContent = error.message || '确认失败'; finalize.disabled = false;
        }
    });
    function updatePublicLink() {
        document.getElementById('xp-public-url-wrap').hidden = !publicAccess.checked;
        document.getElementById('xp-public-disabled').hidden = publicAccess.checked;
    }
    publicAccess.addEventListener('change', updatePublicLink); updatePublicLink();
    const publicLink = document.getElementById('xp-public-url');
    publicLink.textContent = publicLink.href;
    const copyButton = document.getElementById('xp-copy-url');
    copyButton.addEventListener('click', async () => {
        try { await navigator.clipboard.writeText(publicLink.href); copyButton.textContent = '已复制'; } catch { copyButton.textContent = '请手动复制'; }
        setTimeout(() => { copyButton.textContent = '复制链接'; }, 2000);
    });
    const savedNotice = document.getElementById('xp-saved');
    const query = new URLSearchParams(location.search);
    savedNotice.hidden = query.get('saved') !== '1';
    if (query.has('saved')) {
        // A reload should not repeat the notice for changes made afterwards.
        query.delete('saved');
        history.replaceState(null, '', `${location.pathname}${query.toString() ? `?${query}` : ''}${location.hash}`);
    }
    let dirty = false;
    const saveHint = document.getElementById('xp-save-hint');
    const markDirty = () => {
        if (dirty) return;
        dirty = true; savedNotice.hidden = true; saveHint.textContent = '有未保存的更改';
        // The bar stands out while there is something to save.
        saveHint.closest('.xp-savebar').classList.add('xp-savebar--dirty');
    };
    form.addEventListener('input', (event) => { if (!event.target.closest('.xp-search, .xp-value-search, .xp-filter-panel')) markDirty(); });
    form.addEventListener('change', (event) => { if (!event.target.closest('.xp-search, .xp-filter-panel')) markDirty(); });
    let submitting = false;
    addEventListener('beforeunload', (event) => { if (dirty && !submitting) event.preventDefault(); });
    // Returning from a failed save through the back/forward cache: the edits are still unsaved.
    addEventListener('pageshow', () => { submitting = false; });
    if (restored) {
        const notice = document.getElementById('xp-restored'); notice.hidden = false;
        document.getElementById('xp-discard').addEventListener('click', () => { store.clear(); dirty = false; location.reload(); });
        markDirty();
    }
    const editors = [];
    const nameKey = (name) => normalize(name);
    // Mirrors the server's save-time check so a clash is reported on the field instead of an error page.
    function checkNames() {
        const taken = new Set(['所有队伍', '主榜', '总榜', ...(document.getElementById('xp-participation').checked ? ['正式参赛', '非正式参赛'] : []),
            ...(document.getElementById('xp-schools').checked ? teams.map((team) => `${team.organization || '未填写学校'}榜`) : [])].map(nameKey));
        for (const editor of editors) {
            const key = nameKey(editor.name.value);
            editor.name.setCustomValidity(key && taken.has(key) ? '已有同名榜单，请改用不同的名称' : '');
            taken.add(key);
        }
    }
    for (const id of ['xp-participation', 'xp-schools']) document.getElementById(id).addEventListener('change', checkNames);
    const make = (tag, text, className) => {
        const element = document.createElement(tag);
        if (text !== undefined) element.textContent = text;
        element.className = [tag === 'button' ? 'button' : tag === 'select' ? 'select' : '', className || ''].filter(Boolean).join(' ');
        return element;
    };
    function awardFields(parent, initial, includeCounts) {
        const fields = {};
        let basis = null;
        if (includeCounts) {
            const wrapper = make('label', '奖牌名额', 'xp-field');
            basis = make('select');
            for (const [value, text] of [['count', '固定数量'], ['ratio', '按有效队伍比例（%）']]) {
                const option = make('option', text); option.value = value; basis.append(option);
            }
            basis.value = initial.medalBasis === 'ratio' ? 'ratio' : 'count';
            basis.setAttribute('aria-label', '奖牌名额方式');
            wrapper.append(basis); parent.append(wrapper);
        }
        const grid = make('div', undefined, 'xp-medals');
        for (const [tier, label] of [['gold', '金奖'], ['silver', '银奖'], ['bronze', '铜奖']]) {
            const group = make('div');
            for (const [key, caption, value, type] of [
                ...(includeCounts ? [[tier, `${label}名额`, initial.medals[tier], 'number']] : []),
                [`${tier}Citation`, `${label}名称`, initial[`${tier}Citation`], 'text'],
            ]) {
                const wrapper = make('label', caption);
                const input = make('input', undefined, 'textbox'); input.type = type; input.value = value;
                input.setAttribute('aria-label', caption); input.required = true;
                if (type === 'number') { input.min = '0'; input.max = '100000'; input.step = '1'; }
                else input.maxLength = 80;
                wrapper.append(input); group.append(wrapper); fields[key] = input;
            }
            grid.append(group);
        }
        parent.append(grid);
        const checks = make('div', undefined, 'xp-checks');
        for (const [key, text] of [['medalSameScore', '并列同奖'], ['firstSolve', '一血奖'], ['podiumEnabled', '前三名奖项'], ['unofficialFirstSolve', '允许打星选手获一血奖']]) {
            const label = make('label', undefined, 'checkbox'); const input = make('input'); input.type = 'checkbox'; input.checked = initial[key];
            input.setAttribute('aria-label', text); label.append(input, make('span', text)); checks.append(label); fields[key] = input;
        }
        parent.append(checks);
        if (basis) {
            const counts = Object.fromEntries(medals.map((key) => [key, fields[key]]));
            for (const input of Object.values(counts)) {
                const unit = make('small', '', 'xp-medal-unit'); input.closest('label').firstChild?.after?.(unit);
            }
            const sync = () => applyBasis(counts, basis.value);
            basis.addEventListener('change', sync); sync();
        }
        return {
            read: () => ({ ...(includeCounts ? { medals: Object.fromEntries(medals.map((key) => [key, Number(fields[key].value)])), medalBasis: basis.value } : {}),
                ...Object.fromEntries(Object.entries(fields).filter(([key]) => !medals.includes(key)).map(([key, input]) => [key, input.type === 'checkbox' ? input.checked : input.value.trim()])) }),
            set: (values) => {
                for (const [key, input] of Object.entries(fields)) {
                    const value = medals.includes(key) ? values.medals[key] : values[key];
                    if (input.type === 'checkbox') input.checked = value; else input.value = value;
                }
                if (basis && values.medalBasis) { basis.value = values.medalBasis; basis.dispatchEvent(new Event('change')); }
            },
            disable: (disabled) => { for (const input of [...Object.values(fields), ...basis ? [basis] : []]) input.disabled = disabled; },
        };
    }
    const defaultAwardEditor = awardFields(document.getElementById('xp-default-award-options'), settings, false);
    const awardEditors = new Map();
    function refreshAwardEditors() {
        const boards = [{ id: 'all', name: '主榜' },
            ...(data.automaticBoards || []).filter((board) => document.getElementById(board.kind === 'school' ? 'xp-schools' : 'xp-participation').checked),
            ...editors.map((editor) => ({ id: `manual-${editor.board.id}`, name: editor.name.value.trim() || '未命名分榜', medals: editor.board.medals }))];
        const target = document.getElementById('xp-board-awards');
        target.replaceChildren();
        for (const board of boards) {
            let editor = awardEditors.get(board.id);
            if (!editor) {
                const saved = settings.boardAwards?.[board.id] || (board.medals ? { ...settings, medals: board.medals } : null);
                const card = make('details', undefined, 'xp-board'); const summary = make('summary'); card.append(summary);
                const label = make('label', undefined, 'checkbox'); const enabled = make('input'); enabled.type = 'checkbox'; enabled.checked = !!saved;
                label.append(enabled, make('span', '单独设置此榜奖项')); card.append(label);
                const body = make('div'); card.append(body);
                const initial = saved || { ...settings, ...defaultAwardEditor.read(), medalBasis: medalBasis.value, medals: Object.fromEntries(medals.map((key) => [key, Number(root.querySelector(`[data-medal="${key}"]`).value)])) };
                const fields = awardFields(body, initial, true);
                const toggle = () => { body.hidden = !enabled.checked; fields.disable(!enabled.checked); };
                enabled.addEventListener('change', () => {
                    if (enabled.checked && !saved) fields.set({ ...defaultAwardEditor.read(), medalBasis: medalBasis.value, medals: Object.fromEntries(medals.map((key) => [key, Number(root.querySelector(`[data-medal="${key}"]`).value)])) });
                    toggle();
                }); toggle();
                editor = { card, summary, enabled, read: fields.read }; awardEditors.set(board.id, editor);
            }
            editor.summary.textContent = board.name;
            editor.enabled.setAttribute('aria-label', `单独设置${board.name}奖项`);
            target.append(editor.card);
        }
    }
    function readBoardAwards() {
        const result = { ...settings.boardAwards };
        for (const [id, editor] of awardEditors) {
            if (editor.enabled.checked) result[id] = editor.read(); else delete result[id];
        }
        const manualIds = new Set(editors.map((editor) => `manual-${editor.board.id}`));
        for (const id of Object.keys(result)) if (id.startsWith('manual-') && !manualIds.has(id)) delete result[id];
        return result;
    }
    for (const id of ['xp-participation', 'xp-schools']) document.getElementById(id).addEventListener('change', refreshAwardEditors);
    function addBoard(board) {
        const card = make('div', undefined, 'xp-board');
        const title = make('div', undefined, 'xp-line xp-board-header');
        const name = make('input', undefined, 'textbox xp-board-title');
        name.type = 'text'; name.required = true; name.maxLength = 64;
        name.placeholder = '例如：新生榜'; name.setAttribute('aria-label', '分榜名称'); name.value = board.name;
        const remove = make('button', '删除分榜', 'xp-delete'); remove.type = 'button';
        const editor = { board, card, name };
        remove.addEventListener('click', () => {
            const label = name.value.trim() || '未命名分榜';
            if (selected.size && !confirm(`删除“${label}”及其 ${selected.size} 名成员？保存后生效。`)) return;
            editors.splice(editors.indexOf(editor), 1); card.remove(); markDirty(); updateAddButton(); checkNames(); refreshAwardEditors(); refreshSpecialBoards();
        });
        title.append(name, remove); card.append(title);
        const details = make('details', undefined, 'xp-member-picker'); details.open = !board.name;
        const summary = make('summary');
        const knownIds = new Set(teams.map((team) => team.team_id));
        // Members who left the contest are dropped on save; say so instead of listing them as choices.
        const stale = board.teamIds.filter((id) => !knownIds.has(id));
        let selected = new Set(board.teamIds.filter((id) => knownIds.has(id)));
        const choices = teams;
        let matches = choices;
        const updateSummary = () => { summary.textContent = `选择成员（已选 ${selected.size} 人）`; };
        updateSummary();
        const search = make('input', undefined, 'textbox xp-search'); search.type = 'search'; search.placeholder = '搜索姓名、学校、用户 ID 或其他字段'; search.setAttribute('aria-label', '搜索参赛选手');
        const filterPanel = make('div', undefined, 'xp-filter-panel');
        const filterHeader = make('div', undefined, 'xp-line');
        const modeLabel = make('label', '组合条件：');
        const mode = make('select'); mode.setAttribute('aria-label', '组合条件');
        for (const [value, text] of [['all', '满足全部条件'], ['any', '满足任一条件']]) { const option = make('option', text); option.value = value; mode.append(option); }
        modeLabel.append(mode);
        const addFilter = make('button', '＋ 添加筛选条件'); addFilter.type = 'button';
        const onlySelected = make('input'); onlySelected.type = 'checkbox';
        const onlySelectedLabel = make('label', undefined, 'checkbox'); onlySelectedLabel.append(onlySelected, document.createTextNode('只看已选成员'));
        filterHeader.append(modeLabel, addFilter, onlySelectedLabel);
        const conditions = make('div'); const filters = [];
        const filterCount = make('p', undefined, 'xp-muted'); filterCount.setAttribute('aria-live', 'polite');
        filterPanel.append(filterHeader, conditions, filterCount);
        const list = make('div', undefined, 'xp-members');
        const inputs = new Map();
        const bulkButtons = [];
        for (const team of choices) {
            const label = make('label', undefined, 'checkbox xp-member');
            const input = make('input'); input.type = 'checkbox'; input.checked = selected.has(team.team_id);
            const text = `${team.name} · ${team.organization || '未填写学校'} · ID ${team.team_id} · ${team.group.includes('official') ? '正式' : '非正式'}`;
            input.setAttribute('aria-label', text);
            input.addEventListener('change', () => { if (input.checked) selected.add(team.team_id); else selected.delete(team.team_id); updateSummary(); });
            const info = make('span', undefined, 'xp-member-info');
            info.append(make('strong', team.name), make('span', `${team.organization || '未填写学校'} · ID ${team.team_id} · ${team.group.includes('official') ? '正式' : '非正式'}`, 'xp-muted'));
            label.append(input, info); list.append(label);
            inputs.set(team.team_id, { label, input });
        }
        const emptyList = make('p', '没有匹配的选手，请调整筛选条件。', 'xp-empty'); list.append(emptyList);
        function applyFilters() {
            matches = filterMembers(choices, { query: search.value, mode: mode.value, rules: filters.map((filter) => filter.read()) });
            if (onlySelected.checked) matches = matches.filter((team) => selected.has(team.team_id));
            const ids = new Set(matches.map((team) => team.team_id));
            for (const [id, entry] of inputs) entry.label.hidden = !ids.has(id);
            filterCount.textContent = `当前匹配 ${matches.length} 人 / 共 ${choices.length} 人`;
            emptyList.hidden = matches.length > 0;
            for (const [button, title] of bulkButtons) button.textContent = `${title}（${matches.length}）`;
        }
        function addCondition() {
            const row = make('div', undefined, 'xp-filter-row');
            const field = make('select'); field.setAttribute('aria-label', '筛选字段');
            for (const definition of filterFields) { const option = make('option', definition.label); option.value = definition.key; field.append(option); }
            const operator = make('select'); operator.setAttribute('aria-label', '匹配方式');
            for (const [value, text] of [['is', '属于任一选中值'], ['not', '不属于选中值'], ['contains', '包含关键词'], ['empty', '未填写'], ['not-empty', '已填写']]) {
                const option = make('option', text); option.value = value; operator.append(option);
            }
            const values = make('div', undefined, 'xp-filter-values'); values.setAttribute('role', 'group'); values.setAttribute('aria-label', '筛选取值');
            const valueSearch = make('input', undefined, 'textbox xp-value-search'); valueSearch.type = 'search'; valueSearch.placeholder = '搜索取值，可勾选多个'; valueSearch.setAttribute('aria-label', '搜索筛选取值');
            const valueOptions = make('div', undefined, 'xp-value-options');
            const valueCount = make('p', undefined, 'xp-muted xp-value-count');
            const noValues = make('p', '没有匹配的取值', 'xp-muted xp-value-empty');
            const selectedValues = new Set();
            values.append(valueSearch, valueOptions, valueCount);
            const text = make('input', undefined, 'textbox xp-filter-text'); text.type = 'text'; text.placeholder = '多个值用逗号分隔'; text.setAttribute('aria-label', '筛选关键词');
            const remove = make('button', '删除条件', 'xp-delete'); remove.type = 'button';
            const filter = { read: () => ({
                field: field.value, operator: operator.value,
                values: values.hidden ? text.value.split(/[,，;；\n]/).map((value) => value.trim()).filter(Boolean) : [...selectedValues],
            }) };
            function filterValues() {
                let count = 0;
                for (const option of valueOptions.querySelectorAll('label')) {
                    option.hidden = !normalize(option.textContent).includes(normalize(valueSearch.value));
                    if (!option.hidden) count++;
                }
                noValues.hidden = count > 0;
            }
            valueSearch.addEventListener('input', filterValues);
            function updateValues(reset = false) {
                const categorical = !['name', 'username', 'id'].includes(field.value);
                const empty = ['empty', 'not-empty'].includes(operator.value);
                values.hidden = empty || !categorical || operator.value === 'contains';
                text.hidden = empty || !values.hidden;
                if (reset) {
                    valueOptions.replaceChildren(); selectedValues.clear(); text.value = ''; valueSearch.value = '';
                    const options = [...new Set(choices.flatMap((team) => fieldValues(team, field.value)).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
                    for (const value of options) {
                        const label = make('label', undefined, 'checkbox'); const input = make('input'); input.type = 'checkbox'; input.value = value;
                        input.addEventListener('change', () => {
                            if (input.checked) selectedValues.add(value); else selectedValues.delete(value);
                            valueCount.textContent = `已选 ${selectedValues.size} 个值，可连续点选`;
                            applyFilters();
                        });
                        label.append(input, make('span', value)); valueOptions.append(label);
                    }
                    valueOptions.append(noValues); valueCount.textContent = '可勾选多个值'; filterValues();
                }
                applyFilters();
            }
            field.addEventListener('change', () => { operator.value = ['name', 'username', 'id'].includes(field.value) ? 'contains' : 'is'; updateValues(true); });
            operator.addEventListener('change', () => updateValues());
            text.addEventListener('input', applyFilters);
            remove.addEventListener('click', () => { filters.splice(filters.indexOf(filter), 1); row.remove(); applyFilters(); });
            filters.push(filter); row.append(field, operator, values, text, remove); conditions.append(row); updateValues(true);
        }
        addFilter.addEventListener('click', addCondition); mode.addEventListener('change', applyFilters); onlySelected.addEventListener('change', applyFilters); search.addEventListener('input', applyFilters);
        const bulk = make('div', undefined, 'xp-line xp-bulk');
        const undo = make('button', '撤销批量操作'); undo.type = 'button'; undo.disabled = true;
        let beforeBulk;
        const show = () => { for (const [id, entry] of inputs) entry.input.checked = selected.has(id); updateSummary(); markDirty(); };
        for (const [operation, title] of [['add', '勾选筛选结果'], ['remove', '取消勾选筛选结果'], ['replace', '替换为筛选结果']]) {
            const button = make('button', title); button.type = 'button';
            button.addEventListener('click', () => {
                beforeBulk = selected; undo.disabled = false;
                selected = bulkSelection(selected, matches, operation); show();
            }); bulk.append(button); bulkButtons.push([button, title]);
        }
        undo.addEventListener('click', () => { selected = beforeBulk; undo.disabled = true; show(); });
        bulk.append(undo);
        if (stale.length) card.append(make('p', `${stale.length} 名成员已不在参赛名单（ID ${stale.join(', ')}），保存后将从此分榜移除。`, 'xp-notice'));
        details.append(summary, search, filterPanel, bulk, list); card.append(details); container.append(card); applyFilters();
        editor.read = () => ({ id: board.id, name: name.value.trim(), teamIds: [...selected],  });
        editors.push(editor); name.addEventListener('input', () => { checkNames(); refreshAwardEditors(); });
    }
    const addButton = document.getElementById('xp-add');
    function updateAddButton() {
        addButton.disabled = editors.length >= 50;
        document.getElementById('xp-add-limit').hidden = !addButton.disabled;
    }
    for (const board of settings.manualBoards) addBoard(board);
    refreshAwardEditors();
    checkNames();
    updateAddButton();
    addButton.addEventListener('click', () => {
        if (editors.length >= 50) return;
        addBoard({ id: `g-${crypto.randomUUID().slice(0, 8)}`, name: '', teamIds: [] });
        editors.at(-1).name.focus(); markDirty(); updateAddButton(); refreshAwardEditors(); refreshSpecialBoards();
    });
    // 特别奖: a name, how the winner is found, and on which board.
    const specialKinds = [['rank', '分榜名次'], ['lastAccept', '最后一个通过'], ['lastSolver', '有过题的最后一名'], ['manual', '指定队伍']];
    const specialEditors = [];
    const specialList = document.getElementById('xp-specials');
    const addSpecialButton = document.getElementById('xp-add-special');
    const teamLabel = (team) => `${team.name}${team.organization && team.organization !== '未填写学校' ? ` · ${team.organization}` : ''}`;
    const teamById = new Map(teams.map((team) => [team.team_id, team]));
    const teamChoices = make('datalist');
    teamChoices.id = 'xp-special-team-choices';
    for (const team of teams) teamChoices.append(new Option(teamLabel(team), `${teamLabel(team)} #${team.team_id}`));
    specialList.after(teamChoices);
    function boardChoices() {
        return [{ id: 'all', name: '主榜' },
            ...(data.automaticBoards || []).filter((board) => document.getElementById(board.kind === 'school' ? 'xp-schools' : 'xp-participation').checked),
            ...editors.map((editor) => ({ id: `manual-${editor.board.id}`, name: editor.name.value.trim() || '未命名分榜' }))];
    }
    function refreshSpecialBoards() {
        const choices = boardChoices();
        for (const editor of specialEditors) {
            const current = editor.board.value || editor.award.board;
            editor.board.replaceChildren(...choices.map((board) => new Option(board.name, board.id, false, board.id === current)));
            // Preserve the selection even if a switch disabled the board, or saving should remove the award.
            if (current && !choices.some((board) => board.id === current)) {
                const label = current.startsWith('manual-') ? '分榜已删除，保存后移除此奖' : '所选分榜当前不可用';
                editor.board.add(new Option(label, current, false, true));
            }
        }
    }
    function addSpecial(award) {
        const card = make('div', undefined, 'xp-board xp-special-card');
        const head = make('div', undefined, 'xp-line xp-board-header');
        const name = make('input', undefined, 'textbox xp-board-title');
        name.type = 'text'; name.required = true; name.maxLength = 40; name.value = award.name;
        name.placeholder = '最佳女队'; name.setAttribute('aria-label', '特别奖名称');
        const kind = make('select'); kind.setAttribute('aria-label', '获奖方式');
        for (const [value, text] of specialKinds) kind.append(new Option(text, value, false, value === award.kind));
        const remove = make('button', '删除', 'xp-delete'); remove.type = 'button';
        head.append(name, kind, remove);
        const rule = make('div', undefined, 'xp-line');
        const board = make('select'); board.setAttribute('aria-label', '榜单');
        const rankLabel = make('label', undefined, 'xp-inline');
        const rank = make('input', undefined, 'textbox xp-rank'); rank.type = 'number'; rank.min = '1'; rank.max = '1000'; rank.step = '1'; rank.value = String(award.rank || 1);
        rank.setAttribute('aria-label', '名次');
        rankLabel.append('第', rank, '名');
        const unofficial = make('input'); unofficial.type = 'checkbox'; unofficial.checked = !!award.unofficial;
        const ties = make('input'); ties.type = 'checkbox'; ties.checked = award.ties !== false;
        const unofficialLabel = make('label', undefined, 'checkbox'); unofficialLabel.append(unofficial, make('span', '打星队伍可获'));
        const tiesLabel = make('label', undefined, 'checkbox'); tiesLabel.append(ties, make('span', '并列同奖'));
        rule.append(board, rankLabel, unofficialLabel, tiesLabel);
        // 指定队伍: chosen from the participants by name or school.
        const picked = new Set(award.teamIds || []);
        const pick = make('div', undefined, 'xp-line xp-special-teams');
        const chips = make('div', undefined, 'xp-chips');
        const search = make('input', undefined, 'textbox xp-search'); search.type = 'search'; search.placeholder = '队伍名称或学校';
        search.setAttribute('aria-label', '添加获奖队伍');
        search.setAttribute('list', teamChoices.id);
        const renderChips = () => {
            chips.replaceChildren(...[...picked].map((id) => {
                const team = teamById.get(id);
                const label = team ? teamLabel(team) : `当前参赛名单中无队伍 #${id}`;
                const chip = make('span', label, 'xp-chip');
                const drop = make('button', '×', 'xp-chip-remove'); drop.type = 'button'; drop.setAttribute('aria-label', `移除${team?.name ?? id}`);
                drop.addEventListener('click', () => { picked.delete(id); renderChips(); markDirty(); validate(); });
                chip.append(drop);
                return chip;
            }));
        };
        const validate = () => {
            search.setCustomValidity(kind.value === 'manual' && !picked.size ? '请指定获奖队伍' : '');
            search.disabled = picked.size >= 100;
            search.placeholder = search.disabled ? '已选满 100 支队伍' : '队伍名称或学校';
        };
        search.addEventListener('change', () => {
            const id = /#(-?\d+)$/.exec(search.value)?.[1];
            if (id && teamById.has(id)) { picked.add(id); search.value = ''; renderChips(); markDirty(); validate(); }
        });
        pick.append(chips, search);
        card.append(head, rule, pick);
        const editor = { award, card, board, read: () => ({
            id: award.id, name: name.value.trim(), kind: kind.value, board: kind.value === 'manual' ? 'all' : board.value || 'all', rank: Number(rank.value) || 1,
            teamIds: kind.value === 'manual' ? [...picked] : [], unofficial: kind.value === 'rank' && unofficial.checked, ties: ties.checked,
        }) };
        const layout = () => {
            const manual = kind.value === 'manual';
            rule.hidden = manual; pick.hidden = !manual;
            rankLabel.hidden = kind.value !== 'rank';
            unofficialLabel.hidden = kind.value !== 'rank';
            rank.required = kind.value === 'rank';
            validate();
        };
        kind.addEventListener('change', layout);
        remove.addEventListener('click', () => {
            specialEditors.splice(specialEditors.indexOf(editor), 1); card.remove(); markDirty(); updateSpecialButton();
        });
        specialEditors.push(editor);
        specialList.append(card);
        refreshSpecialBoards();
        renderChips();
        layout();
        return editor;
    }
    function updateSpecialButton() { addSpecialButton.disabled = specialEditors.length >= 20; }
    for (const award of settings.specialAwards || []) addSpecial(award);
    updateSpecialButton();
    addSpecialButton.addEventListener('click', () => {
        if (specialEditors.length >= 20) return;
        const editor = addSpecial({ id: `s-${crypto.randomUUID().slice(0, 8)}`, name: '', kind: 'rank', board: 'all', rank: 1, teamIds: [], unofficial: false, ties: true });
        editor.card.querySelector('input').focus(); markDirty(); updateSpecialButton();
    });
    for (const id of ['xp-participation', 'xp-schools']) document.getElementById(id).addEventListener('change', refreshSpecialBoards);
    specialList.closest('form').addEventListener('input', (event) => { if (event.target.classList.contains('xp-board-title') && !event.target.closest('.xp-special-card')) refreshSpecialBoards(); });
    form.addEventListener('submit', () => {
        submitting = true;
        const payload = document.getElementById('xp-payload');
        payload.value = JSON.stringify({
            medals: Object.fromEntries(medals.map((key) => [key, Number(root.querySelector(`[data-medal="${key}"]`).value)])),
            medalBasis: medalBasis.value,
            tieBreak: tieBreak.value,
            schoolBoards: document.getElementById('xp-schools').checked,
            participationBoards: document.getElementById('xp-participation').checked,
            ...defaultAwardEditor.read(),
            boardAwards: readBoardAwards(),
            publicAccess: publicAccess.checked,
            replaceNative: document.getElementById('xp-replace-native').checked,
            showIdentity: showIdentity.checked,
            ccsApi: ccsApi.checked,
            ccsAutoFinalize: autoFinalize.checked,
            manualBoards: editors.map((editor) => editor.read()),
            specialAwards: specialEditors.map((editor) => editor.read()),
        });
        store.set(payload.value);
    });
}
