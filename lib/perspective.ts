/**
 * 选手视角: a contest manager opens Hydro's own contest pages as one chosen team sees them. Hydro decides what
 * to show by that team's rights, because the request's user is that team; nothing is written on its behalf.
 * The view covers read-only pages of one contest, and the team's participant actions there are refused.
 */
import { createHash, randomBytes } from 'node:crypto';
import {
    ContestModel, type Context, ForbiddenError, Handler, NotFoundError, ObjectId, param, PERM, PRIV, type Tdoc, Types, UserModel,
} from 'hydrooj';
import { resolverCodeBase } from './resolver-data';
import pkg from '../package.json';
import { toScriptJson } from './settings';

interface PerspectiveDoc { _id: string; adminUid: number; domainId: string; tid: string; uid: number; name: string; expiresAt: Date }
declare module 'hydrooj' { interface Collections { 'xcpcio.perspectives': PerspectiveDoc } }

export const perspectiveCookie = 'xcpcio_perspective';
export const perspectiveTtl = 2 * 3600 * 1000;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const local = (path: string) => path.replace(/^\/d\/[^/]+/, '') || '/';

/** Pages that render the team's view: the contest's home, problems, files, clarifications, boards and records. */
export function perspectiveScope(path: string, query: URLSearchParams, tid: string) {
    const p = local(path);
    if (new RegExp(`^/contest/${tid}(?:/(?:problems|clarification|scoreboard(?:/[^/]+)?|file/[^/]+/[^/]+))?/?$`).test(p)) return true;
    if (/^\/p\/[^/]+(?:\/file\/[^/]+)?\/?$/.test(p) && query.get('tid') === tid) return true;
    if (/^\/record(?:-conn)?\/?$/.test(p) && query.get('tid') === tid) return true;
    return /^\/record\/[a-f\d]{24}\/?$/.test(p) || /^\/record-detail-conn\/?$/.test(p);
}
/** What a participant does in that contest: attend, submit, ask, print. Refused during the view. */
export function perspectiveAction(path: string, query: URLSearchParams, tid: string) {
    const p = local(path);
    if (new RegExp(`^/contest/${tid}(?:/(?:problems|clarification|print|api/printing/team|code|file/[^/]+/[^/]+))?/?$`).test(p)) return true;
    return /^\/p\/[^/]+\/submit\/?$/.test(p) && query.get('tid') === tid;
}

export class Perspectives {
    private collection;
    private cache = new Map<string, { until: number; doc: PerspectiveDoc | null }>();
    private index?: Promise<string>;
    constructor(db: Context['db']) { this.collection = db.collection('xcpcio.perspectives'); }
    ensureIndexes() {
        return this.index ??= this.collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
            .catch(error => { this.index = undefined; throw error; });
    }
    async start(adminUid: number, domainId: string, tid: string, uid: number, name: string, now = Date.now()) {
        const token = randomBytes(32).toString('hex');
        await this.collection.insertOne({ _id: hash(token), adminUid, domainId, tid, uid, name, expiresAt: new Date(now + perspectiveTtl) });
        return token;
    }
    /** Looked up on every request that carries the cookie, so remembered for a few seconds per process. */
    async find(token: string | undefined, now = Date.now()) {
        if (!token || !/^[a-f\d]{64}$/.test(token)) return null;
        const key = hash(token);
        let entry = this.cache.get(key);
        if (!entry || entry.until <= now) {
            if (this.cache.size > 1000) this.cache.clear();
            entry = { until: now + 5000, doc: await this.collection.findOne({ _id: key }) };
            this.cache.set(key, entry);
        }
        return entry.doc && entry.doc.expiresAt.getTime() > now ? entry.doc : null;
    }
    async end(token: string | undefined) {
        if (!token || !/^[a-f\d]{64}$/.test(token)) return;
        this.cache.delete(hash(token));
        await this.collection.deleteOne({ _id: hash(token) });
    }
    remove(domainId: string, tid?: string) {
        return this.collection.deleteMany(tid ? { domainId, tid } : { domainId } as never);
    }
}

type Marked = Handler & { xcpcioPerspective?: { uid: number; name: string; tid: string }; tsdoc?: { attend?: number; startAt?: Date } };
const canManage = (handler: Handler, tdoc: Tdoc) => handler.user.own(tdoc) || handler.user.hasPerm(PERM.PERM_EDIT_CONTEST);

export function applyPerspective(ctx: Context, dependencies: {
    /** The contest's teams as the board names them. */
    teams(tdoc: Tdoc): Promise<{ uid: number; name: string; school: string }[]>;
}) {
    const store = new Perspectives(ctx.db);
    ctx.on('app/started', () => { void store.ensureIndexes().catch((error) => console.warn('[xcpcio] 选手视角索引失败', error)); });
    ctx.on('contest/del', (domainId, tid) => { void store.remove(domainId, String(tid)).catch(() => null); });
    ctx.on('domain/delete', (domainId) => { void store.remove(domainId).catch(() => null); });
    const cookieOf = (handler: Handler) => handler.context.cookies?.get(perspectiveCookie, { signed: false });

    // Before Hydro's route permission check and before contest handlers read `this.user`, for pages and sockets alike.
    ctx.on('handler/create', async (created, transport) => {
        const handler = created as Handler;
        const token = cookieOf(handler);
        if (!token) return;
        const doc = await store.find(token);
        if (!doc || handler.domain?._id !== doc.domainId || handler.user?._id !== doc.adminUid) return;
        const path = handler.context.originalPath || handler.request.path;
        const query = new URLSearchParams(handler.context.querystring || '');
        const method = String(handler.request.method || 'get').toLowerCase();
        if (transport !== 'ws' && method !== 'get' && method !== 'head') {
            if (perspectiveAction(path, query, doc.tid)) throw new ForbiddenError('选手视角为只读，请先返回管理视角');
            return;
        }
        if (!perspectiveScope(path, query, doc.tid)) return;
        const tdoc = await ContestModel.get(doc.domainId, new ObjectId(doc.tid));
        if (!tdoc || !canManage(handler, tdoc)) return;
        const team = await UserModel.getById(doc.domainId, doc.uid);
        if (!team) return;
        (handler as Marked).xcpcioPerspective = { uid: team._id, name: doc.name || team.uname, tid: doc.tid };
        handler.user = team;
    });
    // Hydro starts a team's own clock when it first opens the problems or a private file; a manager's look does not.
    ctx.on('handler/before', (handler: Handler) => {
        const marked = handler as Marked;
        if (marked.xcpcioPerspective && marked.tsdoc?.attend && !marked.tsdoc.startAt) marked.tsdoc.startAt = new Date();
    });
    ctx.on('handler/after', (handler: Handler) => {
        const view = (handler as Marked).xcpcioPerspective;
        if (!view || !handler.UiContext) return;
        const base = `/d/${encodeURIComponent(handler.domain._id)}/contest/${view.tid}`;
        handler.UiContext.xcpcioPerspective = { name: view.name, exit: '/xcpcio-perspective/exit', back: `${base}/scoreboard/xcpcio-plus` };
    });

    class PerspectiveHandler extends Handler {
        tdoc!: Tdoc;
        @param('tid', Types.ObjectId)
        async prepare(_domain: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            this.checkPriv(PRIV.PRIV_USER_PROFILE);
            const tdoc = await ContestModel.get(this.domain._id, tid);
            if (!tdoc || tdoc.rule !== 'acm') throw new NotFoundError('比赛不存在');
            if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            this.tdoc = tdoc;
        }
        async get() {
            const teams = await dependencies.teams(this.tdoc);
            this.response.template = 'xcpcio_perspective.html';
            this.response.body = { tdoc: this.tdoc, codeBase: resolverCodeBase(pkg.version), runtimeJson: toScriptJson({ teams }),
                contestUrl: `/d/${encodeURIComponent(this.tdoc.domainId)}/contest/${this.tdoc.docId}` };
        }
        @param('uid', Types.Int)
        async post(_domain: string, uid: number) {
            const status = await ContestModel.getStatus(this.tdoc.domainId, this.tdoc.docId, uid);
            const team = (await dependencies.teams(this.tdoc)).find(row => row.uid === uid);
            if (!status?.attend || !team) throw new ForbiddenError('该队伍未参加这场比赛');
            await store.end(cookieOf(this));
            const token = await store.start(this.user._id, this.tdoc.domainId, String(this.tdoc.docId), uid, team.name);
            this.context.cookies.set(perspectiveCookie, token, { signed: false, httpOnly: true, sameSite: 'lax', path: '/',
                maxAge: perspectiveTtl, secure: this.context.secure });
            const base = `/d/${encodeURIComponent(this.tdoc.domainId)}/contest/${this.tdoc.docId}`;
            this.response.redirect = ContestModel.isNotStarted(this.tdoc) ? base : `${base}/problems`;
        }
    }
    class PerspectiveExitHandler extends Handler {
        noCheckPermView = true;
        async post() {
            await store.end(cookieOf(this));
            this.context.cookies.set(perspectiveCookie, '', { signed: false, httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 });
            this.response.body = { ok: true };
        }
    }
    ctx.Route('contest_xcpcio_perspective', '/contest/:tid/perspective', PerspectiveHandler);
    ctx.Route('xcpcio_perspective_exit', '/xcpcio-perspective/exit', PerspectiveExitHandler);
    ctx.i18n.load('zh', { contest_xcpcio_perspective: '选手视角' });
    return { store };
}
