import { ResolverView } from './resolver-view.js';

export const RENDERERS = [['2d', '原版 2D'], ['ccpcoj', 'CCPCOJ 一代'], ['ccpcoj2', 'CCPCOJ 二代']];

/** The style to draw: sessions and screens saved by v2.5 call the CCPCOJ 二代 style '3d'. */
export function rendererKind(value) {
    if (value === '3d') return 'ccpcoj2';
    return RENDERERS.some(([kind]) => kind === value) ? value : '2d';
}

// Replace the canvas whenever a view takes over, so no state of one view's drawing (size,
// transform, data attributes) leaks into the next one's.
export function replaceCanvas(canvas) {
    const next = canvas.cloneNode(false);
    delete next.dataset.renderer;
    delete next.dataset.act;
    delete next.dataset.reveal;
    if (canvas.dataset.renderer && canvas.dataset.renderer !== '2d') next.removeAttribute('aria-description');
    canvas.replaceWith(next);
    return next;
}

export class ResolverStage {
    constructor(canvas, game, position, mounted) {
        this.canvas = canvas;
        this.game = game;
        this.position = position;
        this.mounted = mounted;
        this.generation = 0;
    }

    async select(kind, retry = false) {
        const requested = rendererKind(kind);
        if (this.requested === requested && !retry) return;
        const generation = ++this.generation;
        this.requested = requested;
        let View = ResolverView;
        let message = '';
        const name = RENDERERS.find(([kind]) => kind === requested)[1];
        if (requested !== '2d') {
            try { ({ ResolverViewCcpcoj: View } = await import('../ccpcoj/resolver-view-ccpcoj.js')); }
            catch { message = name + ' 组件加载失败，已切换到原版 2D'; }
        }
        if (generation !== this.generation) return;
        this.unmount();
        this.canvas = replaceCanvas(this.canvas);
        try { this.view = new View(this.canvas, this.game, requested === 'ccpcoj2' ? 2 : 1); }
        catch (error) {
            if (View === ResolverView) throw error;
            this.canvas = replaceCanvas(this.canvas);
            this.view = new ResolverView(this.canvas, this.game);
            message = name + ' 无法在此设备显示，已切换到原版 2D';
        }
        this.canvas.dataset.renderer = this.view instanceof ResolverView ? '2d' : this.view.kind;
        const { steps, index } = this.position();
        this.view.seek(steps, index);
        this.mounted(this.canvas, this.view, message);
    }

    unmount() {
        this.view?.dispose();
        this.view = null;
    }

    dispose() {
        ++this.generation;
        this.unmount();
        return replaceCanvas(this.canvas);
    }
}

export function rendererControls(holder, change, follow = '') {
    holder.innerHTML = '<label>滚榜样式<select class="select" aria-label="滚榜样式">'
        + RENDERERS.map(([kind, label]) => '<option value="' + kind + '">' + label + '</option>').join('') + '</select></label>'
        + '<label hidden><input type="checkbox"> 音效</label><span role="status"></span>';
    const style = holder.querySelector('select');
    const sound = holder.querySelector('input');
    const note = holder.querySelector('[role=status]');
    let current;
    if (follow) { style.add(new Option(follow, ''), 0); style.value = ''; }
    holder.onchange = event => {
        event.stopPropagation();
        if (event.target === style) change(style.value);
        else current?.setSound?.(sound.checked);
    };
    return { style, mounted(canvas, view, message = '') {
        current = view;
        const kind = canvas.dataset.renderer || '2d';
        sound.parentElement.hidden = kind === '2d';
        if (!follow) style.value = kind;
        note.textContent = message;
        if (kind !== '2d' && sound.checked) view.setSound(true);
    } };
}
