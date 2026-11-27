import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    ConnectionHandler, ContestModel, Context, Handler, NotFoundError, ObjectId, param, PERM, PRIV, Tdoc, Types, UserModel,
} from 'hydrooj';
import type { BoardData } from '../board';
import type { ContestLinks } from '../links';
import { seatOf } from '../print';
import type { BoardSettings } from '../settings';
import { toScriptJson } from '../settings';
import { isTeamEntry, loadCoaches, loadSeats, memberIds, type TeamEntry } from '../teams';
import { resolverBoards, resolverCodeBase } from '../resolver-data';
import {
    adminApi, adminChannel, adminRuntime, type ApiResponse, builtinMediaNames, defaultVisualConfig, liveUrls, type LiveStore, overlayApi, overlayChannel,
    overlayControlChannel, pluginRoot, previewRuntime, readBuiltinMedia, shell, storeName,
} from './api';
import { applyCapture } from './capture-routes';
import { LiveHub, type LiveState } from './hub';
import { OverlayClients, OverlayError, OVERLAY_STATUS_MS, overlayTokenHash, type OverlayEndpoint } from './overlay-clients';
import { stateEntries, stateFromEntries, stateUpdate, type LiveStateEntries, type LiveStatePatch } from './state';

interface LiveDoc {
    _id: string;
    token: string;
    /** When the overlay token was issued (absent on documents from before 1.15). */
    tokenAt?: Date;
    /** Separate from the overlay token, so pictures placed in captions survive a token reset. */
    mediaKey: string;
    overlaySeq?: number;
    visualConfig: string;
    state?: LiveState;
    stateEntries?: LiveStateEntries;
    stateRevision?: number;
    updatedAt: Date;
}
interface LiveMedia {
    _id: string;
    key: string;
    name: string;
    mime: string;
    size: number;
    data: Buffer;
    createdAt: Date;
}
declare module 'hydrooj' {
    interface Collections {
        'xcpcio.live': LiveDoc;
        'xcpcio.live.media': LiveMedia;
    }
    interface EventMap {
        /**
         * Another Hydro process changed a contest's live state, token, a template, spotlight scores or a commentary mark,
         * or sends a command to an OBS overlay connected elsewhere.
         */
        'xcpcio/live-sync': (key: string, kind: LiveSyncKind, origin: string, payload?: unknown) => void;
    }
}

type LiveSyncKind = 'state' | 'token' | 'template' | 'spotlight' | 'social' | 'mark' | 'overlay';

/** Contest time is up to the board's rule; the overlay withholds teams until the board shows them. */
const nobody = { user: { _id: 0, own: () => false, hasPerm: () => false, hasPriv: () => false } };

const newToken = () => randomBytes(24).toString('hex');
const sameSecret = (given: string, expected: string) => {
    const buffer = Buffer.from(String(given));
    return buffer.length === Buffer.byteLength(expected) && timingSafeEqual(buffer, Buffer.from(expected));
};

export function applyLive(ctx: Context, dependencies: {
    loadSettings: (tdoc: Tdoc) => Promise<BoardSettings>;
    loadData: (tdoc: Tdoc, identity: boolean) => Promise<BoardData>;
    publicVideos?: (tdoc: Tdoc) => Promise<{ rid: string; url: string }[]>;
    staffReplay?: (tdoc: Tdoc, filter: { rid?: string; teamUid?: string }) => Promise<unknown>;
    intervalMs?: number;
    /** 画面采集 (plugin setting): off, its pages and sockets are not offered and teams have no video. */
    capture?: boolean;
    /** UDP port of Hydro's own STUN server for 画面采集; 0 turns it off. */
    captureStunPort?: number;
    /** The contest's no-login links, revoked together after the contest (lib/links.ts). */
    links?: ContestLinks<Tdoc>;
}) {
    const collection = ctx.db.collection('xcpcio.live');
    const media = ctx.db.collection('xcpcio.live.media');
    const logoNames = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'logos/index.json'), 'utf8')).names;
    const version = JSON.parse(fs.readFileSync(path.join(pluginRoot, 'package.json'), 'utf8')).version;
    const codeBase = resolverCodeBase(version);
    const key = (tdoc: Tdoc) => `${tdoc.domainId}/${tdoc.docId}`;
    const contestBase = (tdoc: Tdoc) => `/d/${encodeURIComponent(tdoc.domainId)}/contest/${tdoc.docId}`;
    const urls = (tdoc: Tdoc, doc: LiveDoc) => liveUrls(contestBase(tdoc), doc.token, doc.mediaKey);
    const hubs = new Map<string, Promise<LiveHub>>();
    // Open overlay websockets per contest, closed when their token is revoked.
    const overlays = new Map<string, Set<{ token: string; close: () => void }>>();
    // Each Hydro process (PM2 cluster) has its own hubs; changes are announced to the others.
    const instance = randomUUID();
    const announce = (contestKey: string, kind: LiveSyncKind, payload?: unknown) => {
        (ctx as unknown as { broadcast: (event: string, ...args: unknown[]) => void }).broadcast('xcpcio/live-sync', contestKey, kind, instance, payload);
    };
    const closeRevoked = (contestKey: string, token: string) => {
        for (const connection of overlays.get(contestKey) || []) if (connection.token !== token) connection.close();
    };
    // The OBS overlays open right now, for the list on the live settings page and its commands.
    const overlayClients = new OverlayClients(ctx.db, (delivery) => announce(delivery.contestKey, 'overlay', delivery));
    ctx.on('app/started', () => { void overlayClients.ensureIndexes().catch(() => null); });
    ctx.on('xcpcio/live-sync', async (contestKey, kind, origin, payload) => {
        if (origin === instance) return;
        if (kind === 'overlay') {
            overlayClients.receive(payload);
            return;
        }
        if (kind === 'state') {
            const change = payload as { patch: LiveStatePatch; revision: number };
            if (change?.patch && Number.isSafeInteger(change.revision)) {
                await (await hubs.get(contestKey)?.catch(() => null))?.reload(change.patch, change.revision);
            }
            return;
        }
        if (kind === 'token') {
            const doc = await collection.findOne({ _id: contestKey });
            if (!doc) return;
            closeRevoked(contestKey, doc.token);
            capture?.revoke(contestKey, doc.token);
            return;
        }
        const hub = await hubs.get(contestKey)?.catch(() => null);
        if (!hub) return;
        if (kind === 'template' && typeof payload === 'string') await hub.templateChanged(payload, true);
        else if (kind === 'spotlight' && Array.isArray(payload)) hub.addScores(payload as { teamId: string; score: number }[], true);
        else if (kind === 'social' && payload && typeof payload === 'object') hub.social(payload as Parameters<LiveHub['social']>[0], true);
        else if (kind === 'mark' && payload && typeof payload === 'object') hub.applyMark(payload as Parameters<LiveHub['applyMark']>[0]);
    });

    async function loadDoc(tdoc: Tdoc): Promise<LiveDoc> {
        const doc: LiveDoc = {
            _id: key(tdoc), token: newToken(), tokenAt: new Date(), mediaKey: newToken(), visualConfig: defaultVisualConfig(tdoc.title), stateEntries: {}, stateRevision: 0, updatedAt: new Date(),
        };
        // Two administrators opening the page at once must end up with the same token.
        await collection.updateOne({ _id: doc._id }, { $setOnInsert: doc }, { upsert: true });
        let current = (await collection.findOne({ _id: doc._id }))!;
        if (!current.stateEntries) {
            // One-time, conditional migration. A second process cannot replace migrated edits.
            await collection.updateOne({ _id: doc._id, stateEntries: { $exists: false } }, {
                $set: { stateEntries: stateEntries(current.state || {}), stateRevision: 0 }, $unset: { state: '' },
            });
            current = (await collection.findOne({ _id: doc._id }))!;
        }
        return current;
    }

    async function readMedia(contestKey: string, name: string) {
        const stored = await media.findOne({ _id: `${contestKey}/${name}` });
        if (stored) {
            const raw = stored.data as unknown;
            const data = Buffer.isBuffer(raw) ? raw
                : ArrayBuffer.isView(raw) ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength)
                    : Buffer.from((raw as { buffer: Uint8Array }).buffer);
            return { data, mime: stored.mime };
        }
        return readBuiltinMedia(name);
    }

    function store(contestKey: string, tdoc: Tdoc): LiveStore {
        return {
            mediaUrl: async (name) => `${urls(tdoc, await loadDoc(tdoc)).media}/${encodeURIComponent(name)}`,
            visualConfig: async () => (await collection.findOne({ _id: contestKey }))?.visualConfig || '{}',
            saveVisualConfig: async (value) => { await collection.updateOne({ _id: contestKey }, { $set: { visualConfig: value, updatedAt: new Date() } }); },
            mediaNames: async () => {
                const stored = await media.find({ key: contestKey }, { projection: { name: 1 } }).toArray();
                return [...new Set([...await builtinMediaNames(), ...stored.map((item) => item.name)])].sort();
            },
            saveMedia: async (name, data, mime) => {
                await media.updateOne({ _id: `${contestKey}/${name}` },
                    { $set: { key: contestKey, name, mime, size: data.length, data, createdAt: new Date() } }, { upsert: true });
            },
        };
    }

    type TeamExtras = { seats: Record<string, string>; coaches: Record<string, string[]> };
    const noExtras = (): TeamExtras => ({ seats: Object.create(null), coaches: Object.create(null) });

    /** Seats and coaches (onsite-toolkit) for the single-team banner; private without the venue identity rule. */
    async function loadTeamExtras(tdoc: Tdoc, identity: boolean): Promise<TeamExtras> {
        if (!identity) return noExtras();
        const cursor = ContestModel.getMultiStatus(tdoc.domainId, { docId: tdoc.docId }) as unknown as {
            project?: (spec: object) => { toArray: () => Promise<TeamEntry[]> };
            toArray: () => Promise<TeamEntry[]>;
        };
        const entries = await (typeof cursor.project === 'function' ? cursor.project({ uid: 1, members: 1 }) : cursor).toArray();
        const [seatMap, coaches] = await Promise.all([
            loadSeats(ctx.db, [...entries.map((entry) => entry.uid), ...memberIds(tdoc, entries)]),
            loadCoaches(ctx.db, entries.map((entry) => entry.uid)),
        ]);
        const seats: Record<string, string> = Object.create(null);
        for (const entry of entries) {
            const seat = seatOf(seatMap, entry.uid, isTeamEntry(entry) ? entry.members : []);
            if (seat) seats[String(entry.uid)] = seat;
        }
        return { seats, coaches };
    }

    /**
     * Seats and coaches are set before a contest, not during it: one contest reads them at most every
     * 30 seconds instead of on every refresh, and keeps the last ones through a failed read.
     */
    function teamExtrasCache() {
        let cached: { at: number; identity: boolean; value: Promise<TeamExtras> } | null = null;
        let last = noExtras();
        return (tdoc: Tdoc, identity: boolean) => {
            if (cached && cached.identity === identity && Date.now() - cached.at < 30_000) return cached.value;
            const entry: { at: number; identity: boolean; value: Promise<TeamExtras> } = { at: Date.now(), identity, value: Promise.resolve(last) };
            entry.value = loadTeamExtras(tdoc, identity).then((value) => (last = value), () => {
                if (cached === entry) cached = null; // read again on the next refresh
                return last;
            });
            cached = entry;
            return entry.value;
        };
    }

    function hubFor(tdoc: Tdoc): Promise<LiveHub> {
        const name = key(tdoc);
        let hub = hubs.get(name);
        if (!hub) {
            const { domainId, docId } = tdoc;
            hub = loadDoc(tdoc).then(async (doc) => {
                const teamExtras = teamExtrasCache();
                const created = new LiveHub({
                    intervalMs: dependencies.intervalMs,
                    load: async () => {
                        const current = await ContestModel.get(domainId, docId);
                        if (!current) return null;
                        const settings = await dependencies.loadSettings(current);
                        // Live shows specific public verdicts while respecting the freeze and venue identity rule.
                        const [data, publicVideos, extras] = await Promise.all([dependencies.loadData(current, settings.showIdentity),
                            dependencies.publicVideos?.(current).catch(() => []) ?? [], teamExtras(current, settings.showIdentity)]);
                        const reactionVideos: Record<string, { type: string; url: string }[]> = Object.create(null);
                        for (const { rid, url } of publicVideos) (reactionVideos[rid] ??= []).push({ type: 'Video', url });
                        return {
                            contest: current, data, settings, reactionVideos, identity: settings.showIdentity, logoNames, now: Date.now(),
                            boards: resolverBoards(data, settings, settings.showIdentity),
                            hidden: !ContestModel.canShowScoreboard.call(nobody as never, current, false),
                            // 画面采集: a broken capture setup must not take the rest of the broadcast down.
                            medias: capture ? await capture.mediasFor(current, data).catch(() => ({})) : {},
                            ...extras,
                        };
                    },
                    announce: (kind, payload) => announce(name, kind, payload),
                    persist: async (patch) => {
                        const saved = await collection.findOneAndUpdate({ _id: name }, stateUpdate(patch), { returnDocument: 'after' });
                        if (!saved) throw new Error('直播配置已删除');
                        const revision = saved.stateRevision!;
                        announce(name, 'state', { patch, revision });
                        return revision;
                    },
                    template: async (template) => {
                        if (!template.endsWith('.svg')) return null;
                        const file = await readMedia(name, storeName(template));
                        return file ? file.data.toString('utf8') : null;
                    },
                }, stateFromEntries(doc.stateEntries || {}), doc.stateRevision || 0);
                await created.ready;
                return created;
            });
            hub.catch(() => hubs.delete(name));
            hubs.set(name, hub);
        }
        return hub;
    }
    // A contest nobody has watched for half an hour gives its memory back; its widget state is saved.
    const sweeper = setInterval(async () => {
        for (const [name, pending] of hubs) {
            const hub = await pending.catch(() => null);
            if (hub && hub.idleFor() > 30 * 60_000 && hubs.get(name) === pending) {
                hubs.delete(name);
                await hub.dispose();
            }
        }
    }, 5 * 60_000);
    sweeper.unref?.();
    ctx.effect(() => async () => {
        clearInterval(sweeper);
        const pending = [...hubs.values()];
        hubs.clear();
        await Promise.all(pending.map((hub) => hub.then((item) => item.dispose(), () => null)));
    });
    ctx.on('contest/del', async (domainId, tid) => {
        const id = `${domainId}/${tid}`;
        const pending = hubs.get(id);
        if (pending) { hubs.delete(id); void pending.then((hub) => hub.dispose(), () => null); }
        closeRevoked(id, '');
        await Promise.all([
            collection.deleteOne({ _id: id }),
            media.deleteMany({ key: id }),
            overlayClients.remove(id),
        ]).catch(() => null);
    });
    ctx.on('domain/delete', async (domainId) => {
        const prefix = `${domainId}/`;
        for (const [id, pending] of [...hubs.entries()]) {
            if (!id.startsWith(prefix)) continue;
            hubs.delete(id);
            void pending.then((hub) => hub.dispose(), () => null);
            closeRevoked(id, '');
        }
        const pattern = new RegExp(`^${domainId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`);
        await Promise.all([collection.deleteMany({ _id: pattern }), media.deleteMany({ key: pattern }), overlayClients.remove(pattern)]).catch(() => null);
    });

    async function checkAdmin(handler: Handler | ConnectionHandler, tid: ObjectId) {
        const tdoc = await ContestModel.get(handler.domain._id, tid);
        if (!tdoc) throw new NotFoundError('Contest not found');
        // A guest gets Hydro's sign-in prompt.
        handler.checkPriv(PRIV.PRIV_USER_PROFILE);
        if (!handler.user.own(tdoc)) handler.checkPerm(PERM.PERM_EDIT_CONTEST);
        if (tdoc.rule !== 'acm') throw new NotFoundError('直播仅支持 ACM 比赛');
        return tdoc;
    }

    async function checkToken(domainId: string, tid: ObjectId, token: string) {
        const tdoc = await ContestModel.get(domainId, tid);
        const doc = tdoc?.rule === 'acm' ? await collection.findOne({ _id: key(tdoc) }) : null;
        if (!tdoc || !doc || !sameSecret(token, doc.token)) throw new NotFoundError('直播链接无效或已作废');
        return { tdoc, doc };
    }

    const capture = dependencies.capture === false ? null : applyCapture(ctx, {
        codeBase, key, contestBase, checkAdmin, checkToken, sameSecret, stunPort: dependencies.captureStunPort ?? 3478,
        currentToken: async (contestKey) => (await collection.findOne({ _id: contestKey }))?.token ?? null,
    });

    async function resetToken(contestKey: string) {
        const token = newToken();
        const previous = await collection.findOneAndUpdate({ _id: contestKey }, { $set: { token, tokenAt: new Date(), updatedAt: new Date() } },
            { returnDocument: 'before', projection: { token: 1 } });
        if (!previous) throw new NotFoundError('直播配置不存在');
        // Overlays already open with the old link stop at once, in every Hydro process.
        closeRevoked(contestKey, token);
        capture?.revoke(contestKey, token);
        // Overlays on the old link leave the list; they reappear once opened with the new one.
        announce(contestKey, 'token');
        await overlayClients.revoke(contestKey, previous.token);
        return token;
    }

    dependencies.links?.add({
        id: 'live', label: '直播 overlay',
        async status(tdoc) {
            const doc = await collection.findOne({ _id: key(tdoc) });
            return { count: doc ? 1 : 0, issuedAt: doc?.tokenAt ?? null };
        },
        async revoke(tdoc) {
            if (!await collection.findOne({ _id: key(tdoc) }, { projection: { _id: 1 } })) return 0;
            await resetToken(key(tdoc));
            return 1;
        },
    });
    if (capture) dependencies.links?.add({ id: 'capture', label: '画面采集设备', status: capture.linkStatus, revoke: capture.revokeDevices });

    const respond = (handler: Handler, response: ApiResponse | null, what: string) => {
        if (!response) throw new NotFoundError(what);
        handler.response.status = response.status;
        handler.response.type = response.type;
        handler.response.body = response.body;
    };

    /** Hydro page: links for OBS and the director, and the token reset. */
    class LiveConfigHandler extends Handler {
        tdoc!: Tdoc;

        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            this.tdoc = await checkAdmin(this, tid);
        }

        async get() {
            const links = urls(this.tdoc, await loadDoc(this.tdoc));
            this.response.template = 'xcpcio_live.html';
            this.response.body = {
                tdoc: this.tdoc, codeBase,
                runtimeJson: toScriptJson({ base: links.root, contestUrl: contestBase(this.tdoc), title: this.tdoc.title, overlay: links.overlay, admin: links.adminBase }),
            };
        }

        async postResetToken() {
            const doc = await loadDoc(this.tdoc);
            const token = await resetToken(doc._id);
            this.response.body = { overlay: urls(this.tdoc, { ...doc, token }).overlay };
        }
    }

    /** The OBS overlays open right now (JSON), and the commands sent to one of them. */
    class LiveOverlaysHandler extends LiveConfigHandler {
        async get() {
            this.response.type = 'application/json';
            this.response.body = { overlays: await overlayClients.list(key(this.tdoc)) };
        }

        @param('action', Types.String)
        @param('id', Types.String)
        async post(_domainId: string, action: string, id: string) {
            try {
                this.response.body = await overlayClients.command(key(this.tdoc), id, action);
            } catch (error) {
                if (!(error instanceof OverlayError)) throw error;
                this.response.status = error.status;
                this.response.body = { error: error.message };
            }
        }
    }

    /** The director's console (ICPC Live admin), behind the Hydro login. */
    class LiveAdminPageHandler extends Handler {
        @param('tid', Types.ObjectId)
        async get(_domainId: string, tid: ObjectId) {
            const tdoc = await checkAdmin(this, tid);
            this.response.addHeader('Cache-Control', 'no-store');
            this.response.type = 'text/html';
            this.response.body = shell('admin', adminRuntime(urls(tdoc, await loadDoc(tdoc))), `${tdoc.title} · 直播导播台`);
        }
    }

    /** The overlay as the console previews it: behind the Hydro login, independent of the OBS token. */
    class LivePreviewPageHandler extends Handler {
        @param('tid', Types.ObjectId)
        async get(_domainId: string, tid: ObjectId) {
            const tdoc = await checkAdmin(this, tid);
            this.response.addHeader('Cache-Control', 'no-store');
            this.response.type = 'text/html';
            this.response.body = shell('overlay', previewRuntime(urls(tdoc, await loadDoc(tdoc))), `${tdoc.title} · 直播画面预览`);
        }
    }

    class LivePreviewApiHandler extends Handler {
        notUsage = true;

        @param('tid', Types.ObjectId)
        async get(_domainId: string, tid: ObjectId) {
            const tdoc = await checkAdmin(this, tid);
            this.response.addHeader('Cache-Control', 'no-store');
            const doc = await loadDoc(tdoc);
            const subpath = /\/live\/api\/overlay\/(.*)$/.exec(this.request.path)?.[1] || '';
            respond(this, await overlayApi(await hubFor(tdoc), subpath, doc.visualConfig), subpath);
        }
    }

    /** admin-home-page: version and useful links. */
    class LiveMainPageHandler extends Handler {
        @param('tid', Types.ObjectId)
        @param('item', Types.String)
        async get(_domainId: string, tid: ObjectId, item: string) {
            const tdoc = await checkAdmin(this, tid);
            const links = urls(tdoc, await loadDoc(tdoc));
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(item === 'git'
                ? { commit: '200c82f', branch: 'v3.5.1', description: `ICPC Live v3.5.1 · hydro-scoreboard-xcpcio-plus ${version}` }
                : [
                    { name: '导播控制 /admin/controls', url: `${links.adminBase}/controls` },
                    { name: 'OBS 画面 /overlay?noStatus', url: `${links.overlay}?noStatus` },
                    { name: '直播设置', url: links.root },
                    { name: 'https://github.com/icpc/live-v3', url: 'https://github.com/icpc/live-v3' },
                ]);
        }
    }

    /** ICPC Live /api/admin. */
    class LiveAdminApiHandler extends Handler {
        notUsage = true;
        tdoc!: Tdoc;

        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            this.tdoc = await checkAdmin(this, tid);
        }

        async all() {
            const hub = await hubFor(this.tdoc);
            hub.touch();
            if (!hub.info) await hub.refresh();
            const subpath = /\/live\/api\/admin\/(.*)$/.exec(this.request.path)?.[1] || '';
            if (subpath === 'replay' && this.request.method.toUpperCase() === 'GET') {
                const { rid, teamUid } = this.request.query;
                this.response.body = (typeof rid === 'string' || typeof teamUid === 'string')
                    ? await dependencies.staffReplay?.(this.tdoc, { rid: typeof rid === 'string' ? rid : undefined,
                        teamUid: typeof teamUid === 'string' ? teamUid : undefined }) ?? [] : [];
                return;
            }
            // 画面采集 for the console's 画面采集 page: devices, the teams they show, and what may go on air.
            if (subpath === 'capture' && this.request.method.toUpperCase() === 'GET') {
                this.response.type = 'application/json';
                this.response.body = JSON.stringify(capture ? await capture.directorStatus(this.tdoc) : { available: false, devices: [] });
                return;
            }
            const files = Object.values(this.request.files || {}).flat().map((file) => ({
                name: file.originalFilename || path.basename(file.filepath), size: file.size, read: () => fs.promises.readFile(file.filepath),
            }));
            respond(this, await adminApi(hub, store(key(this.tdoc), this.tdoc), {
                method: this.request.method, subpath, query: this.request.query, querystring: this.request.querystring,
                body: this.request.body, files, user: this.user.uname,
            }), subpath);
        }
    }

    /** Admin websockets: analytics, spotlight, social, contest info, backend log, admin actions. */
    class LiveAdminConnectionHandler extends ConnectionHandler {
        unsubscribe?: () => void;
        recheck?: NodeJS.Timeout;
        closed = false;

        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            const tdoc = await checkAdmin(this, tid);
            if (this.closed) return;
            const channel = this.channel();
            if (!channel) throw new NotFoundError('channel');
            const hub = await hubFor(tdoc);
            if (this.closed) return;
            this.unsubscribe = hub.subscribe(channel, (payload) => this.send(typeof payload === 'string' ? payload : JSON.stringify(payload)));
            // A director who loses the permission (or the contest) is disconnected within a minute.
            const { domainId, docId } = tdoc;
            const uid = this.user._id;
            this.recheck = setInterval(async () => {
                const [user, current] = await Promise.all([UserModel.getById(domainId, uid), ContestModel.get(domainId, docId)]).catch(() => [null, null]);
                if (!user || !current || !(user.own(current) || user.hasPerm(PERM.PERM_EDIT_CONTEST))) this.close(4003, '直播导播权限已撤销');
            }, 60_000);
            this.recheck.unref?.();
        }

        channel() {
            return adminChannel(/\/live\/ws\/admin\/(.+)$/.exec(this.request.path)?.[1] || '');
        }

        async cleanup() {
            this.closed = true;
            if (this.recheck) clearInterval(this.recheck);
            this.unsubscribe?.();
        }
    }

    /** The console's overlay preview: overlay channels behind the Hydro login. */
    class LivePreviewConnectionHandler extends LiveAdminConnectionHandler {
        channel() {
            return overlayChannel(/\/live\/ws\/overlay\/(.+)$/.exec(this.request.path)?.[1] || '');
        }
    }

    /** /api/overlay over HTTP for OBS: token in the path, no Hydro login. */
    class LiveOverlayApiHandler extends Handler {
        noCheckPermView = true;
        notUsage = true;

        @param('tid', Types.ObjectId)
        @param('token', Types.String)
        async get(_domainId: string, tid: ObjectId, token: string) {
            this.response.addHeader('Cache-Control', 'no-store');
            const { tdoc, doc } = await checkToken(this.domain._id, tid, token);
            const subpath = /\/api\/overlay\/(.*)$/.exec(this.request.path)?.[1] || '';
            respond(this, await overlayApi(await hubFor(tdoc), subpath, doc.visualConfig), subpath);
        }
    }

    /** /api/overlay websockets for OBS, and the overlay's control socket (hydroControl). */
    class LiveOverlayConnectionHandler extends ConnectionHandler {
        noCheckPermView = true;
        unsubscribe?: () => void;
        recheck?: NodeJS.Timeout;
        statusTimer?: NodeJS.Timeout;
        registration?: { token: string; close: () => void };
        endpoint?: OverlayEndpoint;
        contestKey = '';
        closed = false;

        @param('tid', Types.ObjectId)
        @param('token', Types.String)
        async prepare(_domainId: string, tid: ObjectId, token: string) {
            const { tdoc } = await checkToken(this.domain._id, tid, token);
            if (this.closed) return;
            const channel = overlayChannel(/\/ws\/overlay\/(.+)$/.exec(this.request.path)?.[1] || '', true);
            if (!channel) throw new NotFoundError('channel');
            const hub = channel === overlayControlChannel ? null : await hubFor(tdoc);
            if (this.closed) return;
            this.contestKey = key(tdoc);
            this.registration = { token, close: () => this.close(4004, '直播链接已作废') };
            if (!overlays.has(this.contestKey)) overlays.set(this.contestKey, new Set());
            overlays.get(this.contestKey)!.add(this.registration);
            if (hub) this.unsubscribe = hub.subscribe(channel, (payload) => this.send(typeof payload === 'string' ? payload : JSON.stringify(payload)));
            else {
                this.endpoint = {
                    contestKey: this.contestKey, connection: `${instance}/${randomUUID()}`, tokenHash: overlayTokenHash(token),
                    ip: String(this.request.ip || ''), send: (message) => this.send(message),
                };
                overlayClients.attach(this.endpoint);
                // An incoming socket event also works while the browser throttles background timers.
                this.statusTimer = setInterval(() => this.send({ type: 'requestStatus' }), OVERLAY_STATUS_MS);
                this.statusTimer.unref?.();
            }
            // Also for deployments whose processes do not share Hydro's broadcast bus.
            this.recheck = setInterval(async () => {
                const doc = await collection.findOne({ _id: this.contestKey }).catch(() => null);
                if (!doc || !sameSecret(token, doc.token)) this.registration?.close();
            }, 60_000);
            this.recheck.unref?.();
        }

        async message(input: unknown) {
            const endpoint = this.endpoint;
            const message = input as { type?: unknown } | null;
            if (!endpoint || !message || typeof message !== 'object') return;
            try {
                if (message.type === 'hello') await overlayClients.hello(endpoint, message);
                else if (message.type === 'status') await overlayClients.status(endpoint, message);
                else if (message.type === 'ack') await overlayClients.acknowledge(endpoint, message);
            } catch (error) {
                if (error instanceof OverlayError) this.close(error.status === 404 ? 4004 : 4000, error.message);
                else throw error;
            }
        }

        async cleanup() {
            this.closed = true;
            if (this.recheck) clearInterval(this.recheck);
            if (this.statusTimer) clearInterval(this.statusTimer);
            if (this.endpoint) {
                const endpoint = this.endpoint;
                this.endpoint = undefined;
                await overlayClients.detach(endpoint).catch(() => null);
            }
            const registered = overlays.get(this.contestKey);
            if (this.registration && registered) {
                registered.delete(this.registration);
                if (!registered.size) overlays.delete(this.contestKey);
            }
            this.unsubscribe?.();
        }
    }

    class LiveOverlayPageHandler extends Handler {
        noCheckPermView = true;

        @param('tid', Types.ObjectId)
        @param('token', Types.String)
        async get(_domainId: string, tid: ObjectId, token: string) {
            const { tdoc, doc } = await checkToken(this.domain._id, tid, token);
            this.response.addHeader('Cache-Control', 'no-store');
            this.response.type = 'text/html';
            this.response.body = shell('overlay', { ...urls(tdoc, doc), version }, `${tdoc.title} · 直播画面`);
        }
    }

    class LiveMediaHandler extends Handler {
        noCheckPermView = true;
        notUsage = true;

        @param('tid', Types.ObjectId)
        @param('mediaKey', Types.String)
        @param('name', Types.String)
        async get(_domainId: string, tid: ObjectId, mediaKey: string, name: string) {
            const tdoc = await ContestModel.get(this.domain._id, tid);
            const doc = tdoc ? await collection.findOne({ _id: key(tdoc) }) : null;
            if (!tdoc || !doc || !sameSecret(mediaKey, doc.mediaKey)) throw new NotFoundError('media');
            const file = await readMedia(doc._id, storeName(name));
            if (!file) throw new NotFoundError(name);
            this.response.addHeader('Cache-Control', 'private, max-age=60');
            // Uploaded SVG must not run script in the Hydro origin when opened directly.
            this.response.addHeader('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox");
            this.response.addHeader('X-Content-Type-Options', 'nosniff');
            this.response.type = file.mime;
            this.response.body = file.data;
        }
    }

    ctx.Route('contest_xcpcio_live', '/contest/:tid/live', LiveConfigHandler);
    ctx.Route('contest_xcpcio_live_overlays', '/contest/:tid/live/overlays', LiveOverlaysHandler);
    ctx.Route('contest_xcpcio_live_admin', '/contest/:tid/live/admin', LiveAdminPageHandler);
    ctx.Route('contest_xcpcio_live_admin_page', '/contest/:tid/live/admin/*page', LiveAdminPageHandler);
    ctx.Route('contest_xcpcio_live_main_page', '/contest/:tid/live/main-page/:item', LiveMainPageHandler);
    ctx.Route('contest_xcpcio_live_admin_api', '/contest/:tid/live/api/admin/*path', LiveAdminApiHandler);
    ctx.Connection('contest_xcpcio_live_admin_ws', '/contest/:tid/live/ws/admin/*path', LiveAdminConnectionHandler);
    ctx.Route('contest_xcpcio_live_preview', '/contest/:tid/live/preview', LivePreviewPageHandler);
    ctx.Route('contest_xcpcio_live_preview_api', '/contest/:tid/live/api/overlay/*path', LivePreviewApiHandler);
    ctx.Connection('contest_xcpcio_live_preview_ws', '/contest/:tid/live/ws/overlay/*path', LivePreviewConnectionHandler);
    ctx.Route('contest_xcpcio_live_overlay', '/contest/:tid/live-overlay/:token', LiveOverlayPageHandler);
    ctx.Route('contest_xcpcio_live_overlay_api', '/contest/:tid/live-overlay/:token/api/overlay/*path', LiveOverlayApiHandler);
    ctx.Connection('contest_xcpcio_live_overlay_ws', '/contest/:tid/live-overlay/:token/ws/overlay/*path', LiveOverlayConnectionHandler);
    ctx.Route('contest_xcpcio_live_media', '/contest/:tid/live-media/:mediaKey/:name', LiveMediaHandler);
    ctx.i18n.load('zh', { contest_xcpcio_live: '直播导播与 OBS' });
    // The sidebar shows 直播 next to 滚榜 for the same managers, only while this module is enabled.
    ctx.on('handler/after', (handler) => {
        if (handler.UiContext?.xcpcioResolverUrl) {
            handler.UiContext.xcpcioLiveEnabled = true;
            // 画面采集 next to 直播 and 大屏 in the contest's sidebar, for the same managers.
            if (capture) handler.UiContext.xcpcioCaptureEnabled = true;
        }
    });
    return {
        /** 画面采集 settings, for 赛事中控 (null when capture is off in the plugin's configuration). */
        capture: capture?.settings ?? null,
        async announceOnTicker(tdoc: Tdoc, text: string) {
            const hub = await hubFor(tdoc);
            return hub.tickerMessage.createTemporaryFromInput({ type: 'text', part: 'long', periodMs: 30_000, text }, 5 * 60_000);
        },
    };
}
