import { action, api, button, el, field, notify, runtime, select } from './hydro-reaction-ui.js';
import { helpTip } from './hydro-ui.js';

let selectedId = 'portrait';
const release = new URL('../', import.meta.url).pathname.split('/').filter(Boolean).pop();
const demoAsset = (name) => '/hydro-resolver/assets/reaction-template/' + name + '?v=' + encodeURIComponent(release);

export function editLayout(root, data, reload) {
    const layouts = data.layouts;
    const model = layouts.find((v) => v.id === selectedId) || layouts[0];
    if (!model) return root.replaceChildren(el('p', { text: '暂无可用版式' }));
    const portrait = model.template === 'icpc-portrait';
    const shape = portrait ? 'portrait' : 'landscape';
    let artwork = model.artwork || null;
    const strip = el('img', { class: 'rx-artwork', alt: '' });
    const figure = el('div', { class: 'rx-frame rx-' + shape },
        el('video', { src: demoAsset(shape + '-demo.mp4'), poster: demoAsset(shape + '-demo.jpg'),
            preload: 'none', playsinline: true, muted: true, 'aria-label': 'ICPC 版式示例' }), strip);
    const video = figure.firstElementChild;
    const play = button('播放示例', () => video.paused ? video.play() : video.pause());
    const playback = () => { play.textContent = video.paused ? '播放示例' : '暂停示例'; };
    for (const event of ['play', 'pause', 'ended']) video.addEventListener(event, playback);
    const choose = select('成片版式', layouts.map((v) => [v.id, v.name]), model.id, (id) => {
        selectedId = id;
        editLayout(root, data, reload);
    });
    const controls = el('div', { class: 'rx-editor-controls' }, field('成片版式', choose));
    const clip = select('提交录像', [
        ['', '选择一条提交录像'],
        ...data.clips.map((c) => {
            const v = data.videos.find((row) => row.rid === c.rid);
            return [c.rid, v ? v.team + ' · ' + v.problem + ' · ' + v.verdict : '#' + c.teamUid + ' · ' + c.rid];
        }),
    ], '', update);
    const sample = button('生成样片', async () => {
        await action('sample', { rid: clip.value, layoutId: model.id });
        notify('样片已加入渲染队列');
    });
    const rerender = el('input', { type: 'checkbox' });
    const save = button('保存图样', async () => {
        save.disabled = true;
        try {
            await action('layout', { layout: { id: model.id, revision: model.revision, artwork }, rerender: rerender.checked });
            await reload();
            notify('底部图样已保存');
        } finally { update(); }
    });
    const reset = button('恢复默认图样', () => { artwork = null; update(); });
    const input = el('input', { type: 'file', accept: 'image/png,image/jpeg' });
    let uploading = false;
    function update() {
        const dirty = artwork !== (model.artwork || null);
        strip.hidden = !artwork;
        if (artwork) strip.src = runtime.base + '/manage/assets/' + artwork;
        else strip.removeAttribute('src');
        save.disabled = uploading || !dirty;
        reset.disabled = uploading || !artwork;
        sample.disabled = uploading || dirty || !clip.value;
        input.disabled = uploading;
    }
    input.addEventListener('change', async () => {
        if (!input.files.length) return;
        uploading = true;
        update();
        try {
            const form = new FormData();
            form.append('file', input.files[0]);
            artwork = (await api(runtime.base + '/manage/assets', form)).id;
        } catch (e) { notify(e.message, true); }
        finally { uploading = false; input.value = ''; update(); }
    });
    if (portrait) controls.append(el('fieldset', {}, el('legend', {}, '底部图样',
        helpTip('图样尺寸', 'PNG 或 JPEG，建议 1080 × 192 像素。其他比例会居中裁剪。')),
        field('上传图片', input), el('label', { class: 'rx-check' }, rerender, '同时重渲染历史视频'),
        el('div', { class: 'rx-actions' }, save, reset)));
    controls.append(el('fieldset', {}, el('legend', {}, '赛事样片'), field('提交录像', clip), sample));
    update();
    root.replaceChildren(el('div', { class: 'rx-editor' },
        el('figure', { class: 'rx-preview' }, figure,
            el('figcaption', {}, el('span', { text: model.canvas.width + ' × ' + model.canvas.height }), play)),
        controls));
}
