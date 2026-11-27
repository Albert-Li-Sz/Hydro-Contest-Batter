import { ResolverView } from './resolver-view.js';

// A canvas's context type is fixed after its first draw. Replace it whenever a view takes over,
// including returning the audience canvas to an ordinary 2D programme.
export function replaceCanvas(canvas) {
    const next = canvas.cloneNode(false);
    delete next.dataset.renderer;
    delete next.dataset.act;
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
        const requested = kind === '3d' ? '3d' : '2d';
        if (this.requested === requested && !retry) return;
        const generation = ++this.generation;
        this.requested = requested;
        let View = ResolverView;
        let message = '';
        if (requested === '3d') {
            try { ({ ResolverView3D: View } = await import('../render3d/resolver-view-3d.js')); }
            catch { message = '三维组件加载失败，已切换到原版 2D'; }
        }
        if (generation !== this.generation) return;
        this.unmount();
        this.canvas = replaceCanvas(this.canvas);
        try { this.view = new View(this.canvas, this.game); }
        catch (error) {
            if (View === ResolverView) throw error;
            this.canvas = replaceCanvas(this.canvas);
            this.view = new ResolverView(this.canvas, this.game);
            message = '此设备无法使用 WebGL，已切换到原版 2D';
        }
        this.canvas.dataset.renderer = this.view instanceof ResolverView ? '2d' : '3d';
        if (this.canvas.dataset.renderer === '3d') {
            this.lost = event => {
                event.preventDefault();
                this.select('2d').then(() => {
                    this.requested = requested;
                    this.mounted(this.canvas, this.view, 'WebGL 连接已中断，已切换到原版 2D');
                });
            };
            this.canvas.addEventListener('webglcontextlost', this.lost);
        }
        const { steps, index } = this.position();
        this.view.seek(steps, index);
        this.mounted(this.canvas, this.view, message);
    }

    unmount() {
        if (this.lost) this.canvas.removeEventListener('webglcontextlost', this.lost);
        this.lost = null;
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
    holder.innerHTML = '<label>滚榜样式<select class="select" aria-label="滚榜样式"><option value="2d">原版 2D</option><option value="3d">三维 3D</option></select></label>'
        + '<label hidden>机位<select class="select" aria-label="机位"><option value="auto">自动运镜</option><option value="front">正面</option><option value="side">侧面</option></select></label>'
        + '<label hidden><input type="checkbox"> 音效</label><span role="status"></span>';
    const [style, camera] = holder.querySelectorAll('select');
    const sound = holder.querySelector('input');
    const note = holder.querySelector('[role=status]');
    let current;
    if (follow) { style.add(new Option(follow, ''), 0); style.value = ''; }
    holder.onchange = event => {
        event.stopPropagation();
        if (event.target === style) change(style.value);
        else if (event.target === camera) current?.setCamera?.(camera.value);
        else current?.setSound?.(sound.checked);
    };
    return { style, mounted(canvas, view, message = '') {
        current = view;
        const three = canvas.dataset.renderer === '3d';
        camera.parentElement.hidden = sound.parentElement.hidden = !three;
        if (!follow) style.value = three ? '3d' : '2d';
        note.textContent = message;
        view.setCamera?.(camera.value);
        if (three && sound.checked) view.setSound(true);
    } };
}
