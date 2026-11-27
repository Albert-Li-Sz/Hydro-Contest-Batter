// DOM screens arrive as markup and are shown in a sandbox without scripts, styled by the screen's own sheet.
const screenCss = new URL('../hydro-screen.css', import.meta.url).href;
const srcdoc = (thumb) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${location.origin} 'unsafe-inline'; img-src ${location.origin} data:; font-src ${location.origin}"><link rel="stylesheet" href="${screenCss}"></head><body>${thumb.data}</body></html>`;
const keyLabels = { prev: '←', next: '→', pause: '暂停', fullscreen: '全屏', 'exit-fullscreen': '退出全屏' };
function receipt(ack) {
    const label = keyLabels[ack.key] || ack.key;
    if (!ack.ok) return `${label} 失败：${ack.message}`;
    const page = ack.state?.pages ? ` · 第 ${ack.state.page} / ${ack.state.pages} 页` : '';
    const pause = ack.key === 'pause' ? (ack.state?.paused ? ' · 已暂停' : ' · 已继续') : '';
    return `${label} 已执行${page}${pause}`;
}

export function deviceAdmin(runtime, el, showError) {
    const $ = id => document.getElementById(id);
    let remoteRow = null;
    function thumbView(thumb, width, height = width * 9 / 16) {
        if (thumb.kind === 'image') return el('img', { src: thumb.data, alt: '' });
        const ratio = Math.min(width / thumb.width, height / thumb.height);
        const frame = el('iframe', { sandbox: '', tabindex: '-1', 'aria-hidden': 'true', title: '' });
        frame.srcdoc = srcdoc(thumb);
        Object.assign(frame.style, { width: thumb.width + 'px', height: thumb.height + 'px', transform: `scale(${ratio})` });
        const box = el('span', { class: 'device-thumb-html' });
        Object.assign(box.style, { width: Math.round(thumb.width * ratio) + 'px', height: Math.round(thumb.height * ratio) + 'px' });
        box.append(frame);
        return box;
    }
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
        const preview = el('button', { type: 'button', class: 'device-thumb', 'aria-label': '放大画面' });
        let shown = null, loading = 0;
        preview.onclick = () => {
            if (!shown) return;
            $('device-thumb-title').textContent = name.value;
            const width = Math.min(960, innerWidth - 96);
            $('device-thumb-large').replaceChildren(thumbView(shown, width, Math.min(width * 9 / 16 * 1.4, innerHeight - 160)));
            $('device-thumb-dialog').showModal();
        };
        async function loadThumb(d) {
            if (!d.thumb) { shown = null; preview.replaceChildren(); return; }
            if (shown?.at === d.thumb.at || loading === d.thumb.at) return;
            loading = d.thumb.at;
            try {
                const response = await fetch(`${endpoint}?thumb=${encodeURIComponent(device.id)}`, { cache: 'no-store', headers: { Accept: 'application/json' } });
                const { thumb } = await response.json();
                if (!thumb || thumb.at !== d.thumb.at) return;
                shown = thumb;
                preview.replaceChildren(thumbView(thumb, 176, 99));
            } finally { if (loading === d.thumb.at) loading = 0; }
        }
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
        const minus = btn('−', () => step(-.1)), plus = btn('+', () => step(.1));
        // Remote keys: buttons, or the keyboard while this row's remote is on. Receipts come back from the screen.
        let sent = null;
        const answer = el('span', { class: 'device-receipt', role: 'status' });
        async function press(key) {
            const { command } = await action({ id: device.id, action: 'key', key });
            sent = { ...command, label: keyLabels[key] };
            answer.textContent = `${sent.label} 等待执行`;
        }
        const pad = el('div', { class: 'device-remote', hidden: true },
            ...Object.entries(keyLabels).map(([key, label]) => btn(label, () => press(key))), answer);
        const remote = el('button', { type: 'button', class: 'button', text: '遥控', 'aria-pressed': 'false' });
        const api = {};
        api.remote = (on) => {
            remote.setAttribute('aria-pressed', String(on)); pad.hidden = !on; row.classList.toggle('device-remote-on', on);
        };
        api.press = (key) => press(key).catch(showError);
        api.operate = (payload) => operate(payload).catch(showError);
        remote.onclick = () => {
            const on = remoteRow !== api;
            remoteRow?.remote(false);
            remoteRow = on ? api : null;
            api.remote(on);
        };
        actions.prepend(remote);
        const status = el('div', { class: 'device-status' }, online, last, monitor);
        const controls = el('div', { class: 'device-controls' }, name, type, board, minus, scale, plus);
        row.append(preview, el('div', { class: 'device-main' }, status, controls, actions, pad));
        list.append(row);
        return Object.assign(api, { row, update(d) {
            void loadThumb(d).catch(() => {});
            if (sent) {
                if (d.ack?.id === sent.id) { answer.textContent = receipt(d.ack); sent = null; }
                else if (Date.now() - sent.at > 10000) { answer.textContent = `${sent.label} 大屏未响应`; sent = null; }
            }
            remote.disabled = !d.paired;
            online.textContent = d.online ? '在线' : d.paired ? '离线' : '待重新配对'; online.className = d.online ? 'device-online' : '';
            last.textContent = d.lastSeen ? new Date(d.lastSeen).toLocaleString('zh-CN') : '尚未上线';
            for (const [field, value] of [[name, d.name], [type, d.type], [board, d.boardId || ''], [scale, d.scale.toFixed(1)]]) {
                if (document.activeElement !== field) field.value = value;
            }
            board.disabled = !runtime.standingsTypes.includes(type.value);
            const fixed = !runtime.scalableTypes.includes(type.value);
            for (const control of [scale, minus, plus]) control.disabled = fixed;
            copy.disabled = !d.paired;
            const c = d.client;
            monitor.textContent = c ? `${c.screenWidth} × ${c.screenHeight} · ${c.fullscreen ? '全屏' : '窗口'}` : '';
            monitor.title = c ? `视口 ${c.width} × ${c.height} · DPR ${c.dpr} · ${c.version} · ${c.ip} · ${c.ua}` : '';
        } });
    }
    async function refresh() {
        const id = ++refreshId;
        const response = await fetch(endpoint, { cache: 'no-store', headers: { Accept: 'application/json' } });
        if (!response.ok) throw new Error('设备列表读取失败');
        const { devices } = await response.json();
        if (id !== refreshId) return;
        for (const [key, row] of rows) if (!devices.some(d => d.id === key)) { if (remoteRow === row) remoteRow = null; row.row.remove(); rows.delete(key); }
        for (const d of devices) {
            if (!rows.has(d.id)) rows.set(d.id, makeRow(d));
            rows.get(d.id).update(d);
        }
        list.dataset.count = devices.length;
    }
    const tick = async () => { if (busy) return; busy = true; try { await refresh(); } catch (e) { showError(e); } finally { busy = false; } };
    tick(); setInterval(tick, 3000);
    const keys = { ArrowLeft: 'prev', ArrowRight: 'next', ' ': 'pause', f: 'fullscreen', F: 'fullscreen', Escape: 'exit-fullscreen' };
    document.addEventListener('keydown', (event) => {
        if (!remoteRow || event.ctrlKey || event.metaKey || event.altKey || event.repeat || document.querySelector('dialog[open]')) return;
        if (event.target.closest?.('input, select, textarea, [contenteditable=true]')) return;
        const key = event.key;
        if (keys[key]) remoteRow.press(keys[key]);
        else if (key === 'r' || key === 'R') remoteRow.operate({ action: 'reload' });
        else if (key === 'i' || key === 'I') remoteRow.operate({ action: 'identify' });
        else return;
        event.preventDefault();
    });
}
