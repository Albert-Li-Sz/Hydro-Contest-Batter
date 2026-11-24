import { api, action, button, el, field, notify, runtime, select } from './hydro-reaction-ui.js';
const kinds = { webcam: '摄像头', screen: '屏幕', card: '卡片', logo: '学校 Logo', text: '固定文字', image: '图片' };
const fields = {
    team: '队名',
    school: '学校',
    logo: '学校 Logo',
    problem: '题号与气球颜色',
    verdict: '评测结果',
    time: '比赛时间',
    rank: '名次变化',
};
const categories = { first: '一血', accepted: '通过', other: '其他结果' };
const list = (obj) => Object.entries(obj);
const checked = (title, v, fn) =>
    el('label', {}, el('input', { type: 'checkbox', checked: v, onchange: (e) => fn(e.target.checked) }), title);
const number = (name, v, min, max, change) =>
    field(
        name,
        el('input', {
            type: 'number',
            value: v,
            min,
            max,
            step: 1,
            onchange: (e) => {
                if (e.target.checkValidity() && e.target.value !== '') change(Number(e.target.value));
            },
        }),
    );
const clone = (value) => structuredClone(value);
let lastId = '';
export function editLayout(root, data, reload) {
    if (!data.layouts.length) {
        root.append(el('p', { text: '无可用版式' }));
        return;
    }
    let model = clone(data.layouts.find((l) => l.id === lastId) || data.layouts[0]),
        selected = model.items[0]?.id,
        preview = '',
        rerender = false,
        nvidia = false;
    const tools = el('div'),
        canvas = el('div', { class: 'rx-canvas', tabindex: 0, 'aria-label': '版式预览，使用方向键移动选中元素' }),
        controls = el('div'),
        controlsHost = el('div', { class: 'rx-editor' }, el('div', { class: 'rx-canvas-host' }, canvas), controls);
    root.append(tools, controlsHost);
    const current = () => model.items.find((i) => i.id === selected);
    const imageSrc = (id) => runtime.base + '/manage/assets/' + encodeURIComponent(id);
    function loadLayout(id) {
        model = clone(data.layouts.find((l) => l.id === id) || data.layouts[0]);
        lastId = id;
        selected = model.items[0]?.id;
        draw();
    }
    function copy() {
        model = clone(model);
        model.id = '';
        model.revision = 0;
        model.name += ' 副本';
        selected = model.items[0]?.id;
        draw();
    }
    function draw() {
        toolbar();
        drawCanvas();
        panel();
    }
    function toolbar() {
        const options = data.layouts.map((l) => [l.id, l.name]);
        if (!model.id) options.push(['', '未保存的版式']);
        const name = el('input', {
            value: model.name,
            maxlength: 80,
            oninput: (e) => {
                model.name = e.target.value;
            },
        });
        const media = [['', '内置测试片段'], ...data.clips.map((c) => [c.rid, `${c.teamUid} / ${c.rid}`])];
        tools.replaceChildren(
            el(
                'div',
                { class: 'rx-tools' },
                field('选择版式', select('选择版式', options, model.id, loadLayout)),
                button('复制为新版式', copy),
                field('版式名称', name),
                field(
                    '预览素材',
                    select('预览素材', media, preview, (id) => {
                        preview = id;
                        drawCanvas();
                    }),
                ),
                checked('重渲染已有提交', rerender, (v) => {
                    rerender = v;
                }),
                checked('nvidia_full 检查', nvidia, (v) => {
                    nvidia = v;
                }),
                button('保存版式', async () => {
                    let res = await action('layout', { layout: model, rerender, encoder: nvidia ? 'nvidia_full' : 'cpu' });
                    if (res.warnings?.length) {
                        if (!confirm(res.warnings.join('\n') + '\n仍要保存？')) return;
                        res = await action('layout', {
                            layout: model,
                            rerender,
                            encoder: nvidia ? 'nvidia_full' : 'cpu',
                            confirmWarnings: true,
                        });
                    }
                    lastId = res.id;
                    await reload();
                    notify('版式已保存');
                }),
                button('生成样片', async () => {
                    if (!model.id || !preview) throw new Error('请选择一条真实提交和已保存的版式');
                    await action('sample', { rid: preview, layoutId: model.id });
                    notify('样片已加入渲染队列，可在视频列表中查看');
                }),
            ),
        );
    }
    function geometry(node, item) {
        const { width: w, height: h } = model.canvas;
        Object.assign(node.style, {
            left: (item.x / w) * 100 + '%',
            top: (item.y / h) * 100 + '%',
            width: (item.width / w) * 100 + '%',
            height: (item.height / h) * 100 + '%',
            zIndex: item.z,
        });
    }
    function drawCanvas() {
        canvas.replaceChildren();
        const { width: w, height: h } = model.canvas;
        canvas.style.aspectRatio = w + '/' + h;
        canvas.style.width = 'min(100%, calc(55vh * ' + w / h + '))';
        canvas.style.backgroundColor = model.background.color;
        canvas.style.backgroundImage = model.background.image ? 'url(' + imageSrc(model.background.image) + ')' : 'none';
        const clip = data.clips.find((c) => c.rid === preview);
        const result = data.videos.find((v) => v.rid === preview);
        const sample = {
            team: result?.team || '示例队伍',
            school: result?.school || '示例学校',
            problem: result?.problem || 'A',
            verdict: result?.verdict || 'AC',
            time: '1:28',
            rank: '#12 → #8',
        };
        for (const item of model.items.filter((i) => i.visible)) {
            const node = el('div', {
                class: 'rx-item',
                'data-kind': item.kind,
                'aria-label': kinds[item.kind],
                'aria-selected': String(item.id === selected),
            });
            geometry(node, item);
            if (['screen', 'webcam'].includes(item.kind)) {
                const urls =
                    clip?.streams[item.kind] || (!preview ? ['/hydro-resolver/assets/reaction-samples/' + item.kind + '.mp4'] : []);
                if (urls.length) {
                    let idx = 0;
                    const v = el('video', { src: urls[0], autoplay: true, muted: true, loop: urls.length === 1, playsinline: true });
                    v.muted = true;
                    v.style.objectFit = item.fit;
                    if (urls.length > 1)
                        v.onended = () => {
                            idx = (idx + 1) % urls.length;
                            v.src = urls[idx];
                            v.play().catch(() => {});
                        };
                    node.append(v);
                } else node.append('画面缺失');
            } else if (item.kind === 'card') {
                node.style.color = model.card.text;
                node.style.backgroundColor = model.card.primary;
                node.textContent = model.card.fields
                    .map((f) => sample[f] || '')
                    .filter(Boolean)
                    .join(' · ');
                if (model.card.fields.includes('logo'))
                    node.prepend(
                        el('img', { style: 'width:14%;height:auto', src: '/hydro-resolver/assets/img/icpc-logo.png', alt: '示例 Logo' }),
                    );
            } else if (item.kind === 'text') {
                node.textContent = item.props.text || '文字';
                node.style.color = item.props.color;
            } else if (item.kind === 'logo' || item.props.image) {
                const img = el('img', {
                    src: item.kind === 'logo' ? '/hydro-resolver/assets/img/icpc-logo.png' : imageSrc(item.props.image),
                    alt: kinds[item.kind],
                });
                img.style.objectFit = item.fit;
                node.append(img);
            } else node.textContent = '上传图片';
            if (!item.locked && item.id === selected) node.append(el('span', { class: 'rx-handle', 'aria-label': '缩放' }));
            node.onpointerdown = (e) => drag(e, node, item);
            canvas.append(node);
        }
    }
    function snap(value, size, targets, eps) {
        let best = value,
            line = null,
            distance = eps;
        for (const target of targets)
            for (const edge of [0, size / 2, size]) {
                const dx = target - (value + edge);
                if (Math.abs(dx) < distance) {
                    line = target;
                    best = value + dx;
                    distance = Math.abs(dx);
                }
            }
        return { value: Math.round(best), line };
    }
    function drag(event, node, item) {
        event.preventDefault();
        canvas.focus();
        selected = item.id;
        for (const n of canvas.querySelectorAll('.rx-item')) n.setAttribute('aria-selected', String(n === node));
        if (item.locked) {
            panel();
            return;
        }
        const resizing = event.target.classList.contains('rx-handle'),
            start = { ...item },
            rect = canvas.getBoundingClientRect(),
            px = event.clientX,
            py = event.clientY;
        node.setPointerCapture(event.pointerId);
        const others = model.items.filter((i) => i !== item && i.visible),
            w = model.canvas.width,
            h = model.canvas.height;
        const tx = [0, w / 2, w, ...others.flatMap((i) => [i.x, i.x + i.width / 2, i.x + i.width])],
            ty = [0, h / 2, h, ...others.flatMap((i) => [i.y, i.y + i.height / 2, i.y + i.height])];
        function guide(pos, axis) {
            if (pos === null) return;
            const g = el('i', { class: 'rx-guideline' });
            Object.assign(
                g.style,
                axis === 'x'
                    ? { height: '100%', width: '1px', left: (pos / w) * 100 + '%', top: 0 }
                    : { width: '100%', height: '1px', top: (pos / h) * 100 + '%', left: 0 },
            );
            canvas.append(g);
        }
        function move(e) {
            const dx = ((e.clientX - px) * w) / rect.width,
                dy = ((e.clientY - py) * h) / rect.height;
            canvas.querySelectorAll('.rx-guideline').forEach((n) => n.remove());
            if (resizing) {
                item.width = Math.min(7680, Math.max(2, 2 * Math.round((start.width + dx) / 2)));
                item.height = Math.min(7680, Math.max(2, 2 * Math.round((start.height + dy) / 2)));
            } else {
                const x = snap(start.x + dx, item.width, tx, (5 * w) / rect.width),
                    y = snap(start.y + dy, item.height, ty, (5 * h) / rect.height);
                item.x = x.value;
                item.y = y.value;
                guide(x.line, 'x');
                guide(y.line, 'y');
            }
            geometry(node, item);
        }
        function end() {
            node.onpointermove = node.onpointerup = node.onpointercancel = null;
            drawCanvas();
            panel();
            canvas.focus();
        }
        node.onpointermove = move;
        node.onpointerup = end;
        node.onpointercancel = end;
    }
    canvas.onkeydown = (e) => {
        const offsets = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] },
            item = current();
        if (!offsets[e.key] || !item || item.locked) return;
        e.preventDefault();
        const [x, y] = offsets[e.key],
            k = e.shiftKey ? 10 : 1;
        item.x += x * k;
        item.y += y * k;
        drawCanvas();
        panel();
    };
    function upload(label, cb) {
        const input = el('input', {
            type: 'file',
            accept: 'image/png,image/jpeg',
            onchange: async () => {
                try {
                    if (!input.files.length) return;
                    const fd = new FormData();
                    fd.append('file', input.files[0]);
                    const { id } = await api(runtime.base + '/manage/assets', fd);
                    cb(id);
                    draw();
                } catch (e) {
                    notify(e.message, true);
                }
            },
        });
        return field(label, input);
    }
    function panel() {
        const preset = select(
            '画布预设',
            [
                ['custom', '自定义'],
                ['1080x1920', '竖屏 1080 × 1920'],
                ['1920x1080', '横屏 1920 × 1080'],
                ['1080x1080', '方形 1080 × 1080'],
            ],
            model.canvas.width + 'x' + model.canvas.height,
            (v) => {
                if (v !== 'custom') {
                    const [width, height] = v.split('x').map(Number);
                    model.canvas = { width, height };
                    draw();
                }
            },
        );
        if (!preset.value) preset.value = 'custom';
        const group = (title, ...children) =>
            el('fieldset', {}, el('legend', { text: title }), el('div', { class: 'rx-fields' }, ...children));
        const colorInput = (title, val, cb) =>
            field(
                title,
                el('input', {
                    type: 'color',
                    value: val,
                    oninput: (e) => {
                        cb(e.target.value);
                        drawCanvas();
                    },
                }),
            );
        controls.replaceChildren(
            group(
                '画布',
                preset,
                ...['width', 'height'].map((k, i) =>
                    number(['宽', '高'][i], model.canvas[k], 16, 3840, (v) => {
                        model.canvas[k] = v;
                        drawCanvas();
                    }),
                ),
                colorInput('背景色', model.background.color, (v) => {
                    model.background.color = v;
                }),
                upload('背景图', (id) => {
                    model.background.image = id;
                }),
                model.background.image
                    ? button('清除背景图', () => {
                          model.background.image = null;
                          draw();
                      })
                    : null,
            ),
        );
        const kindSelect = select('添加元素', list(kinds), 'text');
        controls.append(
            group(
                '元素',
                select(
                    '选中元素',
                    model.items.map((i) => [i.id, kinds[i.kind] + ' · ' + i.id]),
                    selected,
                    (v) => {
                        selected = v;
                        draw();
                    },
                ),
                kindSelect,
                button('添加元素', () => {
                    const kind = kindSelect.value;
                    if (model.items.filter((i) => i.kind === kind).length >= (['webcam', 'screen', 'card'].includes(kind) ? 1 : 10))
                        throw new Error('同类元素已达上限');
                    const id = kind + '-' + Date.now().toString(36);
                    model.items.push({
                        id,
                        kind,
                        x: 0,
                        y: 0,
                        width: 320,
                        height: 160,
                        z: Math.max(0, ...model.items.map((i) => i.z)) + 1,
                        fit: 'contain',
                        visible: true,
                        locked: false,
                        props: kind === 'text' ? { text: '文字', color: '#ffffff' } : {},
                    });
                    selected = id;
                    draw();
                }),
            ),
        );
        const item = current();
        if (item) {
            const itemFields = [
                ...['x', 'y', 'width', 'height', 'z'].map((k, i) =>
                    number(
                        ['横坐标', '纵坐标', '宽度', '高度', '层次'][i],
                        item[k],
                        i < 2 ? -3840 : i === 4 ? -9999 : 1,
                        i < 2 ? 3840 : i === 4 ? 9999 : 7680,
                        (v) => {
                            if (!item.locked) {
                                item[k] = v;
                                drawCanvas();
                            } else panel();
                        },
                    ),
                ),
                field(
                    '缩放',
                    select(
                        '缩放',
                        [
                            ['contain', '完整显示'],
                            ['cover', '填满裁切'],
                        ],
                        item.fit,
                        (v) => {
                            item.fit = v;
                            drawCanvas();
                        },
                    ),
                ),
                checked('显示', item.visible, (v) => {
                    item.visible = v;
                    drawCanvas();
                }),
                checked('锁定', item.locked, (v) => {
                    item.locked = v;
                    drawCanvas();
                }),
            ];
            if (item.kind === 'text')
                itemFields.push(
                    field(
                        '文字',
                        el('input', {
                            value: item.props.text || '',
                            maxlength: 500,
                            oninput: (e) => {
                                item.props.text = e.target.value;
                                drawCanvas();
                            },
                        }),
                    ),
                    colorInput('文字颜色', item.props.color || '#ffffff', (v) => {
                        item.props.color = v;
                    }),
                );
            if (item.kind === 'image')
                itemFields.push(
                    upload('选择图片', (id) => {
                        item.props.image = id;
                    }),
                );
            itemFields.push(
                button('删除元素', () => {
                    if (item.locked) throw new Error('请先解锁元素');
                    model.items = model.items.filter((i) => i !== item);
                    selected = model.items[0]?.id;
                    draw();
                }),
            );
            controls.append(group(kinds[item.kind], ...itemFields));
        }
        controls.append(
            group(
                '卡片',
                ...list(fields).map(([k, n]) =>
                    checked(n, model.card.fields.includes(k), (v) => {
                        model.card.fields = model.card.fields.filter((f) => f !== k);
                        if (v) model.card.fields.push(k);
                        drawCanvas();
                    }),
                ),
                colorInput('主色', model.card.primary, (v) => {
                    model.card.primary = v;
                }),
                colorInput('文字色', model.card.text, (v) => {
                    model.card.text = v;
                }),
            ),
        );
        controls.append(
            group(
                '适用的提交',
                ...list(categories).map(([k, n]) =>
                    checked(n, model.applies.includes(k), (v) => {
                        model.applies = model.applies.filter((a) => a !== k);
                        if (v) model.applies.push(k);
                    }),
                ),
            ),
        );
    }
    draw();
}
