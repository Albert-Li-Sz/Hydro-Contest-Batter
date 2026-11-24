import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    ContestModel, Context, getAlphabeticId, Handler, NotFoundError, ObjectId, param, PERM, ProblemModel, TaskModel, Tdoc, Types,
} from 'hydrooj';
import { problemColor, type BoardData } from './board';
import type { BoardSettings } from './settings';
import { toScriptJson } from './settings';
import { resolverBoards, resolverCodeBase } from './resolver-data';
import { awardsFor } from './settings';
import { ResolverSessions } from './resolver-sessions';
import type { BalloonScreenData } from './balloon-routes';
import type { ContestLinks } from './links';
import {
    broadcastRows, decodePoster, defaultScreenConfig, groupSources, hiddenBeforeStart, intervalTypes, isPosterId, judgeScreen,
    eligibleScreenReaction, maxPosterImages, reactionPlaylist, type ScreenReaction, normalizeScreenConfig, presentationItem, problemRows, saveScreenConfig, screenCategories, ScreenConfig,
    screenData, ScreenError, screenLabels, screenProjection, ScreenType, screenTypes, screenVariants, standingsTypes,
} from './screens-data';
import { judgeHealth } from './manage/judges';
import type { MonitorMachine } from './monitor';
import { seatOf } from './print';
import { isTeamEntry, loadSeats, memberIds, type TeamEntry } from './teams';

interface ScreenDoc {
    _id: string;
    token: string;
    /** When the token was issued (absent on documents from before 1.15). */
    tokenAt?: Date;
    config: ScreenConfig;
    updatedAt: Date;
    updatedBy: number;
}
declare module 'hydrooj' {
    interface Collections {
        'xcpcio.screens': ScreenDoc;
        'xcpcio.screens.media': { _id: string; mime: string; data: Buffer };
    }
}

const newToken = () => randomBytes(24).toString('hex');

export function applyScreens(ctx: Context, dependencies: {
    loadSettings: (tdoc: Tdoc) => Promise<BoardSettings>;
    loadData: (tdoc: Tdoc, realtime: boolean, identity: boolean, staffResults: boolean) => Promise<BoardData>;
    screenVideos?: (tdoc: Tdoc, layoutId?: string) => Promise<(ScreenReaction & { id: string })[]>;
    screenLayouts?: (tdoc: Tdoc) => Promise<{ id: string; name: string }[]>;
    playScreenVideo?: (tdoc: Tdoc, layoutId: string, id: string, handler: Handler,
        allowed: (video: Pick<ScreenReaction, 'teamUid' | 'accepted' | 'firstSolve'>) => boolean) => Promise<void>;
    machines: (now: number) => Promise<MonitorMachine[]>;
    /** 气球配送 (lib/balloon-routes.ts): its balloons and colours, when the contest uses it. */
    balloons?: (tdoc: Tdoc) => Promise<BalloonScreenData | null>;
    /** The contest's no-login links, revoked together after the contest (lib/links.ts). */
    links?: ContestLinks<Tdoc>;
}) {
    const collection = ctx.db.collection('xcpcio.screens');
    const media = ctx.db.collection('xcpcio.screens.media');
    const sessions = new ResolverSessions(ctx.db);
    const logoNames = JSON.parse(fs.readFileSync(path.join(__dirname, '../logos/index.json'), 'utf8')).names;
    const codeBase = resolverCodeBase(JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version);
    const key = (tdoc: Tdoc) => `${tdoc.domainId}/${tdoc.docId}`;
    const contestBase = (tdoc: Tdoc) => `/d/${encodeURIComponent(tdoc.domainId)}/contest/${tdoc.docId}`;
    // Every screen polls; screens of one contest and board share a computation for a few seconds.
    const cache = new Map<string, { expires: number; value: Promise<unknown> }>();
    function cached<T>(name: string, load: () => Promise<T>): Promise<T> {
        const now = Date.now();
        for (const [id, entry] of cache) if (entry.expires <= now) cache.delete(id);
        const existing = cache.get(name);
        if (existing) return existing.value as Promise<T>;
        const value = load();
        cache.set(name, { expires: now + 3000, value });
        value.catch(() => { if (cache.get(name)?.value === value) cache.delete(name); });
        return value;
    }
    async function loadDoc(tdoc: Tdoc, userId?: number) {
        const existing = await collection.findOne({ _id: key(tdoc) });
        if (existing) return { ...existing, config: normalizeScreenConfig(existing.config) };
        if (userId === undefined) return null;
        const doc: ScreenDoc = { _id: key(tdoc), token: newToken(), tokenAt: new Date(), config: defaultScreenConfig(), updatedAt: new Date(), updatedBy: userId };
        // Two administrators opening the page at once must end up with the same token.
        await collection.updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true });
        return (await collection.findOne({ _id: doc._id }))!;
    }

    dependencies.links?.add({
        id: 'screens', label: '大屏',
        async status(tdoc) {
            const doc = await collection.findOne({ _id: key(tdoc) });
            return { count: doc ? 1 : 0, issuedAt: doc?.tokenAt ?? null };
        },
        // Screens poll with their token, so open ones stop at their next refresh.
        async revoke(tdoc) {
            return (await collection.updateOne({ _id: key(tdoc) }, { $set: { token: newToken(), tokenAt: new Date() } })).matchedCount;
        },
    });

    async function source(tdoc: Tdoc) {
        const settings = await dependencies.loadSettings(tdoc);
        // Screens are seen by anyone in the room: same data and identity rules as the public board.
        const data = await dependencies.loadData(tdoc, false, settings.showIdentity, false);
        return { settings, data, boards: resolverBoards(data, settings, settings.showIdentity) };
    }

    async function screenTeamIds(tdoc: Tdoc, boardId: string) {
        if (boardId === 'all') return null;
        const { boards } = await source(tdoc);
        const board = boards.find(candidate => candidate.id === boardId);
        if (!board) throw new ScreenError('所选分榜已不存在', 404);
        return new Set(board.teamIds);
    }

    async function contestSeats(tdoc: Tdoc) {
        const entries = await ContestModel.getMultiStatus(tdoc.domainId, { docId: tdoc.docId })
            .project<TeamEntry>({ uid: 1, members: 1 }).toArray();
        const seats = await loadSeats(ctx.db, [...entries.map((entry) => entry.uid), ...memberIds(tdoc, entries)]);
        return new Map(entries.map((entry) => [String(entry.uid), seatOf(seats, entry.uid, isTeamEntry(entry) ? entry.members : [])]));
    }

    const labelsOf = (tdoc: Tdoc) => tdoc.pids.map((_, index) => getAlphabeticId(index));
    const colorsOf = (tdoc: Tdoc) => tdoc.pids.map((pid) => problemColor(tdoc.balloon?.[pid]));

    function contestClock(tdoc: Tdoc): BoardData {
        return { contest: { contest_name: tdoc.title, problem_quantity: tdoc.pids.length, problem_id: labelsOf(tdoc),
            balloon_color: colorsOf(tdoc).map((background_color) => ({ background_color })),
            start_time: tdoc.beginAt.getTime() / 1000, end_time: tdoc.endAt.getTime() / 1000 }, teams: [], submissions: [] };
    }

    class ScreensHandler extends Handler {
        tdoc!: Tdoc;

        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            const tdoc = await ContestModel.get(this.domain._id, tid);
            if (!tdoc) throw new NotFoundError('Contest not found');
            if (!this.user._id) throw new ScreenError('请登录比赛管理账号', 403);
            if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            if (tdoc.rule !== 'acm') throw new ScreenError('大屏仅支持 ACM 比赛');
            this.tdoc = tdoc;
        }

        async get() {
            const doc = (await loadDoc(this.tdoc, this.user._id))!;
            const { boards } = await source(this.tdoc);
            const scope = { domainId: this.tdoc.domainId, contestId: String(this.tdoc.docId), ownerId: this.user._id };
            const base = contestBase(this.tdoc);
            this.response.template = 'xcpcio_screens.html';
            this.response.body = {
                tdoc: this.tdoc, codeBase,
                runtimeJson: toScriptJson({
                    base: `${base}/screens`, contestUrl: base, linkBase: `${base}/screen/${doc.token}`,
                    title: this.tdoc.title, config: doc.config, types: screenTypes, labels: screenLabels, variants: screenVariants,
                    categories: screenCategories, groupSources, intervalTypes: [...intervalTypes],
                    reactionLayouts: await dependencies.screenLayouts?.(this.tdoc) ?? [],
                    standingsTypes: [...standingsTypes], boards: boards.map(({ id, name }) => ({ id, name })),
                    sessions: (await sessions.list(scope)).map((row) => ({
                        id: row.id, createdAt: row.createdAt, title: row.overview.title,
                        board: boards.find((board) => board.id === row.config.boardId)?.name || row.config.boardId,
                        rehearsal: row.config.rehearsal,
                    })),
                    contest: { start: this.tdoc.beginAt.toISOString(), end: this.tdoc.endAt.toISOString() },
                }),
            };
        }

        @param('config', Types.String, true)
        async post(_domainId: string, raw?: string) {
            // Hydro runs post() before postBindResolver, postUploadPoster and other named actions.
            if (this.request.body?.operation) return;
            if (typeof raw !== 'string') throw new ScreenError('缺少大屏配置');
            if (raw.length > 20000) throw new ScreenError('大屏配置内容过大');
            let input: unknown;
            try { input = JSON.parse(raw); } catch { throw new ScreenError('大屏配置必须是有效 JSON'); }
            const doc = (await loadDoc(this.tdoc, this.user._id))!;
            const config = saveScreenConfig(input, doc.config);
            const fields: Record<string, unknown> = {};
            for (const type of screenTypes) {
                for (const [field, value] of Object.entries(config.items[type])) {
                    if (field !== 'images' && Object.hasOwn((input as Partial<ScreenConfig>)?.items?.[type] || {}, field)) {
                        fields[`config.items.${type}.${field}`] = value;
                    }
                }
            }
            if (Object.hasOwn(input as object, 'locale')) fields['config.locale'] = config.locale;
            await collection.updateOne({ _id: doc._id }, { $set: { ...fields, updatedAt: new Date(), updatedBy: this.user._id } });
            this.response.body = { config: (await loadDoc(this.tdoc))!.config };
        }

        async postResolverSessions() {
            const doc = (await loadDoc(this.tdoc, this.user._id))!;
            const scope = { domainId: this.tdoc.domainId, contestId: String(this.tdoc.docId), ownerId: this.user._id };
            this.response.body = { sessions: await sessions.list(scope), sessionId: doc.config.items.resolver.sessionId };
        }

        @param('sessionId', Types.String)
        async postBindResolver(_domainId: string, sessionId: string) {
            const scope = { domainId: this.tdoc.domainId, contestId: String(this.tdoc.docId), ownerId: this.user._id };
            await sessions.get(scope, sessionId);
            const doc = (await loadDoc(this.tdoc, this.user._id))!;
            await collection.updateOne({ _id: doc._id }, { $set: { 'config.items.resolver.sessionId': sessionId, updatedAt: new Date(), updatedBy: this.user._id } });
            this.response.body = { sessionId, audienceUrl: `${contestBase(this.tdoc)}/screen/${doc.token}/resolver` };
        }

        @param('image', Types.String)
        async postUploadPoster(_domainId: string, image: string) {
            const file = decodePoster(image);
            const doc = (await loadDoc(this.tdoc, this.user._id))!;
            const id = String(new ObjectId());
            const _id = `${doc._id}/${id}`;
            await media.insertOne({ _id, ...file });
            try {
                const result = await collection.updateOne({ _id: doc._id,
                    [`config.items.poster.images.${maxPosterImages - 1}`]: { $exists: false },
                }, { $push: { 'config.items.poster.images': id } });
                if (!result.modifiedCount) throw new ScreenError(`最多上传 ${maxPosterImages} 张图片`);
            } catch (error) {
                const attached = await collection.findOne({ _id: doc._id, 'config.items.poster.images': id });
                if (!attached) await media.deleteOne({ _id });
                throw error;
            }
            this.response.body = { images: (await loadDoc(this.tdoc))!.config.items.poster.images };
        }

        @param('imageId', Types.String)
        async postRemovePoster(_domainId: string, id: string) {
            if (!isPosterId(id)) throw new ScreenError('图片编号无效');
            const _id = key(this.tdoc);
            await collection.updateOne({ _id }, { $pull: { 'config.items.poster.images': id } });
            await media.deleteOne({ _id: `${_id}/${id}` });
            this.response.body = { images: (await loadDoc(this.tdoc, this.user._id))!.config.items.poster.images };
        }

        async postResetToken() {
            const doc = (await loadDoc(this.tdoc, this.user._id))!;
            const token = newToken();
            await collection.updateOne({ _id: doc._id }, { $set: { token, tokenAt: new Date(), updatedAt: new Date(), updatedBy: this.user._id } });
            this.response.body = { linkBase: `${contestBase(this.tdoc)}/screen/${token}` };
        }

        async onerror(error: Parameters<Handler['onerror']>[0] | ScreenError) {
            if (error instanceof ScreenError) {
                this.response.status = error.status;
                this.response.body = { error: error.message };
                return;
            }
            return super.onerror(error);
        }
    }

    /** Screen links carry their own capability, so venue computers need no Hydro login. */
    class ScreenPublicHandler extends Handler {
        noCheckPermView = true;
        tdoc!: Tdoc;
        doc!: ScreenDoc;
        type!: ScreenType;

        @param('tid', Types.ObjectId)
        @param('token', Types.String)
        @param('type', Types.String)
        async prepare(_domainId: string, tid: ObjectId, token: string, type: string) {
            this.response.addHeader('Cache-Control', 'no-store');
            const tdoc = await ContestModel.get(this.domain._id, tid);
            const doc = tdoc?.rule === 'acm' ? await loadDoc(tdoc) : null;
            const given = Buffer.from(String(token));
            if (!tdoc || !doc || !screenTypes.includes(type as ScreenType)
                || given.length !== Buffer.byteLength(doc.token) || !timingSafeEqual(given, Buffer.from(doc.token))) {
                throw new NotFoundError('大屏链接无效或已作废');
            }
            this.tdoc = tdoc;
            this.doc = doc;
            this.type = type as ScreenType;
        }
    }

    class ScreenViewHandler extends ScreenPublicHandler {
        async get() {
            this.response.template = 'xcpcio_screen_view.html';
            this.response.body = {
                codeBase, title: `${this.tdoc.title} · ${screenLabels[this.type]}`,
                runtimeJson: toScriptJson({ type: this.type, dataUrl: `${contestBase(this.tdoc)}/screen/${this.doc.token}/${this.type}/data` }),
            };
        }
    }

    class ScreenImageHandler extends ScreenPublicHandler {
        notUsage = true;

        @param('mid', Types.String)
        async get(_domainId: string, id: string) {
            if (this.type !== 'poster' || !isPosterId(id) || !this.doc.config.items.poster.images.includes(id)) throw new NotFoundError('Poster not found');
            const file = await media.findOne({ _id: `${this.doc._id}/${id}` });
            if (!file) throw new NotFoundError('Poster not found');
            this.response.addHeader('X-Content-Type-Options', 'nosniff');
            this.response.addHeader('Content-Security-Policy', "default-src 'none'; sandbox");
            this.response.type = file.mime;
            this.response.body = Buffer.isBuffer(file.data) ? file.data : Buffer.from((file.data as unknown as { value: () => Uint8Array }).value());
        }
    }

    class ScreenReactionHandler extends ScreenPublicHandler {
        notUsage = true;

        @param('vid', Types.String)
        async get(_domainId: string, id: string) {
            if (this.type !== 'reactions' || !dependencies.playScreenVideo || !ContestModel.canShowScoreboard.call(this, this.tdoc, false)) {
                throw new NotFoundError('视频不可播放');
            }
            const item = this.doc.config.items.reactions;
            const teams = await screenTeamIds(this.tdoc, item.boardId);
            await dependencies.playScreenVideo(this.tdoc, item.layoutId || '', id, this, video => eligibleScreenReaction(video, item, teams));
        }
    }

    class ScreenDataHandler extends ScreenPublicHandler {
        @param('revision', Types.Int, true)
        @param('session', Types.String, true)
        @param('index', Types.Int, true)
        async get(_domainId: string, revision?: number, known?: string, index?: number) {
            const { locale, items } = this.doc.config;
            const item = items[this.type];
            const base = { type: this.type, locale, serverTime: Date.now() };
            if (this.type === 'resolver') {
                const session = item.sessionId ? await sessions.find(this.tdoc.domainId, String(this.tdoc.docId), item.sessionId) : null;
                if (!session) {
                    this.response.body = { ...base, notice: item.sessionId ? '滚榜会话已结束或删除，请重新投屏' : '等待主持人投到观众屏' };
                    return;
                }
                this.response.body = { ...base, session: session._id, ...await sessions.audience(session, known, revision, index) };
                return;
            }
            // Like the public board, standings stay hidden until the contest starts.
            if (hiddenBeforeStart.has(this.type) && !ContestModel.canShowScoreboard.call(this, this.tdoc, false)) {
                this.response.body = { ...base, notice: '比赛尚未开始' };
                return;
            }
            const { tdoc, type } = this;
            const contest = contestClock(tdoc);
            const program = presentationItem(type, item, contest);
            try {
                let payload: unknown;
                if (type === 'poster') payload = item.images.map((id) => `${contestBase(tdoc)}/screen/${this.doc.token}/poster/images/${id}`);
                else if (type === 'reactions') {
                    const [videos, teams] = await Promise.all([
                        dependencies.screenVideos?.(tdoc, item.layoutId || undefined) ?? [],
                        screenTeamIds(tdoc, item.boardId),
                    ]);
                    const mediaBase = `${contestBase(tdoc)}/screen/${this.doc.token}/reactions/videos/`;
                    payload = reactionPlaylist(videos.map(v => ({ ...v, url: mediaBase + encodeURIComponent(v.id) })), item, teams);
                }
                else if (type === 'clarifications') payload = await cached(`${key(tdoc)}|broadcast`, async () => broadcastRows(
                    await ContestModel.getMultiClarification(tdoc.domainId, tdoc.docId, 0), tdoc.pids, labelsOf(tdoc),
                ));
                else if (type === 'problem-list') payload = await cached(`${key(tdoc)}|problems`, async () => problemRows(tdoc.pids,
                    await ProblemModel.getList(tdoc.domainId, tdoc.pids, true, false, ['docId', 'title', 'config'], true), colorsOf(tdoc), labelsOf(tdoc),
                ));
                else if (type === 'judges') payload = await cached('judges', async () => {
                    const now = Date.now();
                    const [machines, count] = await Promise.all([dependencies.machines(now), TaskModel.count({ type: 'judge' })]);
                    return judgeScreen(judgeHealth(now, machines, count), count);
                });
                else if (!standingsTypes.has(type)) payload = screenData(contest, null, { logoNames, locked: false, firstSolve: false, unofficialFirstSolve: false });
                else {
                    const boardId = item.boardId;
                    const locked = ContestModel.isLocked(tdoc);
                    const withSeats = type === 'floor' || type === 'balloons';
                    const options = type === 'groups' ? item.source : type === 'rank-trend' ? type : withSeats ? 'seats' : '';
                    const prefix = `${key(tdoc)}|${tdoc.beginAt.getTime()}|${tdoc.endAt.getTime()}|${tdoc.lockAt?.getTime() || ''}|${locked}`;
                    const projection = await cached(`${prefix}|${boardId}|${options}`, async () => {
                        const [{ settings, data, boards }, seats] = await Promise.all([cached(`${prefix}|source`, () => source(tdoc)),
                            withSeats ? cached(`${prefix}|seat-list`, () => contestSeats(tdoc)) : undefined]);
                        const board = boards.find((candidate) => candidate.id === boardId);
                        if (!board) throw new ScreenError('所选分榜已不存在，请在大屏管理页重新选择', 404);
                        const rules = awardsFor(settings, boardId);
                        return screenData(data, boardId === 'all' ? null : new Set(board.teamIds), {
                            logoNames, locked, seats, trend: type === 'rank-trend',
                            groups: type === 'groups' && item.source === 'boards' ? boards.filter((group) => group.id !== 'all') : null,
                            firstSolve: rules.firstSolve, unofficialFirstSolve: rules.unofficialFirstSolve, tieBreak: rules.tieBreak,
                        });
                    });
                    if (type === 'logo-wall' && !projection.contest.organizations.length) throw new ScreenError('暂无可展示的学校，请检查公开榜的学校显示设置');
                    // CCPC 新榜单模式: before the freeze the board's columns are not problems.
                    if (type === 'balloons' && (await cached(`${prefix}|source`, () => source(tdoc))).data.hiddenFrom !== undefined) {
                        throw new ScreenError('封榜前隐藏题号时不显示气球配送图');
                    }
                    const balloons = type === 'balloons' ? await cached(`${prefix}|balloons`, async () => {
                        // 气球配送 tracks the balloons itself when the contest uses it (also after the freeze, in its colours).
                        const own = await dependencies.balloons?.(tdoc);
                        if (own?.withheld) throw new ScreenError('按队配色或统一一血气球时不显示气球配送图');
                        if (own) return own;
                        const index = new Map(tdoc.pids.map((pid, i) => [pid, String(i)]));
                        const rows = await ContestModel.getMultiBalloon(tdoc.domainId, tdoc.docId, { sent: { $exists: false } })
                            .project<{ _id: ObjectId; uid: number; pid: number }>({ uid: 1, pid: 1 }).toArray();
                        return { pending: rows.flatMap((row) => index.has(row.pid) ? [{ teamId: String(row.uid), problemId: index.get(row.pid)!, submissionId: String(row._id) }] : []), colors: null };
                    }) : undefined;
                    payload = screenProjection(type, item, projection, balloons?.pending);
                    // The colours 气球配送 sets for its tickets are the balloons' colours on the screen too.
                    if (balloons?.colors && payload && typeof payload === 'object' && Array.isArray((payload as { problems?: unknown }).problems)) {
                        for (const problem of (payload as { problems: { id: string; color: string }[] }).problems) {
                            const color = balloons.colors[Number(problem.id)];
                            if (color) problem.color = color;
                        }
                    }
                }
                this.response.body = { ...base, item: program, data: payload, title: tdoc.title };
            } catch (error) {
                if (!(error instanceof ScreenError)) throw error;
                this.response.body = { ...base, notice: error.message };
            }
        }
    }

    ctx.Route('contest_xcpcio_screens', '/contest/:tid/screens', ScreensHandler);
    ctx.Route('contest_xcpcio_screen_view', '/contest/:tid/screen/:token/:type', ScreenViewHandler);
    ctx.Route('contest_xcpcio_screen_data', '/contest/:tid/screen/:token/:type/data', ScreenDataHandler);
    ctx.Route('contest_xcpcio_screen_reaction', '/contest/:tid/screen/:token/:type/videos/:vid', ScreenReactionHandler);
    ctx.Route('contest_xcpcio_screen_image', '/contest/:tid/screen/:token/:type/images/:mid', ScreenImageHandler);
    ctx.i18n.load('zh', { contest_xcpcio_screens: '大屏' });
}
