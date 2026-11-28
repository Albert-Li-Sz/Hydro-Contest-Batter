import { ResolverView } from '../render/resolver-view.js';
import { initFonts } from '../render/text.js';
import { renderDimensions, readDisplaySettings } from '../display-preferences.js';
import { DEFAULT_SCHOOL_LOGO, teamLogoUrl } from '../logos.js';
import { HEIGHT, teamName } from './draw.js';
import * as classic from './gen1.js';
import * as modern from './gen2.js';

// The problem chip changes colour first; then the row travels, slow to start and fast to land
// (cubic-bezier(1, 0, 1, 1)), longer the further it goes.
const FLIP_MS = 360;
const SETTLE_MS = 120;
const SCROLL_MS = 256;
const FLICKER_MS = 1000;
const DIALOG_MS = 300;
const acts = ['赛后滚榜', '冻结榜单', '翻牌揭晓', '领奖台'];
const unit = x => Math.max(0, Math.min(1, x));
const between = (a, b, mix) => a + (b - a) * mix;
const ease = x => x * x * (3 - 2 * x);

/** cubic-bezier(1, 0, 1, 1): x(s) = 3s − 3s² + s³, y(s) = 3s² − 2s³. */
function climb(t) {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    let lo = 0, hi = 1;
    for (let i = 0; i < 24; i++) {
        const s = (lo + hi) / 2;
        if (3 * s - 3 * s * s + s * s * s < t) lo = s; else hi = s;
    }
    const s = (lo + hi) / 2;
    return 3 * s * s - 2 * s * s * s;
}

function moveDuration(rows) {
    return Math.min(3000, Math.max(256, (rows / 10 + 1) * 512));
}

function awardsScene(screen) { return screen === 'teamAward' || screen === 'teamList'; }

const tierOf = award => /(?:^|[- ])(gold|silver|bronze)(?:$|[- ])/i.exec(award?.id || '')?.[1]?.toLowerCase()
    || /^(gold|silver|bronze)\b/i.exec(award?.citation || '')?.[1]?.toLowerCase()
    || /^(金|银|铜)[奖牌]/.exec(award?.citation || '')?.[1]?.replace('金', 'gold').replace('银', 'silver').replace('铜', 'bronze') || null;

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

/**
 * The CCPCOJ-style resolvers on one Canvas 2D surface. Generation 1 follows the CCPCOJ rank
 * roll, generation 2 the CCPCOJ-2 card stage; both show the whole board, mark the judging
 * team, turn its problem chip to the verdict before the team moves to its place, and open the
 * opening, awards and podium over the board. Ranking, selection and seek checkpoints come from
 * the original ResolverView without a surface.
 */
export class ResolverViewCcpcoj {
    constructor(canvas, game, generation = 1) {
        this.canvas = canvas;
        this.game = game;
        this.generation = generation === 2 ? 2 : 1;
        this.kind = this.generation === 2 ? 'ccpcoj2' : 'ccpcoj';
        this.theme = this.generation === 2 ? modern : classic;
        this.ctx = canvas.getContext('2d', { alpha: false });
        if (!this.ctx) throw new Error('Canvas 2D unavailable');
        this.board = new ResolverView(null, game);
        this.options = this.board.options;
        this.teams = game.contest.teams || [];
        this.problems = game.contest.problems || [];
        this.teamOf = new Map(this.teams.map(team => [team.id, team]));
        this.organizations = new Map((game.contest.organizations || []).map(org => [org.id, org]));
        this.title = game.contest.formalName || game.contest.name || 'ICPC';
        // Medal zones by rank, as many places as each medal has winners (positions only, no names).
        const counts = { gold: 0, silver: 0, bronze: 0 };
        for (const award of game.contest.awards || []) {
            const tier = tierOf(award);
            if (tier && /medal|^(gold|silver|bronze)/i.test(award.id || award.citation || '')) counts[tier] += award.teamIds?.length || 0;
        }
        this.zones = [['gold', counts.gold], ['silver', counts.gold + counts.silver], ['bronze', counts.gold + counts.silver + counts.bronze]];
        this.summary = {
            title: this.title, teams: this.teams.length, problems: this.problems.length, medals: counts,
            schools: new Set(this.teams.map(team => team.organizationName).filter(Boolean)).size,
            freezeMinutes: Math.round((game.contest.freezeDurationMs || 0) / 60000),
        };
        this.images = new Map();
        this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
        this.elapsed = 0;
        this.sound = false;
        this.resetCue();
        this.onResize = () => this.resize();
        window.addEventListener('resize', this.onResize);
        window.addEventListener('resolver-display', this.onResize);
        this.resize();
        this.fonts = initFonts('zh-CN').then(() => this.markFrame());
    }

    ready() { return this.fonts; }

    resetCue() {
        this.act = this.options.startScreen === 'scoreboard' ? 3 : 1;
        this.revelation = null;
        this.scrolling = false;
        this.finalAwards = [];
        this.motion = null;
        this.rankChange = null;
        this.recent = null;
        this.pick = null;
        this.tween = null;
        this.shownScroll = null;
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
                this.recent = step.teamId;
                break;
        }
    }

    applyStep(step, { instant = false } = {}) {
        if (!step) return;
        const resolves = step.type === 'resolve', scrolls = step.type === 'scroll';
        const before = this.board.stageState();
        const lastAct = this.act;
        const animate = !instant && !this.reduced;
        const start = this.shownScroll ?? this.windowFor(before, this.focusOf(before).team?.id);
        const order = resolves && animate ? before.order.slice() : before.order;
        const cellsBefore = resolves && animate ? (before.results[step.teamId] || []).slice() : null;
        const previous = resolves ? before.standings.get(step.teamId) : null;
        this.board.applyStep(step, { instant });
        if (instant) this.board.finishReplay();
        if (step.type === 'pause' || step.type === 'delay') return;
        this.cue(step);
        const state = this.board.stageState();
        if (lastAct !== this.act || before.screen !== state.screen) this.elapsed = instant ? 1400 : 0;
        this.pick = step.type === 'selectSubmission' && animate ? { clock: 0 } : null;
        if (resolves) {
            const score = state.standings.get(step.teamId);
            this.rankChange = previous?.rank && score?.rank ? { from: previous.rank, to: score.rank } : null;
            const rows = Math.abs(order.indexOf(step.teamId) - state.order.indexOf(step.teamId));
            const speed = Math.max(.4, Math.min(12, Number(step.speedMultiplier) || 1));
            this.motion = animate ? {
                kind: 'resolve', start, before: order, standings: before.standings, cells: cellsBefore,
                teamId: step.teamId, clock: 0, speed, moving: rows > 0, moveMs: moveDuration(rows),
            } : null;
        } else if (animate && scrolls) {
            const rows = Math.abs(this.windowFor(state, this.focusOf(state).team?.id) - start);
            this.motion = { kind: 'scroll', start, clock: 0, moveMs: moveDuration(rows), speed: Math.max(.5, Math.min(12, Number(step.speedMultiplier) || 1)) };
        } else if (step.type !== 'selectTeam' || this.motion?.kind !== 'scroll') {
            this.motion = null;
        }
        if (instant) { this.tween = null; this.shownScroll = null; }
        if (this.act === 4 && lastAct !== 4) this.chime('finale', instant);
        this.markFrame();
    }

    seek(steps, target) {
        this.board.seek(steps, target);
        this.resetCue();
        for (let i = 0; i <= target && i < steps.length; i++) this.cue(steps[i]);
        this.elapsed = 1400;
        this.markFrame();
    }

    focusOf(state) {
        if (this.scrolling || this.act === 4) return {};
        const selected = state.submission || this.revelation;
        const team = this.teamOf.get(selected?.teamId || state.selected[0]);
        return { team, problemIndex: selected?.problemIndex };
    }

    /** The first visible row: the session's scroll, moved to keep the judging team in view with two rows below it. */
    windowFor(state, id) {
        const count = this.L.count;
        const end = Math.max(0, state.order.length - count);
        let start = Math.min(end, Math.max(0, Number(state.scroll) || 0));
        if (!id) return start;
        const index = state.order.indexOf(id);
        const below = Math.min(2, Math.floor(count / 4));
        if (index >= 0) start = Math.min(end, Math.max(0, Math.min(index, Math.max(start, index - count + 1 + below))));
        return start;
    }

    medalOf(rank) {
        if (!rank) return null;
        for (const [tier, last] of this.zones) if (rank <= last) return tier;
        return null;
    }

    boardFrame(state, flip, travel) {
        const focus = this.focusOf(state);
        const from = this.motion;
        const destination = this.windowFor(state, focus.team?.id);
        const mix = from ? travel : 1;
        let scroll;
        if (from) {
            scroll = between(from.start, destination, mix);
            this.tween = null;
        } else {
            if (this.shownScroll != null && Math.abs(this.shownScroll - destination) > .001 && this.tween?.to !== destination && !this.reduced) {
                this.tween = { from: this.shownScroll, to: destination, clock: 0 };
            }
            scroll = this.tween ? between(this.tween.from, this.tween.to, ease(unit(this.tween.clock / SCROLL_MS))) : destination;
        }
        this.shownScroll = scroll;
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
            const early = from?.before && flip < .5;
            const shownRank = from?.standings && (flip < .5 || mix < 1) ? from.standings.get(id)?.rank : state.standings.get(id)?.rank;
            const judging = focus.team?.id === id;
            rows.push({
                id, index, position, rank: shownRank, medal: this.medalOf(shownRank),
                score: early ? from.standings.get(id) : state.standings.get(id),
                cells: early && id === from.teamId ? from.cells : null,
                judging, recent: !judging && this.recent === id,
            });
        }
        // The judging row is painted last so it passes over the rows it overtakes.
        rows.sort((a, b) => Number(a.judging) - Number(b.judging) || a.position - b.position);
        return { rows, state, problemIndex: focus.problemIndex, focus, showSchool: this.options.showSchool !== false };
    }

    awardInfo(state) {
        const team = this.teamOf.get(state.award?.teamId || state.selected[0]);
        const awards = state.award?.awards || [];
        const medal = awards.find(award => award.awardType === 'medal' || tierOf(award));
        const lead = medal || awards[0];
        const score = state.standings.get(team?.id);
        const cells = state.results[team?.id] || [];
        const firsts = cells.flatMap((cell, p) => cell?.status === 'solved' && cell.firstToSolve ? [this.problems[p]?.label] : []);
        const others = awards.filter(award => award !== lead).map(award => award.citation).filter(Boolean);
        const rank = score?.rank || (team ? '*' : '');
        return {
            team, medal: medal ? tierOf(medal) : null, title: lead?.citation || '获奖', others,
            rank, solved: score?.solved ?? 0, firsts: firsts.join(', '),
            rows: [['单位', team?.organizationName], ['队伍', teamName(team)], ['名次', rank],
                ['首答', firsts.join(', ')], ['题数', score?.solved ?? ''], ['奖项', others.join('、')]],
        };
    }

    image(src) {
        if (!src || src === DEFAULT_SCHOOL_LOGO) return null;
        let img = this.images.get(src);
        if (!img) {
            img = new Image();
            img.crossOrigin = 'anonymous';
            img.onload = () => this.markFrame();
            img.src = src;
            if (this.images.size >= 64) {
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
            const duration = resolving ? FLIP_MS + (this.motion.moving ? this.motion.moveMs : 0) + SETTLE_MS : this.motion.moveMs;
            if (resolving && before < FLIP_MS / 2 && this.motion.clock >= FLIP_MS / 2) this.chime(this.revelation?.status);
            if (this.motion.clock >= duration) this.motion = null;
            this.dirty = true;
        }
        if (this.tween) {
            this.tween.clock += dt;
            if (this.tween.clock >= SCROLL_MS) this.tween = null;
            this.dirty = true;
        }
        if (this.pick && this.pick.clock < FLICKER_MS) {
            const step = Math.floor(this.pick.clock / 200);
            this.pick.clock += dt;
            if (Math.floor(this.pick.clock / 200) !== step) this.dirty = true;
        }
        if (this.reduced) return;
        const state = this.board.stageState();
        const dialogOpen = this.act !== 3 || awardsScene(state.screen);
        // Generation 2 breathes the glow of a problem waiting to turn.
        const waiting = this.generation === 2 && this.act === 3 && !!state.submission && !this.revelation;
        const key = dialogOpen && this.elapsed <= 1400 ? 'enter' + this.elapsed
            : this.act === 4 ? 'cycle' + Math.floor(this.elapsed / 3600)
                : awardsScene(state.screen) ? 'page' + Math.floor(this.elapsed / 5200)
                    : waiting ? 'wait' + Math.floor(this.elapsed / 33) : null;
        if (key !== this.lastDraw) this.dirty = true;
        this.lastDraw = key;
    }

    render() {
        if (!this.dirty) return;
        this.dirty = false;
        const { ctx, L } = this, state = this.board.stageState(), motion = this.motion;
        const flip = motion?.kind === 'resolve' ? unit(motion.clock / FLIP_MS) : this.revelation ? 1 : 0;
        const travel = motion?.kind === 'resolve' ? motion.moving ? climb(unit((motion.clock - FLIP_MS) / motion.moveMs)) : 1
            : motion ? climb(unit(motion.clock / motion.moveMs)) : 1;
        const frame = this.boardFrame(state, flip, travel);
        const fx = {
            solid: !!this.pick && this.pick.clock < FLICKER_MS && Math.floor(this.pick.clock / 200) % 2 === 1,
            glow: motion?.kind === 'resolve' && flip < 1 ? Math.sin(Math.PI * flip) : 0,
            pulse: this.reduced || this.revelation ? 0 : .5 + .5 * Math.sin(this.elapsed / 260),
        };
        const { board, openingCard, awardCard, teamListCard, podiumCard } = this.theme;
        const dialog = this.reduced ? 1 : unit(this.elapsed / DIALOG_MS);

        ctx.setTransform(this.canvas.width / L.width, 0, 0, this.canvas.height / HEIGHT, 0, 0);
        ctx.globalAlpha = 1;
        board(ctx, L, frame, this.teamOf, this.problems, team => this.logo(team), fx);
        if (this.act === 1) openingCard(ctx, L, this.summary, dialog);
        // The generation 2 curtain lifts off the board as the session leaves the opening.
        if (this.act === 2 && this.generation === 2 && !this.reduced && this.elapsed < 700) openingCard(ctx, L, this.summary, 1, ease(unit(this.elapsed / 700)));
        if (this.act === 3 && state.screen === 'teamAward') {
            const info = this.awardInfo(state);
            awardCard(ctx, L, info, dialog, this.image(info.team?.photo), this.logo(info.team), this.summary);
        }
        if (this.act === 3 && state.screen === 'teamList') {
            const prize = state.award?.awards?.[0];
            const ids = prize?.teamIds?.length ? prize.teamIds : state.selected;
            const entries = ids.map(id => this.teamOf.get(id)).filter(Boolean)
                .map(team => ({ title: teamName(team), detail: team.organizationName || '' }));
            teamListCard(ctx, L, prize?.citation || '获奖队伍', entries, dialog, Math.floor(this.elapsed / 5200));
        }
        if (this.act === 4) {
            const winners = podiumWinners(state, this.finalAwards);
            const progress = [500, 250, 0].map(delay => this.reduced ? 1 : unit((this.elapsed - DIALOG_MS - delay) / 450));
            podiumCard(ctx, L, winners, this.teamOf, team => this.logo(team), Math.floor(this.elapsed / 3600), dialog, progress, this.summary);
        }

        const problem = this.problems[frame.problemIndex];
        const phase = motion?.kind === 'resolve' ? flip < .5 ? 'turning' : travel < 1 ? 'rising' : 'result'
            : problem ? this.revelation ? 'result' : 'pending' : '';
        this.canvas.dataset.reveal = phase;
        const labels = [acts[this.act - 1]];
        if (frame.focus.team) labels.push(teamName(frame.focus.team));
        if (problem) labels.push(problem.label, this.revelation && flip >= .5 ? this.revelation.status === 'solved' ? '通过' : '未通过' : '待揭晓');
        const description = labels.join(' · ');
        if (this.canvas.getAttribute('aria-description') !== description) this.canvas.setAttribute('aria-description', description);
    }

    resize() {
        const logicalWidth = Math.max(1080, Math.min(5760, Number(this.canvas.dataset.logicalWidth) || 1920));
        const dims = renderDimensions(logicalWidth, this.canvas.dataset.resolution || readDisplaySettings().resolution);
        this.L = this.theme.stageLayout(logicalWidth, this.options.rowsPerScreen, this.teams.length, this.problems.length);
        if (this.canvas.width !== dims.width) this.canvas.width = dims.width;
        if (this.canvas.height !== dims.height) this.canvas.height = dims.height;
        this.tween = null;
        this.shownScroll = null;
        this.markFrame();
    }

    debugState() { return { ...this.board.debugState(), act: this.act, renderer: this.kind }; }

    dispose() {
        window.removeEventListener('resize', this.onResize);
        window.removeEventListener('resolver-display', this.onResize);
        this.board?.dispose();
        for (const img of this.images?.values() || []) img.onload = null;
        this.images?.clear();
        this.audio?.close().catch(() => {});
    }
}
