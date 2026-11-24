import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ContestModel, type Context, Handler, NotFoundError, ObjectId, param, PERM, SystemModel, type Tdoc, Types } from 'hydrooj';
import type { ContestLinks } from './links';
import { resolverCodeBase } from './resolver-data';
import { toScriptJson } from './settings';
import { layoutWarnings, normalizeLayout, publicSettings, ReactionError, type ReactionLayout } from './reactions';
import { contestKey, createReactionStore, reactionBase, runDetails, videoId, videoKey, type ReactionDependencies } from './reactions-store';
import { serveRecordingMedia } from './recording-store';
import { proxyReactionMedia } from './reaction-media';
import { issueWorkerCode, workerApiPath, workerAuthorized, workerName, workerOrigin } from './reactions-connection';

const maxVideo = 200 * 1024 ** 2;
const safeEqual = (a: string, b: string) =>
    Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const fileId = (s: unknown) => typeof s === 'string' && /^[a-f0-9]{24}$/.test(s);
const shortId = (s: unknown) => typeof s === 'string' && /^[\w-]{1,48}$/.test(s);
const tokenExpired = () => new NotFoundError('链接不存在或已经失效');
const codeBase = () => resolverCodeBase(JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version);
async function readHeader(file: string, size: number) {
    const fd = await fs.promises.open(file, 'r');
    try {
        const b = Buffer.alloc(size);
        const read = await fd.read(b, 0, size, 0);
        return b.subarray(0, read.bytesRead);
    } finally {
        await fd.close();
    }
}
export function applyReactions(ctx: Context, deps: ReactionDependencies & { links?: ContestLinks<Tdoc> }) {
    const store = createReactionStore(ctx, deps);
    ctx.on('app/started', async () => {
        await Promise.all([
            store.videos.createIndex({ contestKey: 1, state: 1, priority: 1, createdAt: 1 }),
            store.videos.createIndex({ contestKey: 1, teamUid: 1 }),
            store.videos.createIndex({ contestKey: 1, hidden: 1, readyAt: -1 }),
            store.layouts.createIndex({ contestKey: 1, 'layout.id': 1, 'layout.revision': -1 }),
            store.workers.createIndex({ contestKey: 1, lastSeen: -1 }),
            store.assets.createIndex({ contestKey: 1 }),
            store.assets.createIndex({ path: 1 }),
            store.connections.createIndex({ contestKey: 1, issuedAt: -1 }),
            store.videos.createIndex({ path: 1 }, { sparse: true }),
            ctx.db.collection('xcpcio.recording.clips' as never).createIndex({ contestKey: 1, state: 1, readyAt: 1 }),
        ]);
    });
    const on = ctx.on.bind(ctx) as unknown as (event: string, listener: (key: string) => void) => void;
    on('xcpcio/recording-clip', (key) => store.invalidate(key));
    ctx.on('contest/del', (d, id) => store.remove(`${d}/${id}`));
    ctx.on('domain/delete', async (domain) => {
        const pattern = new RegExp('^' + domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/');
        const keys = new Set([
            ...(await store.videos.distinct('contestKey', { contestKey: pattern })),
            ...(await store.layouts.distinct('contestKey', { contestKey: pattern })),
            ...(await store.assets.distinct('contestKey', { contestKey: pattern })),
            ...(await store.connections.distinct('contestKey', { contestKey: pattern })),
            ...(await store.configs.distinct('_id', { _id: pattern })),
        ]);
        for (const key of keys) await store.remove(key);
    });
    ctx.on('record/judge', async (rdoc) => {
        if (!rdoc?.contest || !rdoc.rejudged) return;
        const key = `${rdoc.domainId}/${rdoc.contest}`;
        // First-to-solve can move to a different submission of the same problem. Reconcile all ready clips.
        const tdoc = await ContestModel.get(rdoc.domainId, rdoc.contest);
        if (tdoc?.rule === 'acm' && (await store.videos.findOne({ contestKey: key, pid: rdoc.pid }, { projection: { _id: 1 } })))
            await store.sync(tdoc, true);
    });
    deps.links?.add({
        id: 'reaction-worker',
        label: '反应视频媒体机',
        async status(t) {
            const key = contestKey(t);
            const [d, count, last] = await Promise.all([
                store.cfg(key),
                store.connections.countDocuments({ contestKey: key }),
                store.connections.findOne({ contestKey: key }, { sort: { issuedAt: -1 }, projection: { issuedAt: 1 } }),
            ]);
            const issued = Math.max(d.token && d.tokenAt ? +d.tokenAt : 0, last ? +last.issuedAt : 0);
            return { count: count + (d.token ? 1 : 0), issuedAt: issued ? new Date(issued) : null };
        },
        async revoke(t) {
            const key = contestKey(t);
            const [old, current] = await Promise.all([
                store.configs.updateOne({ _id: key, token: { $exists: true } }, { $unset: { token: '', tokenAt: '' } }),
                store.connections.deleteMany({ contestKey: key }),
            ]);
            return old.modifiedCount + current.deletedCount;
        },
    });
    deps.links?.add({
        id: 'reaction-public',
        label: '公开反应视频',
        async status(t) {
            const d = await store.cfg(contestKey(t));
            return { count: store.policy(d).enabled ? 1 : 0, issuedAt: null };
        },
        async revoke(t) {
            return (await store.configs.updateOne({ _id: contestKey(t), 'public.enabled': true }, { $set: { 'public.enabled': false } }))
                .modifiedCount;
        },
    });
    class ContestBase extends Handler {
        tdoc!: Tdoc;
        get key() {
            return contestKey(this.tdoc);
        }
        get base() {
            return reactionBase(this.tdoc);
        }
        @param('tid', Types.ObjectId)
        async prepare(_domain: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'private, no-store');
            this.response.addHeader('Referrer-Policy', 'no-referrer');
            const doc = await ContestModel.get(this.domain._id, tid);
            if (!doc || doc.rule !== 'acm') throw tokenExpired();
            this.tdoc = doc;
        }
        async onerror(error: Parameters<Handler['onerror']>[0]) {
            if (error instanceof ReactionError) {
                this.response.status = error.status;
                this.response.body = { error: error.message };
                return;
            }
            return super.onerror(error);
        }
        page(template: string, extra: Record<string, unknown> = {}) {
            this.response.template = template;
            this.response.body = {
                tdoc: { title: this.tdoc.title },
                title: this.tdoc.title,
                codeBase: codeBase(),
                runtimeJson: toScriptJson({ base: this.base, title: this.tdoc.title, ...extra }),
            };
        }
        async video(id: string) {
            const [rid, layout, rest] = id.split('~');
            if (rest || !fileId(rid) || !shortId(layout)) throw tokenExpired();
            const v = await store.videos.findOne({ _id: videoKey(this.key, rid, layout) });
            if (!v) throw tokenExpired();
            return v;
        }
    }
    class Admin extends ContestBase {
        @param('tid', Types.ObjectId)
        async prepare(d: string, tid: ObjectId) {
            await super.prepare(d, tid);
            if (!this.user._id) throw new ReactionError('请先登录比赛管理账号', 403);
            if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
        }
        input() {
            const b = this.request.body || {};
            try {
                return typeof b.payload === 'string' ? JSON.parse(b.payload) : b;
            } catch {
                throw new ReactionError('请求格式无效');
            }
        }
    }
    class Manage extends Admin {
        async get() {
            this.page('xcpcio_reactions.html', { tab: this.request.path.endsWith('/layouts') ? 'layouts' : 'videos' });
        }
        async post() {
            const b = this.input(),
                action = b.action;
            if (action === 'public') {
                const policy = publicSettings(b.settings, store.policy(await store.cfg(this.key)));
                if (!(await store.versions(this.key)).some((v) => v.layout.id === policy.layoutId)) throw new ReactionError('版式不存在');
                if (policy.enabled && policy.timing === 'live' && (await deps.loadSettings(this.tdoc)).ccpcBoard.enabled)
                    throw new ReactionError('CCPC 隐藏题号模式不能开启赛中公开');
                await store.configs.updateOne({ _id: this.key }, { $set: { public: policy } }, { upsert: true });
            } else if (action === 'createConnection' || action === 'rotateConnection') {
                const create = action === 'createConnection';
                const id = create ? new ObjectId().toHexString() : b.id;
                if (!fileId(id) || (!create && !Number.isSafeInteger(b.revision))) throw new ReactionError('媒体机编号或版本无效');
                const now = new Date(),
                    origin = workerOrigin(b.origin, SystemModel.get('server.url'), this.request.host, this.context.protocol);
                const { code, tokenHash } = issueWorkerCode(origin, this.base, id);
                const stamp = { tokenHash, issuedAt: now, issuedBy: this.user._id };
                if (create) {
                    await store.connections.insertOne({ _id: id, contestKey: this.key, name: workerName(b.name), revision: 1, ...stamp });
                } else {
                    const result = await store.connections.updateOne(
                        { _id: id, contestKey: this.key, revision: b.revision },
                        { $set: stamp, $inc: { revision: 1 } },
                    );
                    if (!result.matchedCount) throw new ReactionError('媒体机连接已经变更，请刷新后重试', 409);
                }
                this.response.body = { id, code, revision: create ? 1 : b.revision + 1 };
                return;
            } else if (action === 'revokeConnection') {
                if (!fileId(b.id) || !Number.isSafeInteger(b.revision)) throw new ReactionError('媒体机连接无效');
                const result = await store.connections.deleteOne({ _id: b.id, contestKey: this.key, revision: b.revision });
                if (!result.deletedCount) throw new ReactionError('媒体机连接已经变更，请刷新后重试', 409);
            } else if (action === 'revokeLegacy') {
                await store.configs.updateOne({ _id: this.key }, { $unset: { token: '', tokenAt: '' } });
            } else if (action === 'layout') {
                const history = await store.versions(this.key),
                    id = b.layout?.id || new ObjectId().toHexString();
                if (!shortId(id)) throw new ReactionError('版式编号无效');
                const old = history.filter((v) => v.layout.id === id).at(-1);
                if ((old?.layout.revision || 0) !== (b.layout?.revision || 0)) throw new ReactionError('版式已经更新，请刷新后再保存', 409);
                const layout = normalizeLayout(b.layout, id, (old?.layout.revision || 0) + 1);
                const warnings = layoutWarnings(layout, b.encoder === 'nvidia_full');
                if (warnings.length && b.confirmWarnings !== true) {
                    this.response.body = { warnings };
                    return;
                }
                const ids = [
                    ...new Set([layout.background.image, ...layout.items.map((i) => i.props.image)].filter((a): a is string => !!a)),
                ];
                if (ids.length && (await store.assets.countDocuments({ _id: { $in: ids }, contestKey: this.key })) !== ids.length)
                    throw new ReactionError('版式素材不存在');
                try {
                    await store.layouts.insertOne({
                        _id: `${this.key}/${id}/${layout.revision}`,
                        contestKey: this.key,
                        layout,
                        effectiveAt: b.rerender === true ? 0 : Date.now(),
                    });
                } catch (e) {
                    if ((e as { code?: number }).code === 11000) throw new ReactionError('同时保存了另一版本，请刷新重试', 409);
                    throw e;
                }
                if (b.rerender === true) await store.sync(this.tdoc, true);
                this.response.body = { ok: true, id, revision: layout.revision };
                return;
            } else if (['hide', 'restore', 'retry', 'sample'].includes(action)) {
                let v;
                if (action === 'sample') {
                    const clip = (await store.clipList(this.key, { rid: String(b.rid), state: { $in: ['ready', 'partial'] } }))[0];
                    const layout = store.latest(await store.versions(this.key)).find((l) => l.id === b.layoutId);
                    if (!clip || !layout) throw new ReactionError('请选择已就绪的提交和已保存的版式');
                    await store.sync(this.tdoc, true);
                    // A proof render is private even if the live layout is currently public.
                    const ref = await store.videos.findOne({ contestKey: this.key, rid: clip.rid });
                    if (!ref) throw new ReactionError('当前提交未匹配可渲染任务');
                    const id = 'sample-' + new ObjectId().toHexString(),
                        sample = { ...layout, id, name: layout.name + ' · 样片' };
                    await store.videos.insertOne({
                        ...ref,
                        _id: videoKey(this.key, clip.rid, id),
                        layoutId: id,
                        layout: sample,
                        layoutRevision: layout.revision,
                        generation: 1,
                        state: 'waiting',
                        path: undefined,
                        bytes: 0,
                        attempts: 0,
                        hidden: { at: Date.now(), by: this.user._id },
                        createdAt: Date.now(),
                        updatedAt: Date.now(),
                    });
                } else {
                    v = await this.video(String(b.id));
                    if (action === 'retry') {
                        if (v.state === 'ineligible') throw new ReactionError('该提交不适用当前版式');
                        await store.videos.updateOne(
                            { _id: v._id, generation: v.generation },
                            { $set: { state: 'waiting', error: '', updatedAt: Date.now() }, $inc: { generation: 1 } },
                        );
                    } else {
                        await store.videos.updateOne(
                            { _id: v._id },
                            { $set: { hidden: action === 'hide' ? { at: Date.now(), by: this.user._id } : null } },
                        );
                    }
                }
            } else throw new ReactionError('未知操作');
            this.response.body = { ok: true };
        }
    }
    class AdminData extends Admin {
        async get() {
            await store.sync(this.tdoc);
            const query = this.request.query;
            const listing = query.page ? await store.adminPage(this.tdoc, query) : null;
            const [doc, layouts, videos, workers, clips, board, connections] = await Promise.all([
                store.cfg(this.key),
                store.versions(this.key),
                listing?.rows ?? store.videos.find({ contestKey: this.key }).sort({ priority: 1, createdAt: 1 }).toArray(),
                store.workers.find({ contestKey: this.key }).sort({ lastSeen: -1 }).toArray(),
                query.page && query.tab !== 'layouts' ? [] : store.clipList(this.key, { state: { $in: ['ready', 'partial'] } }),
                deps.loadSettings(this.tdoc),
                store.connections
                    .find({ contestKey: this.key }, { projection: { _id: 1, name: 1, revision: 1, issuedAt: 1 } })
                    .sort({ issuedAt: -1 })
                    .toArray(),
            ]);
            this.response.body = {
                config: store.policy(doc),
                ...(listing ? { paging: listing.paging, stats: listing.stats } : {}),
                connections: connections.map((c) => ({ id: c._id, name: c.name, revision: c.revision, issuedAt: c.issuedAt })),
                legacyEnabled: !!doc.token,
                layouts: store.latest(layouts),
                workers,
                ccpc: board.ccpcBoard.enabled,
                videos: videos
                    .filter((v) => v.state !== 'ineligible')
                    .map((v) => ({
                        id: videoId(v),
                        rid: v.rid,
                        layoutId: v.layoutId,
                        layoutName: v.layout.name,
                        firstSolve: v.firstSolve,
                        accepted: v.accepted,
                        state: v.state,
                        hidden: !!v.hidden,
                        priority: v.priority,
                        team: v.team,
                        school: v.school,
                        problem: v.problem,
                        verdict: v.verdict,
                        teamUid: v.teamUid,
                        error: v.error,
                        worker: v.worker,
                        updatedAt: v.updatedAt,
                        readyAt: v.readyAt,
                        bytes: v.bytes,
                        durationMs: v.durationMs,
                        submittedAt: v.submittedAt,
                        url: v.state === 'ready' ? `${this.base}/manage/video/${videoId(v)}` : null,
                    })),
                clips: clips.map((c) => ({
                    rid: c.rid,
                    teamUid: c.teamUid,
                    pid: c.pid,
                    streams: Object.fromEntries(
                        Object.entries(c.streams).map(([k, s]) => [
                            k,
                            s.segments.map((id) => `${this.base.slice(0, -'/reactions'.length)}/live/capture/recordings/media/${id}`),
                        ]),
                    ),
                })),
            };
        }
    }
    class AdminVideo extends Admin {
        async get() {
            const v = await this.video(String(this.request.params.id));
            if (v.state !== 'ready' || !v.path) throw tokenExpired();
            await serveRecordingMedia(
                ctx,
                this,
                { path: v.path, mime: 'video/mp4', bytes: v.bytes || 0 },
                this.request.query.download ? 'reaction-' + videoId(v) + '.mp4' : undefined,
            );
        }
    }
    class AdminAsset extends Admin {
        async post() {
            const file = Object.values(this.request.files || {}).flat()[0];
            if (!file || !file.size || file.size > 10 * 1024 ** 2) throw new ReactionError('请上传小于 10 MB 的 PNG 或 JPEG');
            const head = await readHeader(file.filepath, 12);
            const ext = head.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
                ? 'png'
                : head.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))
                  ? 'jpg'
                  : null;
            if (!ext) throw new ReactionError('图片格式无效');
            const id = new ObjectId().toHexString(),
                target = `xcpcio/reactions/${this.key}/layouts/${id}.${ext}`,
                mime = ext === 'jpg' ? 'image/jpeg' : 'image/png';
            await ctx.storage.put(target, file.filepath);
            // A lost Mongo acknowledgement can still represent a committed insert. Keep the blob
            // intact for the daily orphan scan in the ambiguous case.
            await store.assets.insertOne({ _id: id, contestKey: this.key, path: target, mime, bytes: file.size });
            this.response.body = { id };
        }
    }
    class AdminAssetRead extends Admin {
        async get() {
            const asset = await store.assets.findOne({ contestKey: this.key, _id: String(this.request.params.id) });
            if (!asset) throw tokenExpired();
            await serveRecordingMedia(ctx, this, asset);
        }
    }
    class Public extends ContestBase {
        noCheckPermView = true;
        async get() {
            if (!store.policy(await store.cfg(this.key)).enabled) throw tokenExpired();
            this.page('xcpcio_reactions_public.html');
        }
    }
    class PublicData extends ContestBase {
        noCheckPermView = true;
        async get() {
            if (this.request.query.page) {
                const data = await store.publicPage(this.tdoc, this.request.query);
                if (!data) throw tokenExpired();
                this.response.body = data;
                return;
            }
            const cfg = store.policy(await store.cfg(this.key));
            if (!cfg.enabled) throw tokenExpired();
            this.response.body = { videos: await store.publicVideos(this.tdoc), download: cfg.download };
        }
    }
    async function serveAudienceMedia(handler: Handler, v: { path?: string; bytes?: number }, id: string, download = false) {
        const filename = download ? 'reaction-' + id + '.mp4' : undefined;
        const path = v.path!;
        if ('dir' in (await ctx.storage.status()))
            await serveRecordingMedia(ctx, handler, { path, bytes: v.bytes || 0, mime: 'video/mp4' }, filename);
        else await proxyReactionMedia(handler, v.bytes || 0, () => ctx.storage.signDownloadLink(path), filename);
    }
    async function playScreenVideo(
        tdoc: Tdoc,
        layoutId: string,
        id: string,
        handler: Handler,
        allowed: (v: { teamUid: number; accepted: boolean; firstSolve: boolean }) => boolean,
    ) {
        const [rid, layout, rest] = String(id).split('~');
        if (rest || !fileId(rid) || !shortId(layout)) throw tokenExpired();
        const access = await store.publicAccess(tdoc, layoutId);
        if (!access.config.enabled || layout !== access.config.layoutId) throw tokenExpired();
        const key = contestKey(tdoc);
        const video = await store.videos.findOne({ _id: videoKey(key, rid, layout) });
        if (!video?.path || !allowed(video) || !access.allows(video)) throw tokenExpired();
        // Sampling outputs are never registered layouts. Only staff-authored display layouts may go on air.
        if (!(await store.versions(key)).some((v) => v.layout.id === layout && v.layout.revision === video.layoutRevision))
            throw tokenExpired();
        handler.response.addHeader('Cache-Control', 'private, no-store');
        await serveAudienceMedia(handler, video, id);
    }
    async function screenLayouts(tdoc: Tdoc) {
        return store.latest(await store.versions(contestKey(tdoc))).map((l) => ({ id: l.id, name: l.name }));
    }
    class PublicVideo extends ContestBase {
        noCheckPermView = true;
        async get() {
            const v = await this.video(String(this.request.params.id)),
                access = await store.publicAccess(this.tdoc);
            if (!access.allows(v) || !v.path) throw tokenExpired();
            if (this.request.query.download && !access.config.download) throw new ReactionError('本场关闭了视频下载', 403);
            await serveAudienceMedia(this, v, videoId(v), !!this.request.query.download);
        }
    }
    const sign = (token: string, scope: string, id: string, expires: number) =>
        createHmac('sha256', token).update([scope, id, expires].join('/')).digest('hex');
    class SignedFile extends ContestBase {
        noCheckPermView = true;
        async get() {
            const { id, scope } = this.request.params,
                expires = Number(this.request.query.expires),
                signature = String(this.request.query.sig || '');
            const doc = await store.cfg(this.key);
            if (
                !doc.token ||
                !['segments', 'assets'].includes(scope) ||
                !Number.isSafeInteger(expires) ||
                expires < Date.now() ||
                !safeEqual(signature, sign(doc.token, scope, id, expires))
            )
                throw tokenExpired();
            const file =
                scope === 'segments'
                    ? (await store.mediaSegments(this.key, [id]))[0]
                    : await store.assets.findOne({ _id: id, contestKey: this.key });
            if (!file) throw tokenExpired();
            await serveRecordingMedia(ctx, this, file);
        }
    }
    class Machine extends ContestBase {
        noCheckPermView = true;
        legacySecret = '';
        connectionId: string | null = null;
        connectionRevision = 0;
        get machineBase() {
            return this.connectionId ? workerApiPath(this.base, this.connectionId) : this.base + '-api/' + this.legacySecret;
        }
        @param('tid', Types.ObjectId)
        async prepare(domain: string, tid: ObjectId) {
            await super.prepare(domain, tid);
            const id = this.request.params.workerId;
            if (id !== undefined) {
                const doc = fileId(id) ? await store.connections.findOne({ _id: id, contestKey: this.key }) : null;
                if (!doc || !workerAuthorized(this.request.headers.authorization, doc.tokenHash))
                    throw new ReactionError('媒体机连接无效或已撤销', 401);
                this.connectionId = doc._id;
                this.connectionRevision = doc.revision;
                return;
            }
            const doc = await store.cfg(this.key);
            const token = String(this.request.params.token);
            if (!doc.token || !safeEqual(token, doc.token)) throw tokenExpired();
            this.legacySecret = doc.token;
        }
        async stillAuthorized() {
            if (this.connectionId) {
                const live = await store.connections.findOne(
                    { _id: this.connectionId, contestKey: this.key, revision: this.connectionRevision },
                    { projection: { _id: 1 } },
                );
                if (!live) throw new ReactionError('媒体机连接已更换或撤销', 401);
            } else if ((await store.cfg(this.key)).token !== this.legacySecret) {
                throw tokenExpired();
            }
        }
        signed(scope: string, id: string) {
            if (this.connectionId) return this.machineBase + '/files/' + scope + '/' + encodeURIComponent(id);
            const expires = Date.now() + 15 * 60_000;
            return (
                this.base +
                '/files/' +
                scope +
                '/' +
                encodeURIComponent(id) +
                '?expires=' +
                expires +
                '&sig=' +
                sign(this.legacySecret, scope, id, expires)
            );
        }
        async serveFile(file: { path: string; bytes: number; mime: string }) {
            if (this.connectionId && !('dir' in (await ctx.storage.status()))) {
                await proxyReactionMedia(this, file.bytes, () => ctx.storage.signDownloadLink(file.path), undefined, file.mime);
            } else {
                await serveRecordingMedia(ctx, this, file);
            }
        }
        wireLayout(layout: ReactionLayout) {
            return {
                ...layout,
                background: {
                    ...layout.background,
                    image: layout.background.image ? this.signed('assets', layout.background.image) : null,
                },
                items: layout.items.map((i) => ({
                    ...i,
                    props: { ...i.props, ...(i.props.image ? { image: this.signed('assets', i.props.image) } : {}) },
                })),
            };
        }
    }
    class MachineFile extends Machine {
        async get() {
            const { scope, id } = this.request.params;
            const file =
                scope === 'assets'
                    ? await store.assets.findOne({ _id: id, contestKey: this.key })
                    : scope === 'segments'
                      ? (await store.mediaSegments(this.key, [id]))[0]
                      : null;
            if (!file || ('kind' in file && file.kind !== 'clip')) throw tokenExpired();
            await this.serveFile(file);
        }
    }
    class SourceStream extends Machine {
        async get() {
            const { rid, stream } = this.request.params;
            if (!fileId(rid) || (stream !== 'screen' && stream !== 'webcam')) throw tokenExpired();
            const clip = (await store.clipList(this.key, { rid, state: { $in: ['ready', 'partial'] } }))[0];
            const captured = clip?.streams[stream as 'screen' | 'webcam'];
            if (!captured) throw tokenExpired();
            const segments = await store.mediaSegments(this.key, captured.segments);
            if (segments.length === 1) {
                await this.serveFile(segments[0]);
                return;
            }
            this.response.body = {
                stream,
                windowStartMs: clip.windowStart,
                windowEndMs: clip.windowEnd,
                missing: captured.missing,
                segments: segments.map((s) => ({ url: this.signed('segments', s._id), startMs: s.startAt, endMs: s.endAt })),
            };
        }
    }
    class Feed extends Machine {
        async get() {
            const name = this.request.params.feed,
                rid = this.request.params.rid;
            if (name === 'layouts.json' && !rid) {
                await store.sync(this.tdoc);
                const current = store.latest(await store.versions(this.key));
                const revisions = current.map((l) => l.id + ':' + l.revision);
                // Most tasks share the current layout. Drop those snapshots inside MongoDB so polling
                // ten thousand jobs does not bring ten thousand identical layouts into Node.
                const tasks = await store.videos
                    .aggregate([
                        {
                            $match: {
                                contestKey: this.key,
                                $or: [
                                    { state: { $in: ['waiting', 'stale', 'failed'] } },
                                    { state: 'rendering', leaseAt: { $lt: Date.now() - 60_000 } },
                                ],
                            },
                        },
                        { $sort: { priority: 1, createdAt: 1 } },
                        {
                            $project: {
                                _id: 0,
                                runId: '$rid',
                                layoutId: 1,
                                generation: 1,
                                revision: '$layoutRevision',
                                priority: 1,
                                layout: {
                                    $cond: [
                                        { $in: [{ $concat: ['$layoutId', ':', { $toString: '$layoutRevision' }] }, revisions] },
                                        '$$REMOVE',
                                        '$layout',
                                    ],
                                },
                            },
                        },
                    ])
                    .toArray();
                this.response.body = {
                    layouts: current.map((l) => this.wireLayout(l)),
                    tasks: tasks.map((t) => (t.layout ? { ...t, layout: this.wireLayout(t.layout) } : t)),
                };
                return;
            }
            if (!['runs.json', 'fullRuns', 'fullRuns.json', 'contestInfo.json'].includes(name) || (name === 'fullRuns') !== !!rid)
                throw tokenExpired();
            const context = await store.context(this.tdoc),
                { info } = context;
            if (name === 'contestInfo.json') {
                this.response.body = {
                    name: info.name,
                    status: info.status,
                    resultType: info.resultType,
                    contestLengthMs: info.contestLengthMs,
                    freezeTimeMs: info.freezeTimeMs,
                    problems: info.problems,
                    teams: info.teams.map((t) => ({
                        id: t.id,
                        fullName: t.name,
                        displayName: t.shortName,
                        isOutOfContest: t.isOutOfContest,
                    })),
                    customFields: info.customFields,
                };
                return;
            }
            const clips = await store.clipList(this.key, {
                state: { $in: ['requested', 'uploading', 'ready', 'partial'] },
                ...(rid ? { rid } : {}),
            });
            const details = runDetails(context, new Set(clips.map((c) => c.rid)));
            const allIds =
                name === 'runs.json' ? [] : [...new Set(clips.flatMap((c) => Object.values(c.streams).flatMap((s) => s.segments)))];
            const media = new Map((await store.mediaSegments(this.key, allIds)).map((m) => [m._id, m]));
            const rows = clips.flatMap((c) => {
                const detail = details.get(c.rid);
                if (!detail) return [];
                const { run, team, problem, rankAfter, rankBefore } = detail;
                const ready = c.state === 'partial' || c.state === 'ready',
                    result = run.result;
                if (name === 'runs.json')
                    return [
                        {
                            id: c.rid,
                            teamId: run.teamId,
                            problemId: run.problemId,
                            time: run.time,
                            rankAfter,
                            rankBefore,
                            verdict: ready && result.type === 'ICPC' ? result.verdict.shortName : 'IN_PROGRESS',
                            isAccepted: result.type === 'ICPC' && result.verdict.isAccepted,
                            isFirstToSolve: result.type === 'ICPC' && result.isFirstToSolveRun,
                        },
                    ] as Record<string, unknown>[];
                if (!ready) return [];
                return [
                    {
                        id: c.rid,
                        team,
                        problem,
                        result,
                        time: run.time,
                        judgedAtMs: c.judgedAt,
                        testedTime: Math.max(0, c.judgedAt - +this.tdoc.beginAt),
                        reactionVideos: Object.entries(c.streams).map(([stream, s]) => ({
                            type: 'Video',
                            url: `${this.machineBase}/clips/${c.rid}/${stream}`,
                            hydro: {
                                stream,
                                windowStartMs: c.windowStart,
                                windowEndMs: c.windowEnd,
                                missing: s.missing,
                                segments: s.segments
                                    .flatMap((id) => {
                                        const m = media.get(id);
                                        return m ? [{ url: this.signed('segments', id), startMs: m.startAt, endMs: m.endAt }] : [];
                                    })
                                    .sort((a, b) => a.startMs - b.startMs),
                            },
                        })),
                    },
                ];
            });
            if (rid && !rows[0]) throw tokenExpired();
            this.response.body = rid ? rows[0] : rows;
        }
    }
    class Worker extends Machine {
        async post() {
            const b = this.request.body || {},
                name = String(b.name || '')
                    .trim()
                    .slice(0, 80),
                partition = String(b.partition ?? '0').slice(0, 40);
            if (!name) throw new ReactionError('媒体机名称不能为空');
            const item = b.current,
                current =
                    item && fileId(item.runId) && shortId(item.layoutId) && Number.isInteger(item.generation)
                        ? {
                              runId: String(item.runId),
                              layoutId: String(item.layoutId),
                              generation: Number(item.generation),
                          }
                        : null;
            const now = Date.now();
            const owner = this.connectionId ? this.connectionId + '/' + this.connectionRevision : null;
            if (current) {
                const claimed = await store.videos.updateOne(
                    {
                        _id: videoKey(this.key, current.runId, current.layoutId),
                        generation: current.generation,
                        $or: [
                            { state: { $in: ['waiting', 'stale', 'failed'] } },
                            { state: 'rendering', worker: name, workerOwner: owner ?? { $exists: false } },
                            { state: 'rendering', leaseAt: { $lt: now - 60000 } },
                        ],
                    },
                    {
                        $set: { state: 'rendering', worker: name, ...(owner ? { workerOwner: owner } : {}), leaseAt: now, updatedAt: now },
                        ...(!owner ? { $unset: { workerOwner: '' as const } } : {}),
                    },
                );
                if (!claimed.matchedCount) throw new ReactionError('任务已由其他媒体机领取、完成或更新', 409);
            }
            await store.videos.updateMany(
                { contestKey: this.key, state: 'rendering', leaseAt: { $lt: now - 60000 } },
                { $set: { state: 'waiting' } },
            );
            await store.workers.updateOne(
                {
                    _id: `${this.key}/${this.connectionId ? this.connectionId + '/' : ''}${encodeURIComponent(name)}/${encodeURIComponent(partition)}`,
                },
                {
                    $set: {
                        contestKey: this.key,
                        connectionId: this.connectionId,
                        connectionRevision: this.connectionRevision,
                        name,
                        partition,
                        version: String(b.version || '').slice(0, 100),
                        lastSeen: now,
                        ip: this.request.ip,
                        current,
                        queue: Math.max(0, Math.floor(Number(b.queue) || 0)),
                    },
                },
                { upsert: true },
            );
            this.response.body = { ok: true };
        }
    }
    class Result extends Machine {
        async put() {
            await this.receive();
        }
        async post() {
            await this.receive();
        }
        async receive() {
            const { rid, layoutId } = this.request.params,
                generation = Number(this.request.query.generation ?? this.request.body?.generation);
            if (!fileId(rid) || !shortId(layoutId) || !Number.isSafeInteger(generation) || generation < 1)
                throw new ReactionError('任务编号或代次无效');
            const query = { _id: videoKey(this.key, rid, layoutId), generation };
            const job = await store.videos.findOne(query);
            if (!job || ['ineligible', 'removed'].includes(job.state)) throw new ReactionError('此任务已更新', 409);
            if (job.state === 'ready') {
                this.response.body = { ok: true };
                return;
            }
            if (this.request.path.endsWith('/error')) {
                await store.videos.updateOne(
                    { ...query, state: { $nin: ['ready', 'ineligible', 'removed'] } },
                    {
                        $set: {
                            state: 'failed',
                            updatedAt: Date.now(),
                            error: String(this.request.body?.error || '渲染失败').slice(0, 2000),
                        },
                        $inc: { attempts: 1 },
                    },
                );
                this.response.body = { ok: true };
                return;
            }
            const durationMs = Number(this.request.query.durationMs ?? this.request.body?.durationMs);
            if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 600_000) throw new ReactionError('媒体时长无效');
            const max = maxVideo,
                file = this.request.files?.file,
                upload = Array.isArray(file) ? file[0] : file;
            const temp = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'hydro-reaction-'));
            try {
                let src = upload?.filepath,
                    bytes = upload?.size || 0;
                if (!src) {
                    if (String(this.request.headers['content-type']).split(';')[0] !== 'video/mp4')
                        throw new ReactionError('请上传 MP4 成品');
                    if (Number(this.request.headers['content-length']) > max) throw new ReactionError('成品超过 200 MB', 413);
                    src = path.join(temp, 'result.mp4');
                    await pipeline(
                        this.context.req,
                        new Transform({
                            transform(chunk, _encoding, cb) {
                                bytes += chunk.length;
                                cb(bytes > max ? new ReactionError('成品超过 200 MB', 413) : null, chunk);
                            },
                        }),
                        fs.createWriteStream(src),
                    );
                }
                if (bytes > max || !bytes) throw new ReactionError('成品大小无效', 413);
                const head = await readHeader(src, 12);
                if (head.length < 12 || head.toString('ascii', 4, 8) !== 'ftyp') throw new ReactionError('成品缺少 MP4 容器头');
                const target = `xcpcio/reactions/${this.key}/videos/${rid}-${layoutId}-${generation}-${randomBytes(8).toString('hex')}.mp4`;
                await this.stillAuthorized();
                await ctx.storage.put(target, src);
                try {
                    await this.stillAuthorized();
                } catch (error) {
                    await ctx.storage.del(target);
                    throw error;
                }
                // Delete this upload only on a definite lost compare-and-set. A transport error
                // from Mongo can arrive after commit, so keep the blob for the orphan scan in that case.
                const updated = await store.videos.findOneAndUpdate(
                    { ...query, state: { $nin: ['ready', 'ineligible', 'removed'] } },
                    {
                        $set: {
                            state: 'ready',
                            path: target,
                            bytes,
                            durationMs,
                            codec: String(this.request.query.codec || '').slice(0, 120),
                            readyAt: Date.now(),
                            updatedAt: Date.now(),
                            error: '',
                        },
                        $inc: { attempts: 1 },
                    },
                    { returnDocument: 'before' },
                );
                if (!updated) {
                    await ctx.storage.del(target);
                    if (!(await store.videos.findOne({ ...query, state: 'ready' }))) throw new ReactionError('任务在上传期间已经更新', 409);
                } else if (updated.path) {
                    await ctx.storage.del(updated.path);
                }
            } finally {
                await fs.promises.rm(temp, { recursive: true, force: true });
            }
            this.response.body = { ok: true };
        }
    }
    const base = '/contest/:tid/reactions',
        machine = base + '-api/:token/reactions';
    ctx.Route('contest_xcpcio_reactions_manage', base + '/manage', Manage);
    ctx.Route('contest_xcpcio_reactions_layouts', base + '/manage/layouts', Manage);
    ctx.Route('contest_xcpcio_reactions_manage_data', base + '/manage/data', AdminData);
    ctx.Route('contest_xcpcio_reactions_asset_upload', base + '/manage/assets', AdminAsset);
    ctx.Route('contest_xcpcio_reactions_asset_read', base + '/manage/assets/:id', AdminAssetRead);
    ctx.Route('contest_xcpcio_reactions_staff_video', base + '/manage/video/:id', AdminVideo);
    ctx.Route('contest_xcpcio_reactions_public', base, Public);
    ctx.Route('contest_xcpcio_reactions_data', base + '/data', PublicData);
    ctx.Route('contest_xcpcio_reactions_video', base + '/video/:id', PublicVideo);
    ctx.Route('contest_xcpcio_reactions_file', base + '/files/:scope/:id', SignedFile);
    ctx.Route('contest_xcpcio_reactions_worker', machine + '/worker', Worker);
    ctx.Route('contest_xcpcio_reactions_result', machine + '/results/:rid/:layoutId', Result);
    ctx.Route('contest_xcpcio_reactions_error', machine + '/results/:rid/:layoutId/error', Result);
    ctx.Route('contest_xcpcio_reactions_source', base + '-api/:token/clips/:rid/:stream', SourceStream);
    ctx.Route('contest_xcpcio_reactions_feed', machine + '/:feed', Feed);
    ctx.Route('contest_xcpcio_reactions_run', machine + '/:feed/:rid', Feed);
    const workerBase = base + '-api/workers/:workerId';
    ctx.Route('contest_xcpcio_reactions_connected_worker', workerBase + '/reactions/worker', Worker);
    ctx.Route('contest_xcpcio_reactions_connected_result', workerBase + '/reactions/results/:rid/:layoutId', Result);
    ctx.Route('contest_xcpcio_reactions_connected_error', workerBase + '/reactions/results/:rid/:layoutId/error', Result);
    ctx.Route('contest_xcpcio_reactions_connected_file', workerBase + '/files/:scope/:id', MachineFile);
    ctx.Route('contest_xcpcio_reactions_connected_source', workerBase + '/clips/:rid/:stream', SourceStream);
    ctx.Route('contest_xcpcio_reactions_connected_feed', workerBase + '/reactions/:feed', Feed);
    ctx.Route('contest_xcpcio_reactions_connected_run', workerBase + '/reactions/:feed/:rid', Feed);
    ctx.i18n.load('zh', { contest_xcpcio_reactions_manage: '反应视频与渲染', contest_xcpcio_reactions_public: '反应视频' });
    return {
        screenVideos: store.publicVideos,
        playScreenVideo,
        screenLayouts,
        publicVideos: store.publicVideos,
        staffReplay: store.staffReplay,
        summary: store.summary,
        setPublic: store.setPublic,
    };
}
