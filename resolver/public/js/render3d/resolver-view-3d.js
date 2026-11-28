import * as THREE from '../vendor/three.module.min.js';
import { ResolverView } from '../render/resolver-view.js';
import { initFonts } from '../render/text.js';
import { renderDimensions, readDisplaySettings } from '../display-preferences.js';
import { DEFAULT_SCHOOL_LOGO, teamLogoUrl } from '../logos.js';
import { award, board, opening, podium, replay, stageLayout, teamName } from './graphics.js';
import { BroadcastScene } from './scene.js';

const FLIP_MS = 480;
const MOVE_MS = 525;
const REPLAY_MS = 23500;
const acts = ['赛后滚榜', '提交回放', '翻牌揭晓', '领奖台'];
const unit = x => Math.max(0, Math.min(1, x));
const ease = x => x * x * (3 - 2 * x);
const between = (a, b, mix) => a + (b - a) * mix;

function publicReplay(game, teams, problems) {
    const initial = game.initialState;
    // Older saved games have no run stream; use only the public starting cells.
    const source = Array.isArray(initial?.replay) ? initial.replay
        : teams.flatMap((team, t) => (initial?.results?.[team.id] || []).flatMap((cell, p) => {
            if (cell.time == null || (cell.status !== 'solved' && cell.status !== 'failed')) return [];
            return [[(cell.timeSeconds ?? cell.time * 60) * 1000, t, p, Number(cell.status === 'solved')]];
        }));
    return source.filter(run => Array.isArray(run) && Number.isFinite(run[0]) && run[0] >= 0
        && teams[run[1]] && problems[run[2]]).sort((a, b) => a[0] - b[0]);
}

function through(runs, elapsed) {
    let lo = 0, hi = runs.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (runs[mid][0] <= elapsed) lo = mid + 1;
        else hi = mid;
    }
    return lo;
}

function awardsScene(screen) { return screen === 'teamAward' || screen === 'teamList'; }

function podiumWinners(state, awards) {
    const winners = [null, null, null];
    for (const entry of awards || []) {
        if (!Number.isInteger(entry.place) || entry.place < 0 || entry.place > 2 || !entry.teamIds?.length) continue;
        if (!winners[entry.place]) winners[entry.place] = { name: entry.name, teamIds: [] };
        winners[entry.place].teamIds.push(...entry.teamIds.filter(id => !winners[entry.place].teamIds.includes(id)));
    }
    if (winners.some(Boolean)) return winners;
    for (const id of state.order) {
        const score = state.standings.get(id);
        if (!score?.solved || score.rank < 1 || score.rank > 3) continue;
        const at = score.rank - 1;
        winners[at] ||= { teamIds: [] };
        winners[at].teamIds.push(id);
    }
    return winners;
}

export class ResolverView3D {
    constructor(canvas, game) {
        this.canvas = canvas;
        this.game = game;
        const attributes = { alpha: false, antialias: true, powerPreference: 'high-performance' };
        const gl = canvas.getContext('webgl2', attributes) || canvas.getContext('webgl', attributes);
        if (!gl) throw new Error('WebGL unavailable');
        this.renderer = new THREE.WebGLRenderer({ canvas, context: gl, alpha: false, antialias: true });
        try {
            this.stage = new BroadcastScene(this.renderer);
            this.board = new ResolverView(null, game);
            this.options = this.board.options;
            this.teams = game.contest.teams || [];
            this.problems = game.contest.problems || [];
            this.teamOf = new Map(this.teams.map(team => [team.id, team]));
            this.organizations = new Map((game.contest.organizations || []).map(org => [org.id, org]));
            this.title = game.contest.formalName || game.contest.name || 'ICPC';
            this.runs = publicReplay(game, this.teams, this.problems);
            this.duration = Math.max(1, game.initialState?.contestTimeMs || game.contest.durationMs || 0, this.runs.at(-1)?.[0] || 0);
            this.timeline = new Array(96);
            for (const run of this.runs) {
                const i = Math.min(95, Math.floor(run[0] / this.duration * 96));
                this.timeline[i] ||= run;
            }
            this.images = new Map();
            this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
            this.cameraMode = 'auto';
            this.elapsed = 0;
            this.resetCue();
            this.onResize = () => this.resize();
            window.addEventListener('resize', this.onResize);
            window.addEventListener('resolver-display', this.onResize);
            this.resize();
            this.fonts = initFonts('zh-CN').then(() => this.markFrame());
        } catch (error) {
            this.dispose();
            throw error;
        }
    }

    ready() { return this.fonts; }

    resetCue() {
        this.act = this.options.startScreen === 'scoreboard' ? 3 : 1;
        this.revelation = null;
        this.scrolling = false;
        this.finalAwards = [];
        this.motion = null;
        this.rankChange = null;
    }

    cue(step) {
        switch (step.type) {
            case 'presentation':
                if (step.screen === 'splash') this.act = 1;
                else if (step.screen === 'scoreboard' && this.act === 1) this.act = 2;
                else if (awardsScene(step.screen)) this.act = 3;
                this.revelation = null;
                break;
            case 'selectTeam':
                this.scrolling = false;
                this.revelation = null;
                if (step.role === 'finale' || (!step.role && !step.teamIds?.length && this.act === 3)) {
                    this.act = 4;
                    this.finalAwards = step.podium || [];
                } else if (step.teamIds?.length && step.role !== 'setup') this.act = 3;
                break;
            case 'scroll':
                this.scrolling = true;
                this.revelation = null;
                break;
            case 'selectSubmission':
                this.act = 3;
                this.scrolling = false;
                this.revelation = null;
                break;
            case 'resolve':
                this.act = 3;
                this.scrolling = false;
                this.revelation = step;
                break;
        }
    }

    applyStep(step, { instant = false } = {}) {
        if (!step) return;
        const resolves = step.type === 'resolve', scrolls = step.type === 'scroll';
        const before = this.board.stageState();
        const lastAct = this.act;
        const animate = !instant && !this.reduced;
        const start = (resolves || scrolls) ? this.windowFor(before, this.focusOf(before).team?.id) : 0;
        const order = resolves && animate ? before.order.slice() : before.order;
        const cellsBefore = resolves && animate ? (before.results[step.teamId] || []).slice() : null;
        const previous = resolves ? before.standings.get(step.teamId) : null;
        this.board.applyStep(step, { instant });
        if (instant) this.board.finishReplay();
        if (step.type === 'pause' || step.type === 'delay') return;
        this.cue(step);
        const state = this.board.stageState();
        if (lastAct !== this.act || before.screen !== state.screen) {
            this.elapsed = instant ? 1200 : 0;
            this.lastDraw = null;
        }
        const score = resolves ? state.standings.get(step.teamId) : null;
        if (resolves) {
            this.rankChange = previous?.rank && score?.rank ? { from: previous.rank, to: score.rank } : null;
            const canMove = order.indexOf(step.teamId) !== state.order.indexOf(step.teamId);
            const speed = Math.max(.4, Math.min(12, Number(step.speedMultiplier) || 1));
            this.motion = animate ? {
                kind: 'resolve', start, before: order, standings: before.standings, cells: cellsBefore,
                teamId: step.teamId, clock: 0, speed, moving: canMove,
            } : null;
        } else if (this.act === 3 && animate && scrolls) {
            this.motion = { kind: 'scroll', start, clock: 0, speed: Math.max(.5, Math.min(12, Number(step.speedMultiplier) || 1)) };
        } else if (step.type !== 'selectTeam' || this.motion?.kind !== 'scroll') {
            this.motion = null;
        }
        if (this.act === 4 && lastAct !== 4) this.chime('finale', instant);
        this.markFrame();
    }

    seek(steps, target) {
        this.board.seek(steps, target);
        this.resetCue();
        for (let i = 0; i <= target && i < steps.length; i++) this.cue(steps[i]);
        this.elapsed = this.act <= 2 ? 0 : 1200;
        this.lastDraw = null;
        this.markFrame();
    }

    focusOf(state) {
        if (this.scrolling) return {};
        const selected = state.submission || this.revelation;
        const team = this.teamOf.get(selected?.teamId || state.selected[0]);
        return { team, problemIndex: selected?.problemIndex };
    }

    windowFor(state, id) {
        const count = this.L.count;
        const end = Math.max(0, state.order.length - count);
        let start = Math.min(end, Math.max(0, Number(state.scroll) || 0));
        if (!id) return start;
        const index = state.order.indexOf(id);
        if (index >= 0) start = Math.max(0, Math.min(index, Math.max(start, index - count + 1)));
        return start;
    }

    boardFrame(state, flip, moving) {
        const focus = this.focusOf(state);
        const from = this.motion;
        const destination = this.windowFor(state, focus.team?.id);
        const mix = from ? moving : 1;
        const scroll = from ? between(from.start, destination, mix) : destination;
        const low = Math.max(0, Math.floor(scroll) - 2), high = Math.ceil(scroll) + this.L.count + 2;
        const ids = new Set(state.order.slice(low, high));
        if (from?.before) for (const id of from.before.slice(low, high)) ids.add(id);
        if (focus.team) ids.add(focus.team.id);
        const rows = [];
        for (const id of ids) {
            const index = state.order.indexOf(id);
            if (index < 0) continue;
            const first = from?.before?.indexOf(id) ?? index;
            const position = between(first < 0 ? index : first, index, mix) - scroll;
            if (position <= -1 || position >= this.L.count) continue;
            const old = from?.before && flip < .5 ? {
                score: from.standings.get(id), cells: id === from.teamId ? from.cells : null,
            } : null;
            const rank = from?.standings && (flip < .5 || mix < 1) ? from.standings.get(id)?.rank : state.standings.get(id)?.rank;
            rows.push({ id, index, position, rank, selected: focus.team?.id === id, old });
        }
        rows.sort((a, b) => Number(a.selected) - Number(b.selected) || a.position - b.position);
        const problemStart = Math.max(0, Math.min(this.problems.length - this.L.slots,
            (focus.problemIndex ?? 0) - Math.floor(this.L.slots / 2)));
        if (this.revelation && flip >= .5) focus.result = this.revelation;
        if (mix >= 1 && flip >= .5) focus.rank = this.rankChange;
        return { rows, state, focus, problemStart };
    }

    image(src) {
        if (!src || src === DEFAULT_SCHOOL_LOGO) return null;
        let img = this.images.get(src);
        if (!img) {
            img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => this.markFrame();
            img.src = src;
            if (this.images.size >= 14) {
                const key = this.images.keys().next().value;
                this.images.get(key).onload = null;
                this.images.delete(key);
            }
        } else this.images.delete(src);
        this.images.set(src, img);
        return img.complete && img.naturalWidth ? img : null;
    }

    logo(team) {
        const org = this.organizations.get(team?.organizationId);
        return this.image(teamLogoUrl(team, org) || org?.logo || team?.logo);
    }

    setCamera(mode) {
        this.cameraMode = ['front', 'side'].includes(mode) ? mode : 'auto';
        this.markFrame();
    }

    setSound(enabled) {
        this.sound = enabled;
        if (!enabled) return;
        const Audio = window.AudioContext || window.webkitAudioContext;
        if (!Audio) return;
        this.audio ||= new Audio();
        this.audio.resume().catch(() => {});
    }

    chime(kind, instant = false) {
        if (instant || !this.sound || this.audio?.state !== 'running') return;
        const tones = kind === 'finale' ? [392, 523, 659] : kind === 'solved' ? [440, 659] : [196];
        tones.forEach((frequency, i) => {
            const at = this.audio.currentTime + i * .072;
            const oscillator = this.audio.createOscillator(), gain = this.audio.createGain();
            oscillator.frequency.value = frequency;
            gain.gain.setValueAtTime(.0001, at);
            gain.gain.exponentialRampToValueAtTime(.047, at + .014);
            gain.gain.exponentialRampToValueAtTime(.0001, at + .215);
            oscillator.connect(gain).connect(this.audio.destination);
            oscillator.start(at); oscillator.stop(at + .22);
            oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        });
    }

    markFrame() {
        this.dirty = true;
        this.canvas.dataset.act = String(this.act);
    }

    update(dt) {
        this.elapsed += dt;
        if (this.motion) {
            const before = this.motion.clock;
            this.motion.clock += dt * this.motion.speed;
            const resolving = this.motion.kind === 'resolve';
            const duration = resolving ? FLIP_MS + (this.motion.moving ? MOVE_MS : 0) : MOVE_MS;
            if (resolving && before < FLIP_MS / 2 && this.motion.clock >= FLIP_MS / 2) this.chime(this.revelation?.status);
            if (this.motion.clock >= duration) this.motion = null;
            this.dirty = true;
        }
        // The entrance eases camera yaw and backdrop in every act, including the reveal board.
        const movingStage = !this.reduced && this.elapsed <= 1250;
        const state = this.board.stageState();
        const page = Math.floor(this.elapsed / (this.act === 4 ? 3600 : 5200));
        const key = this.act === 2 ? Math.min(Math.floor(REPLAY_MS / 50), Math.floor(this.elapsed / 50)) + '/' + page
            : this.act === 4 || awardsScene(state.screen) ? page : null;
        if (key !== this.lastDraw || movingStage) this.dirty = true;
        this.lastDraw = key;
    }

    render() {
        if (this.dirty) {
            const L = this.L, state = this.board.stageState(), motion = this.motion;
            const enter = this.reduced ? 1 : ease(unit(this.elapsed / 650));
            const flip = motion?.kind === 'resolve' ? unit(motion.clock / FLIP_MS) : this.revelation ? 1 : 0;
            const travel = motion?.kind === 'resolve' ? motion.moving ? ease(unit((motion.clock - FLIP_MS) / MOVE_MS)) : 1
                : motion ? ease(unit(motion.clock / MOVE_MS)) : 1;
            const rows = this.act === 3 && !awardsScene(state.screen) ? this.boardFrame(state, flip, travel) : null;
            const problem = this.problems[rows?.focus.problemIndex];
            const winners = this.act === 4 ? podiumWinners(state, this.finalAwards) : [];
            const progress = [360, 100, 0].map(delay => this.reduced ? 1 : unit((this.elapsed - delay) / 570));
            this.stage.pose({
                act: this.act, camera: this.reduced ? 'front' : this.cameraMode, enter, flip, winners,
                podiumProgress: progress,
                focus: problem ? { label: problem.label || problem.id, result: this.revelation } : null,
            });
            this.stage.paint(ctx => {
                if (this.act === 1) opening(ctx, L, this.title, this.teams.length, this.problems.length);
                if (this.act === 2) {
                    const time = this.duration * unit(this.elapsed / REPLAY_MS);
                    const team = this.teams[Math.floor(this.elapsed / 5200) % Math.max(1, this.teams.length)];
                    replay(ctx, L, this.title, time, this.duration, this.runs, through(this.runs, time), this.teams,
                        this.problems, team, this.image(team?.photo), this.logo(team), this.timeline);
                }
                if (rows) board(ctx, L, this.title, rows, this.teamOf, this.problems);
                else if (this.act === 3) {
                    const team = this.teamOf.get(state.award?.teamId || state.selected[0]);
                    award(ctx, L, this.title, state, this.teamOf, this.elapsed, this.image(team?.photo), this.logo(team));
                }
                if (this.act === 4) podium(ctx, L, this.title, winners, this.teamOf, Math.floor(this.elapsed / 3600),
                    team => this.logo(team), progress);
            });
            const phase = motion?.kind === 'resolve' ? flip < .5 ? 'turning' : travel < 1 ? 'rising' : 'result'
                : problem ? this.revelation ? 'result' : 'pending' : '';
            this.canvas.dataset.reveal = phase;
            const labels = [acts[this.act - 1]];
            if (rows?.focus.team) labels.push(teamName(rows.focus.team));
            if (problem) labels.push(problem.label, rows.focus.result ? rows.focus.result.status === 'solved' ? '通过' : '未通过' : '待揭晓');
            const description = labels.join(' · ');
            if (this.canvas.getAttribute('aria-description') !== description) this.canvas.setAttribute('aria-description', description);
            this.dirty = false;
        }
        this.stage.render();
    }

    resize() {
        const logicalWidth = Math.max(1080, Math.min(5760, Number(this.canvas.dataset.logicalWidth) || 1920));
        const dims = renderDimensions(logicalWidth, this.canvas.dataset.resolution || readDisplaySettings().resolution);
        this.L = stageLayout(logicalWidth, this.options.rowsPerScreen, this.teams.length, this.problems.length);
        this.stage.resize(this.L, dims.width, dims.height);
        this.markFrame();
    }

    debugState() { return { ...this.board.debugState(), act: this.act, renderer: '3d' }; }

    dispose() {
        window.removeEventListener('resize', this.onResize);
        window.removeEventListener('resolver-display', this.onResize);
        this.board?.dispose();
        this.stage?.dispose();
        for (const img of this.images?.values() || []) img.onload = null;
        this.images?.clear();
        this.audio?.close().catch(() => {});
        this.renderer.dispose();
        this.renderer.forceContextLoss();
    }
}
