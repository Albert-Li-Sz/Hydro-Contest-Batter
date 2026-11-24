// Derived from hydro-dev/Hydro/packages/scoreboard-xcpcio (AGPL-3.0-or-later).
import fs from 'node:fs';
import path from 'node:path';
import {
    ContestModel, Context, ForbiddenError, getAlphabeticId, Handler, NotFoundError, ObjectId,
    param, PERM, Schema, STATUS, Tdoc, Types, UserModel, ValidationError,
} from 'hydrooj';
import { BoardData, BoardTeam, automaticBoards, enhanceBoard, problemColor, reservedBoardNames, schoolName } from './lib/board';
import { BoardSettings, checkBoardNames, defaultSettings, normalizeSettings, pruneMembers, toScriptJson } from './lib/settings';
import { buildRosterTeam, defaultProfileFields, FilterField, rosterFields } from './lib/roster';
import { replacementRequest } from './lib/access';
import { describeTeam, memberIds, type TeamEntry } from './lib/teams';
import { applyResolver } from './lib/resolver-routes';
import { applyScreens } from './lib/screens-routes';
import { applyLive } from './lib/live/routes';
import { applyMonitor } from './lib/monitor-routes';
import { applyOverview } from './lib/overview-routes';
import { applyResults } from './lib/results-routes';
import { applyCcs } from './lib/ccs/routes';
import { applyManage } from './lib/manage-routes';
import { applyPrintServers } from './lib/print-routes';
import { applyBalloons } from './lib/balloon-routes';
import { ContestLinks } from './lib/links';
import { applyPresence } from './lib/presence-routes';
import { applyClarificationDesk } from './lib/clarification-desk-routes';
import { applyControl } from './lib/control-routes';
import { displaySpecialAwards } from './lib/special-awards';
import { applyBoardRules, labelsHidden } from './lib/ccpc-board';

export const name = 'scoreboard-xcpcio-plus';
export const Config = Schema.object({
    asDefault: Schema.boolean().default(true).description('将 ACM 比赛默认计分板替换为增强榜'),
    publicByDefault: Schema.boolean().default(false).description('未保存过设置的比赛默认开放免登录公开榜单'),
    refreshInterval: Schema.number().min(5000).max(300000).default(15000).description('榜单刷新间隔（毫秒）'),
    resolverSessionDays: Schema.number().min(0).max(365).step(1).default(0).description('滚榜会话闲置清理天数，0 为永久保留'),
    live: Schema.boolean().default(true).description('启用直播模块（ICPC Live 导播台与 OBS 画面）'),
    liveCaptureStunPort: Schema.number().min(0).max(65535).step(1).default(3478).description('画面采集内置 STUN 服务的 UDP 端口，0 为关闭（只采集屏幕时帮助选手机与 OBS 建立连接，需放行该端口）'),
    liveCapture: Schema.boolean().default(true).description('启用直播的画面采集（选手屏幕与摄像头，需同时启用直播模块；各场比赛还需在“画面采集”页单独启用）'),
    profileFields: Schema.array(Schema.object({
        key: Schema.string().required().description('Hydro 公开个人资料字段名'),
        label: Schema.string().required().description('筛选项名称'),
    })).default(defaultProfileFields).description('成员批量筛选使用的额外公开资料字段'),
});

interface SettingsDoc {
    _id: string;
    settings: BoardSettings;
    updatedBy: number;
    updatedAt: Date;
}
declare module 'hydrooj' {
    interface Collections { 'xcpcio.enhanced.settings': SettingsDoc }
}

const status = new Map<number, string>([
    [STATUS.STATUS_ACCEPTED, 'CORRECT'], [STATUS.STATUS_WRONG_ANSWER, 'WRONG_ANSWER'],
    [STATUS.STATUS_COMPILING, 'PENDING'], [STATUS.STATUS_WAITING, 'PENDING'], [STATUS.STATUS_JUDGING, 'PENDING'],
    [STATUS.STATUS_TIME_LIMIT_EXCEEDED, 'TIME_LIMIT_EXCEEDED'], [STATUS.STATUS_MEMORY_LIMIT_EXCEEDED, 'MEMORY_LIMIT_EXCEEDED'],
    // Hydro's ACM rule charges penalty for system/unknown errors and hacks, but not for format errors.
    [STATUS.STATUS_RUNTIME_ERROR, 'RUNTIME_ERROR'], [STATUS.STATUS_SYSTEM_ERROR, 'JUDGEMENT_FAILED'],
    [STATUS.STATUS_COMPILE_ERROR, 'COMPILATION_ERROR'], [STATUS.STATUS_FETCHED, 'PENDING'],
    [STATUS.STATUS_OUTPUT_LIMIT_EXCEEDED, 'OUTPUT_LIMIT_EXCEEDED'], [STATUS.STATUS_ETC, 'JUDGEMENT_FAILED'],
    [STATUS.STATUS_HACKED, 'HACKED'], [STATUS.STATUS_FORMAT_ERROR, 'PRESENTATION_ERROR'],
    // Hydro exempts only accepted, compile error, format error and canceled; ignored records are charged.
    [STATUS.STATUS_IGNORED, 'REJECTED'], [STATUS.STATUS_CANCELED, 'CANCELED'],
]);
const liveStatuses = new Map<number, string>([
    ...status, [STATUS.STATUS_IGNORED, 'IGNORED'], [STATUS.STATUS_ETC, 'UNKNOWN_ERROR'],
    [STATUS.STATUS_HACK_SUCCESSFUL, 'HACK_SUCCESSFUL'], [STATUS.STATUS_HACK_UNSUCCESSFUL, 'HACK_UNSUCCESSFUL'],
]);
const maskedResults = ['WRONG_ANSWER', 'TIME_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED', 'RUNTIME_ERROR', 'OUTPUT_LIMIT_EXCEEDED', 'HACKED'];
const boardStatus = (code: number) => status.get(code) || 'JUDGEMENT_FAILED';

/** `identity` adds the display name and school, which Hydro treats as private user information. */
export async function loadContestData(tdoc: Tdoc, realtime: boolean, identity = false, results: boolean | 'live' = false): Promise<BoardData> {
    const entries = await ContestModel.getMultiStatus(tdoc.domainId, { docId: tdoc.docId }).toArray();
    // Team contests (Hydro 5.1): load the members along with the teams.
    const users = await UserModel.getList(tdoc.domainId, [...entries.map((entry) => entry.uid), ...memberIds(tdoc, entries as TeamEntry[])]);
    const ended = ContestModel.isDone(tdoc);
    const frozen = ContestModel.isLocked(tdoc) && !realtime;
    // School ranks need to know which teams share a school, also where the school name stays private.
    const schoolKeys = new Map<string, string>();
    const teams: BoardTeam[] = entries.filter((entry) => users[entry.uid]).map((entry) => {
        const team = describeTeam(entry as TeamEntry, users, identity)!;
        // A team without a school counts on its own.
        const own = describeTeam(entry as TeamEntry, users, true)!.school?.trim();
        const school = own ? schoolName(own) : `#${entry.uid}`;
        if (!schoolKeys.has(school)) schoolKeys.set(school, `s${schoolKeys.size + 1}`);
        return {
            team_id: `${entry.uid}`,
            name: team.name,
            organization: team.school,
            group: [entry.unrank ? 'unofficial' : 'official'],
            school_key: schoolKeys.get(school),
            ...team.members?.length ? { members: team.members } : {},
        };
    });
    const knownIds = new Set(teams.map((team) => team.team_id));
    const duration = tdoc.endAt.getTime() - tdoc.beginAt.getTime();
    const submissions: BoardData['submissions'] = [];
    for (const entry of entries) {
        if (!knownIds.has(`${entry.uid}`)) continue;
        // The current journal is authoritative after a rejudge; duplicate IDs must not add penalty twice.
        const journal = new Map((entry.journal || []).map((record) => [`${record.rid}`, record]));
        // Hydro's ACM rule times every submission from the contest start, also when
        // participants have a personal window; follow it so both boards rank alike.
        const start = tdoc.beginAt.getTime();
        const limit = duration;
        for (const record of journal.values()) {
            const submitted = new ObjectId(record.rid).getTimestamp().getTime();
            const timestamp = submitted - start;
            const problemId = tdoc.pids.indexOf(record.pid);
            if (problemId < 0 || timestamp < 0 || timestamp >= limit) continue;
            let result = results === 'live' ? liveStatuses.get(record.status) || 'UNKNOWN_ERROR' : boardStatus(record.status);
            if (!results && !ended && maskedResults.includes(result)) {
                result = 'REJECTED';
            }
            // Strictly after the freeze, as in Hydro: a submission in the freeze second itself stays visible.
            if (frozen && tdoc.lockAt && submitted > tdoc.lockAt.getTime()) result = 'FROZEN';
            submissions.push({
                submission_id: `${record.rid}`, team_id: `${entry.uid}`, problem_id: problemId,
                timestamp, status: result,
                ...results === true && typeof record.score === 'number' ? { score: record.score } : {},
            });
        }
    }
    return {
        contest: {
            contest_name: tdoc.title,
            start_time: Math.floor(tdoc.beginAt.getTime() / 1000),
            end_time: Math.floor(tdoc.endAt.getTime() / 1000),
            frozen_time: tdoc.lockAt ? Math.floor((tdoc.endAt.getTime() - tdoc.lockAt.getTime()) / 1000) : 0,
            penalty: 1200,
            problem_quantity: tdoc.pids.length,
            problem_id: tdoc.pids.map((_pid, index) => getAlphabeticId(index)),
            // The contest's own balloon colours (Hydro: contest management → balloon → set colour).
            // The engine derives a readable text colour from each background itself.
            balloon_color: tdoc.pids.map((pid) => ({ color: '#000', background_color: problemColor(tdoc.balloon?.[pid]) })),
            organization: '学校',
            status_time_display: { correct: true, incorrect: true, pending: true },
            logo: { preset: 'ICPC' },
            options: { submission_timestamp_unit: 'millisecond' },
        },
        teams,
        submissions,
    };
}

export async function loadRoster(tdoc: Tdoc, fields: FilterField[] = defaultProfileFields) {
    const entries = await ContestModel.getMultiStatus(tdoc.domainId, { docId: tdoc.docId }).toArray();
    const users = await UserModel.getList(tdoc.domainId, [...entries.map((entry) => entry.uid), ...memberIds(tdoc, entries as TeamEntry[])]);
    return entries.filter((entry) => users[entry.uid]).map((entry) => {
        const roster = buildRosterTeam(users[entry.uid], !!entry.unrank, fields);
        const team = describeTeam(entry as TeamEntry, users, true)!;
        // A team's school comes from its members; the settings page is for contest managers.
        return team.members ? { ...roster, name: team.name, organization: schoolName(team.school), members: team.members } : roster;
    });
}

export async function apply(ctx: Context, config: ReturnType<typeof Config>) {
    const collection = ctx.db.collection('xcpcio.enhanced.settings');
    const settingsKey = (domainId: string, contestId: string) => `${domainId}/${contestId}`;
    const loadSettings = async (tdoc: Tdoc) => {
        const doc = await collection.findOne({ _id: settingsKey(tdoc.domainId, `${tdoc.docId}`) });
        const settings = normalizeSettings(doc?.settings || { ...defaultSettings, publicAccess: !!config.publicByDefault });
        settingsVersion.set(settings, doc?.updatedAt ? new Date(doc.updatedAt).getTime() : 0);
        return settings;
    };
    // Every request reads the saved settings anyway; their save time versions the cache, so a
    // save handled by another Hydro process invalidates this one's entry too.
    const settingsVersion = new WeakMap<BoardSettings, number>();
    // Anonymous viewers all poll the same frozen data; share one computation per short window.
    const publicCache = new Map<string, { expires: number, body: Promise<BoardData> }>();
    const publicTtl = Math.min(5000, Math.floor(config.refreshInterval / 2));
    const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'public/hydro-xcpcio/manifest.json'), 'utf8'));
    const profileFields = config.profileFields || defaultProfileFields;
    const contestBase = (tdoc: Tdoc) => `/d/${encodeURIComponent(tdoc.domainId)}/contest/${tdoc.docId}`;
    const publicPath = (tdoc: Tdoc) => `${contestBase(tdoc)}/xcpcio-public`;
    /**
     * The contest's board data with its board rules: 过题后忽略再次提交 for everyone, and before the freeze the CCPC
     * board's hidden labels for every public projection (`realtime` false). Every channel reads it through here.
     */
    const loadData = async (tdoc: Tdoc, realtime: boolean, identity = false, results: boolean | 'live' = false, saved?: BoardSettings) => {
        const [data, settings] = await Promise.all([loadContestData(tdoc, realtime, identity, results), saved || loadSettings(tdoc)]);
        return applyBoardRules(data, settings, tdoc, Date.now(), realtime);
    };
    // The CCS API keeps one problem per id (its public view is withheld while the labels are hidden, lib/ccs/source.ts).
    const loadPlain = async (tdoc: Tdoc, realtime: boolean, identity = false, results: boolean | 'live' = false) => {
        const [data, settings] = await Promise.all([loadContestData(tdoc, realtime, identity, results), loadSettings(tdoc)]);
        return applyBoardRules(data, settings, tdoc, Date.now(), true);
    };
    const respond = async (handler: Handler, tdoc: Tdoc, realtime: boolean, json: boolean, publicView = false, saved?: BoardSettings) => {
        const settings = saved || await loadSettings(tdoc);
        if (realtime && !handler.user.own(tdoc)) handler.checkPerm(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
        handler.response.addHeader('Cache-Control', 'no-store');
        // Same rule as Hydro's native board, plus the per-contest opt-in for everyone else.
        const identity = settings.showIdentity || (!publicView && handler.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO));
        const ended = ContestModel.isDone(tdoc);
        const frozen = ContestModel.isLocked(tdoc) && !realtime;
        const board = async () => {
            const data = await loadData(tdoc, realtime, identity, false, settings);
            return displaySpecialAwards(enhanceBoard(data, settings, { identity }), settings, ended, frozen);
        };
        if (json || handler.request.json) {
            if (!publicView) {
                handler.response.body = await board();
                return;
            }
            const key = `${settingsKey(tdoc.domainId, `${tdoc.docId}`)}@${settingsVersion.get(settings) ?? 0}:${ended}:${frozen}`;
            const now = Date.now();
            for (const [cached, entry] of publicCache) if (entry.expires <= now) publicCache.delete(cached);
            let entry = publicCache.get(key);
            if (!entry) {
                entry = { expires: now + publicTtl, body: board() };
                entry.body.catch(() => publicCache.delete(key));
                publicCache.set(key, entry);
            }
            handler.response.body = await entry.body;
            return;
        }
        const canManage = handler.user.own(tdoc) || handler.user.hasPerm(PERM.PERM_EDIT_CONTEST);
        const canRealtime = handler.user.own(tdoc) || handler.user.hasPerm(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD);
        const base = contestBase(tdoc);
        const dataPath = publicView ? publicPath(tdoc) : `${base}/scoreboard/xcpcio-plus`;
        handler.response.template = 'xcpcio_plus_board.html';
        handler.response.body = {
            tdoc: publicView ? { title: tdoc.title, domainId: tdoc.domainId, docId: tdoc.docId } : tdoc,
            settingsUrl: canManage ? `${base}/xcpcio-settings` : null,
            publicUrl: settings.publicAccess && !publicView ? publicPath(tdoc) : null,
            // Only while frozen does the realtime board differ from what everyone sees.
            realtimeUrl: canRealtime && !realtime && ContestModel.isLocked(tdoc) ? `${base}/scoreboard/xcpcio-plus?realtime=true` : null,
            frozenUrl: realtime ? `${base}/scoreboard/xcpcio-plus` : null,
            // Hydro's own 解除封榜 (ContestScoreboardHandler.postUnlock, which checks the permission again); it
            // needs the contest to have ended. Also on the public page, where managers land when it is enabled.
            unlock: canManage && tdoc.lockAt && !tdoc.unlocked
                ? { url: `${base}/scoreboard`, ready: ContestModel.isDone(tdoc) } : null,
            // While the contest runs, the per-submission feed is for staff only. The page hides it;
            // the board data itself still needs every (result-masked) submission to rank.
            hideSubmissions: !ContestModel.isDone(tdoc) && !canManage && !canRealtime,
            runtimeJson: toScriptJson({
                dataSource: `${dataPath}?json=true${realtime ? '&realtime=true' : ''}#allInOne=true`,
                refreshInterval: config.refreshInterval,
            }),
            assetBase: manifest.base, js: manifest.js, css: manifest.css, realtime,

        };
    };

    /** Saves checked settings (the settings page and 赛事中控); every process sees them on its next read. */
    const saveSettings = async (tdoc: Tdoc, input: BoardSettings, uid: number) => {
        let settings = input;
        try {
            const teams = await loadRoster(tdoc, profileFields);
            // Participants can leave between page load and save; drop them instead of rejecting the form.
            settings = pruneMembers(settings, new Set(teams.map((team) => team.team_id)));
            checkBoardNames(settings, reservedBoardNames(teams, settings));
        } catch (error) {
            throw new ValidationError('config', error instanceof Error ? error.message : '无效设置');
        }
        await collection.updateOne(
            { _id: settingsKey(tdoc.domainId, `${tdoc.docId}`) },
            { $set: { settings, updatedBy: uid, updatedAt: new Date() } },
            { upsert: true },
        );
        (ctx.broadcast as any)('xcpcio/ccs-touch', settingsKey(tdoc.domainId, `${tdoc.docId}`));
        return settings;
    };

    class SettingsHandler extends Handler {
        tdoc!: Tdoc;

        @param('tid', Types.ObjectId)
        async prepare(domainId: string, tid: ObjectId) {
            domainId = this.domain._id;
            const contest = await ContestModel.get(domainId, tid);
            if (!contest) throw new NotFoundError('Contest not found');
            if (!this.user.own(contest)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            if (contest.rule !== 'acm') throw new ValidationError('tid', '仅支持 ACM 比赛');
            this.tdoc = contest;
        }

        async get() {
            const teams = await loadRoster(this.tdoc, profileFields);
            const settings = await loadSettings(this.tdoc);
            this.response.template = 'xcpcio_plus_settings.html';
            this.response.body = {
                tdoc: this.tdoc,
                boardUrl: `${contestBase(this.tdoc)}/scoreboard/xcpcio-plus`,
                resolverUrl: `${contestBase(this.tdoc)}/resolver`,
                screensUrl: `${contestBase(this.tdoc)}/screens`,
                publicUrl: publicPath(this.tdoc),
                ccsUrl: `/d/${encodeURIComponent(this.tdoc.domainId)}/ccsapi/contests/${this.tdoc.docId}`,
                replacementEnabled: config.asDefault,
                assetBase: manifest.base,
                settingsJson: toScriptJson({ settings, teams, automaticBoards: automaticBoards(teams), filterFields: rosterFields(teams, profileFields) }),
            };
        }

        @param('config', Schema.string().required())
        async post(domainId: string, raw: string) {
            let settings: BoardSettings;
            try {
                if (raw.length > 1000000) throw new Error('设置内容过大');
                settings = normalizeSettings(JSON.parse(raw));
            } catch (error) {
                throw new ValidationError('config', error instanceof Error ? error.message : '无效设置');
            }
            await saveSettings(this.tdoc, settings, this.user._id);
            this.response.redirect = `${contestBase(this.tdoc)}/xcpcio-settings?saved=1`;
        }
    }

    class PublicBoardHandler extends Handler {
        noCheckPermView = true;
        tdoc!: Tdoc;
        savedSettings!: BoardSettings;

        @param('tid', Types.ObjectId)
        async prepare(domainId: string, tid: ObjectId) {
            domainId = this.domain._id;
            const tdoc = await ContestModel.get(domainId, tid);
            if (!tdoc || tdoc.rule !== 'acm') throw new NotFoundError('Contest not found');
            this.savedSettings = await loadSettings(tdoc);
            if (!this.savedSettings.publicAccess) throw new NotFoundError('Public scoreboard is disabled');
            // Public access skips login and contest membership, not the rule that hides the board before the start.
            if (!ContestModel.canShowScoreboard.call(this, tdoc, true)) throw new ForbiddenError('比赛开始后才能查看榜单');
            this.tdoc = tdoc;
        }

        @param('json', (value: unknown) => Types.Boolean[0](value), true)
        @param('realtime', (value: unknown) => Types.Boolean[0](value), true)
        async get(domainId: string, json = false, realtime = false) {
            if (realtime) throw new ForbiddenError('公开链接不提供未公开的实时结果');
            await respond(this, this.tdoc, false, json, true, this.savedSettings);
        }
    }

    ctx.Route('contest_xcpcio_plus_settings', '/contest/:tid/xcpcio-settings', SettingsHandler);
    const resolver = applyResolver(ctx, { loadSettings, loadData, sessionDays: config.resolverSessionDays ?? 0 });
    const monitor = applyMonitor(ctx);
    // 气球配送: its balloons feed the 气球配送图 screen, its tickets the print servers' receipt printers.
    // Links that work without a Hydro login register here, so they can be revoked after the contest.
    const links = new ContestLinks<Tdoc>();
    const balloons = applyBalloons(ctx, { loadSettings, links });
    applyScreens(ctx, { loadSettings, loadData, machines: monitor.machines, balloons: balloons.screen, links });
    applyOverview(ctx, { loadSettings, loadData });
    const results = applyResults(ctx, { loadSettings, loadData, statusOf: boardStatus, resolver });
    applyCcs(ctx, { loadSettings, loadData: loadPlain });
    applyManage(ctx, { machines: monitor.machines, links, beforeRejudge: results.beforeRejudge });
    applyPresence(ctx);
    applyPrintServers(ctx, { receipts: balloons.receipts });
    const live = config.live !== false
        ? applyLive(ctx, { loadSettings, loadData: (tdoc, identity) => loadData(tdoc, false, identity, 'live'), capture: config.liveCapture !== false, captureStunPort: config.liveCaptureStunPort ?? 3478, links })
        : null;
    applyClarificationDesk(ctx, { links, liveTicker: live?.announceOnTicker });
    applyControl(ctx, {
        loadSettings, saveSettings, balloons: balloons.control, capture: live?.capture ?? null, live: !!live, review: results.reviewSummary,
    });
    ctx.Route('contest_xcpcio_plus_public', '/contest/:tid/xcpcio-public', PublicBoardHandler);
    // CCPC 新榜单模式: Hydro's own board views (HTML, CSV) show every label; until the freeze they are for staff only.
    ctx.on('handler/before-prepare', async (handler: Handler) => {
        const match = /\/contest\/([a-f\d]{24})\/scoreboard\/([^/?#]+)\/?$/i.exec(handler.context.originalPath || handler.request.path);
        if (!match || match[2] === 'xcpcio-plus') return;
        const tdoc = await ContestModel.get(handler.domain._id, new ObjectId(match[1]));
        if (!tdoc || tdoc.rule !== 'acm') return;
        if (handler.user.own(tdoc) || handler.user.hasPerm(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD)) return;
        if (labelsHidden((await loadSettings(tdoc)).ccpcBoard, tdoc, Date.now())) throw new ForbiddenError('封榜前隐藏题号期间不提供此榜单');
    });
    ctx.i18n.load('zh', { 'XCPCIO Plus': 'XCPCIO 增强榜' });
    ctx.inject(['scoreboard', 'server'], ({ scoreboard, server }) => {
        scoreboard.addView('xcpcio-plus', 'XCPCIO Plus', { tdoc: 'tdoc', realtime: (value: unknown) => Types.Boolean[0](value), json: (value: unknown) => Types.Boolean[0](value) }, {
            async display({ tdoc, realtime, json }) {
                await respond(this, tdoc, !!realtime, !!json);
            },
            supportedRules: ['acm'],
        });
        // Handler layers run before native route/domain permission checkers and contest assignment checks.
        server.addHandlerLayer('xcpcio-plus-replacement', async (context, next) => {
            const route = replacementRequest(context.path, context.querystring || '');
            if (!route || context.pendingError || !['GET', 'HEAD'].includes(context.method)) return next();
            const domainId = context.HydroContext?.domain?._id || context.domainId;
            if (typeof domainId !== 'string') return next();
            const tdoc = await ContestModel.get(domainId, new ObjectId(route.tid));
            if (!tdoc || tdoc.rule !== 'acm') return next();
            const settings = await loadSettings(tdoc);
            // While the CCPC board hides labels, Hydro's own board (which shows them) is never served.
            const sealed = labelsHidden(settings.ccpcBoard, tdoc, Date.now());
            if (route.enhanced ? !settings.publicAccess : !sealed && (!config.asDefault || !settings.replaceNative)) return next();
            const target = settings.publicAccess ? publicPath(tdoc) : `${contestBase(tdoc)}/scoreboard/xcpcio-plus`;
            const url = `${target}${route.query ? `?${route.query}` : ''}`;
            const response = context.HydroContext?.response;
            if (!response) { context.redirect(url); return; }
            // Hydro's outermost response layer rewrites the Koa response after this stack
            // unwinds, which turns a plain ctx.redirect() into `200 {}`. Hand the target to
            // that layer; the placeholder handler stops it from logging an unhandled request.
            response.redirect = url;
            context.handler ||= {};
        });
    });
}
