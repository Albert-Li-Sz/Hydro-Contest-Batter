/**
 * The CCS Contest API over HTTP, at `/d/<domain>/ccsapi/` (Hydro's own `/api/:op` is a different
 * thing). Authentication: HTTP Basic with a Hydro account, or a Hydro login session; without one,
 * read-only public access when the contest's board is public.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { type Readable } from 'node:stream';
import type { Context, Tdoc } from 'hydrooj';
import { schoolName } from '../board';
import { accessObject, accountProperties, type AccessContext, endpointProperties, idProperties, project } from './access';
import {
    buildObjects, buildScoreboard, type CcsObjects, type CcsSource, contestTimes, mimeOf, type View,
} from './model';
import { createCcsSourceLoader, logoRegistry, type SourceDependencies, type HydroApi } from './source';
import { ccsStore, contestKey } from './store';
import {
    abstime, reltime, CcsError, type Endpoint, ENDPOINTS, isId, languageId, parseAbstime, parseReltime, type Role, SPEC_URL, SPEC_VERSION, teamId, uidOfTeam,
} from './types';
import { applyWriter } from './writer';
import { openFeed } from './feed';
import { type HostLookup, validateWebhookUrl, type WebhookPost } from './ssrf';
import { readZip, writeZip, ZipError } from './zip';
import { VERDICT_CHANGED } from '../verdict-event';

const MAX_WEBHOOKS_PER_DOMAIN = 20;
const MAX_WEBHOOKS_PER_USER = 10;

const TYPE_CONTEST = 30;
const TYPE_CONTEST_CLARIFICATION = 31;
const AUTH_TTL_MS = 5 * 60_000;
const logoKey = (name: string) => name.normalize('NFKC').trim().toLowerCase().replace(/\s+/g, ' ');


interface Caller {
    user: any | null;
    /** Authenticated through HTTP Basic (as opposed to a browser session). */
    basic: boolean;
}

export function applyCcsApi(host: HydroApi, ctx: Context, dependencies: SourceDependencies & { webhookLookup?: HostLookup; webhookPost?: WebhookPost }) {
    const { ContestModel, DocumentModel, DomainModel, Handler, ObjectId, PERM, PRIV, ProblemModel, RecordModel, SettingModel, StorageModel, SystemModel, UserModel } = host;
    const { loadCcsSource, problemLanguages } = createCcsSourceLoader(host);
    /** An ObjectId whose timestamp is `ms` (submissions and clarifications PUT with a time). */
const objectIdAt = (ms: number) => new ObjectId(Math.floor(ms / 1000).toString(16).padStart(8, '0') + new ObjectId().toHexString().slice(8));

    const store = ccsStore(ctx);
    const sources = new Map<string, { expires: number; value: Promise<CcsSource> }>();
    const writer = applyWriter(host, ctx, store, dependencies, loadCcsSource, { lookup: dependencies.webhookLookup, post: dependencies.webhookPost }, (key) => {
        sources.delete(key);
        (ctx as unknown as { broadcast: (event: string, ...args: unknown[]) => void }).broadcast('xcpcio/ccs-invalidated', key);
    });
    const version = JSON.parse(fs.readFileSync(path.join(__dirname, '../../package.json'), 'utf8')).version as string;
    const settingsCollection = ctx.db.collection('xcpcio.enhanced.settings' as never) as unknown as {
        find: (filter: object) => { toArray: () => Promise<{ _id: string; settings?: { ccsApi?: boolean } }[]> };
    };
    const on = ctx.on.bind(ctx) as unknown as (name: string, listener: (...args: any[]) => unknown) => () => void;
    on('app/started', () => store.ensureIndexes().catch(() => null));
    on('xcpcio/ccs-touch', (key: string) => { sources.delete(key); writer.touch(key); });
    on('xcpcio/ccs-invalidated', (key: string) => { sources.delete(key); });
    on('record/change', (rdoc: { domainId?: string; contest?: unknown }) => {
        if (rdoc?.domainId && rdoc?.contest) sources.delete(contestKey(String(rdoc.domainId), String(rdoc.contest)));
    });
    for (const event of ['record/judge', VERDICT_CHANGED]) {
        on(event, (rdoc: { domainId?: string; contest?: unknown }) => {
            if (rdoc?.domainId && rdoc?.contest) sources.delete(contestKey(String(rdoc.domainId), String(rdoc.contest)));
        });
    }
    on('contest/edit', (tdoc: { domainId?: string; docId?: unknown }) => {
        if (tdoc?.domainId && tdoc?.docId) sources.delete(contestKey(String(tdoc.domainId), String(tdoc.docId)));
    });
    on('contest/del', (domainId: string, tid: unknown) => {
        const key = contestKey(String(domainId), String(tid));
        sources.delete(key);
        void store.deleteContest(String(domainId), String(tid)).catch(() => null);
    });
    on('domain/delete', (domainId: string) => {
        const prefix = `${domainId}/`;
        for (const key of sources.keys()) if (key.startsWith(prefix)) sources.delete(key);
        void store.deleteDomain(String(domainId)).catch(() => null);
    });
    const touch = (key: string) => {
        sources.delete(key);
        writer.touch(key);
        (ctx as unknown as { broadcast: (event: string, ...args: unknown[]) => void }).broadcast('xcpcio/ccs-touch', key);
    };

    // A verified password is remembered briefly: hashing it on every poll would be slow.
    const verified = new Map<string, { uid: number; expires: number; fingerprint: string }>();

    /**
     * Requests that arrive while a contest's source is loading share that load; a finished source is never
     * reused, so a GET never lags an event already delivered to a client. Writes, Hydro record/contest events
     * and writer commits also drop a load still running, so later requests read again.
     */
    const sourceFor = (tdoc: Tdoc, fresh = false) => {
        const key = contestKey(tdoc.domainId, `${tdoc.docId}`);
        let entry = sources.get(key);
        if (!entry || fresh) {
            const value = loadCcsSource(ctx, store, dependencies, tdoc);
            entry = { expires: Infinity, value };
            const settle = () => { if (sources.get(key)?.value === value) sources.delete(key); };
            value.then(settle, settle);
            sources.set(key, entry);
        }
        return entry.value;
    };
    const objectsOf = buildObjects;

    class CcsHandler extends Handler {
        noCheckPermView = true;
        notUsage = true;
        caller: Caller = { user: null, basic: false };

        private json(status: number, body: unknown) {
            this.response.status = status;
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(body);
        }

        private header(name: string, value: string) {
            this.response.addHeader(name, value);
        }

        async onerror(error: any) {
            let code = 500;
            let message = error?.message || '服务器错误';
            if (error instanceof CcsError) code = error.code;
            else if (error instanceof ZipError || error instanceof URIError) code = 400;
            else if (error?.constructor?.name === 'NotFoundError' || error?.constructor?.name?.endsWith('NotFoundError')) code = 404;
            else if (['PermissionError', 'PrivilegeError', 'ForbiddenError'].includes(error?.constructor?.name)) code = 403;
            else if (typeof error?.code === 'number' && error.code >= 400 && error.code < 600) code = error.code;
            if (code === 500) console.error('[ccs]', error);
            if (code === 401) this.header('WWW-Authenticate', 'Basic realm="CCS API", charset="UTF-8"');
            this.header('Access-Control-Allow-Origin', '*');
            this.json(code, { code, message: code === 500 ? '服务器错误' : message });
        }

        /** HTTP Basic with a Hydro account, else the browser's Hydro session, else nobody. */
        private async identify(): Promise<Caller> {
            const header = this.request.headers.authorization;
            if (typeof header === 'string' && /^basic /i.test(header)) {
                const decoded = Buffer.from(header.slice(6).trim(), 'base64').toString('utf8');
                const split = decoded.indexOf(':');
                if (split < 1) throw new CcsError(401, '认证信息格式错误');
                const uname = decoded.slice(0, split);
                const password = decoded.slice(split + 1);
                const cacheKey = createHash('sha256').update(`${this.domain._id}\n${decoded}`).digest('hex');
                const cached = verified.get(cacheKey);
                let user: any = null;
                if (cached && cached.expires > Date.now()) {
                    user = await UserModel.getById(this.domain._id, cached.uid);
                    if (cached.fingerprint !== createHash('sha256').update(`${user?._hash}:${user?._salt}`).digest('hex')) user = null;
                }
                if (!user) {
                    if (this.limitRate) await this.limitRate('ccs_login', 60, 30, this.request.ip);
                    const candidate = await UserModel.getByUname(this.domain._id, uname) as any;
                    if (candidate?.tfa || candidate?.authn) throw new CcsError(401, '此账号启用了双因素认证，请使用 Hydro 登录会话或专用 API 账号');
                    if (!candidate) throw new CcsError(401, '用户名或密码错误');
                    try {
                        await candidate.checkPassword(password);
                    } catch {
                        throw new CcsError(401, '用户名或密码错误');
                    }
                    user = candidate;
                    for (const [key, entry] of verified) if (entry.expires < Date.now()) verified.delete(key);
                    if (verified.size >= 1000) verified.delete(verified.keys().next().value!);
                    verified.set(cacheKey, { uid: candidate._id, expires: Date.now() + AUTH_TTL_MS, fingerprint: createHash('sha256').update(`${candidate._hash}:${candidate._salt}`).digest('hex') });
                }
                if (user?.tfa || user?.authn) throw new CcsError(401, '此账号启用了双因素认证，请使用 Hydro 登录会话或专用 API 账号');
                if (!user || !user.hasPriv(PRIV.PRIV_USER_PROFILE)) throw new CcsError(401, '账号已停用');
                return { user, basic: true };
            }
            if (header) throw new CcsError(401, '只支持 HTTP Basic 或 Hydro 登录会话');
            return { user: this.user?._id > 0 ? this.user : null, basic: false };
        }

        /** The caller's role in a contest, or an error when it may not see the contest at all. */
        private async roleIn(tdoc: Tdoc, settingsPublic: boolean): Promise<{ role: Role; team: string | null }> {
            const user = this.caller.user;
            if (user) {
                if (!user.hasPriv(PRIV.PRIV_USER_PROFILE)) throw new CcsError(401, '账号已停用');
                if (user.own(tdoc) || user.hasPerm(PERM.PERM_EDIT_CONTEST)) return { role: 'admin', team: null };
                if (user.hasPerm(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD)) return { role: 'judge', team: null };
                const entry = await ContestModel.getMultiStatus(tdoc.domainId, {
                    docId: tdoc.docId, $or: [{ uid: user._id }, { members: user._id }],
                }).toArray() as { uid: number; attend?: number }[];
                const attended = entry.find((item) => !!item.attend);
                if (attended) return { role: 'team', team: teamId(attended.uid) };
            }
            if (settingsPublic) return { role: 'public', team: null };
            throw user ? new CcsError(403, '没有权限访问此比赛') : new CcsError(401, '需要登录');
        }

        async all() {
            this.header('Access-Control-Allow-Origin', '*');
            this.header('Cache-Control', 'no-store');
            this.header('X-Content-Type-Options', 'nosniff');
            // HEAD is answered as GET (Koa drops the body).
            const requested = this.request.method.toUpperCase();
            const method = requested === 'HEAD' ? 'GET' : requested;
            if (method === 'OPTIONS') {
                this.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
                this.header('Access-Control-Allow-Headers', 'Authorization, Content-Type');
                this.response.status = 204;
                this.response.type = 'text/plain';
                this.response.body = '';
                return;
            }
            this.caller = await this.identify();
            if (method !== 'GET') {
                if (!this.caller.user) throw new CcsError(401, '需要登录');
                if (method !== 'DELETE' && !String(this.request.headers['content-type'] || '').toLowerCase().startsWith('application/json')) {
                    throw new CcsError(415, '请求体必须使用 application/json');
                }
                if (!this.caller.basic) {
                    const origin = this.request.headers.origin || this.request.headers.referer;
                    if (typeof origin === 'string') {
                        let host: string | null = null;
                        try { host = new URL(origin).host; } catch { /* malformed: rejected below */ }
                        if (host !== this.request.host) throw new CcsError(403, '跨站写入被拒绝');
                    }
                }
            }
            const params = (this.request.params || {}) as Record<string, string | undefined>;
            const route = this.request.path.replace(/^\/d\/[^/]+/, '').replace(/^\/ccsapi\/?/, '').split('/').filter(Boolean);
            if (!route.length) return this.apiInfo(method);
            if (route[0] === 'webhooks') {
                if (route.length > 2) throw new CcsError(404, '没有这个端点');
                return this.webhooks(method, route[1]);
            }
            if (route[0] !== 'contests') throw new CcsError(404, '没有这个端点');
            if (route.length > 6 || route[2] === 'contests') throw new CcsError(404, '没有这个端点');
            if (route.length === 1) return this.contestList(method);
            const cid = params.cid ?? route[1];
            if (!/^[a-f\d]{24}$/.test(cid)) throw new CcsError(404, '没有这场比赛');
            const tdoc = await ContestModel.get(this.domain._id, new ObjectId(cid)).catch(() => null) as Tdoc | null;
            if (!tdoc || tdoc.rule !== 'acm') throw new CcsError(404, '没有这场比赛');
            const settings = await dependencies.loadSettings(tdoc);
            if (!settings.ccsApi) throw new CcsError(404, '这场比赛没有开放 CCS API');
            const { role, team } = await this.roleIn(tdoc, settings.publicAccess);
            const access: AccessContext = {
                role, identity: role === 'judge' || role === 'admin' || settings.showIdentity,
                teamContest: !!(tdoc as { allowTeam?: boolean }).allowTeam,
            };
            const [, , endpoint, oid, file, name] = route;
            if (method !== 'GET' && (await store.contest(tdoc.domainId, cid)).snapshotId) throw new CcsError(409, '比赛数据已确认最终结果，不能继续修改 CCS 数据');
            if (endpoint === 'finalize' && !oid) return this.only(method, ['POST'], () => this.finalize(tdoc, access));
            if (['access', 'account', 'state', 'scoreboard', 'event-feed'].includes(endpoint) && oid) throw new CcsError(404, '没有这个端点');
            if (!endpoint) return this.contest(method, tdoc, access);
            if (!(ENDPOINTS as readonly string[]).includes(endpoint) && !['access', 'account'].includes(endpoint)) throw new CcsError(404, '没有这个端点');
            if (endpoint === 'access') return this.only(method, ['GET'], () => this.json(200, accessObject(access)));
            if (endpoint === 'account') return this.only(method, ['GET'], () => this.account(tdoc, access, team));
            const props = endpointProperties(access);
            if (!props[endpoint as Endpoint]) throw new CcsError(404, '无权访问此端点');
            if (endpoint === 'event-feed') return this.only(method, ['GET'], () => this.eventFeed(tdoc, access, team));
            if (endpoint === 'scoreboard') return this.only(method, ['GET'], () => this.scoreboard(tdoc, access, team));
            if (endpoint === 'state') {
                return this.only(method, ['GET'], async () => this.json(200, project((await this.objects(tdoc, access, team, false, true)).state, props.state)));
            }
            if (file) return this.only(method, ['GET'], () => this.file(tdoc, access, team, endpoint as Endpoint, oid!, file, name));
            if (oid) return this.object(method, tdoc, access, team, endpoint as Endpoint, decodeURIComponent(oid));
            return this.collection(method, tdoc, access, team, endpoint as Endpoint);
        }

        private only(method: string, allowed: string[], run: () => unknown) {
            if (!allowed.includes(method)) {
                this.header('Allow', allowed.join(', '));
                throw new CcsError(405, `此端点不支持 ${method}`);
            }
            return run();
        }

        private apiInfo(method: string) {
            return this.only(method, ['GET'], () => this.json(200, {
                version: SPEC_VERSION, version_url: SPEC_URL, provider: { name: 'Hydro XCPCIO Plus', version },
            }));
        }

        private async objects(tdoc: Tdoc, access: AccessContext, team: string | null, fresh = false, skipCommentary = false) {
            const source = await sourceFor(tdoc, fresh);
            const options = skipCommentary ? { skipCommentary: true } : undefined;
            if (access.role === 'judge' || access.role === 'admin') return objectsOf(source, 'full', options);
            const objects = objectsOf(source, access.role === 'team' && team ? `team-${team}` : 'public', options);
            // Current privacy settings still apply after the final snapshot is frozen.
            if (access.identity) return objects;
            return { ...objects, organizations: [], groups: objects.groups.filter(group => !group.id.startsWith('school-')),
                awards: objects.awards.filter(award => !award.id.startsWith('group-winner-school-')),
                teams: objects.teams.map(item => ({ ...item, organization_id: null, group_ids: item.group_ids?.filter(id => !id.startsWith('school-')) })),
            };
        }

        private async contestList(method: string) {
            return this.only(method, ['GET'], async () => {
                const rows = await settingsCollection.find({ 'settings.ccsApi': true }).toArray();
                const list = [];
                for (const row of rows) {
                    const [domainId, tid] = String(row._id).split('/');
                    if (domainId !== this.domain._id || !/^[a-f\d]{24}$/.test(tid)) continue;
                    const tdoc = await ContestModel.get(domainId, new ObjectId(tid)).catch(() => null) as Tdoc | null;
                    if (!tdoc || tdoc.rule !== 'acm') continue;
                    const settings = await dependencies.loadSettings(tdoc);
                    if (!settings.ccsApi) continue;
                    try {
                        const { role } = await this.roleIn(tdoc, settings.publicAccess);
                        const access: AccessContext = {
                            role, identity: role === 'judge' || role === 'admin' || settings.showIdentity,
                            teamContest: !!(tdoc as { allowTeam?: boolean }).allowTeam,
                        };
                        list.push(project((await this.objects(tdoc, access, null, false, true)).contest, endpointProperties(access).contests));
                    } catch { /* not visible to this caller */ }
                }
                this.json(200, list);
            });
        }

        private async contest(method: string, tdoc: Tdoc, access: AccessContext) {
            if (method === 'GET') {
                this.json(200, project((await this.objects(tdoc, access, null, false, true)).contest, endpointProperties(access).contests));
                return;
            }
            if (method !== 'PATCH') return this.only(method, ['GET', 'PATCH'], () => null);
            const body = this.body();
            if (body.id !== undefined && body.id !== `${tdoc.docId}`) throw new CcsError(409, '请求中的比赛 id 与地址不一致');
            if (body.id === undefined) throw new CcsError(400, '缺少 id');
            const key = contestKey(tdoc.domainId, `${tdoc.docId}`);
            const now = Date.now();
            const allowed = 'scoreboard_thaw_time' in body ? ['id', 'scoreboard_thaw_time'] : ['id', 'start_time', 'countdown_pause_time'];
            if (Object.keys(body).some(key => !allowed.includes(key))) throw new CcsError(400, '比赛 PATCH 含有不支持的字段');
            if ('scoreboard_thaw_time' in body) {
                if (access.role !== 'admin') throw new CcsError(403, '需要 contest_thaw 权限');
                const at = parseAbstime(body.scoreboard_thaw_time);
                if (at === null) throw new CcsError(400, 'scoreboard_thaw_time 格式错误');
                if (!tdoc.lockAt || (tdoc as { unlocked?: boolean }).unlocked) throw new CcsError(403, '比赛没有封榜或已经解冻');
                if (at <= now) {
                    if (now < tdoc.endAt.getTime()) throw new CcsError(403, '比赛结束后才能解冻');
                    await ContestModel.unlockScoreboard(tdoc.domainId, tdoc.docId);
                    await store.setMeta(key, tdoc.domainId, `${tdoc.docId}`, { thawedAt: now, thawAt: null });
                    touch(key);
                    const fresh = await ContestModel.get(tdoc.domainId, tdoc.docId) as Tdoc;
                    this.json(200, project((await this.objects(fresh, access, null, true)).contest, endpointProperties(access).contests));
                    return;
                }
                if (at < tdoc.endAt.getTime()) throw new CcsError(403, '解冻时间不能早于比赛结束');
                await store.setMeta(key, tdoc.domainId, `${tdoc.docId}`, { thawAt: at });
                touch(key);
                this.response.status = 204;
                this.response.type = 'text/plain';
                this.response.body = '';
                return;
            }
            if (!('start_time' in body)) throw new CcsError(400, '只能修改 start_time 或 scoreboard_thaw_time');
            if (access.role !== 'admin') throw new CcsError(403, '需要 contest_start 权限');
            const { meta } = await store.contest(tdoc.domainId, `${tdoc.docId}`);
            const begin = tdoc.beginAt.getTime();
            if (meta.countdownPauseMs == null && now >= begin - 30_000) throw new CcsError(403, '比赛已开始或即将开始，不能修改开始时间');
            if (body.start_time === null) {
                const pause = body.countdown_pause_time === undefined || body.countdown_pause_time === null
                    ? Math.max(30_000, begin - now) : parseReltime(body.countdown_pause_time);
                if (pause === null || pause < 0) throw new CcsError(400, 'countdown_pause_time 格式错误');
                await store.setMeta(key, tdoc.domainId, `${tdoc.docId}`, { countdownPauseMs: pause });
                const shift = now + Math.max(pause, 60_000) - begin;
                await ContestModel.edit(tdoc.domainId, tdoc.docId, { beginAt: new Date(begin + shift), endAt: new Date(tdoc.endAt.getTime() + shift), ...(tdoc.lockAt ? { lockAt: new Date(tdoc.lockAt.getTime() + shift) } : {}) });
            } else {
                if (body.countdown_pause_time !== undefined && body.countdown_pause_time !== null) throw new CcsError(400, '设置了开始时间时 countdown_pause_time 必须为空');
                const at = parseAbstime(body.start_time);
                if (at === null) throw new CcsError(400, 'start_time 格式错误');
                if (at < now + 30_000) throw new CcsError(403, '开始时间必须在 30 秒之后');
                const shift = at - begin;
                await ContestModel.edit(tdoc.domainId, tdoc.docId, {
                    beginAt: new Date(at), endAt: new Date(tdoc.endAt.getTime() + shift),
                    ...tdoc.lockAt ? { lockAt: new Date(new Date(tdoc.lockAt).getTime() + shift) } : {},
                });
                await ContestModel.recalcStatus(tdoc.domainId, tdoc.docId);
                await store.setMeta(key, tdoc.domainId, `${tdoc.docId}`, { countdownPauseMs: null });
            }
            touch(key);
            const fresh = await ContestModel.get(tdoc.domainId, tdoc.docId) as Tdoc;
            this.json(200, project((await this.objects(fresh, access, null, true)).contest, endpointProperties(access).contests));
        }

        private async account(tdoc: Tdoc, access: AccessContext, team: string | null) {
            const user = this.caller.user;
            if (!user) throw new CcsError(404, '未登录');
            const type = access.role === 'admin' ? 'admin' : access.role === 'judge' ? 'judge' : access.role === 'team' ? 'team' : 'staff';
            const objects = await this.objects(tdoc, access, team, false, true);
            const personId = objects.persons.some((person) => person.id === `p${user._id}`) ? `p${user._id}` : null;
            this.json(200, project({
                id: `u${user._id}`, username: user.uname, name: user.displayName || user.uname, type, team_id: team, person_id: personId,
            }, accountProperties));
        }

        private async scoreboard(tdoc: Tdoc, access: AccessContext, team: string | null) {
            const source = await sourceFor(tdoc);
            const view: View = access.role === 'judge' || access.role === 'admin' ? 'full' : 'public';
            const groupId = typeof this.request.query.group_id === 'string' ? this.request.query.group_id : null;
            if (groupId !== null) {
                const objects = await this.objects(tdoc, access, team, false, true);
                if (!objects.groups.some((group) => group.id === groupId)) throw new CcsError(400, '没有这个分组');
            }
            this.json(200, buildScoreboard(source, view, groupId));
        }

        private async collection(method: string, tdoc: Tdoc, access: AccessContext, team: string | null, endpoint: Endpoint) {
            if (method === 'POST') return this.create(tdoc, access, team, endpoint, null);
            if (method !== 'GET') return this.only(method, ['GET', 'POST'], () => null);
            const objects = await this.objects(tdoc, access, team, false, endpoint !== 'commentary');
            const list = endpoint === 'contests' ? [objects.contest] : (objects[endpoint as keyof CcsObjects] as unknown as Record<string, unknown>[]);
            if (!Array.isArray(list)) throw new CcsError(404, '没有这个端点');
            const props = endpointProperties(access)[endpoint]!;
            // Filtering on ID properties (an empty value matches null), all conditions together.
            const filters = (idProperties[endpoint] || []).filter((key) => props.includes(key) && typeof this.request.query[key] === 'string')
                .map((key) => [key, this.request.query[key] as string] as const);
            const filtered = list.filter((item) => filters.every(([key, value]) => {
                const field = (item as unknown as Record<string, unknown>)[key];
                return value === '' ? field == null : field === value;
            }));
            this.json(200, filtered.map((item) => project(item, props)));
        }

        private async object(method: string, tdoc: Tdoc, access: AccessContext, team: string | null, endpoint: Endpoint, id: string) {
            if (method === 'PUT') return this.create(tdoc, access, team, endpoint, id);
            if (method === 'PATCH' || method === 'DELETE') return this.changeAward(method, tdoc, access, endpoint, id);
            if (method !== 'GET') return this.only(method, ['GET', 'PUT', 'PATCH', 'DELETE'], () => null);
            const objects = await this.objects(tdoc, access, team, false, endpoint !== 'commentary');
            const list = objects[endpoint as keyof CcsObjects] as unknown as { id: string }[];
            const found = Array.isArray(list) ? list.find((item) => item.id === id) : undefined;
            if (!found) throw new CcsError(404, `没有 id 为 ${id} 的对象`);
            this.json(200, project(found, endpointProperties(access)[endpoint]));
        }

        private body(): Record<string, any> {
            const body = this.request.body;
            if (!body || typeof body !== 'object' || Array.isArray(body)) throw new CcsError(400, '请求体必须是 JSON 对象');
            return body as Record<string, any>;
        }

        private async create(tdoc: Tdoc, access: AccessContext, team: string | null, endpoint: Endpoint, id: string | null) {
            const body = this.body();
            if (id !== null) {
                if (body.id === undefined) throw new CcsError(400, 'PUT 必须提供 id');
                if (body.id !== undefined && body.id !== id) throw new CcsError(409, '请求中的 id 与地址不一致');
                if (!isId(id)) throw new CcsError(400, 'id 格式错误');
            } else if (body.id !== undefined) throw new CcsError(400, 'POST 不能指定 id');
            if (endpoint === 'submissions') return this.submit(tdoc, access, team, body, id);
            if (endpoint === 'clarifications') return this.clarify(tdoc, access, team, body, id);
            if (endpoint === 'awards') return this.putAward(tdoc, access, body, id);
            if (endpoint === 'commentary' && id === null) return this.comment(tdoc, access, body);
            throw new CcsError(405, '此端点不支持写入');
        }

        private async created(tdoc: Tdoc, access: AccessContext, team: string | null, endpoint: Endpoint, id: string) {
            const key = contestKey(tdoc.domainId, `${tdoc.docId}`);
            touch(key);
            const objects = await this.objects(tdoc, access, team, true, endpoint !== 'commentary');
            const found = (objects[endpoint as keyof CcsObjects] as unknown as { id: string }[]).find((item) => item.id === id);
            this.header('Location', `/d/${encodeURIComponent(tdoc.domainId)}/ccsapi/contests/${tdoc.docId}/${endpoint}/${encodeURIComponent(id)}`);
            this.json(201, found ? project(found, endpointProperties(access)[endpoint]) : { id });
        }

        /** team_submit, proxy_submit and admin_submit: a Hydro record judged as any contest submission. */
        private async submit(tdoc: Tdoc, access: AccessContext, team: string | null, body: Record<string, any>, id: string | null) {
            const admin = access.role === 'admin';
            if (access.role !== 'team' && !admin) throw new CcsError(403, '没有提交权限');
            const timed = 'time' in body;
            if (id !== null && !(admin && timed)) throw new CcsError(400, 'PUT 提交需要 admin_submit 并提供 time');
            if (!admin && (timed || body.contest_time !== undefined)) throw new CcsError(400, '队伍提交不能指定 time');
            if (typeof body.language_id !== 'string' || typeof body.problem_id !== 'string') throw new CcsError(400, '缺少 language_id 或 problem_id');
            const source = await sourceFor(tdoc);
            const language = source.languages.find((lang) => languageId(lang.key) === body.language_id);
            if (!language || language.submittable === false) throw new CcsError(400, `语言 ${body.language_id} 不可用于此比赛提交`);
            const pid = Number(body.problem_id);
            if (!tdoc.pids.includes(pid)) throw new CcsError(400, `没有题目 ${body.problem_id}`);
            let uid: number;
            let rankingUid: number;
            if (access.role === 'team') {
                if (body.team_id !== undefined && body.team_id !== team) throw new CcsError(400, 'team_id 与登录队伍不一致');
                uid = this.caller.user._id;
                rankingUid = uidOfTeam(team!)!;
            } else {
                if (typeof body.team_id !== 'string') throw new CcsError(400, '代理提交需要 team_id');
                const teamUid = uidOfTeam(body.team_id);
                const known = (await this.objects(tdoc, access, team)).teams.some((item) => item.id === body.team_id);
                if (teamUid === null || !known) throw new CcsError(400, `没有队伍 ${body.team_id}`);
                rankingUid = teamUid;
                uid = teamUid < 0 ? source.accounts.find(account => account.teamUid === teamUid)?.uid ?? teamUid : teamUid;
            }
            const now = Date.now();
            if (source.meta.countdownPauseMs != null) throw new CcsError(400, '比赛开始倒计时已暂停');
            const at = timed ? parseAbstime(body.time) : now;
            if (at === null || at > now) throw new CcsError(400, 'time 格式错误或在未来');
            if ('contest_time' in body && parseReltime(body.contest_time) !== at - tdoc.beginAt.getTime()) throw new CcsError(400, 'contest_time 与 time 不一致');
            if (body.entry_point != null) throw new CcsError(400, 'Hydro 使用语言配置确定入口，此语言不接受自定义 entry_point');
            if (at < tdoc.beginAt.getTime() || at >= tdoc.endAt.getTime()) throw new CcsError(400, '提交时间不在比赛时间内');
            const files = body.files;
            if (!Array.isArray(files) || files.length !== 1 || typeof files[0]?.data !== 'string') throw new CcsError(400, 'files 必须是一个 zip 文件（data 为 base64）');
            if (files[0].mime !== undefined && files[0].mime !== 'application/zip') throw new CcsError(400, 'files 的 mime 必须是 application/zip');
            const limit = Number(SystemModel.get('limit.codelength')) || 128 * 1024;
            if (files[0].data.length > (limit * 4 + 65536) * 2 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(files[0].data)) throw new CcsError(400, 'zip 的 base64 内容无效或过大');
            const entries = readZip(Buffer.from(files[0].data, 'base64'), { maxFiles: 1, maxBytes: limit * 4 });
            if (entries.length !== 1) throw new CcsError(400, 'zip 中必须恰好有一个源文件');
            let code: string;
            try { code = new TextDecoder('utf-8', { fatal: true }).decode(entries[0].data).replace(/\r\n/g, '\n'); }
            catch { throw new CcsError(400, '源文件必须为 UTF-8 文本'); }
            if (!code.length) throw new CcsError(400, '源文件不能为空');
            const originalProblem = await ProblemModel.get(tdoc.domainId, pid) as any;
            const problem = originalProblem?.reference ? await ProblemModel.get(originalProblem.reference.domainId, originalProblem.reference.pid) : originalProblem;
            if (!problem || typeof problem.config !== 'object' || !problem.config) throw new CcsError(400, '题目配置不可用');
            if (!(await problemLanguages(tdoc, originalProblem)).includes(language.key)) throw new CcsError(400, '该题目不接受此语言');
            if (code.length > limit) throw new CcsError(400, `代码过长（最多 ${limit} 字符）`);
            const key = contestKey(tdoc.domainId, `${tdoc.docId}`);
            if (id !== null && (await store.refOf(key, 'submissions', id) || source.records.some((record) => record.submissionId === id))) {
                throw new CcsError(409, `提交 ${id} 已存在`);
            }
            const status = await ContestModel.getStatus(tdoc.domainId, tdoc.docId, rankingUid) as { attend?: number } | null;
            if (!status?.attend) throw new CcsError(400, '该队伍没有参加比赛');
            if (this.limitRate) {
                await this.limitRate('ccs_submit', 60, Number(SystemModel.get('limit.submission')) || 30, String(uid));
            }
            let rid: import('hydrooj').ObjectId;
            if (timed) {
                // Submitted at the given time: the record id carries the time, as Hydro reads it.
                rid = objectIdAt(at);
                if (id !== null) {
                    try { await store.mapId(key, 'submissions', id, `${rid}`); }
                    catch (error) { if ((error as any)?.code === 11000) throw new CcsError(409, `提交 ${id} 已存在`); throw error; }
                }
                const rdoc = {
                    status: 0, _id: rid, uid, code, lang: language.key, pid, domainId: tdoc.domainId, score: 0, time: 0, memory: 0,
                    judgeTexts: [], compilerTexts: [], testCases: [], judger: null, judgeAt: null, rejudged: false, contest: tdoc.docId, ccsTime: new Date(at),
                };
                try { await (RecordModel as any).coll.insertOne(rdoc); }
                catch (error) {
                    if (id !== null) await store.releaseId(key, 'submissions', id, `${rid}`);
                    throw error;
                }
                (ctx as any).broadcast('record/change', rdoc);
                const priority = await (RecordModel as any).submissionPriority(uid, 50);
                await (RecordModel as any).judge(tdoc.domainId, rdoc, priority, { detail: false }, { type: 'judge', rejudge: false });
            } else {
                rid = await RecordModel.add(tdoc.domainId, pid, uid, language.key, code, true, { contest: tdoc.docId, type: 'judge' }) as import('hydrooj').ObjectId;
            }
            await Promise.all([
                ProblemModel.inc(tdoc.domainId, pid, 'nSubmit', 1),
                DomainModel.incUserInDomain(tdoc.domainId, uid, 'nSubmit'),
                ContestModel.updateStatus(tdoc.domainId, tdoc.docId, rankingUid, rid, pid),
            ]);
            const submissionId = id ?? `${rid}`;
            return this.created(tdoc, access, team, 'submissions', submissionId);
        }

        /** Native questions/replies are mirrored; CCS also retains directed/group messages and supplied IDs. */
        private async clarify(tdoc: Tdoc, access: AccessContext, team: string | null, body: Record<string, any>, id: string | null) {
            if (access.role === 'public') throw new CcsError(403, '没有发送澄清的权限');
            const admin = access.role === 'admin';
            const timed = 'time' in body;
            if ((timed || id !== null) && !admin) throw new CcsError(400, '指定 id 或 time 需要 admin_clar');
            if (id !== null && !timed) throw new CcsError(400, 'PUT 澄清需要提供 time');
            if ('contest_time' in body && !timed) throw new CcsError(400, '不能单独指定 contest_time');
            if (typeof body.text !== 'string' || !body.text.trim() || body.text.length > 10000) throw new CcsError(400, 'text 必须为 1 至 10000 字符');
            const at = timed ? parseAbstime(body.time) : Date.now();
            if (at === null || at > Date.now()) throw new CcsError(400, 'time 格式错误或在未来');
            if ('contest_time' in body && parseReltime(body.contest_time) !== at - tdoc.beginAt.getTime()) throw new CcsError(400, 'contest_time 与 time 不一致');
            const objects = await this.objects(tdoc, access, team, true);
            const source = await sourceFor(tdoc);
            const key = contestKey(tdoc.domainId, String(tdoc.docId));
            const ccsId = id ?? `c${new ObjectId().toHexString()}`;
            if (objects.clarifications.some(item => item.id === ccsId)) throw new CcsError(409, '澄清 id 已存在');
            const nullableRef = (field: string, objects: { id: string }[]) => {
                if (body[field] == null) return null;
                if (typeof body[field] !== 'string' || !objects.some(item => item.id === body[field])) throw new CcsError(400, `${field} 不存在`);
                return body[field] as string;
            };
            const arrayRef = (field: string, known: { id: string }[]) => {
                if (body[field] == null) return null;
                if (!Array.isArray(body[field]) || body[field].some((v: unknown) => typeof v !== 'string' || !known.some(o => o.id === v))) throw new CcsError(400, `${field} 无效`);
                return [...new Set<string>(body[field])];
            };
            const problem = nullableRef('problem_id', objects.problems);
            const reply = nullableRef('reply_to_id', objects.clarifications);
            let from = nullableRef('from_team_id', objects.teams);
            const recipients = arrayRef('to_team_ids', objects.teams);
            const groups = arrayRef('to_group_ids', objects.groups);
            if (access.role === 'team') {
                if ('to_team_ids' in body || 'to_group_ids' in body) throw new CcsError(400, '队伍不能指定接收者');
                if ('from_team_id' in body && from !== team) throw new CcsError(400, 'from_team_id 与登录队伍不一致');
                from = team;
                if (!contestTimes(source).started || contestTimes(source).ended) throw new CcsError(400, '比赛进行中才能提问');
            } else if (!admin && 'from_team_id' in body) throw new CcsError(400, '裁判不能指定 from_team_id');
            if (from && (recipients !== null || groups !== null)) throw new CcsError(400, '队伍不能向其他队伍或分组发送消息');
            const clarification = {
                id: ccsId, from_team_id: from, to_team_ids: recipients, to_group_ids: groups,
                reply_to_id: reply, problem_id: problem, text: body.text,
                time: abstime(at), contest_time: reltime(at - tdoc.beginAt.getTime()),
            };
            try { await store.addClarification(key, clarification); }
            catch (error) { if ((error as any)?.code === 11000) throw new CcsError(409, '澄清 id 已存在'); throw error; }
            // Preserve Hydro's own audience rules. Multicast messages live in the CCS store; they
            // must never be mirrored as a public Hydro announcement by accident.
            try {
                const nativeParent = reply && source.clarifications.find(item => (item.ccsId ?? `c${item.docId}`) === reply);
                if (nativeParent && (!recipients || recipients.length === 1 && recipients[0] === teamId(source.teamOfUser.get(nativeParent.owner) ?? nativeParent.owner)) && groups === null) {
                    await DocumentModel.push(tdoc.domainId, TYPE_CONTEST_CLARIFICATION as never, new ObjectId(nativeParent.docId) as never, 'reply' as never,
                        { _id: objectIdAt(at), owner: from ? uidOfTeam(from)! : this.caller.user._id, content: body.text, ip: this.request.ip, ccsMirror: true } as never);
                } else if (!reply && (from || recipients === null && groups === null)) {
                    await DocumentModel.add(tdoc.domainId, body.text, from ? uidOfTeam(from)! : 0, TYPE_CONTEST_CLARIFICATION as never, objectIdAt(at) as never,
                        TYPE_CONTEST as never, tdoc.docId as never, { subject: problem ? Number(problem) : 0, ip: this.request.ip, ccsMirror: true } as never);
                }
            } catch (error) { console.error('[ccs] clarification stored, native mirror failed', error); }
            return this.created(tdoc, access, team, 'clarifications', ccsId);
        }

        private async validTeams(tdoc: Tdoc, access: AccessContext, ids: unknown) {
            if (!Array.isArray(ids) || ids.some((item) => typeof item !== 'string')) throw new CcsError(400, 'team_ids 必须是队伍 id 数组');
            const teams = new Set((await this.objects(tdoc, access, null, false, true)).teams.map((item) => item.id));
            const unknown = (ids as string[]).find((item) => !teams.has(item));
            if (unknown) throw new CcsError(400, `没有队伍 ${unknown}`);
            return [...new Set(ids as string[])];
        }

        private async putAward(tdoc: Tdoc, access: AccessContext, body: Record<string, any>, id: string | null) {
            if (access.role !== 'admin') throw new CcsError(403, '只有管理员可以修改奖项');
            if (typeof body.citation !== 'string' || !body.citation.trim() || body.team_ids === undefined) {
                throw new CcsError(400, '需要 citation 和 team_ids');
            }
            const teamIds = body.team_ids === null ? null : await this.validTeams(tdoc, access, body.team_ids);
            const key = contestKey(tdoc.domainId, `${tdoc.docId}`);
            const awardId = id ?? `award-${new ObjectId().toHexString()}`;
            await store.setAward(key, { id: awardId, citation: body.citation.trim(), team_ids: teamIds });
            sources.delete(key);
            return this.created(tdoc, access, null, 'awards', awardId);
        }

        private async changeAward(method: string, tdoc: Tdoc, access: AccessContext, endpoint: Endpoint, id: string) {
            if (endpoint !== 'awards') throw new CcsError(405, `此端点不支持 ${method}`);
            if (access.role !== 'admin') throw new CcsError(403, '只有管理员可以修改奖项');
            const key = contestKey(tdoc.domainId, `${tdoc.docId}`);
            const current = (await this.objects(tdoc, access, null, false, true)).awards.find((award) => award.id === id);
            if (!current) throw new CcsError(404, `没有奖项 ${id}`);
            if (method === 'DELETE') {
                await store.setAward(key, { id, deleted: true });
                sources.delete(key);
                touch(key);
                this.response.status = 204;
                this.response.type = 'text/plain';
                this.response.body = '';
                return;
            }
            const body = this.body();
            if (body.id !== undefined && body.id !== id) throw new CcsError(409, '请求中的 id 与地址不一致');
            if ('citation' in body && (typeof body.citation !== 'string' || !body.citation.trim())) throw new CcsError(400, 'citation 无效');
            const teamIds = 'team_ids' in body ? body.team_ids === null ? null : await this.validTeams(tdoc, access, body.team_ids) : current.team_ids;
            await store.setAward(key, { id, citation: 'citation' in body ? body.citation.trim() : current.citation, team_ids: teamIds });
            sources.delete(key);
            touch(key);
            const objects = await this.objects(tdoc, access, null, true, true);
            this.json(200, project(objects.awards.find((award) => award.id === id)!, endpointProperties(access).awards));
        }

        private async comment(tdoc: Tdoc, access: AccessContext, body: Record<string, any>) {
            if (access.role !== 'admin' && access.role !== 'judge') throw new CcsError(403, '需要 post_comment 权限');
            for (const field of ['time', 'contest_time', 'source_id']) if (body[field] !== undefined) throw new CcsError(400, `不能指定 ${field}`);
            if (typeof body.message !== 'string' || !body.message.trim()) throw new CcsError(400, '缺少 message');
            if (!Array.isArray(body.tags) || body.tags.some((tag: unknown) => typeof tag !== 'string')) throw new CcsError(400, 'tags 必须是字符串数组');
            const objects = await this.objects(tdoc, access, null, false, true);
            const refs = (field: string, known: Set<string>) => {
                const value = body[field];
                if (value === undefined || value === null) return null;
                if (!Array.isArray(value) || value.some((item) => typeof item !== 'string' || !known.has(item))) throw new CcsError(400, `${field} 中有不存在的对象`);
                return [...new Set(value as string[])];
            };
            const key = contestKey(tdoc.domainId, `${tdoc.docId}`);
            const id = await store.addComment(key, {
                at: Date.now(), message: body.message, tags: body.tags, sourceUid: this.caller.user?._id ?? null,
                team_ids: refs('team_ids', new Set(objects.teams.map((item) => item.id))),
                problem_ids: refs('problem_ids', new Set(objects.problems.map((item) => item.id))),
                submission_ids: refs('submission_ids', new Set(objects.submissions.map((item) => item.id))),
            });
            sources.delete(key);
            return this.created(tdoc, access, null, 'commentary', id);
        }

        /** Submission sources (jury), organization logos and problem attachments. */
        private async file(tdoc: Tdoc, access: AccessContext, team: string | null, endpoint: Endpoint, oid: string, file: string, name?: string) {
            const objects = await this.objects(tdoc, access, team, false, true);
            const id = decodeURIComponent(oid);
            if (endpoint === 'submissions' && file === 'files' && !name) {
                const source = await sourceFor(tdoc);
                const record = source.records.find((item) => item.submissionId === id);
                if (access.role !== 'admin' && access.role !== 'judge' && (!team || !record || teamId(record.teamUid) !== team)) throw new CcsError(403, '只能下载本队代码');
                if (!record || !objects.submissions.some((item) => item.id === id)) throw new CcsError(404, `没有提交 ${id}`);
                const rdoc = await RecordModel.get(tdoc.domainId, new ObjectId(record.rid)) as any;
                if (!rdoc) throw new CcsError(404, `没有提交 ${id}`);
                const langs = (SettingModel as unknown as { langs: Record<string, any> }).langs || {};
                let entry: { name: string; data: Buffer };
                let archive: Buffer | undefined;
                if (rdoc.files?.code) {
                    const [storagePath, original] = String(rdoc.files.code).split('#');
                    entry = { name: original || `main.${langs[rdoc.lang]?.code_file?.split('.').pop() || 'txt'}`, data: await readStream(await StorageModel.get(`submission/${storagePath}`)) };
                    if (/\.zip$/i.test(original || '') && entry.data.subarray(0, 2).toString('ascii') === 'PK') archive = entry.data;
                } else {
                    const codeFile = langs[rdoc.lang]?.code_file;
                    entry = { name: typeof codeFile === 'string' && codeFile ? codeFile : `main.${String(rdoc.lang).split('.')[0] || 'txt'}`, data: Buffer.from(String(rdoc.code ?? ''), 'utf8') };
                }
                this.header('Cache-Control', 'private, no-store');
                entry.name = path.posix.basename(entry.name.replace(/\\/g, '/'));
                this.header('Content-Disposition', 'attachment; filename="files.zip"');
                this.response.type = 'application/zip';
                this.response.body = archive ?? writeZip([entry], new Date(record.submittedAt));
                return;
            }
            if (endpoint === 'organizations' && file === 'logo' && !name) {
                const organization = objects.organizations.find((item) => item.id === id);
                if (!organization?.logo) throw new CcsError(404, '没有校徽');
                const registry = logoRegistry();
                const logoId = registry.names[logoKey(schoolName(organization.name))];
                const pngPath = logoId && /^[a-f\d]{12}$/.test(logoId) ? path.join(__dirname, '../../logos/png', `${logoId}.png`) : null;
                if (!pngPath) throw new CcsError(404, '没有校徽');
                let png: Buffer;
                try { png = await fs.promises.readFile(pngPath); } catch { throw new CcsError(404, '没有校徽'); }
                this.header('Cache-Control', 'public, max-age=86400');
                this.response.type = 'image/png';
                this.response.body = png;
                return;
            }
            if (endpoint === 'problems' && file === 'attachments' && name) {
                const problem = objects.problems.find((item) => item.id === id);
                const filename = decodeURIComponent(name);
                if (!problem?.attachments?.some((item) => item.filename === filename)) throw new CcsError(404, '没有这个附件');
                const pdoc = await ProblemModel.get(tdoc.domainId, Number(id)) as any;
                const owner = pdoc?.reference ? { domainId: pdoc.reference.domainId, docId: pdoc.reference.pid } : { domainId: tdoc.domainId, docId: Number(id) };
                this.response.type = mimeOf(filename);
                this.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
                this.response.body = await StorageModel.get(`problem/${owner.domainId}/${owner.docId}/additional_file/${filename}`);
                return;
            }
            throw new CcsError(404, '没有这个文件');
        }

        private async finalize(tdoc: Tdoc, access: AccessContext) {
            if (access.role !== 'admin') throw new CcsError(403, '只有管理员可以确认最终结果');
            const source = await sourceFor(tdoc, true);
            const times = contestTimes(source);
            if (!times.ended || (times.freezes && times.thawedAt === null)
                || source.records.some(record => [0, 20, 21, 22].includes(record.judgings.at(-1)!.status))) {
                throw new CcsError(409, '比赛须已结束、已解冻且没有待评测提交');
            }
            const key = contestKey(tdoc.domainId, String(tdoc.docId));
            await store.setMeta(key, tdoc.domainId, String(tdoc.docId), { finalizeRequested: Date.now() });
            touch(key);
            this.json(202, { message: '最终结果确认已提交，事件流将在快照保存后结束' });
        }

        private async eventFeed(tdoc: Tdoc, access: AccessContext, team: string | null) {
            if (this.request.query.since_id !== undefined) throw new CcsError(400, '请使用 since_token');
            const key = contestKey(tdoc.domainId, String(tdoc.docId));
            const view: View = access.role === 'judge' || access.role === 'admin' ? 'full' : team ? `team-${team}` : 'public';
            if (team) await store.registerTeamView(key, team);
            touch(key);
            const stream = await openFeed({ store, key, view, access, since: this.request.query.since_token,
                authorized: async () => {
                    const current = await ContestModel.get(tdoc.domainId, tdoc.docId);
                    if (!current) return false;
                    const settings = await dependencies.loadSettings(current);
                    if (!settings.ccsApi) return false;
                    try {
                        if (this.caller.basic) this.caller = await this.identify();
                        else if (this.caller.user) this.caller.user = await UserModel.getById(tdoc.domainId, this.caller.user._id);
                        const allowed = await this.roleIn(current, settings.publicAccess);
                        return allowed.role === access.role && allowed.team === team
                            && (allowed.role === 'judge' || allowed.role === 'admin' || settings.showIdentity === access.identity);
                    } catch { return false; }
                },
            });
            (this.context as any).compress = false;
            (this.context as any).req?.socket?.setTimeout?.(0);
            (this.context as any).res?.once?.('close', () => stream.destroy());
            this.header('X-Accel-Buffering', 'no');
            this.response.type = 'application/x-ndjson';
            this.response.body = stream;
        }

        /** Webhooks of this domain (spec: `webhooks` beside `contests`), for contest administrators. */
        private async webhooks(method: string, id?: string) {
            const user = this.caller.user;
            if (!user) throw new CcsError(401, '需要登录');
            if (!user.hasPriv(PRIV.PRIV_USER_PROFILE)) throw new CcsError(401, '账号已停用');
            const domainAdmin = user.hasPerm(PERM.PERM_EDIT_CONTEST);
            const show = (hook: any) => ({ id: hook._id, url: hook.url, endpoints: hook.endpoints, contest_ids: hook.contest_ids, active: hook.active });
            if (id) {
                const hook = await store.webhooks.findOne({ _id: id, domainId: this.domain._id });
                if (!hook) throw new CcsError(404, `没有 webhook ${id}`);
                if (!domainAdmin && hook.owner !== user._id) throw new CcsError(403, '只能管理自己注册的 webhook');
                if (method === 'GET') return this.json(200, show(hook));
                if (method === 'DELETE') {
                    await store.webhooks.deleteOne({ _id: id });
                    this.response.status = 204;
                    this.response.type = 'text/plain';
                    this.response.body = '';
                    return;
                }
                return this.only(method, ['GET', 'DELETE'], () => null);
            }
            if (method === 'GET') {
                const hooks = await store.webhooks.find({ domainId: this.domain._id, ...(!domainAdmin ? { owner: user._id } : {}) }).toArray();
                return this.json(200, hooks.map(show));
            }
            if (method !== 'POST') return this.only(method, ['GET', 'POST'], () => null);
            const body = this.body();
            if (body.id !== undefined) throw new CcsError(400, 'POST 不能指定 id');
            validateWebhookUrl(body.url);
            if (typeof body.token !== 'string' || !/^[\x21-\x7e]{1,1024}$/.test(body.token)) throw new CcsError(400, 'token 须为 1 至 1024 个可打印 ASCII 字符');
            const existingHooks = await store.webhooks.find({ domainId: this.domain._id }).toArray();
            if (existingHooks.length >= MAX_WEBHOOKS_PER_DOMAIN) throw new CcsError(400, `当前域最多注册 ${MAX_WEBHOOKS_PER_DOMAIN} 个 webhook`);
            if (existingHooks.filter((h) => h.owner === user._id).length >= MAX_WEBHOOKS_PER_USER) throw new CcsError(400, `单个账号最多注册 ${MAX_WEBHOOKS_PER_USER} 个 webhook`);
            const endpoints = body.endpoints ?? [];
            const contestIds = body.contest_ids ?? [];
            const known = new Set<string>(['contests', 'contest', 'state', 'judgement-types', 'languages', 'problems', 'groups', 'organizations', 'teams', 'persons', 'accounts', 'submissions', 'judgements', 'runs', 'clarifications', 'awards', 'commentary']);
            if (!Array.isArray(endpoints) || endpoints.some((item) => typeof item !== 'string' || !known.has(item))) throw new CcsError(400, 'endpoints 无效');
            if (!Array.isArray(contestIds) || contestIds.some((item) => typeof item !== 'string' || !/^[a-f\d]{24}$/.test(item))) throw new CcsError(400, 'contest_ids 无效');
            // Only changes after registration are sent: start at each contest's current end of log.
            const rows = await settingsCollection.find({ 'settings.ccsApi': true }).toArray();
            const available: string[] = [];
            const cursors: Record<string, number> = {};
            for (const row of rows) {
                const [domainId, tid] = String(row._id).split('/');
                if (domainId !== this.domain._id || !/^[a-f\d]{24}$/.test(tid)) continue;
                const contest = await ContestModel.get(domainId, new ObjectId(tid));
                if (!contest || contest.rule !== 'acm' || !(await dependencies.loadSettings(contest)).ccsApi || !domainAdmin && !user.own(contest)) continue;
                available.push(tid);
                cursors[Buffer.from(String(row._id)).toString('base64url')] = await store.lastSeq(String(row._id), 'full');
            }
            if (!domainAdmin && !available.length) throw new CcsError(403, '只有比赛管理员可以注册 webhook');
            if (contestIds.some((tid: string) => !available.includes(tid))) throw new CcsError(400, 'contest_ids 中有未开放或不可管理的比赛');
            const hookId = `w${new ObjectId().toHexString()}`;
            await store.webhooks.insertOne({
                _id: hookId, domainId: this.domain._id, owner: user._id, url: body.url, endpoints: endpoints.map((item: string) => (item === 'contest' ? 'contests' : item)),
                contest_ids: contestIds, token: body.token, active: true, cursors, failingSince: null, lastError: null, createdAt: new Date(),
            });
            this.header('Location', `/d/${encodeURIComponent(this.domain._id)}/ccsapi/webhooks/${hookId}`);
            this.json(201, { id: hookId, url: body.url, endpoints, contest_ids: contestIds, active: true });
        }
    }

    for (const [name, route] of [
        ['ccsapi', '/ccsapi'],
        ['ccsapi_webhooks', '/ccsapi/webhooks'],
        ['ccsapi_webhook', '/ccsapi/webhooks/:wid'],
        ['ccsapi_contests', '/ccsapi/contests'],
        ['ccsapi_contest', '/ccsapi/contests/:cid'],
        ['ccsapi_endpoint', '/ccsapi/contests/:cid/:endpoint'],
        ['ccsapi_object', '/ccsapi/contests/:cid/:endpoint/:oid'],
        ['ccsapi_file', '/ccsapi/contests/:cid/:endpoint/:oid/:file'],
        ['ccsapi_attachment', '/ccsapi/contests/:cid/:endpoint/:oid/:file/:name'],
        ['ccsapi_unknown', '/ccsapi/*path'],
    ] as const) ctx.Route(name, route, CcsHandler);
    return { store, writer, handler: CcsHandler };
}

async function readStream(stream: Readable) {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks);
}
