// 证书: the results snapshot certificates are issued from, the sheet of names they print, their layout, and
// issuing and handing them out. Certificates keep the values they were issued with; issuing again replaces only
// those whose values changed.
import { awardEnglish, certificateFrame, fieldInk, logoBox } from './certificate-frame.js';
import { $, el, formatTime, get, notify, openDialog, post, runtime } from './hydro-manage-common.js';

const root = $('manage-root');
const status = el('p', { class: 'resolver-muted', role: 'status', hidden: true });
const kindOrder = ['team', 'member', 'coach', 'participation'];
const statusNames = { valid: ['有效', 'manage-tag--ok'], corrected: ['已更正', 'manage-tag--warn'], revoked: ['已撤销', 'manage-tag--bad'] };
const stateNames = { new: ['新证书', ''], same: ['已出证', 'manage-tag--ok'], changed: ['将更正', 'manage-tag--warn'] };
let data = null;
let editing = 'award';
let selectedField = null;
let draft = null;
let sampleKind = 'member';
let issuedFilter = 'valid';

async function load() {
    try {
        data = await get();
        draft = structuredClone(data.config.templates);
        render();
    } catch (error) { notify(status, error.message, true); }
}

async function run(operation, payload, message) {
    try {
        const result = await post(operation, payload);
        notify(status, typeof message === 'function' ? message(result) : message);
        await load();
        return result;
    } catch (error) { notify(status, error.message, true); return null; }
}

const group = (title, ...children) => el('section', { class: 'manage-group' }, el('h3', { text: title }), ...children);
const field = (label, input) => el('label', { class: 'resolver-field' }, el('span', { text: label }), input);
const tag = (text, tone = '') => el('span', { class: `manage-tag ${tone}`, text });
const option = (value, text, selected) => new Option(text, value, false, selected);
const link = (text, href, attrs = {}) => el('a', { class: 'button', href, ...attrs, text });
const fileUrl = (format, params = {}) => `${runtime.fileUrl}/${format}?${new URLSearchParams(Object.entries(params).filter(([, value]) => value))}`;

function sourceGroup() {
    const { config, preview } = data;
    const source = el('select', { class: 'select', 'aria-label': '成绩快照' },
        option('', '选择成绩快照', !config.source), ...data.snapshots.map((snapshot) => option(snapshot.id, snapshot.name, snapshot.id === config.source)));
    const board = el('select', { class: 'select', 'aria-label': '榜单' },
        ...(preview?.boards || [{ id: 'all', name: '所有队伍' }]).map((item) => option(item.id, item.name, item.id === config.board)));
    const kinds = el('div', { class: 'certificate-kinds' }, ...kindOrder.map((kind) => {
        const box = el('input', { type: 'checkbox', checked: config.kinds[kind], 'data-kind': kind });
        return el('label', { class: 'checkbox' }, box, el('span', { text: runtime.kindNames[kind] }));
    }));
    const skipped = new Set(config.skipAwards);
    const awards = el('div', { class: 'certificate-kinds' }, ...(preview?.awards || []).map((award) => {
        const box = el('input', { type: 'checkbox', checked: !skipped.has(award.id), 'data-award': award.id });
        return el('label', { class: 'checkbox' }, box, el('span', { text: `${award.name}（${award.teams} 队）` }));
    }));
    const text = (key, label) => field(label, el('input', { class: 'textbox', type: 'text', value: config[key], 'data-key': key, 'aria-label': label }));
    const names = el('div', { class: 'resolver-fields' }, text('contest', '比赛名称'), text('contestEn', '比赛英文名'), text('issuer', '颁发单位'), text('date', '颁发日期'));
    const save = el('button', { class: 'button primary', type: 'button', text: '保存', onclick: () => {
        const payload = {
            source: source.value, board: board.value,
            kinds: Object.fromEntries([...kinds.querySelectorAll('input')].map((box) => [box.dataset.kind, box.checked])),
            skipAwards: [...awards.querySelectorAll('input')].filter((box) => !box.checked).map((box) => box.dataset.award),
            ...Object.fromEntries([...names.querySelectorAll('input')].map((input) => [input.dataset.key, input.value])),
        };
        run('config', payload, '已保存出证设置');
    } });
    const snapshot = el('button', { class: 'button', type: 'button', text: '保存当前成绩为快照并选用', onclick: () => {
        const label = el('input', { class: 'textbox', type: 'text', value: '出证', maxlength: 80, 'aria-label': '快照名称' });
        openDialog({
            title: '保存当前成绩为快照', confirm: '保存并选用',
            body: [el('p', { text: '证书将从这份快照出具，之后的重测或改动不会进入已出的证书。' }), field('快照名称', label)],
            submit: async () => { await run('snapshot', { label: label.value }, '已保存快照并选为出证依据'); },
        });
    } });
    return group('出证依据',
        el('div', { class: 'manage-toolbar' }, source, board, snapshot),
        data.error ? el('p', { class: 'manage-error', text: data.error }) : null,
        preview && !preview.final ? el('p', { class: 'manage-error', text: '这份快照不是最终成绩：评测未完成或仍在封榜中，不能出证。' }) : null,
        el('h4', { text: '证书种类' }), kinds,
        preview?.awards?.length ? el('h4', { text: '出证的奖项' }) : null, awards,
        names, el('div', { class: 'resolver-actions' }, save));
}

function personList(people) {
    return people.map((person) => (person.nameEn ? `${person.name}（${person.nameEn}）` : person.name)).join('、') || '—';
}

function editTeam(team) {
    const input = (label, value, name) => field(label, el('input', { class: 'textbox', type: 'text', value: value || '', name, 'aria-label': label }));
    const peopleInputs = (list, role) => list.map((person, index) => el('div', { class: 'certificate-row' },
        input(`${role} ${index + 1}`, person.name, `${role}-${index}-name`), input(`${role} ${index + 1} 英文名`, person.nameEn, `${role}-${index}-nameEn`)));
    const form = el('div', { class: 'certificate-props' },
        el('div', { class: 'certificate-row' }, input('队伍', team.team, 'team'), input('队伍英文名', team.teamEn, 'teamEn')),
        el('div', { class: 'certificate-row' }, input('学校', team.school, 'school'), input('学校英文名', team.schoolEn, 'schoolEn')),
        ...peopleInputs(team.members, '队员'), ...peopleInputs(team.coaches, '教练'));
    openDialog({
        title: `${team.team} · 制证信息`, confirm: '保存', body: [form],
        submit: async () => {
            const value = (name) => form.querySelector(`[name="${name}"]`)?.value.trim() || '';
            const people = (list, role) => list.map((_, index) => ({ name: value(`${role}-${index}-name`), nameEn: value(`${role}-${index}-nameEn`) }));
            const result = await post('team', { teamId: team.teamId, override: {
                team: value('team'), teamEn: value('teamEn'), school: value('school'), schoolEn: value('schoolEn'),
                members: people(team.members, '队员'), coaches: people(team.coaches, '教练'),
            } });
            if (result) { notify(status, '已保存'); await load(); }
        },
    });
}

function sheetGroup() {
    const { preview, config } = data;
    if (!preview) return group('制证信息表', el('p', { class: 'resolver-muted', text: '选择成绩快照后显示参赛队伍。' }));
    const missing = new Map();
    for (const entry of preview.entries) {
        if (!entry.missing.length) continue;
        const set = missing.get(entry.teamId) || new Set();
        for (const name of entry.missing) set.add(runtime.placeholders[name] || name);
        missing.set(entry.teamId, set);
    }
    const upload = el('input', { type: 'file', accept: '.csv,text/csv', hidden: true, onchange: async () => {
        const file = upload.files[0];
        if (!file) return;
        const result = await run('upload', { csv: await file.text() }, (value) => `已读取 ${value.updated} 行${value.unknown.length ? `，${value.unknown.length} 个队伍 ID 不在名单中：${value.unknown.slice(0, 5).join('、')}` : ''}`);
        upload.value = '';
        return result;
    } });
    const lock = el('button', { class: `button${config.locked ? '' : ' primary'}`, type: 'button', text: config.locked ? '解除锁定' : '核对完毕，锁定信息表',
        onclick: () => run('config', { locked: !config.locked }, config.locked ? '已解除锁定' : '信息表已锁定，可以出证') });
    const rows = preview.sheet.map((team) => el('tr', {},
        el('td', {}, team.team, team.official ? null : el('span', { class: 'manage-small manage-dim', text: ' 打星' }),
            team.teamEn ? el('div', { class: 'manage-small manage-dim', text: team.teamEn }) : null),
        el('td', {}, team.school || '—', team.schoolEn ? el('div', { class: 'manage-small manage-dim', text: team.schoolEn }) : null),
        el('td', { text: personList(team.members) }),
        el('td', { text: personList(team.coaches) }),
        el('td', {}, ...[...(missing.get(team.teamId) || [])].map((name) => tag(`缺${name}`, 'manage-tag--warn'))),
        el('td', { class: 'col-actions' }, el('button', { class: 'button', type: 'button', text: '编辑', disabled: config.locked, onclick: () => editTeam(team) }))));
    return group('制证信息表',
        el('div', { class: 'manage-toolbar' },
            link('下载信息表', fileUrl('sheet')),
            el('button', { class: 'button', type: 'button', text: '上传信息表', disabled: config.locked, onclick: () => upload.click() }), upload,
            el('span', { class: 'manage-spacer' }),
            config.locked ? tag('已锁定', 'manage-tag--ok') : null, lock),
        el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' },
            el('thead', {}, el('tr', {}, ...['队伍', '学校', '队员', '教练', '缺失字段', ''].map((text) => el('th', { text })))),
            el('tbody', {}, ...rows))));
}

// ------------------------------------------------------------------ template editor

const pageOf = (template) => (template.orientation === 'portrait' ? { width: 210, height: 297 } : { width: 297, height: 210 });
const PT_MM = 25.4 / 72;

function fillText(text, values) {
    let used = 0; let filled = 0;
    const result = text.replace(/\{([a-zA-Z]+)\}/g, (match, name) => {
        if (!Object.hasOwn(runtime.placeholders, name)) return match;
        used++;
        const value = name === 'awardEn' ? awardEnglish(values.award) : values[name] || '';
        if (value) filled++;
        return value;
    });
    return used && !filled ? '' : result.trim();
}

function sampleValues(kind) {
    const real = data.preview?.samples?.[kind];
    const values = real ? { ...real } : Object.fromEntries(Object.entries(runtime.placeholders).map(([key, label]) => [key, `〔${label}〕`]));
    values.number = 'SAMPLE0000';
    return values;
}

const frames = new Map();
function frameSvg(page) {
    if (!frames.has(page.width)) {
        const ns = 'http://www.w3.org/2000/svg';
        const svg = document.createElementNS(ns, 'svg');
        svg.setAttribute('viewBox', `0 0 ${page.width} ${page.height}`);
        svg.setAttribute('class', 'certificate-frame');
        svg.setAttribute('aria-hidden', 'true');
        for (const shape of certificateFrame(page.width, page.height)) {
            const path = document.createElementNS(ns, 'path');
            path.setAttribute('d', shape.commands.map((command) => command.join(' ')).join(' '));
            path.setAttribute('fill', shape.fill || 'none');
            path.setAttribute('stroke', shape.stroke || 'none');
            path.setAttribute('stroke-width', shape.weight);
            svg.append(path);
        }
        frames.set(page.width, svg);
    }
    return frames.get(page.width).cloneNode(true);
}
const logoSrc = (logo) => `${runtime.assetUrl}/${logo.id}?v=${logo.revision}`;
let schoolNames;
async function logoCatalog() {
    if (!schoolNames) {
        const response = await fetch('/hydro-resolver/logos/index.json');
        if (!response.ok) throw new Error('校徽库暂时无法读取');
        schoolNames = (await response.json()).names;
    }
    return schoolNames;
}

async function imageData(blob) {
    if (blob.size > 6 * 1024 * 1024) throw new Error('图片最大 6 MB');
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

async function logoPng(blob) {
    const bitmap = await createImageBitmap(blob);
    try {
        if (bitmap.width * bitmap.height > 40_000_000) throw new Error('校徽图片尺寸过大');
        const scale = Math.min(1, 1400 / Math.max(bitmap.width, bitmap.height));
        const canvas = el('canvas', { width: Math.max(1, Math.round(bitmap.width * scale)), height: Math.max(1, Math.round(bitmap.height * scale)) });
        canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        return await new Promise((resolve, reject) => canvas.toBlob((png) => png ? resolve(png) : reject(new Error('无法读取校徽图片')), 'image/png'));
    } finally { bitmap.close(); }
}

const savingLogos = new Set();
function logoSlot(slot) {
    const side = slot === 0 ? '左侧校徽' : '右侧校徽';
    const logo = data.logos.find((item) => item.slot === slot);
    const id = `certificate-logo-slot-${slot}`;
    const container = el('fieldset', { id, class: 'certificate-logo-slot', disabled: savingLogos.has(slot), 'aria-label': side });
    async function save(blob, label) {
        if (savingLogos.has(slot)) throw new Error(`${side}正在保存`);
        if (blob && blob.size > 6 * 1024 * 1024) throw new Error('校徽图片最大 6 MB');
        savingLogos.add(slot);
        container.disabled = true;
        try {
            const encoded = blob ? await imageData(await logoPng(blob)) : null;
            const result = await post('logo', { slot, label, data: encoded });
            data.logos = data.logos.filter((item) => item.slot !== slot);
            if (result.id) data.logos.push(result);
            renderStage();
            notify(status, `${side}已${result.id ? '保存' : '移除'}`);
        } finally {
            savingLogos.delete(slot);
            $(id)?.replaceWith(logoSlot(slot));
        }
    }
    const upload = el('input', { type: 'file', accept: 'image/png,image/jpeg', hidden: true, 'aria-label': `${side}文件`, onchange: async () => {
        const file = upload.files[0];
        if (!file) return;
        try { await save(file, file.name); } catch (error) { notify(status, error.message, true); }
        upload.value = '';
    } });
    const choose = el('button', { type: 'button', class: 'button', text: '选学校', 'aria-label': `${side}选择学校`, onclick: async () => {
        try {
            const names = await logoCatalog();
            const listId = `certificate-schools-${slot}`;
            const list = el('datalist', { id: listId });
            const input = el('input', { class: 'textbox', type: 'text', list: listId, autocomplete: 'off', 'aria-label': '学校名称' });
            const update = () => {
                const query = input.value.trim().toLowerCase();
                list.replaceChildren(...Object.keys(names).filter((name) => query && name.includes(query)).slice(0, 35).map((value) => el('option', { value })));
            };
            input.addEventListener('input', update);
            openDialog({ title: `${side} · 选择学校`, confirm: '使用校徽', body: [field('输入学校中文或英文名', input), list], submit: async () => {
                const label = input.value.trim();
                const id = names[label.toLowerCase()];
                if (typeof id !== 'string' || !/^[a-f0-9]{12}$/.test(id)) throw new Error('请从校徽库选择学校，或上传学校的校徽图片');
                const res = await fetch(`/hydro-resolver/logos/${id}.webp`);
                if (!res.ok) throw new Error('无法读取这所学校的校徽');
                await save(await res.blob(), label);
            } });
            input.focus();
        } catch (error) { notify(status, error.message, true); }
    } });
    container.append(el('div', { class: 'certificate-logo-name' }, logo ? el('img', { src: logoSrc(logo), alt: '' }) : null,
        el('strong', { text: side }), logo ? el('span', { text: logo.label }) : null),
        el('div', { class: 'certificate-logo-actions' }, choose, el('button', { type: 'button', class: 'button', text: '上传图片', 'aria-label': `${side}上传图片`, onclick: () => upload.click() }),
            upload, logo ? el('button', { type: 'button', class: 'button', text: '移除', 'aria-label': `移除${side}`, onclick: async () => {
                try { await save(null, ''); } catch (error) { notify(status, error.message, true); }
            } }) : null));
    return container;
}

let stageObserver;
function stage(template, kind) {
    const page = pageOf(template);
    const box = el('div', { class: `certificate-stage is-${template.font}`, style: `aspect-ratio: ${page.width} / ${page.height}` });
    if (template.background) box.append(el('img', { class: 'certificate-background', src: `${runtime.assetUrl}/${template.background}`, alt: '' }));
    else if (template.frame === 'engraved') box.append(frameSvg(page));
    else box.append(el('div', { class: 'certificate-border' }));
    for (const logo of data.logos) {
        const area = logoBox(page.width, logo.slot);
        const position = `left:${100 * area.x / page.width}%;top:${100 * area.y / page.height}%;width:${100 * area.width / page.width}%;height:${100 * area.height / page.height}%`;
        box.append(el('img', { class: 'certificate-school-logo', src: logoSrc(logo), alt: logo.label, style: position, draggable: 'false' }));
    }
    const values = sampleValues(kind);
    const nodes = new Map();
    const place = () => {
        const scale = box.clientWidth / page.width;
        if (!scale) return;
        for (const item of template.fields) {
            const node = nodes.get(item.id);
            if (!node) continue;
            node.style.left = `${item.x * scale}px`;
            node.style.top = `${item.y * scale}px`;
            if (item.type === 'qr') {
                node.style.width = node.style.height = `${item.size * scale}px`;
                node.style.transform = 'translate(-50%, -50%)';
            } else {
                node.style.fontSize = `${item.size * PT_MM * scale}px`;
                const limit = item.width * scale;
                if (limit && node.scrollWidth > limit) node.style.fontSize = `${Math.max(4, item.size * limit / node.scrollWidth) * PT_MM * scale}px`;
                node.style.color = fieldInk(item, values.award);
                node.style.transform = `translate(${item.align === 'center' ? '-50%' : item.align === 'right' ? '-100%' : '0'}, -50%)`;
            }
        }
    };
    for (const item of template.fields) {
        const shown = !item.kinds.length || item.kinds.includes(kind);
        if (!shown) continue;
        const content = item.type === 'qr' ? '' : fillText(item.text, values);
        if (!content && item.type === 'text' && selectedField !== item.id) continue;
        const node = el('div', { class: `certificate-field${item.type === 'qr' ? ' is-qr' : ''}${shown ? '' : ' is-hidden'}${selectedField === item.id ? ' is-selected' : ''}`,
            text: content, title: item.text || '二维码', 'data-id': item.id });
        node.addEventListener('pointerdown', (event) => {
            event.preventDefault();
            selectedField = item.id;
            for (const other of box.querySelectorAll('.certificate-field')) other.classList.toggle('is-selected', other === node);
            renderProps();
            const scale = box.clientWidth / page.width;
            const start = { x: event.clientX, y: event.clientY, fx: item.x, fy: item.y };
            node.setPointerCapture(event.pointerId);
            const move = (moved) => {
                item.x = Math.min(page.width, Math.max(0, Math.round((start.fx + (moved.clientX - start.x) / scale) * 2) / 2));
                item.y = Math.min(page.height, Math.max(0, Math.round((start.fy + (moved.clientY - start.y) / scale) * 2) / 2));
                place();
                renderProps();
            };
            const up = () => { node.removeEventListener('pointermove', move); node.removeEventListener('pointerup', up); };
            node.addEventListener('pointermove', move);
            node.addEventListener('pointerup', up);
        });
        nodes.set(item.id, node);
        box.append(node);
    }
    stageObserver?.disconnect();
    stageObserver = new ResizeObserver(place);
    stageObserver.observe(box);
    requestAnimationFrame(place);
    return box;
}

let propsHost = null;
let stageHost = null;

function renderStage() {
    if (!stageHost) return;
    stageHost.replaceChildren(stage(draft[editing], editing === 'participation' ? 'participation' : sampleKind));
}

function renderProps() {
    if (!propsHost) return;
    const template = draft[editing];
    const item = template.fields.find((candidate) => candidate.id === selectedField);
    const list = el('ul', { class: 'certificate-fields-list' }, ...template.fields.map((candidate) => el('li', {}, el('button', {
        type: 'button', 'aria-current': candidate.id === selectedField ? 'true' : 'false', text: candidate.type === 'qr' ? '二维码' : candidate.text || '（空）',
        onclick: () => { selectedField = candidate.id; renderStage(); renderProps(); },
    }))));
    if (!item) { propsHost.replaceChildren(list); return; }
    const update = (changes, redraw = true) => { Object.assign(item, changes); if (redraw) renderStage(); };
    const num = (label, key, min, max, step = 0.5) => field(label, el('input', { class: 'textbox', type: 'number', min, max, step, value: item[key], 'aria-label': label,
        onchange: (event) => { if (event.target.checkValidity()) update({ [key]: Number(event.target.value) }); } }));
    const content = el('textarea', { class: 'textbox', rows: 2, 'aria-label': '内容', oninput: (event) => update({ text: event.target.value }) });
    content.value = item.text;
    const chips = el('div', { class: 'certificate-chips' }, ...Object.entries(runtime.placeholders).map(([key, label]) => el('button', { type: 'button', text: label, onclick: () => {
        const at = content.selectionStart ?? content.value.length;
        content.value = `${content.value.slice(0, at)}{${key}}${content.value.slice(content.selectionEnd ?? at)}`;
        update({ text: content.value });
        content.focus();
    } })));
    const align = el('select', { class: 'select', 'aria-label': '对齐', onchange: (event) => update({ align: event.target.value }) },
        option('left', '左对齐', item.align === 'left'), option('center', '居中', item.align === 'center'), option('right', '右对齐', item.align === 'right'));
    const autoColor = el('input', { type: 'checkbox', checked: item.medalColor, onchange: (event) => update({ medalColor: event.target.checked }) });
    const color = el('input', { type: 'color', value: item.color, 'aria-label': '颜色', oninput: (event) => {
        autoColor.checked = false; update({ color: event.target.value, medalColor: false });
    } });
    const kinds = el('div', { class: 'certificate-kinds' }, ...kindOrder.filter((kind) => (editing === 'participation') === (kind === 'participation')).map((kind) => {
        const box = el('input', { type: 'checkbox', checked: !item.kinds.length || item.kinds.includes(kind), onchange: () => {
            const chosen = [...kinds.querySelectorAll('input')].filter((input) => input.checked).map((input) => input.dataset.kind);
            update({ kinds: chosen.length === kinds.querySelectorAll('input').length ? [] : chosen });
        } });
        box.dataset.kind = kind;
        return el('label', { class: 'checkbox' }, box, el('span', { text: runtime.kindNames[kind] }));
    }));
    const remove = el('button', { class: 'button', type: 'button', text: '删除字段', onclick: () => {
        template.fields = template.fields.filter((candidate) => candidate !== item);
        selectedField = null; renderStage(); renderProps();
    } });
    propsHost.replaceChildren(list, el('div', { class: 'certificate-props' },
        item.type === 'qr' ? null : field('内容', content), item.type === 'qr' ? null : chips,
        el('div', { class: 'certificate-row' }, num('横向（mm）', 'x', 0, pageOf(template).width), num('纵向（mm）', 'y', 0, pageOf(template).height)),
        el('div', { class: 'certificate-row' }, item.type === 'qr' ? num('边长（mm）', 'size', 4, 80) : num('字号（pt）', 'size', 4, 120, 1),
            item.type === 'qr' ? null : num('最大宽度（mm）', 'width', 0, pageOf(template).width)),
        item.type === 'qr' ? null : el('div', { class: 'certificate-row' }, field('对齐', align), field('颜色', color)),
        item.type === 'text' && /\{award(?:En)?\}/.test(item.text) ? el('label', { class: 'checkbox' }, autoColor, '按金银铜奖着色') : null,
        editing === 'participation' ? null : field('印在', kinds), remove));
}

function templateGroup() {
    const template = draft[editing];
    const tabs = el('div', { class: 'manage-tabs', role: 'tablist' }, ...[['award', '获奖证书'], ['participation', '参赛证明']].map(([id, text]) => el('button', {
        type: 'button', role: 'tab', 'aria-selected': editing === id ? 'true' : 'false', text,
        onclick: () => { editing = id; selectedField = null; render(); },
    })));
    const orientation = el('select', { class: 'select', 'aria-label': '方向', onchange: (event) => {
        const before = pageOf(template);
        const prev = data.recommended[template.orientation][editing];
        template.orientation = event.target.value;
        const after = pageOf(template);
        const next = data.recommended[template.orientation][editing];
        for (const item of template.fields) {
            const oldField = template.frame === 'engraved' && prev.fields.find((f) => f.id === item.id);
            const newField = oldField && next.fields.find((f) => f.id === item.id);
            for (const key of ['x', 'y', 'width', 'size']) {
                if (newField && item[key] === oldField[key]) item[key] = newField[key];
                else if (key !== 'size') {
                    const dim = key === 'y' ? 'height' : 'width';
                    item[key] = Math.min(after[dim], Math.round(item[key] / before[dim] * after[dim] * 2) / 2);
                }
            }
        }
        renderStage(); renderProps();
    } }, option('landscape', '横向 A4', template.orientation === 'landscape'), option('portrait', '纵向 A4', template.orientation === 'portrait'));
    const font = el('select', { class: 'select', 'aria-label': '字体', onchange: (event) => { template.font = event.target.value; renderStage(); } },
        option('serif', '宋体 / Times', template.font === 'serif'), option('sans', '黑体 / Helvetica', template.font === 'sans'));
    const sample = editing === 'participation' ? null : el('select', { class: 'select', 'aria-label': '示例', onchange: (event) => { sampleKind = event.target.value; renderStage(); } },
        ...['member', 'team', 'coach'].map((kind) => option(kind, runtime.kindNames[kind], sampleKind === kind)));
    const upload = el('input', { type: 'file', accept: 'image/png,image/jpeg', hidden: true, onchange: async () => {
        const file = upload.files[0];
        if (!file) return;
        const which = editing;
        try {
            const result = await post('background', { template: which, data: await imageData(file) });
            draft[which].background = result.id;
            render(); notify(status, '已换上背景图片');
        } catch (error) { notify(status, error.message, true); }
        upload.value = '';
    } });
    const add = (type) => {
        const page = pageOf(template);
        const id = `f-${Math.random().toString(36).slice(2, 8)}`;
        template.fields.push({ id, type, text: type === 'qr' ? '' : '{name}', x: page.width / 2, y: page.height / 2, size: type === 'qr' ? 24 : 16,
            align: 'center', width: type === 'qr' ? 24 : 200, color: '#2b2118', kinds: [] });
        selectedField = id; renderStage(); renderProps();
    };
    const save = el('button', { class: 'button primary', type: 'button', text: '保存模板', onclick: async () => {
        const templates = structuredClone(draft);
        const result = await run('config', { templates }, '模板已保存');
        if (!result) draft = templates;
    } });
    stageHost = el('div');
    propsHost = el('div');
    const view = el('div', { class: 'certificate-columns' }, stageHost, propsHost);
    renderStage(); renderProps();
    const useDesign = el('button', { type: 'button', class: 'button', text: '套用竞赛版式', onclick: () => {
        draft[editing] = structuredClone(data.recommended[template.orientation][editing]);
        selectedField = null; render(); notify(status, '已套用竞赛版式，保存模板后生效');
    } });
    return group('模板', el('fieldset', { class: 'certificate-logos' }, el('legend', { text: '学校校徽（全场共用，最多两个）' }), logoSlot(0), logoSlot(1)), tabs,
        el('div', { class: 'manage-toolbar' }, orientation, font, sample, useDesign,
            el('button', { class: 'button', type: 'button', text: template.background ? '更换背景' : '上传背景', onclick: () => upload.click() }), upload,
            template.background ? el('button', { class: 'button', type: 'button', text: '去掉背景', onclick: async () => {
                const which = editing;
                try { await post('background', { template: which, data: null }); draft[which].background = null; render(); notify(status, '已去掉背景图片'); }
                catch (error) { notify(status, error.message, true); }
            } }) : null,
            el('button', { class: 'button', type: 'button', text: '＋ 文字', onclick: () => add('text') }),
            template.fields.some((item) => item.type === 'qr') ? null : el('button', { class: 'button', type: 'button', text: '＋ 二维码', onclick: () => add('qr') }),
            el('span', { class: 'manage-spacer' }),
            link('样张 PDF', fileUrl('sample', { template: editing, kind: editing === 'participation' ? '' : sampleKind }), { target: '_blank', rel: 'noopener' }), save),
        view);
}

function issueGroup() {
    const { preview, config } = data;
    const counts = { new: 0, same: 0, changed: 0 };
    let missing = 0;
    for (const entry of preview?.entries || []) { counts[entry.state]++; if (entry.missing.length) missing++; }
    const valid = data.issued.filter((item) => item.status === 'valid');
    const schools = [...new Set(valid.map((item) => item.school).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    const school = el('select', { class: 'select', 'aria-label': '学校' }, option('', '全部学校', true), ...schools.map((name) => option(name, name, false)));
    const zip = link('下载 ZIP', fileUrl('zip'));
    const pdf = link('合并 PDF', fileUrl('pdf'), { target: '_blank', rel: 'noopener' });
    school.addEventListener('change', () => { zip.href = fileUrl('zip', { school: school.value }); pdf.href = fileUrl('pdf', { school: school.value }); });
    const ready = preview && preview.final && config.locked;
    const issue = el('button', { class: 'button primary', type: 'button', text: '出证', disabled: !ready, onclick: () => openDialog({
        title: '出证', confirm: '出证',
        body: [el('p', { text: `新出 ${counts.new} 张，更正 ${counts.changed} 张，撤销 ${preview.stale} 张，${counts.same} 张不变。` }),
            missing ? el('p', { class: 'manage-error', text: `${missing} 张证书有缺失字段，对应的行会留空。` }) : null],
        submit: async () => { await run('issue', {}, (result) => `新出 ${result.created} 张，更正 ${result.corrected} 张，撤销 ${result.revoked} 张，${result.unchanged} 张不变`); },
    }) });
    const filters = el('div', { class: 'manage-tabs', role: 'tablist' }, ...[['valid', '有效'], ['corrected', '已更正'], ['revoked', '已撤销'], ['all', '全部']].map(([id, text]) => el('button', {
        type: 'button', role: 'tab', 'aria-selected': issuedFilter === id ? 'true' : 'false',
        text: `${text} ${id === 'all' ? data.issued.length : data.issued.filter((item) => item.status === id).length}`, onclick: () => { issuedFilter = id; render(); },
    })));
    const shown = data.issued.filter((item) => issuedFilter === 'all' || item.status === issuedFilter);
    const table = shown.length ? el('div', { class: 'manage-scroll' }, el('table', { class: 'data-table' },
        el('thead', {}, el('tr', {}, ...['编号', '证书', '获奖者', '学校', '奖项', '状态', ''].map((text) => el('th', { text })))),
        el('tbody', {}, ...shown.slice(0, 500).map((item) => el('tr', {},
            el('td', { class: 'manage-nowrap' }, el('a', { href: `${runtime.verifyBase}${item.code}`, target: '_blank', rel: 'noopener', text: item.code })),
            el('td', { text: runtime.kindNames[item.kind] }),
            el('td', { text: item.name }),
            el('td', { text: item.school || '—' }),
            el('td', { text: item.award || '—' }),
            el('td', {}, tag(...statusNames[item.status]), item.replacedBy ? el('span', { class: 'manage-small manage-dim', text: ` → ${item.replacedBy}` }) : null,
                el('div', { class: 'manage-small manage-dim', text: `第 ${item.version} 版 · ${formatTime(item.changedAt || item.issuedAt)}` })),
            el('td', { class: 'col-actions' }, el('a', { class: 'button', href: fileUrl('pdf', { code: item.code }), target: '_blank', rel: 'noopener', text: 'PDF' })))))))
        : el('p', { class: 'manage-empty', text: '没有证书。' });
    return group('出证与发放',
        preview ? el('p', {}, ...Object.entries(counts).map(([state, count]) => tag(`${stateNames[state][0]} ${count}`, stateNames[state][1])),
            preview.stale ? tag(`将撤销 ${preview.stale}`, 'manage-tag--bad') : null, missing ? tag(`有缺失字段 ${missing}`, 'manage-tag--warn') : null) : null,
        el('div', { class: 'manage-toolbar' }, issue, el('span', { class: 'manage-spacer' }), school, zip, pdf,
            link('选手下载页', runtime.mineUrl, { target: '_blank', rel: 'noopener' })),
        filters, table);
}

function render() {
    if (!data) return;
    root.replaceChildren(status, sourceGroup(), sheetGroup(), templateGroup(), issueGroup());
}

load();
