export function deviceAdmin(runtime, el, showError) {
    const $ = id => document.getElementById(id);
    const form = $('device-form'), dialog = $('device-dialog'), list = $('device-list');
    const endpoint = runtime.base + '/devices';
    const types = runtime.types.map(id => [id, runtime.labels[id]]);
    const boards = [['', '跟随画面'], ...runtime.boards.map(board => [board.id, board.name])];
    let repair = null, busy = false, refreshId = 0;
    const rows = new Map();
    function options(select, choices) { for (const [id, label] of choices) select.add(new Option(label, id)); }
    options(form.elements.type, types); options(form.elements.boardId, boards);
    form.elements.type.onchange = () => { form.elements.boardId.disabled = !runtime.standingsTypes.includes(form.elements.type.value); };
    function open(device = null) {
        repair = device; form.reset();
        $('device-error').textContent = '';
        $('device-dialog-title').textContent = device ? '重新配对 · ' + device.name : '连接大屏';
        $('device-initial').hidden = !!device;
        form.elements.name.required = !device;
        form.elements.type.onchange();
        dialog.showModal(); form.elements.code.focus();
    }
    async function action(data) {
        const response = await fetch(endpoint, { method: 'POST', headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
            body: JSON.stringify({ payload: JSON.stringify(data) }) });
        const result = await response.json();
        if (!response.ok || result.error) throw new Error(result.error?.message || result.error || '设备操作失败');
        return result;
    }
    $('screen-connect').onclick = () => open();
    $('device-cancel').onclick = () => dialog.close();
    form.onsubmit = async event => {
        event.preventDefault();
        const submit = form.querySelector('[type=submit]'); submit.disabled = true;
        try {
            const code = form.elements.code.value;
            await action(repair ? { action: 'repair', id: repair.id, code } : { action: 'claim', code,
                name: form.elements.name.value, type: form.elements.type.value, boardId: form.elements.boardId.value || null });
            dialog.close(); await refresh();
        } catch (error) { $('device-error').textContent = error.message; }
        finally { submit.disabled = false; }
    };
    const field = (tag, label, attrs = {}) => el(tag, { 'aria-label': label, ...attrs });
    function makeRow(device) {
        const row = el('div', { class: 'device-row', 'data-device': device.id });
        const online = el('strong'), last = el('small'), monitor = el('small');
        const name = field('input', '设备名称', { class: 'textbox device-name', maxlength: 80 });
        const type = field('select', '设备画面', { class: 'select' }), board = field('select', '设备分榜', { class: 'select' });
        options(type, types); options(board, boards);
        const scale = field('input', '设备缩放', { type: 'number', min: .6, max: 2, step: .1, class: 'textbox device-scale' });
        async function operate(payload) {
            const result = await action({ id: device.id, ...payload }); await refresh(); return result;
        }
        function edit(patch) { operate({ action: 'edit', ...patch }).catch(showError); }
        const btn = (label, fn) => {
            const b = el('button', { type: 'button', class: 'button', text: label });
            b.onclick = async () => { b.disabled = true; try { await fn(); } catch (e) { showError(e); } finally { b.disabled = false; } };
            return b;
        };
        name.onchange = () => edit({ name: name.value }); type.onchange = () => edit({ type: type.value });
        board.onchange = () => edit({ boardId: board.value || null });
        scale.onchange = () => { if (scale.reportValidity()) edit({ scale: scale.valueAsNumber }); };
        const step = by => { scale.value = Math.min(2, Math.max(.6, Number(scale.value) + by)).toFixed(1); edit({ scale: Number(scale.value) }); };
        const copy = btn('复制启动链接', async () => {
            const { link } = await operate({ action: 'link' });
            const url = new URL(link, location.href).href;
            try { await navigator.clipboard.writeText(url); $('device-status').textContent = '启动链接已复制'; }
            catch { window.prompt('复制启动链接', url); }
        });
        const actions = el('div', { class: 'device-actions' }, btn('识别', () => operate({ action: 'identify' })),
            btn('刷新', () => operate({ action: 'reload' })), copy, btn('重新配对', () => open({ id: device.id, name: name.value })),
            btn('删除', () => confirm('删除大屏「' + name.value + '」？') && operate({ action: 'delete' })));
        row.append(online, last, name, type, board, btn('−', () => step(-.1)), scale, btn('+', () => step(.1)), monitor, actions);
        list.append(row);
        return { row, update(d) {
            online.textContent = d.online ? '在线' : d.paired ? '离线' : '待重新配对'; online.className = d.online ? 'device-online' : '';
            last.textContent = d.lastSeen ? new Date(d.lastSeen).toLocaleString('zh-CN') : '尚未上线';
            for (const [field, value] of [[name, d.name], [type, d.type], [board, d.boardId || ''], [scale, d.scale.toFixed(1)]]) {
                if (document.activeElement !== field) field.value = value;
            }
            board.disabled = !runtime.standingsTypes.includes(type.value);
            copy.disabled = !d.paired;
            const c = d.client;
            monitor.textContent = c ? `${c.screenWidth} × ${c.screenHeight} · ${c.fullscreen ? '全屏' : '窗口'}` : '';
            monitor.title = c ? `视口 ${c.width} × ${c.height} · DPR ${c.dpr} · ${c.version} · ${c.ip} · ${c.ua}` : '';
        } };
    }
    async function refresh() {
        const id = ++refreshId;
        const response = await fetch(endpoint, { cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('设备列表读取失败');
        const { devices } = await response.json();
        if (id !== refreshId) return;
        for (const [key, row] of rows) if (!devices.some(d => d.id === key)) { row.row.remove(); rows.delete(key); }
        for (const d of devices) {
            if (!rows.has(d.id)) rows.set(d.id, makeRow(d));
            rows.get(d.id).update(d);
        }
        list.dataset.count = devices.length;
    }
    const tick = async () => { if (busy) return; busy = true; try { await refresh(); } catch (e) { showError(e); } finally { busy = false; } };
    tick(); setInterval(tick, 3000);
}
