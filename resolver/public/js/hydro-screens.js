// Hydro big-screen administration page: pick a screen in the side menu, then edit its settings and link.
const runtime = JSON.parse(document.getElementById('screens-runtime').textContent);
const $ = (id) => document.getElementById(id);
const message = $('message');
let config = structuredClone(runtime.config);
let linkBase = runtime.linkBase;
let dirty = false;
let savedConfig = structuredClone(config);
let refreshSessions = () => {};

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else node.setAttribute(key, value);
    }
    node.append(...children);
    return node;
}

function select(options, value, onChange) {
    const field = el('select', { class: 'select' });
    for (const [optionValue, label] of options) field.add(new Option(label, optionValue));
    field.value = value;
    field.addEventListener('change', () => { onChange(field.value); changed(); });
    return field;
}

// Settings save themselves a moment after the last change; open screens pick them up on their next poll.
let saveTimer = null;
let saving = null;
function changed() {
    dirty = true;
    $('save-status').textContent = '';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 700);
}

async function save() {
    if (saving) return (await saving) && (!dirty || await save());
    if (!dirty) return true;
    const invalid = [...document.querySelectorAll('#screen-panel input, #screen-panel textarea')].find((field) => !field.checkValidity());
    if (invalid) { $('save-status').textContent = invalid.validationMessage; return false; }
    const sent = structuredClone(config);
    const items = {};
    for (const type of runtime.types) {
        const changes = Object.entries(sent.items[type]).filter(([field, value]) => field !== 'images' && savedConfig.items[type][field] !== value);
        if (changes.length) items[type] = Object.fromEntries(changes);
    }
    const patch = { items, ...sent.locale !== savedConfig.locale ? { locale: sent.locale } : {} };
    message.hidden = true;
    dirty = false;
    $('save-status').textContent = '正在保存…';
    saving = request({ config: JSON.stringify(patch) }).then(({ config: saved }) => {
        for (const [type, fields] of Object.entries(items)) {
            for (const field of Object.keys(fields)) {
                savedConfig.items[type][field] = saved.items[type][field];
                if (config.items[type][field] === sent.items[type][field]) config.items[type][field] = saved.items[type][field];
            }
        }
        if ('locale' in patch) savedConfig.locale = saved.locale;
        $('save-status').textContent = dirty ? '' : '已保存';
        return true;
    }).catch((error) => {
        dirty = true; $('save-status').textContent = ''; showError(error); return false;
    }).finally(() => { saving = null; });
    return (await saving) && (!dirty || await save());
}

const toLocalInput = (iso) => {
    if (!iso) return '';
    const date = new Date(iso);
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};

const linkFor = (type) => new URL(`${linkBase}/${type}${runtime.query || ''}`, location.href).href;
const imageFor = (id) => `${linkBase}/poster/images/${id}`;

function readImage(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result).split(',')[1]);
        reader.onerror = () => reject(new Error('无法读取图片'));
        reader.readAsDataURL(file);
    });
}

let refreshPosters = () => {};
function posterControls(item) {
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp' });
    const list = el('ol', { class: 'screen-posters' });
    const apply = async (body) => {
        message.hidden = true;
        file.disabled = true;
        for (const button of list.querySelectorAll('button')) button.disabled = true;
        try {
            item.images = (await request(body)).images;
        } catch (error) { showError(error); }
        finally { refreshPosters(); }
    };
    // Choosing a file uploads it.
    file.addEventListener('change', async () => {
        const selected = file.files[0];
        if (!selected) return;
        try {
            if (selected.size > 2 * 1024 * 1024) throw new Error('图片不能超过 2 MiB');
            await apply({ operation: 'upload_poster', image: await readImage(selected) });
        } catch (error) { showError(error); } finally { file.value = ''; }
    });
    refreshPosters = () => {
        list.replaceChildren(...item.images.map((id, index) => {
            const remove = el('button', { type: 'button', class: 'button', text: '移除', 'aria-label': `移除图片 ${index + 1}` });
            remove.addEventListener('click', () => apply({ operation: 'remove_poster', imageId: id }));
            return el('li', {}, el('img', { src: imageFor(id), alt: `图片 ${index + 1}`, loading: 'lazy' }), remove);
        }));
        file.disabled = item.images.length >= 20;
    };
    refreshPosters();
    return el('div', { class: 'screen-poster-controls' }, el('label', { text: '添加图片（PNG、JPEG、WebP，≤ 2 MiB，最多 20 张）' }, file), list);
}

function card(type) {
    const item = config.items[type];
    const fields = el('div', { class: 'resolver-fields resolver-two' });
    if (runtime.standingsTypes.includes(type)) {
        const options = runtime.boards.map((board) => [board.id, board.name]);
        if (!runtime.boards.some((board) => board.id === item.boardId)) options.push([item.boardId, `${item.boardId}（已不存在）`]);
        fields.append(el('label', { text: '分榜' }, select(options, item.boardId, (value) => { item.boardId = value; })));
    }
    if (runtime.variants[type]) {
        fields.append(el('label', { text: '样式' }, select(runtime.variants[type], item.variant, (value) => { item.variant = value; })));
    }
    if (type === 'groups') {
        fields.append(el('label', { text: '分组方式' }, select(runtime.groupSources, item.source, (value) => { item.source = value; })));
    }
    if (runtime.intervalTypes.includes(type)) {
        const input = el('input', { class: 'textbox', type: 'number', min: '2', max: '600', step: '1', required: '' });
        input.value = item.interval;
        input.addEventListener('input', () => { item.interval = input.valueAsNumber; changed(); });
        fields.append(el('label', { text: '切换间隔（秒）' }, input));
    }
    if (type === 'countdown') {
        const time = el('input', { class: 'textbox', type: 'datetime-local' });
        time.value = toLocalInput(item.targetTime);
        const update = () => { time.disabled = item.target !== 'custom'; time.required = item.target === 'custom'; };
        time.addEventListener('input', () => { item.targetTime = time.value ? new Date(time.value).toISOString() : null; changed(); });
        fields.append(el('label', { text: '倒计时到' }, select([['end', '比赛结束'], ['start', '比赛开始'], ['custom', '指定时间']], item.target, (value) => {
            item.target = value;
            update();
        })), el('label', { text: '指定时间' }, time));
        update();
    }
    if (type === 'message') {
        const text = el('textarea', { class: 'textbox', maxlength: '2000' });
        text.value = item.text;
        text.addEventListener('input', () => { item.text = text.value; changed(); });
        fields.append(el('label', { text: '公告文字' }, text));
    }
    if (type === 'resolver') {
        const field = select([], item.sessionId, (value) => { item.sessionId = value; });
        const populate = (sessions) => {
            field.replaceChildren(new Option('等待主持人投屏', ''));
            for (const session of sessions) field.add(new Option(
                `${session.board} · ${session.rehearsal ? '彩排' : '正式'} · ${new Date(session.createdAt).toLocaleString('zh-CN')}`, session.id));
            if (item.sessionId && !sessions.some((session) => session.id === item.sessionId)) field.add(new Option('其他管理员的会话或已删除的会话', item.sessionId));
            field.value = item.sessionId;
        };
        let refreshId = 0;
        refreshSessions = async () => {
            const id = ++refreshId;
            const selected = item.sessionId;
            try {
                const data = await request({ operation: 'resolver_sessions' });
                if (id !== refreshId) return;
                if (!saving && item.sessionId === selected && item.sessionId === savedConfig.items.resolver.sessionId) {
                    item.sessionId = savedConfig.items.resolver.sessionId = data.sessionId;
                }
                populate(data.sessions.map((row) => ({ ...row, rehearsal: row.config.rehearsal,
                    board: runtime.boards.find((board) => board.id === row.config.boardId)?.name || row.config.boardId })));
            } catch (error) { showError(error); }
        };
        populate(runtime.sessions);
        fields.append(el('label', { text: '跟随的滚榜会话' }, field));
        addEventListener('focus', () => { if (location.hash === '#screen-resolver') refreshSessions(); });
    }
    const link = el('input', { class: 'textbox', readonly: '', 'aria-label': `${runtime.labels[type]}链接` });
    link.value = linkFor(type);
    link.dataset.type = type;
    const copy = el('button', { class: 'button', type: 'button', text: '复制链接' });
    copy.addEventListener('click', async () => {
        if ((dirty || saving) && !await save()) return;
        try { await navigator.clipboard.writeText(link.value); copy.textContent = '已复制'; } catch { link.select(); copy.textContent = '请手动复制'; }
        setTimeout(() => { copy.textContent = '复制链接'; }, 2000);
    });
    const open = el('a', { class: 'button', target: '_blank', rel: 'noopener', text: '新窗口打开', href: link.value });
    open.dataset.type = type;
    open.addEventListener('click', async (event) => {
        if (!dirty && !saving) return;
        event.preventDefault();
        const tab = window.open('about:blank', '_blank');
        if (tab) tab.opener = null;
        if (await save()) { if (tab) tab.location.replace(linkFor(type)); }
        else tab?.close();
    });
    const preview = el('button', { class: 'button', type: 'button', text: '预览' });
    preview.addEventListener('click', async () => {
        clearTimeout(saveTimer);
        if (!await save()) return;
        $('preview-title').textContent = runtime.labels[type];
        $('screen-preview-frame').src = linkFor(type);
        $('screen-preview').showModal();
    });
    const body = el('div', { class: 'section__body' });
    if (fields.childElementCount) body.append(fields);
    if (type === 'poster') body.append(posterControls(item));
    body.append(el('div', { class: 'screen-link' }, link, copy, preview, open));
    // Not the hash's id: a matching id would make the browser jump to the card on every load.
    return el('section', { class: 'section visible screen-card', id: `screen-card-${type}`, 'data-type': type, hidden: '' },
        el('div', { class: 'section__header' }, el('h2', { class: 'section__title', text: runtime.labels[type] })), body);
}

async function request(body) {
    const response = await fetch(runtime.base, {
        method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok || data.url) throw new Error((typeof data.error === 'string' ? data.error : data.error?.message) || '请求失败，请检查登录状态');
    return data;
}

function showError(error) {
    message.textContent = error.message || String(error);
    message.hidden = false;
}

$('contest-title').textContent = runtime.title;
$('back-link').href = runtime.contestUrl;
$('locale').value = config.locale;
$('locale').addEventListener('change', () => { config.locale = $('locale').value; changed(); });
$('screen-panel').append(...runtime.types.map(card));

// Side menu: one entry per screen; the chosen screen's settings show on the left.
const menuLinks = new Map();
for (const [label, types] of runtime.categories) {
    $('screen-menu').append(el('li', { class: 'screens-menu-category', text: label }));
    for (const type of types) {
        const link = el('a', { class: 'menu__link', href: `#screen-${type}`, text: runtime.labels[type] });
        link.addEventListener('click', (event) => { event.preventDefault(); choose(type, true); });
        $('screen-menu').append(el('li', { class: 'menu__item' }, link));
        menuLinks.set(type, link);
    }
}
function choose(type, focus = false) {
    if (!runtime.types.includes(type)) type = runtime.types[0];
    for (const section of $('screen-panel').children) section.hidden = section.dataset.type !== type;
    for (const [key, link] of menuLinks) {
        link.classList.toggle('active', key === type);
        if (key === type) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
    }
    if (type === 'resolver') refreshSessions();
    if (location.hash !== `#screen-${type}`) history.replaceState(null, '', `#screen-${type}`);
    if (focus && matchMedia('(max-width: 1024px)').matches) $('screen-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    // Keep the chosen entry visible inside the (scrolling) side menu without moving the page.
    const menu = $('screen-menu');
    const active = menuLinks.get(type);
    if (active && menu.scrollHeight > menu.clientHeight) {
        const top = active.offsetTop - menu.offsetTop;
        if (top < menu.scrollTop || top + active.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = Math.max(0, top - menu.clientHeight / 3);
    }
}
if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
choose(location.hash.replace(/^#screen-/, ''));
addEventListener('hashchange', () => choose(location.hash.replace(/^#screen-/, '')));
$('reset-token').addEventListener('click', () => $('reset-confirm').showModal());
$('reset-confirm').addEventListener('close', async () => {
    if ($('reset-confirm').returnValue !== 'confirm') return;
    try {
        linkBase = (await request({ operation: 'reset_token' })).linkBase;
        for (const node of document.querySelectorAll('#screen-panel .screen-link [data-type]')) {
            if (node.tagName === 'INPUT') node.value = linkFor(node.dataset.type);
            else node.href = linkFor(node.dataset.type);
        }
        refreshPosters();
        $('save-status').textContent = '已生成新链接，旧链接已失效';
    } catch (error) { showError(error); }
});
$('screen-preview').addEventListener('close', () => $('screen-preview-frame').removeAttribute('src'));
addEventListener('beforeunload', (event) => { if (dirty || saving) event.preventDefault(); });
