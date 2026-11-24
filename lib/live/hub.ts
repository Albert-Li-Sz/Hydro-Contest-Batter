/**
 * One contest's ICPC Live backend: the DataBus, services and controllers of ICPC Live v3
 * (backend Application.kt / ServiceRoot.kt / Controllers.kt, MIT) in one Node object.
 */
import { FirstSolveBulletin, medalCutoff, problemFocus } from './broadcast';
import { awardsFor } from '../settings';
import { buildContestInfo, buildRuns, firstSolveRuns, type LiveSource } from './model';
import { liveOverview, overviewKey, type LiveOverview } from './overview';
import {
    computeScoreboard, runsByTeam, scoreboardDiff, standingsAtRuns, statistics, timeline, type ScoreboardState,
} from './scoreboard';
import { AnalyticsService, chineseAnalyticsTemplates, QueueService, SpotlightService } from './services';
import type { ContestInfo, OptimismLevel, RunInfo, TeamInfo } from './types';
import { optimismLevels } from './types';
import {
    ApiActionError, generateId, PresetsController, type PresetId, type PresetState, ShowOrderCounter, TickerManager, type TickerMessage, type Widget,
    WidgetController, WidgetManager,
} from './widgets';
import * as S from './widget-settings';
import { stateEntries, type FeaturedSelection, type LiveState, type LiveStateEntries, type LiveStatePatch } from './state';
export type { LiveState } from './state';

type Listener = (payload: unknown) => void;

export interface HubDependencies {
    load: () => Promise<LiveSource | null>;
    persist: (patch: LiveStatePatch) => Promise<number>;
    /** SVG title templates by media name. */
    template: (name: string) => Promise<string | null>;
    /** Tell the other Hydro processes about an in-memory change (spotlight scores, commentary marks, templates). */
    announce?: (kind: 'template' | 'spotlight' | 'social' | 'mark', payload: unknown) => void;
    intervalMs?: number;
    idleMs?: number;
}

const camel = (position: string) => position.split('_').map((part) => part[0] + part.slice(1).toLowerCase()).join('');

const escapeHtml = (value: string) => value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** TemplateSubstitutorImpl: `{a.b}` is replaced escaped, `{!a.b}` raw, unknown keys stay. */
export function substituteTemplate(template: string, data: Record<string, unknown>, sanitize: (value: string) => string = escapeHtml) {
    const lookup = (key: string) => {
        let value: unknown = data;
        for (const part of key.split('.')) {
            if (Array.isArray(value)) value = value[Number(part)];
            else if (value && typeof value === 'object') value = (value as Record<string, unknown>)[part];
            else return null;
            if (value === undefined) return null;
        }
        if (value === null || value === undefined) return null;
        return typeof value === 'object' ? JSON.stringify(value) : String(value);
    };
    return template.replace(/\{(!?[a-z0-9A-Z_.-]*)}/g, (match, key: string) => {
        if (key.startsWith('!')) return lookup(key.slice(1)) ?? match;
        const value = lookup(key);
        return value === null ? match : sanitize(value);
    });
}

const tickerPrefix: Record<string, string> = {
    clock: 'ticker_clock', empty: 'ticker_empty', image: 'ticker_image', scoreboard: 'ticker_scoreboard', text: 'ticker_text',
};

/** The admin route of a controller, as the consoles match it in adminActions. */
const adminPath = (name: string) => {
    const [head, position] = name.split('/');
    if (head !== 'teamView' || !position) return name;
    if (position.startsWith('PVP_')) return `teamPVP/${position}`;
    return position === 'SINGLE' ? `teamView/${position}` : `splitScreen/${position}`;
};

export class LiveHub {
    /** What the overlay may show (no teams before the start, like the public board). */
    info: ContestInfo | null = null;
    /** What the director sees: always the full team list, so views can be prepared before the start. */
    adminInfo: ContestInfo | null = null;
    private firstSolves = new FirstSolveBulletin();
    private infoJson = '';
    private adminInfoJson = '';
    private runs = new Map<string, RunInfo>();
    private featuredRun: FeaturedSelection | null = null;
    private displayedFeature: { id: string; signature: string } | null = null;
    private byTeam = new Map<string, RunInfo[]>();
    private scoreboards = new Map<OptimismLevel, ScoreboardState>();
    private statisticsJson = '';
    private overview: LiveOverview | null = null;
    private overviewJson = '';
    private timelines = new Map<string, string>();
    private channels = new Map<string, Set<Listener>>();
    private logLines: string[] = [];
    private templates = new Map<string, string>();
    private spotTeams = new Map<string, string | null>();

    readonly widgets = new WidgetManager();
    readonly ticker = new TickerManager();
    private counter = new ShowOrderCounter();
    readonly queueService = new QueueService();
    readonly spotlight = new SpotlightService();
    readonly analytics: AnalyticsService;

    readonly controllers: Record<string, WidgetController<any, Widget>> = {};
    readonly teamViews: Record<S.TeamViewPosition, WidgetController<ReturnType<ReturnType<typeof S.teamViewSettings>>, Widget>>;
    readonly advertisement: PresetsController<ReturnType<typeof S.advertisementSettings>, Widget>;
    readonly picture: PresetsController<ReturnType<typeof S.pictureSettings>, Widget>;
    readonly title: PresetsController<ReturnType<typeof S.titleSettings>, Widget>;
    readonly tickerMessage: PresetsController<ReturnType<typeof S.tickerMessageSettings>, TickerMessage>;

    private broadcastScope = '';
    private timer: NodeJS.Timeout | null = null;
    private cleaner: NodeJS.Timeout | null = null;
    private spotlightTimer: NodeJS.Timeout | null = null;
    private rotationTimer: NodeJS.Timeout | null = null;
    private saveTimer: NodeJS.Timeout | null = null;
    private observed: LiveStateEntries = {};
    private pending: LiveStatePatch = {};
    private inFlight: LiveStatePatch = {};
    private saving: Promise<boolean> | null = null;
    private versions = new Map<string, number>();
    private remote = new Map<string, { revision: number; value: LiveStatePatch[string] }>();
    private applyingRemote: Promise<void> | null = null;
    private lastActivity = 0;
    private refreshing: Promise<void> | null = null;
    private disposed = false;
    readonly ready: Promise<void>;

    constructor(private deps: HubDependencies, state: LiveState = {}, private baseRevision = 0) {
        const changed = () => this.changed();
        const single = <T>(name: string, defaults: T, normalize: (input: unknown) => T, construct: (settings: T) => Widget | null, dynamic = false) => {
            const controller = new WidgetController<T, Widget>(defaults, this.widgets, this.counter, construct, (input) => normalize(input), changed, null, dynamic);
            this.controllers[name] = controller;
            return controller;
        };
        const fixed = (type: string, id: string) => (settings: unknown): Widget => ({ type, id, widgetLocationId: id, statisticsId: id, settings });
        single('queue', S.queueSettings({}), S.queueSettings, fixed('QueueWidget', 'queue'));
        single('statistics', {}, S.emptySettings, fixed('StatisticsWidget', 'statistics'));
        single('ticker', {}, S.emptySettings, fixed('TickerWidget', 'ticker'));
        single('scoreboard', S.scoreboardSettings({}), S.scoreboardSettings, fixed('ScoreboardWidget', 'scoreboard'));
        single('fullScreenClock', S.clockSettings({}), S.clockSettings, fixed('FullScreenClockWidget', 'fullScreenClock'));
        single('overview', S.overviewSettings({}), S.overviewSettings, fixed('ContestOverviewWidget', 'overview'));
        single('firstSolve', {}, S.emptySettings, () => {
            const items = this.firstSolves.items(Date.now());
            return items.length ? { ...fixed('FirstSolveWidget', 'firstSolve')({}), items } : null;
        }, true);
        single('medalCutoff', S.medalCutoffSettings({}), S.medalCutoffSettings, (settings) => {
            const board = this.scoreboards.get('normal');
            return this.info && this.info.status.type !== 'before' && board
                ? { ...fixed('MedalCutoffWidget', 'medalCutoff')(settings), data: medalCutoff(this.info, board, settings.group, settings.medal) } : null;
        }, true);
        single('problemFocus', S.problemFocusSettings({}), S.problemFocusSettings, (settings) => {
            const data = this.info && this.info.status.type !== 'before' && problemFocus(this.info, this.runs.values(), settings.problemId, this.controllers.scoreboard.status().settings.group);
            return data ? { ...fixed('ProblemFocusWidget', 'problemFocus')(settings), data } : null;
        }, true);
        single('teamLocator', S.locatorSettings({}), S.locatorSettings, (settings) => {
            const teams = new Set(this.info?.teams.map((team) => team.id) || []);
            return fixed('TeamLocatorWidget', 'teamLocator')({
                circles: settings.circles.filter((circle) => circle.teamId && teams.has(circle.teamId)),
                scene: settings.scene,
            });
        }, true);
        const teamViews = {} as typeof this.teamViews;
        for (const position of S.teamViewPositions) {
            const normalize = S.teamViewSettings(position);
            teamViews[position] = single(`teamView/${position}`, normalize({}), normalize, (settings) => this.teamViewWidget(position, settings), true);
        }
        this.teamViews = teamViews;
        const preset = <T>(normalize: (input: unknown) => T, construct: (settings: T) => Widget | null) =>
            new PresetsController<T, Widget>(this.widgets, this.counter, construct, (input) => normalize(input), changed);
        this.advertisement = preset(S.advertisementSettings, (advertisement) => {
            const id = generateId('advertisement');
            return { type: 'AdvertisementWidget', id, widgetLocationId: 'advertisement', statisticsId: 'advertisement', advertisement };
        });
        this.picture = preset(S.pictureSettings, (picture) => {
            const id = generateId('picture');
            return { type: 'PictureWidget', id, widgetLocationId: 'picture', statisticsId: 'picture', picture };
        });
        this.title = preset(S.titleSettings, (settings) => {
            const template = this.templates.get(settings.preset);
            if (template === undefined) throw new ApiActionError(`Title template ${settings.preset} is not loaded`);
            const content = `data: image/svg+xml; utf8; base64,${Buffer.from(this.renderTitle(template, settings.data)).toString('base64')}`;
            return { type: 'SvgWidget', id: generateId('svg'), widgetLocationId: 'svg', statisticsId: 'svg', content };
        });
        this.tickerMessage = new PresetsController(this.ticker, this.counter,
            (settings) => ({ id: generateId(tickerPrefix[settings.type]), settings }),
            (input) => S.tickerMessageSettings(input), changed);
        this.analytics = new AnalyticsService(chineseAnalyticsTemplates, {
            showAdvertisement: (text, ttl, onExpire) => {
                const id = this.advertisement.createTemporary({ text }, ttl, onExpire);
                this.advertisement.show(id);
                return id;
            },
            hideAdvertisement: (id) => { try { this.advertisement.hide(id); } catch { /* already gone */ } },
            showTicker: (text, ttl, onExpire) => {
                const id = this.tickerMessage.createTemporary({ type: 'text', part: 'long', periodMs: 30_000, text }, ttl, onExpire);
                this.tickerMessage.show(id);
                return id;
            },
            hideTicker: (id) => { try { this.tickerMessage.hide(id); } catch { /* already gone */ } },
            marked: (messageId, commentId, field, value) => this.deps.announce?.('mark', { messageId, commentId, field, value }),
        });
        this.queueService.subscribe((event) => this.publish('queue', event));
        this.spotlight.onChange(() => this.publishInteresting());
        this.ready = this.restore(state).then(() => {
            this.observed = structuredClone(stateEntries(this.state()));
            for (const [key, value] of Object.entries(stateEntries(state))) {
                if (key.startsWith('preset/') && typeof (value as PresetState<unknown>).expiresAt === 'number'
                    && (value as PresetState<unknown>).expiresAt! <= Date.now()) this.pending[key] = null;
            }
            if (Object.keys(this.pending).length) this.scheduleSave();
        });
    }

    private async restore(state: LiveState) {
        this.featuredRun = state.featuredRun ?? null;
        const titles = Array.isArray(state.presets?.title) ? state.presets!.title : [];
        for (const item of titles) {
            const name = (item?.settings as { preset?: unknown } | undefined)?.preset;
            if (typeof name === 'string') await this.loadTemplate(name).catch(() => null);
        }
        for (const [name, controller] of Object.entries(this.controllers)) controller.load(state.controllers?.[name]);
        this.advertisement.load(state.presets?.advertisement);
        this.picture.load(state.presets?.picture);
        this.title.load(titles);
        this.tickerMessage.load(state.presets?.tickerMessage);
    }

    /** Apply committed entries only. Local unsaved changes keep their place until saved. */
    async reload(patch: LiveStatePatch, revision: number) {
        await this.ready;
        if (this.disposed) return;
        for (const [key, value] of Object.entries(patch)) {
            if (revision <= (this.versions.get(key) ?? this.baseRevision) || revision <= (this.remote.get(key)?.revision ?? -1)) continue;
            this.remote.set(key, { revision, value });
        }
        await this.applyRemote();
    }

    private applyRemote(): Promise<void> {
        if (this.applyingRemote) return this.applyingRemote;
        this.applyingRemote = this.drainRemote().finally(() => { this.applyingRemote = null; });
        return this.applyingRemote;
    }

    private async drainRemote() {
        while (!this.disposed) {
            const available = [...this.remote].find(([key]) => !(key in this.pending) && !(key in this.inFlight));
            if (!available) return;
            const [key, change] = available;
            if (key.startsWith('preset/title/') && change.value) {
                const name = (change.value.settings as { preset?: string })?.preset;
                if (typeof name === 'string') await this.loadTemplate(name).catch(() => null);
            }
            // Loading a title may yield to another update, or a local edit.
            if (this.disposed) return;
            if (key in this.pending || key in this.inFlight) continue;
            if (this.remote.get(key) !== change) continue;
            this.remote.delete(key);
            if (change.revision <= (this.versions.get(key) ?? this.baseRevision)) continue;
            const before = this.observed[key];
            let uri = '';
            if (key === 'featuredRun') {
                this.featuredRun = change.value?.settings as FeaturedSelection ?? null;
                this.syncFeatured();
                uri = '/api/admin/analytics';
            } else if (key.startsWith('controller/')) {
                const name = key.slice(11);
                this.controllers[name]?.load(change.value);
                uri = `/api/admin/${adminPath(name)}`;
            } else if (key.startsWith('preset/')) {
                const [, name, idText] = key.split('/');
                const presets = this.presetControllers()[name];
                const id = /^\d+$/.test(idText) ? Number(idText) : idText;
                presets?.apply(id, change.value as PresetState<unknown> | null);
                uri = `/api/admin/${name}`;
            }
            this.versions.set(key, change.revision);
            this.observed = structuredClone(stateEntries(this.state()));
            if (uri && JSON.stringify(before) !== JSON.stringify(this.observed[key])) this.publish('adminActions', uri);
        }
    }

    private presetControllers(): Record<string, typeof this.advertisement | typeof this.picture | typeof this.title | typeof this.tickerMessage> {
        return { advertisement: this.advertisement, picture: this.picture, title: this.title, tickerMessage: this.tickerMessage };
    }

    /** A media file was uploaded again: titles using it are drawn with the new template. */
    async templateChanged(name: string, remote = false) {
        this.forgetTemplate(name);
        if (!remote) this.deps.announce?.('template', name);
        if (!this.title.persistentState.some((item) => item.settings.preset === name)) return;
        await this.loadTemplate(name).catch(() => null);
        this.title.resync((settings) => settings.preset === name);
    }

    /** Spotlight score requests (admin teamSpotlight/addScore), shared with the other processes. */
    addScores(requests: { teamId: string; score: number }[], remote = false) {
        for (const request of requests) this.spotlight.addScore(request.teamId, request.score);
        if (!remote) this.deps.announce?.('spotlight', requests);
    }

    /** A commentary mark made in another process. */
    applyMark(payload: { messageId: string; commentId: string; field: 'advertisement' | 'tickerMessage'; value: { presetId: PresetId; expirationTimeUnixMs: number | null } | null }) {
        this.analytics.applyMark(payload.messageId, payload.commentId, payload.field, payload.value);
    }

    async loadTemplate(name: string) {
        if (this.templates.has(name)) return;
        const template = await this.deps.template(name);
        if (template === null) throw new ApiActionError(`No title template named ${name}`);
        this.templates.set(name, template);
    }

    forgetTemplate(name: string) { this.templates.delete(name); }

    private renderTitle(template: string, data: Record<string, string>) {
        const values: Record<string, unknown> = { ...data };
        // A title is drawn here, so it may name a team before the start if the director chose to.
        const team = data.teamId ? this.adminInfo?.teams.find((item) => item.id === data.teamId) : undefined;
        const org = (id?: string | null) => (id ? this.adminInfo?.organizations.find((item) => item.id === id) : undefined);
        if (team) {
            values.team = { ...team, fullName: team.name, displayName: team.shortName };
            if (org(team.organizationId)) values.org = org(team.organizationId);
        }
        if (data.organizationId && org(data.organizationId)) values.org = org(data.organizationId);
        return substituteTemplate(template, values);
    }

    private teamViewWidget(position: S.TeamViewPosition, settings: ReturnType<ReturnType<typeof S.teamViewSettings>>): Widget | null {
        const info = this.info;
        if (!info) return null;
        const teamId = settings.teamId ?? this.spotTeam(position);
        const team = teamId ? info.teams.find((item) => item.id === teamId) : undefined;
        if (!team) return null;
        const content = settings.mediaTypes.map((type) => team.medias[type]).filter(Boolean);
        const id = `teamView${camel(position)}`;
        return {
            type: 'TeamViewWidget', id, widgetLocationId: id, statisticsId: 'teamView',
            settings: {
                teamId: team.id, primary: content[0] || [], secondary: content[1] || [], showTaskStatus: settings.showTaskStatus,
                achievement: settings.showAchievement ? team.medias.achievement || [] : [], showTimeLine: settings.showTimeLine, position,
            },
        };
    }

    // ---- persistence -------------------------------------------------------------------

    private changed() {
        const next = stateEntries(this.state());
        for (const key of new Set([...Object.keys(this.observed), ...Object.keys(next)])) {
            if (JSON.stringify(this.observed[key]) !== JSON.stringify(next[key])) this.pending[key] = structuredClone(next[key] ?? null);
        }
        this.observed = structuredClone(next);
        this.scheduleSave();
    }

    private scheduleSave() {
        if (this.saveTimer || this.saving || this.disposed) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.flush();
        }, 500);
        this.saveTimer.unref?.();
    }

    private flush(): Promise<boolean> {
        if (this.saving) return this.saving;
        if (!Object.keys(this.pending).length) return Promise.resolve(true);
        const patch = this.pending;
        this.pending = {};
        this.inFlight = patch;
        this.saving = (async () => {
            try {
                const revision = await this.deps.persist(patch);
                for (const key of Object.keys(patch)) this.versions.set(key, Math.max(revision, this.versions.get(key) ?? this.baseRevision));
                return true;
            } catch (error) {
                // Keep newer edits and retry the failed fields, without overwriting unrelated state.
                this.pending = { ...patch, ...this.pending };
                this.log(`保存直播控件状态失败：${(error as Error)?.message || error}`);
                return false;
            } finally {
                this.inFlight = {};
                this.saving = null;
                await this.applyRemote();
                if (Object.keys(this.pending).length) this.scheduleSave();
            }
        })();
        return this.saving;
    }

    state(): LiveState {
        return {
            featuredRun: this.featuredRun,
            controllers: Object.fromEntries(Object.entries(this.controllers).map(([name, controller]) => [name, controller.persistentState])),
            presets: {
                advertisement: this.advertisement.persistentState,
                picture: this.picture.persistentState,
                title: this.title.persistentState,
                tickerMessage: this.tickerMessage.persistentState,
            },
        };
    }

    // ---- channels ----------------------------------------------------------------------

    private publish(channel: string, payload: unknown) {
        const listeners = this.channels.get(channel);
        if (!listeners) return;
        for (const listener of listeners) listener(payload);
    }

    private interestingTeams() {
        return (this.adminInfo?.teams || []).map((team: TeamInfo) => ({ teamId: team.id, teamName: team.name, score: this.spotlight.score(team.id) }));
    }

    private interestingQueued = false;
    private publishInteresting() {
        if (this.interestingQueued || !this.channels.get('teamSpotlight')?.size) return;
        this.interestingQueued = true;
        setTimeout(() => {
            this.interestingQueued = false;
            this.publish('teamSpotlight', this.interestingTeams());
        }, 500).unref?.();
    }

    /** First value of a channel, for the plain-HTTP variants of the flow endpoints. */
    current(channel: string): unknown {
        const [name, argument] = channel.split(':');
        switch (name) {
        case 'contestInfo': return this.info;
        case 'admin': return argument === 'contestInfo' ? this.adminInfo : null;
        case 'runs': return [...this.runs.values()].sort((a, b) => a.time - b.time);
        case 'teamRuns': return timeline(this.byTeam.get(argument) || []);
        case 'statistics': return this.info && this.scoreboards.get('normal') ? statistics(this.info, this.scoreboards.get('normal')!, this.runs.values()) : { type: 'ICPC', teamsCount: 0, stats: [], verdictCounts: {} };
        case 'overview': return this.overview;
        case 'scoreboard': {
            const state = this.scoreboards.get(argument as OptimismLevel);
            return state ? scoreboardDiff(state) : { rows: {}, order: [], ranks: [], awards: [] };
        }
        case 'teamSpotlight': return this.interestingTeams();
        case 'analytics': return this.analytics.list();
        default: return null;
        }
    }

    /** Subscribe to a channel; the listener first receives what a new subscriber upstream gets. */
    subscribe(channel: string, listener: Listener) {
        this.touch();
        let unsubscribe: () => void;
        const [name] = channel.split(':');
        if (name === 'mainScreen') unsubscribe = this.widgets.subscribe(listener);
        else if (name === 'ticker') unsubscribe = this.ticker.subscribe(listener);
        else if (name === 'queue') unsubscribe = this.queueService.subscribe(listener);
        else if (name === 'analytics') unsubscribe = this.analytics.subscribe(listener);
        else {
            if (name === 'backendLog') for (const line of this.logLines) listener(line);
            else if (!['adminActions', 'social'].includes(name)) {
                const value = this.current(channel);
                if (value !== null) listener(value);
            }
            let listeners = this.channels.get(channel);
            if (!listeners) this.channels.set(channel, listeners = new Set());
            listeners.add(listener);
            unsubscribe = () => listeners!.delete(listener);
        }
        this.subscribers++;
        let done = false;
        return () => {
            if (done) return;
            done = true;
            this.subscribers--;
            unsubscribe();
            if (this.channels.get(channel)?.size === 0) {
                this.channels.delete(channel);
                this.timelines.delete(channel);
            }
            this.lastActivity = Date.now();
        };
    }

    private subscribers = 0;

    private mediaFor(runId: string, mediaType: string) {
        const run = this.runs.get(runId);
        if (!run || run.isHidden) return [];
        if (mediaType === 'reactionVideo') return run.reactionVideos;
        return this.info?.teams.find((team) => team.id === run.teamId)?.medias[mediaType] ?? [];
    }

    selectRun(runId: string, mediaType: string | null) {
        if (!this.runs.has(runId)) throw new ApiActionError(`Unknown submission ${runId}`);
        if (mediaType === null && this.featuredRun?.runId !== runId) return;
        if (mediaType !== null && !this.mediaFor(runId, mediaType).length) {
            throw new ApiActionError(`该队伍没有${mediaType === 'camera' ? '摄像头' : mediaType === 'screen' ? '屏幕' : mediaType}画面，无法使用 Featured run`);
        }
        this.featuredRun = mediaType === null ? null : {
            runId, mediaType, expiresAt: Date.now() + this.info!.queueSettings.featuredRunWaitTimeSeconds * 1000,
        };
        this.syncFeatured();
        this.changed();
    }

    private syncFeatured() {
        const selection = this.featuredRun;
        const media = selection && selection.expiresAt > Date.now() ? this.mediaFor(selection.runId, selection.mediaType) : [];
        const signature = media.length ? JSON.stringify([selection, media]) : '';
        if (signature === (this.displayedFeature?.signature ?? '')) return;
        if (this.displayedFeature) {
            this.queueService.unfeature(this.displayedFeature.id);
            this.analytics.setFeatured(this.displayedFeature.id, null);
            this.displayedFeature = null;
        }
        if (selection && media.length && this.queueService.feature(selection.runId, media)) {
            this.analytics.setFeatured(selection.runId, { expirationTimeUnixMs: selection.expiresAt, mediaType: media });
            this.displayedFeature = { id: selection.runId, signature };
        }
    }

    /** How long nobody has watched or used this contest's live module. */
    idleFor(now = Date.now()) { return this.subscribers ? 0 : now - this.lastActivity; }

    log(line: string) {
        const entry = `${new Date().toISOString()} ${line}`;
        this.logLines.push(entry);
        if (this.logLines.length > 500) this.logLines.shift();
        this.publish('backendLog', entry);
    }

    adminAction(uri: string, user: string) {
        this.log(`Changing request ${uri} is done by ${user}`);
        this.publish('adminActions', uri);
    }

    social(message: { chatmessage: string; chatname: string; type: string; teamIds: string[] }, remote = false) {
        this.spotlight.social(message.teamIds);
        this.publish('social', message);
        if (!remote) this.deps.announce?.('social', message);
    }

    // ---- data --------------------------------------------------------------------------

    /** Keep polling while someone watches, and for a while after the last request. */
    touch() {
        this.lastActivity = Date.now();
        if (!this.timer && !this.disposed) this.loop();
    }

    /** Every 2 seconds during the contest; before and after it changes are rare (rejudges, unfreezing). */
    private interval() {
        if (this.deps.intervalMs) return this.deps.intervalMs;
        return this.info?.status.type === 'running' ? 2000 : 5000;
    }

    private loop() {
        const tick = async () => {
            this.timer = null;
            if (this.disposed) return;
            if (!this.subscribers && Date.now() - this.lastActivity > (this.deps.idleMs ?? 60_000)) {
                this.stopTimers();
                return;
            }
            await this.refresh().catch((error) => this.log(`读取比赛数据失败：${error?.message || error}`));
            if (!this.disposed) {
                this.timer = setTimeout(tick, this.interval());
                this.timer.unref?.();
            }
        };
        this.timer = setTimeout(tick, 0);
        this.timer.unref?.();
        if (!this.cleaner) {
            this.cleaner = setInterval(() => {
                this.syncFeatured();
                this.queueService.clean(this.info);
                if (this.controllers.firstSolve.shown) this.controllers.firstSolve.sync();
            }, 1000);
            this.cleaner.unref?.();
        }
        if (!this.spotlightTimer) {
            this.spotlightTimer = setInterval(() => {
                const state = this.scoreboards.get('normal');
                if (state && this.info) this.spotlight.pushScoreboard(state.ranking, this.info);
            }, this.spotlight.pushInterval);
            this.spotlightTimer.unref?.();
        }
        if (!this.rotationTimer) {
            // TeamViewController: a view without a team follows the spotlight, one team per 30 seconds.
            this.rotationTimer = setInterval(() => this.rotateSpotlight(), 30_000);
            this.rotationTimer.unref?.();
        }
    }

    private rotateSpotlight() {
        if (!this.info) return;
        for (const position of S.teamViewPositions) {
            const controller = this.teamViews[position];
            if (!controller.shown || controller.settings.teamId) continue;
            const next = this.spotlight.next(this.info);
            if (next) this.spotTeams.set(position, next);
            controller.sync();
        }
    }

    /** The team a view without its own team follows, picked on first use. */
    private spotTeam(position: S.TeamViewPosition) {
        let teamId = this.spotTeams.get(position) ?? null;
        if (!teamId && this.info) {
            teamId = this.spotlight.next(this.info) ?? this.info.teams[0]?.id ?? null;
            this.spotTeams.set(position, teamId);
        }
        return teamId;
    }

    private stopTimers() {
        for (const timer of [this.cleaner, this.spotlightTimer, this.rotationTimer]) if (timer) clearInterval(timer);
        this.cleaner = this.spotlightTimer = this.rotationTimer = null;
    }

    /** Load, diff and publish. Concurrent callers share one load. */
    refresh() {
        this.refreshing ||= this.doRefresh().finally(() => { this.refreshing = null; });
        return this.refreshing;
    }

    private async doRefresh() {
        await this.ready;
        const source = await this.deps.load();
        if (!source || this.disposed) return;
        this.apply(source);
    }

    /** Apply one snapshot of the contest (exposed for tests). */
    apply(source: LiveSource) {
        // 赛况总览 moves with the clock (elapsed time, recent runs), so it is rebuilt every refresh.
        const overview = liveOverview(source);
        const overviewJson = overviewKey(overview);
        this.overview = overview;
        if (overviewJson !== this.overviewJson) {
            this.overviewJson = overviewJson;
            this.publish('overview', overview);
        }
        const info = buildContestInfo(source);
        const runs = buildRuns(source, info);
        const infoJson = JSON.stringify(info);
        const infoChanged = infoJson !== this.infoJson;
        if (infoChanged) {
            this.info = info;
            this.infoJson = infoJson;
            this.publish('contestInfo', info);
        }
        const adminInfo = source.hidden ? buildContestInfo({ ...source, hidden: false }) : info;
        const adminInfoJson = adminInfo === info ? infoJson : JSON.stringify(adminInfo);
        if (adminInfoJson !== this.adminInfoJson) {
            this.adminInfo = adminInfo;
            this.adminInfoJson = adminInfoJson;
            this.publish('admin:contestInfo', adminInfo);
            this.publishInteresting();
        }
        const next = new Map(runs.map((run) => [run.id, run]));
        const changed = runs.filter((run) => JSON.stringify(this.runs.get(run.id)) !== JSON.stringify(run));
        const removed = [...this.runs.values()].filter((run) => !next.has(run.id)).map((run) => ({ ...run, isHidden: true }));
        this.runs = next;
        this.byTeam = runsByTeam(runs);
        const group = this.controllers.scoreboard.status().settings.group as string;
        const rules = awardsFor(source.settings, group);
        const scope = JSON.stringify([group, rules.firstSolve, rules.unofficialFirstSolve]);
        const newScope = scope !== this.broadcastScope;
        this.broadcastScope = scope;
        if (!changed.length && !removed.length && !infoChanged && !newScope && this.scoreboards.size) return;
        for (const level of optimismLevels) {
            const previous = this.scoreboards.get(level);
            const state = computeScoreboard(info, this.byTeam, level);
            this.scoreboards.set(level, state);
            const diff = scoreboardDiff(state, previous);
            if (!previous || Object.keys(diff.rows).length || JSON.stringify(previous.ranking) !== JSON.stringify(state.ranking)) {
                this.publish(`scoreboard:${level}`, diff);
            }
        }
        const normal = this.scoreboards.get('normal')!;
        const field = group === 'all' ? info.teams : info.teams.filter((team) => team.groups.includes(group));
        this.firstSolves.update(info, firstSolveRuns(runs, field, rules), this.controllers.firstSolve.shown, newScope, Date.now());
        if (!infoChanged) for (const id of ['firstSolve', 'medalCutoff', 'problemFocus']) this.controllers[id].sync();
        if (removed.length) this.analytics.remove(removed.map((run) => run.id));
        const history = standingsAtRuns(info, runs, new Set(changed.map((run) => run.id)));
        for (const run of [...removed, ...changed]) {
            this.queueService.onRun(run, info);
            this.spotlight.onRun(run, info);
            if (!run.isHidden) this.analytics.onRun(run, info, normal.ranking, history.get(run.id));
        }
        const stats = statistics(info, normal, runs);
        this.syncFeatured();
        const statsJson = JSON.stringify(stats);
        if (statsJson !== this.statisticsJson) {
            this.statisticsJson = statsJson;
            this.publish('statistics', stats);
        }
        if (changed.length || removed.length) this.publish('runs', this.current('runs'));
        for (const [channel] of this.channels) {
            if (!channel.startsWith('teamRuns:')) continue;
            const value = JSON.stringify(this.current(channel));
            if (this.timelines.get(channel) !== value) {
                this.timelines.set(channel, value);
                this.publish(channel, JSON.parse(value));
            }
        }
        if (infoChanged) {
            for (const controller of Object.values(this.controllers)) controller.sync();
            this.publishInteresting();
        }
    }

    regions() {
        const used = new Set(this.adminInfo?.teams.flatMap((team) => team.groups) || []);
        return (this.adminInfo?.groups || []).filter((group) => used.has(group.id));
    }

    teams() { return (this.adminInfo?.teams || []).filter((team) => !team.isHidden); }

    usageStatistics() { return this.widgets.usageStatistics(); }

    async dispose() {
        this.disposed = true;
        if (this.timer) clearTimeout(this.timer);
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        this.stopTimers();
        for (const presets of [this.advertisement, this.picture, this.title, this.tickerMessage]) presets.dispose();
        this.channels.clear();
        if (await this.flush()) await this.flush();
    }
}
