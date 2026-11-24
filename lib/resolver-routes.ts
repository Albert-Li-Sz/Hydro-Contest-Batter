import fs from 'node:fs';
import path from 'node:path';
import {
    ContestModel, Context, Handler, NotFoundError, ObjectId, param, PERM, Tdoc, Types,
} from 'hydrooj';
import { type BoardData, enhanceBoard } from './board';
import { specialAwardResults } from './special-awards';
import type { BoardSettings } from './settings';
import { toScriptJson } from './settings';
import { defaultResolverConfig, parseResolverConfig, prepareResolver, ResolverError, resolverAssetBase, resolverBoards, resolverCodeBase } from './resolver-data';
import { ResolverSessions, ResolverSession, ResolverScope } from './resolver-sessions';

export function applyResolver(ctx: Context, dependencies: {
    /** Sessions idle for longer than this are deleted together with their snapshots. */
    sessionDays: number;
    loadSettings: (tdoc: Tdoc) => Promise<BoardSettings>;
    loadData: (tdoc: Tdoc, realtime: boolean, identity: boolean, staffResults: boolean) => Promise<BoardData>;
}) {
    const sessions = new ResolverSessions(ctx.db);
    const logoNames = JSON.parse(fs.readFileSync(path.join(__dirname, '../logos/index.json'), 'utf8')).names;
    const codeBase = resolverCodeBase(JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version);
    const sessionTtl = dependencies.sessionDays * 24 * 3600 * 1000;
    ctx.on('app/started', async () => { await sessions.ensureIndexes(); await sessions.prune(sessionTtl); });

    async function sourceFor(tdoc: Tdoc, privateInfo: boolean) {
        const settings = await dependencies.loadSettings(tdoc);
        const identity = settings.showIdentity || privateInfo;
        const data = await dependencies.loadData(tdoc, true, identity, true);
        const boards = resolverBoards(data, settings, identity);
        return { settings, data, boards, ended: ContestModel.isDone(tdoc) };
    }

    async function payloadFor(tdoc: Tdoc, input: unknown, privateInfo: boolean) {
        const { settings, data, boards, ended } = await sourceFor(tdoc, privateInfo);
        const board = boards.find((item) => item.id === (input as { boardId?: unknown })?.boardId);
        const defaults = defaultResolverConfig({ ...settings, medals: board?.medals || settings.medals }, ended);
        const config = parseResolverConfig(input, defaults);
        try {
            return prepareResolver(data, boards, config, {
                contestId: String(tdoc.docId), ended, capturedAt: new Date(), logoNames,
                special: specialAwardResults(enhanceBoard(data, settings, { identity: true }), settings),
            });
        } catch (error) {
            // Upstream validates input size before generating potentially large step sets.
            if (error instanceof Error && 'expose' in error && error.expose === true && 'status' in error) {
                throw new ResolverError(error.message, Number(error.status));
            }
            throw error;
        }
    }

    class ResolverHandler extends Handler {
        tdoc!: Tdoc;
        scope!: ResolverScope;
        base!: string;
        resolverSession?: ResolverSession;
        deletingSession = false;

        @param('tid', Types.ObjectId)
        @param('sid', Types.String, true)
        async prepare(_domainId: string, tid: ObjectId, sid?: string) {
            this.response.addHeader('Cache-Control', 'no-store');
            const tdoc = await ContestModel.get(this.domain._id, tid);
            if (!tdoc) throw new NotFoundError('Contest not found');
            if (!this.user._id) throw new ResolverError('请登录比赛管理账号', 403);
            if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            if (tdoc.rule !== 'acm') throw new ResolverError('滚榜仅支持 ACM 比赛');
            this.tdoc = tdoc;
            this.scope = { domainId: this.domain._id, contestId: String(tdoc.docId), ownerId: this.user._id };
            this.base = `/d/${encodeURIComponent(this.domain._id)}/contest/${tdoc.docId}/resolver`;
            if (sid) this.resolverSession = await sessions.get(this.scope, sid, this.deletingSession);
        }

        async source() {
            return sourceFor(this.tdoc, this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO));
        }

        async payload(raw: string) {
            if (typeof raw !== 'string' || raw.length > 10000) throw new ResolverError('滚榜配置格式无效或内容过大');
            let input: unknown;
            try { input = JSON.parse(raw); } catch { throw new ResolverError('滚榜配置必须是有效 JSON'); }
            return payloadFor(this.tdoc, input, this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO));
        }

        controlledSession() {
            if (!this.resolverSession) throw new ResolverError('滚榜会话不存在', 404);
            sessions.checkToken(this.resolverSession, this.request.headers['x-resolver-control']);
            return this.resolverSession;
        }

        async onerror(error: Parameters<Handler['onerror']>[0] | ResolverError) {
            if (error instanceof ResolverError) {
                this.response.status = error.status;
                this.response.body = { error: error.message };
                return;
            }
            return super.onerror(error);
        }
    }

    class ResolverConfigHandler extends ResolverHandler {
        async get() {
            const { settings, data, boards, ended } = await this.source();
            this.response.template = 'xcpcio_resolver_config.html';
            this.response.body = {
                tdoc: this.tdoc, assetBase: resolverAssetBase, codeBase, settingsUrl: `${this.base.slice(0, -'/resolver'.length)}/xcpcio-settings`, contestUrl: this.base.slice(0, -'/resolver'.length),
                runtimeJson: toScriptJson({
                    base: this.base, contestUrl: this.base.slice(0, -'/resolver'.length),
                    title: data.contest.contest_name, boards, ended,
                    initialStats: {
                        teamCount: data.teams.length,
                        officialCount: data.teams.filter((team) => !team.group.includes('unofficial')).length,
                        problemCount: data.contest.problem_quantity,
                    },
                    durationSeconds: data.contest.end_time - data.contest.start_time,
                    contestFreezeAtSeconds: Number(data.contest.frozen_time) > 0
                        ? data.contest.end_time - data.contest.start_time - Number(data.contest.frozen_time) : null,
                    config: defaultResolverConfig(settings, ended), sessionDays: dependencies.sessionDays,
                }),
            };
        }
    }

    class ResolverPreviewHandler extends ResolverHandler {
        @param('config', Types.String)
        async post(_domainId: string, config: string) {
            const payload = await this.payload(config);
            this.response.body = { game: payload.game, overview: payload.overview, config: payload.config };
        }
    }

    class ResolverSessionsHandler extends ResolverHandler {
        async get() {
            this.response.body = { sessions: await sessions.list(this.scope) };
        }

        @param('config', Types.String)
        async post(_domainId: string, config: string) {
            const payload = await this.payload(config);
            await sessions.prune(sessionTtl);
            const session = await sessions.create(this.scope, payload);
            this.response.body = { id: session._id, url: `${this.base}/sessions/${session._id}`, overview: session.overview };
        }
    }

    class ResolverPlayHandler extends ResolverHandler {
        async get() {
            const session = this.resolverSession!;
            this.response.template = 'xcpcio_resolver_play.html';
            this.response.body = {
                tdoc: this.tdoc, codeBase,
                configUrl: this.base,
                runtimeJson: toScriptJson({
                    id: session._id, controlToken: session.controlToken, screensUrl: `/d/${encodeURIComponent(this.tdoc.domainId)}/contest/${this.tdoc.docId}/screens`,
                    base: `${this.base}/sessions/${session._id}`, rehearsal: session.config.rehearsal,
                }),
            };
        }
    }

    class ResolverDataHandler extends ResolverHandler {
        async get() {
            const session = this.controlledSession();
            const payload = await sessions.read(session);
            this.response.body = { ...payload.game, playback: sessions.playback(session), overview: session.overview };
        }
    }

    class ResolverPlaybackHandler extends ResolverHandler {
        async get() {
            this.response.body = { playback: sessions.playback(this.controlledSession()) };
        }

        @param('index', Types.Int)
        @param('revision', Types.Int)
        async post(_domainId: string, index: number, revision: number) {
            const result = await sessions.move(this.controlledSession(), index, revision);
            this.response.status = result.status;
            this.response.body = result;
        }
    }

    class ResolverDeleteHandler extends ResolverHandler {
        deletingSession = true;
        async post() {
            // The list page is authenticated and ownership was checked in prepare.
            await sessions.remove(this.resolverSession!);
            this.response.body = { deleted: true };
        }
    }

    ctx.Route('contest_resolver', '/contest/:tid/resolver', ResolverConfigHandler);
    ctx.Route('contest_resolver_preview', '/contest/:tid/resolver/preview', ResolverPreviewHandler);
    ctx.Route('contest_resolver_sessions', '/contest/:tid/resolver/sessions', ResolverSessionsHandler);
    ctx.Route('contest_resolver_play', '/contest/:tid/resolver/sessions/:sid', ResolverPlayHandler);
    ctx.Route('contest_resolver_data', '/contest/:tid/resolver/sessions/:sid/data', ResolverDataHandler);
    ctx.Route('contest_resolver_playback', '/contest/:tid/resolver/sessions/:sid/playback', ResolverPlaybackHandler);
    ctx.Route('contest_resolver_delete', '/contest/:tid/resolver/sessions/:sid/delete', ResolverDeleteHandler);
    ctx.on('handler/after', (handler) => {
        const tdoc = handler.response.body?.tdoc;
        if (tdoc?.rule !== 'acm' || !handler.user._id) return;
        if (!handler.user.own(tdoc) && !handler.user.hasPerm(PERM.PERM_EDIT_CONTEST)) return;
        handler.UiContext.xcpcioResolverUrl = `/d/${encodeURIComponent(handler.domain._id)}/contest/${tdoc.docId}/resolver`;
    });
    ctx.i18n.load('zh', { contest_resolver: '滚榜预演与播放', contest_resolver_play: '滚榜播放' });
    return {
        /** Every resolver session of the contest, whoever created it. */
        ofContest: (tdoc: Tdoc) => sessions.ofContest(tdoc.domainId, String(tdoc.docId)),
        /** A new session for `ownerId` with each listed session's configuration, on the current results; the old ones stay. */
        async rebuild(tdoc: Tdoc, ids: string[], ownerId: number, privateInfo: boolean) {
            const all = await sessions.ofContest(tdoc.domainId, String(tdoc.docId));
            const created: { from: string; id: string; url: string }[] = [];
            for (const id of ids) {
                const old = all.find((session) => session.id === id);
                if (!old) continue;
                const payload = await payloadFor(tdoc, old.config, privateInfo);
                const session = await sessions.create({ domainId: tdoc.domainId, contestId: String(tdoc.docId), ownerId }, payload);
                created.push({ from: id, id: session._id, url: `/d/${encodeURIComponent(tdoc.domainId)}/contest/${tdoc.docId}/resolver/sessions/${session._id}` });
            }
            return created;
        },
    };
}
