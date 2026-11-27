import * as THREE from '../vendor/three.module.min.js';
import { ResolverView } from '../render/resolver-view.js';
import { renderDimensions, readDisplaySettings } from '../display-preferences.js';

const palette = { ink: '#edf5ff', muted: '#a3b6ce', cyan: '#65e1e3', gold: '#f8d188', failed: '#ff9a91', pending: '#e3b369' };
const actNames = ['', '序幕', '提交回放与队伍巡礼', '翻牌揭晓', '领奖台'];
const placeNames = ['冠军', '亚军', '季军'];
const podiumColors = [0xe3b86d, 0x96aec9, 0xbb815e];
const faceFont = 'system-ui, "PingFang SC", "Microsoft YaHei", sans-serif';

function text(ctx, value, x, y, width, height, color, { align = 'left', weight = 550 } = {}) {
    if (!value || width <= 0) return;
    ctx.font = weight + ' ' + height + 'px ' + faceFont;
    ctx.fillStyle = color;
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillText(String(value), x, y, width);
}
function backdrop(ctx, w, h, light = false) {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, light ? '#204550' : '#162f4c');
    grad.addColorStop(1, '#0a182e');
    ctx.fillStyle = grad; ctx.fillRect(0, 0, w, h);
    ctx.strokeStyle = light ? '#71dad2' : '#34516d';
    ctx.lineWidth = 3; ctx.strokeRect(2, 2, w - 4, h - 4);
}
function nameOf(team) { return team?.displayName || team?.name || team?.id || '—'; }
function timeLabel(ms) {
    const minute = Math.floor(ms / 60000);
    return String(Math.floor(minute / 60)).padStart(2, '0') + ':' + String(minute % 60).padStart(2, '0');
}
function box(group, w, h, depth, color, x = 0, y = 0, z = 0) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, depth),
        new THREE.MeshStandardMaterial({ color, metalness: 0.45, roughness: 0.4 }));
    mesh.position.set(x, y, z);
    group.add(mesh);
    return mesh;
}
// Every card has a physical edge, a front face and its own transform in the stage.
function card(group, w, h, pixelWidth = 900) {
    const holder = new THREE.Group();
    group.add(holder);
    box(holder, w, h, 0.13, 0x243e55, 0, 0, -0.08);
    const surface = document.createElement('canvas');
    surface.width = pixelWidth;
    surface.height = Math.max(32, Math.round(pixelWidth * h / w));
    const ctx = surface.getContext('2d');
    const texture = new THREE.CanvasTexture(surface);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const face = new THREE.Mesh(new THREE.PlaneGeometry(w, h), new THREE.MeshBasicMaterial({ map: texture, toneMapped: false }));
    holder.add(face);
    return { holder, paint(draw) { ctx.clearRect(0, 0, surface.width, surface.height); draw(ctx, surface.width, surface.height); texture.needsUpdate = true; } };
}
function clearGroup(group) {
    group.traverse(object => {
        object.geometry?.dispose();
        const mats = Array.isArray(object.material) ? object.material : [object.material];
        for (const mat of mats) if (mat) { mat.map?.dispose(); mat.dispose(); }
    });
    group.clear();
}
function layeredPanel(ctx, w, h, kicker, title, detail = '', accent = palette.cyan) {
    backdrop(ctx, w, h);
    text(ctx, kicker, w / 2, h * .18, w * .88, Math.min(h * .10, w * .048), accent, { align: 'center', weight: 700 });
    text(ctx, title, w / 2, h * .49, w * .88, Math.min(h * .25, w * .12), palette.ink, { align: 'center', weight: 750 });
    text(ctx, detail, w / 2, h * .78, w * .88, Math.min(h * .11, w * .065), palette.muted, { align: 'center' });
}
function historicalReplay(game) {
    if (Array.isArray(game.initialState?.replay)) return game.initialState.replay;
    // Earlier saved games retain the latest public time per problem, but no per-submission stream.
    return game.contest.teams.flatMap((team, t) => (game.initialState?.results?.[team.id] || []).flatMap((cell, p) => {
        if (!['solved','failed'].includes(cell.status) || cell.time == null) return [];
        return [[(cell.timeSeconds ?? cell.time * 60) * 1000, t, p, Number(cell.status === 'solved')]];
    })).sort((a, b) => a[0] - b[0]);
}

export class ResolverView3D {
    constructor(canvas, game) {
        this.canvas = canvas;
        this.game = game;
        const attributes = { antialias: true, alpha: false, powerPreference: 'high-performance', preserveDrawingBuffer: false };
        const gl = canvas.getContext('webgl2', attributes) || canvas.getContext('webgl', attributes);
        if (!gl) throw new Error('WebGL unavailable');
        this.renderer = new THREE.WebGLRenderer({ canvas, context: gl, ...attributes });
        try {
            // Share ranking, selection and seek checkpoints without a second drawing surface or image cache.
            this.board = new ResolverView(null, game);
            this.options = this.board.options;
            this.teams = game.contest.teams || [];
            this.byId = new Map(this.teams.map(t => [t.id, t]));
            this.problems = game.contest.problems || [];
            this.replay = historicalReplay(game);
            this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            this.cameraMode = 'auto';
            this.scene = new THREE.Scene();
            this.scene.background = new THREE.Color(0x081427);
            this.scene.fog = new THREE.FogExp2(0x081427, .026);
            this.camera = new THREE.PerspectiveCamera(36, 16 / 9, .1, 150);
            this.scene.add(new THREE.HemisphereLight(0xd8f3ff, 0x152139, 2.5));
            const key = new THREE.DirectionalLight(0xe0ecff, 3.4);
            key.position.set(-5, 9, 9); this.scene.add(key);
            const rim = new THREE.DirectionalLight(0x64ddd6, 2.6);
            rim.position.set(6, 2, -7); this.scene.add(rim);
            this.stage = new THREE.Group(); this.scene.add(this.stage);
            const floor = box(this.scene, 85, .14, 85, 0x101f30, 0, -3.75, -13);
            floor.material.roughness = .32;
            const grid = new THREE.GridHelper(56, 36, 0x355166, 0x1c3448);
            grid.position.set(0, -3.67, -13); this.scene.add(grid);
            this.orbit = new THREE.Group(); this.scene.add(this.orbit);
            for (let i = 0; i < 3; i++) {
                const ring = new THREE.Mesh(new THREE.TorusGeometry(4.3 + i * .38, .024 + i * .006, 6, 96, Math.PI * (1.35 + i * .19)),
                    new THREE.MeshStandardMaterial({ color: i === 1 ? 0xdfbb76 : 0x5cb7c3, emissive: 0x20424a, metalness: .65, roughness: .25 }));
                ring.rotation.set(.45 + i * .33, i * .46, i * 1.85); this.orbit.add(ring);
            }
            this.orbit.position.set(0, .2, -1.6);
            this.target = new THREE.Vector3();
            this.elapsed = this.sinceAct = this.flip = 0;
            this.resetCue();
            this.onResize = () => this.resize();
            window.addEventListener('resize', this.onResize);
            window.addEventListener('resolver-display', this.onResize);
            this.resize();
            this.paintStage();
        } catch (error) { this.dispose(); throw error; }
    }

    ready() { return document.fonts.ready; }

    resetCue() {
        this.act = this.options.startScreen === 'scoreboard' ? 2 : 1;
        this.revealed = null;
        this.finalPodium = [];
    }

    cue(step) {
        if (step.type === 'presentation' && step.screen === 'splash') this.act = 1;
        if (step.type === 'presentation' && step.screen === 'scoreboard' && this.act === 1) this.act = 2;
        if (step.type === 'selectTeam' && step.teamIds?.length && step.role !== 'setup') { this.act = 3; this.revealed = null; }
        if (step.type === 'selectSubmission') { this.act = 3; this.revealed = null; }
        if (step.type === 'resolve') { this.act = 3; this.revealed = step; }
        if (step.role === 'finale' || (step.type === 'selectTeam' && !step.teamIds?.length && !step.role && this.act === 3)) {
            this.act = 4; this.finalPodium = step.podium || [];
        }
    }

    applyStep(step, { instant = false } = {}) {
        if (!step) return;
        this.board.applyStep(step, { instant });
        if (instant) this.board.finishReplay();
        const old = this.act;
        this.cue(step);
        if (this.act !== old) this.sinceAct = 0;
        if (step.type === 'resolve') { this.flip = instant || this.reduced ? 1 : 0; this.chime(step.status === 'solved' ? 660 : 220, instant); }
        if (this.act === 4 && old !== 4) this.chime(880, instant);
        if (!['delay','pause'].includes(step.type)) this.paintStage(instant);
    }

    seek(steps, target) {
        this.board.seek(steps, target);
        this.resetCue();
        for (let i = 0; i <= target && i < steps.length; i++) this.cue(steps[i]);
        this.sinceAct = 0; this.flip = 1;
        this.paintStage(true);
    }

    paintStage(instant = true) {
        const changed = this.paintedAct !== this.act;
        if (changed) {
            clearGroup(this.stage);
            this.rows = new Map();
            this.panels = [];
            this.paradeKey = '';
            this.podiumKey = '';
            this.paintedAct = this.act;
            this.canvas.dataset.act = String(this.act);
            this.orbit.visible = this.act === 1 || this.act === 2;
            this.orbit.scale.setScalar(this.act === 2 ? .86 : 1);
            this.heading = card(this.stage, 8.1, .65, 1000);
            this.heading.holder.position.set(0, 3.12, -.25);
            this.heading.paint((ctx, w, h) => {
                backdrop(ctx, w, h);
                text(ctx, actNames[this.act], w * .04, h / 2, w * .47, h * .53, palette.cyan, { weight: 750 });
                text(ctx, this.game.contest.name, w * .96, h / 2, w * .45, h * .40, palette.muted, { align: 'right' });
            });
        }
        const title = this.game.contest.formalName || this.game.contest.name || 'ICPC';
        if (this.act === 1 && changed) {
            const main = card(this.stage, 10.6, 3.2, 1280);
            main.paint((ctx,w,h) => layeredPanel(ctx,w,h,'XCPC · RESOLVER', title, this.teams.length + ' 支队伍    /    ' + this.problems.length + ' 道赛题', palette.gold));
            this.panels.push(main);
        } else if (this.act === 2) {
            if (changed) {
                const run = card(this.stage, 7.8, 2.36); run.holder.position.set(-1.8, .82, .5);
                const team = card(this.stage, 7.8, 1.76); team.holder.position.set(1.3, -1.55, .65);
                const history = card(this.stage, 2.1, 3.50, 360); history.holder.position.set(4.7, .62, -.3);
                this.panels.push(run, team, history);
            }
            this.paintParade();
        } else if (this.act === 3) {
            if (changed) {
                this.focusCard = card(this.stage, 3.55, 3.25, 620);
                this.focusCard.holder.position.set(4.48, .30, .52);
            }
            this.paintRows(instant);
            this.paintFocus();
        } else if (this.act === 4) {
            if (changed) {
                this.winners = this.podium();
                const heights = [2.9, 2.15, 1.55];
                for (let i = 0; i < 3; i++) {
                    const x = [0,-3.65,3.65][i], h = heights[i], z = i ? -.45 : .05;
                    box(this.stage, 3.35, h, 2.1, podiumColors[i], x, -3.55 + h / 2, z);
                    const panel = card(this.stage, 3.65, 1.72, 550);
                    panel.holder.position.set(x, -3.55 + h + 1.15, z + .28);
                    this.panels.push(panel);
                    const number = card(this.stage, .78, .70, 128);
                    number.holder.position.set(x, -3.55 + h * .52, z + 1.09);
                    number.paint((ctx,w,h) => { backdrop(ctx,w,h); text(ctx,String(i+1),w/2,h/2,w*.8,h*.65,palette.ink,{align:'center'}); });
                }
            }
            this.paintPodium();
        }
    }

    paintParade() {
        const span = this.game.initialState.contestTimeMs || this.game.contest.durationMs || 1;
        const elapsed = this.sinceAct / 1000;
        const fraction = (elapsed % 22) / 22, time = span * fraction;
        let lo = 0, hi = this.replay.length;
        while (lo < hi) { const mid = (lo + hi) >>> 1; if (this.replay[mid][0] <= time) lo = mid + 1; else hi = mid; }
        const index = lo - 1, entry = this.replay[index];
        const t = Math.floor(elapsed / 3) % Math.max(1, this.teams.length);
        const key = [index, t, Math.floor(fraction * 96)].join('/');
        if (key === this.paradeKey) return;
        this.paradeKey = key;
        const [runCard, teamCard, list] = this.panels;
        runCard.paint((ctx,w,h) => {
            const team = entry && this.teams[entry[1]], p = entry && this.problems[entry[2]];
            const label = Array.isArray(this.game.initialState.replay) ? '公开提交回放' : '封榜前题目记录';
            layeredPanel(ctx,w,h,label + '  ·  ' + timeLabel(time), entry ? nameOf(team) : '等待首个公开记录',
                entry ? timeLabel(entry[0]) + '    ' + (p?.label || p?.id) + '    ' + (entry[3] ? '通过' : '未通过') : '', entry && !entry[3] ? palette.failed : palette.cyan);
            ctx.fillStyle = '#27425a'; ctx.fillRect(w*.06,h*.91,w*.88,h*.022);
            ctx.fillStyle = palette.cyan; ctx.fillRect(w*.06,h*.91,w*.88*fraction,h*.022);
        });
        const team = this.teams[t];
        teamCard.paint((ctx,w,h) => layeredPanel(ctx,w,h,'队伍巡礼' + (team ? '    ' + (t+1) + ' / ' + this.teams.length : ''),
            nameOf(team), team?.organizationName || '', palette.gold));
        list.paint((ctx,w,h) => {
            backdrop(ctx,w,h); text(ctx,'最近提交',w/2,h*.11,w*.85,w*.17,palette.ink,{align:'center'});
            this.replay.slice(Math.max(0,lo-5),lo).reverse().forEach((r,j) => {
                text(ctx,timeLabel(r[0]) + '  ' + (this.problems[r[2]]?.label || ''),w*.10,h*(.28+.14*j),w*.8,w*.145,r[3]?palette.cyan:palette.failed);
            });
        });
    }

    paintRows(instant) {
        const state = this.board.stageState(), focus = state.selected[0] || this.revealed?.teamId;
        const count = Math.min(9, Math.max(4, this.options.rowsPerScreen || 8));
        const focusRow = focus ? state.order.indexOf(focus) : -1;
        const start = Math.max(0, Math.min(state.order.length - count, focusRow >= 0 ? focusRow - Math.floor(count / 2) : state.scroll));
        const visible = state.order.slice(start, start + count);
        for (const [id, row] of this.rows) if (!visible.includes(id)) {
            clearGroup(row.holder); this.stage.remove(row.holder); this.rows.delete(id);
        }
        const spacing = 5.65 / count;
        visible.forEach((id,i) => {
            let row = this.rows.get(id);
            if (!row) {
                row = card(this.stage, 8.45, spacing*.90, 940);
                row.holder.position.set(-2.25, 2.60 - i*spacing - spacing/2, 0);
                this.rows.set(id, row);
            }
            const selected = state.selected.includes(id), score = state.standings.get(id), team = this.byId.get(id), cells = state.results[id] || [];
            row.y = 2.60 - i*spacing - spacing/2;
            row.z = selected ? .42 : 0;
            if (instant || this.reduced) { row.holder.position.y = row.y; row.holder.position.z = row.z; }
            row.paint((ctx,w,h) => {
                backdrop(ctx,w,h,selected);
                text(ctx, String(score?.rank || '★'), w*.06, h*.49, w*.085, h*.55, selected?palette.gold:palette.muted, {align:'center'});
                text(ctx, nameOf(team), w*.124, h*.34, w*.65, h*.43, palette.ink, {weight:700});
                text(ctx, (score?.solved || 0) + ' / ' + (score?.time || 0), w*.96,h*.38,w*.19,h*.39,palette.cyan,{align:'right'});
                const cellWidth = Math.min(w*.055, w*.74 / Math.max(1,cells.length));
                cells.forEach((cell,p) => {
                    const x = w*.124+p*cellWidth;
                    ctx.fillStyle = { solved: cell.firstToSolve?'#428bc5':'#26756c', failed:'#8b494f', pending:'#8d703c' }[cell.status] || '#26394d';
                    ctx.fillRect(x,h*.64,cellWidth*.88,h*.28);
                    text(ctx,this.problems[p]?.label || '',x+cellWidth*.44,h*.78,cellWidth*.76,h*.21,palette.ink,{align:'center'});
                });
            });
        });
    }

    paintFocus(back = false) {
        const state = this.board.stageState();
        const reveal = this.revealed, pending = state.submission;
        const id = pending?.teamId || reveal?.teamId || state.selected[0];
        const team = this.byId.get(id);
        const p = pending?.problemIndex ?? reveal?.problemIndex;
        const result = pending || back ? '待揭晓' : reveal?.status === 'solved' ? '通过' : '未通过';
        this.focusCard.paint((ctx,w,h) => {
            if ((state.screen === 'teamAward' || state.screen === 'teamList') && state.award?.awards?.length) {
                const a = state.award.awards;
                layeredPanel(ctx,w,h,a.map(x=>x.citation).join(' · '), nameOf(team || this.byId.get(a[0].teamIds[0])),
                    state.screen === 'teamList' ? a[0].teamIds.map(x=>nameOf(this.byId.get(x))).join('、') : team?.organizationName || '',palette.gold);
            } else if (p != null) {
                layeredPanel(ctx,w,h,this.problems[p]?.label || '题目',result, nameOf(team),
                    pending || back ? palette.pending : reveal?.status === 'solved' ? palette.cyan : palette.failed);
            } else layeredPanel(ctx,w,h,'队伍',nameOf(team),team?.organizationName || '');
        });
        this.back = back;
    }

    podium() {
        if (this.finalPodium.length) return this.finalPodium;
        const state = this.board.stageState();
        const places = new Map();
        for (const id of state.order) {
            const score = state.standings.get(id);
            if (!score?.rank || !score.solved || score.rank > 3) continue;
            const place = score.rank - 1;
            if (!places.has(place)) places.set(place, { place, name: '第 ' + score.rank + ' 名', teamIds: [] });
            places.get(place).teamIds.push(id);
        }
        return [...places.values()];
    }

    paintPodium() {
        const cycle = Math.floor(this.sinceAct / 3000);
        if (this.podiumKey === cycle) return;
        this.podiumKey = cycle;
        this.panels.forEach((p,i) => {
            const prize = this.winners.find(w => w.place === i), ids = prize?.teamIds || [];
            const team = ids.length && this.byId.get(ids[cycle % ids.length]);
            p.paint((ctx,w,h) => layeredPanel(ctx,w,h,prize?.name || placeNames[i],team ? nameOf(team) : '—',
                (team?.organizationName || '') + (ids.length > 1 ? '  ·  并列 ' + (cycle % ids.length + 1) + '/' + ids.length : ''),palette.gold));
        });
    }

    setCamera(mode) { this.cameraMode = ['front','side','auto'].includes(mode) ? mode : 'auto'; }
    setSound(enabled) {
        this.sound = enabled;
        if (enabled) {
            const Audio = window.AudioContext || window.webkitAudioContext;
            if (Audio) { this.audio ||= new Audio(); this.audio.resume().catch(() => {}); }
        }
    }
    chime(frequency, instant) {
        if (instant || !this.sound || this.audio?.state !== 'running') return;
        const at = this.audio.currentTime, osc = this.audio.createOscillator(), gain = this.audio.createGain();
        osc.type = 'sine'; osc.frequency.setValueAtTime(frequency, at);
        gain.gain.setValueAtTime(.0001, at); gain.gain.exponentialRampToValueAtTime(.065, at + .018);
        gain.gain.exponentialRampToValueAtTime(.0001, at + .24);
        osc.connect(gain).connect(this.audio.destination); osc.start(at); osc.stop(at + .25);
        osc.onended = () => { osc.disconnect(); gain.disconnect(); };
    }
    update(dt) {
        this.elapsed += dt; this.sinceAct += dt;
        if (this.act === 2) this.paintParade();
        if (this.act === 4) this.paintPodium();
        if (this.act === 3) {
            const factor = this.reduced ? 1 : 1 - Math.exp(-dt / 135);
            for (const row of this.rows.values()) {
                row.holder.position.y += (row.y - row.holder.position.y) * factor;
                row.holder.position.z += (row.z - row.holder.position.z) * factor;
            }
            if (this.revealed) {
                this.flip = Math.min(1,this.flip + dt/620);
                const back = this.flip < .5;
                if (this.back !== back) this.paintFocus(back);
                this.focusCard.holder.rotation.y = (back ? this.flip : this.flip-1) * Math.PI;
            } else this.focusCard.holder.rotation.y = 0;
        }
        if (!this.reduced) this.orbit.rotation.y = this.elapsed / 7800;
        const side = this.cameraMode === 'side' ? 3.0 : this.cameraMode === 'front' || this.reduced ? 0
            : this.act === 3 ? 1.0 : Math.sin(this.elapsed / 4800)*1.55;
        const distance = Math.max(13.9, 22.2/this.camera.aspect);
        this.target.set(side, this.act === 4 ? 1.65 : .65, distance);
        this.camera.position.lerp(this.target, this.reduced ? 1 : 1-Math.exp(-dt/170));
        this.camera.lookAt(0,-.05,0);
    }
    render() { this.renderer.render(this.scene, this.camera); }
    resize() {
        const width = Number(this.canvas.dataset.logicalWidth) || 1920;
        const { width: w, height: h } = renderDimensions(width, this.canvas.dataset.resolution || readDisplaySettings().resolution);
        this.renderer.setSize(w,h,false);
        this.camera.aspect = w/h; this.camera.updateProjectionMatrix();
        this.camera.position.set(0,.65,Math.max(13.9,22.2/this.camera.aspect));
        this.camera.lookAt(0,-.05,0);
        if (this.act === 3 && this.paintedAct === 3) this.paintRows(true);
    }
    debugState() { return { ...this.board.debugState(), act: this.act, renderer: '3d' }; }
    dispose() {
        window.removeEventListener('resize', this.onResize);
        window.removeEventListener('resolver-display', this.onResize);
        this.board?.dispose();
        if (this.scene) clearGroup(this.scene);
        this.audio?.close().catch(() => {});
        this.renderer.dispose();
        this.renderer.forceContextLoss();
    }
}
