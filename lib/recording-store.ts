import { createHash, randomUUID } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, stat, statfs } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import type { Context, Handler } from 'hydrooj';
import { missingIntervals, readRange, RecordingError, type StreamName } from './recording';

export interface Segment {
    _id: string; contestKey: string; teamUid: number; device: string; kind: 'archive' | 'clip' | 'test'; stream: StreamName;
    startAt: number; endAt: number; bytes: number; mime: string; path: string; createdAt: number; testId?: string;
    sourceKind?: string; quality?: unknown;
}
export interface Clip {
    _id: string; contestKey: string; teamUid: number; rid: string; pid: number; status: number; firstSolve: boolean; priority: number;
    state: 'requested' | 'uploading' | 'ready' | 'partial' | 'missing'; windowStart: number; windowEnd: number;
    submittedAt: number; judgedAt: number; device: string | null; requestedAt: number; readyAt?: number; refreshToken?: string;
    streams: Partial<Record<StreamName, { segments: string[]; missing: { from: number; to: number }[] }>>; reason?: string;
}
export async function serveRecordingMedia(ctx: Context, handler: Handler, item: Pick<Segment, 'path' | 'bytes' | 'mime'>, downloadName?: string) {
    const service = ctx.storage;
    const info = await service.status();
    if (!('dir' in info) || typeof info.dir !== 'string') {
        handler.response.redirect = await service.signDownloadLink(item.path, downloadName || '', false, 'user');
        return;
    }
    const root = resolve(info.dir);
    const path = resolve(root, item.path);
    if (!path.startsWith(root + sep)) throw new RecordingError('文件路径无效', 404);
    const file = await stat(path).catch(() => null);
    if (!file?.isFile()) throw new RecordingError('录像文件不存在', 404);
    handler.response.addHeader('Accept-Ranges', 'bytes');
    handler.response.addHeader('X-Content-Type-Options', 'nosniff');
    let range;
    try { range = readRange(handler.request.headers.range, file.size); }
    catch {
        handler.response.status = 416;
        handler.response.addHeader('Content-Range', `bytes */${file.size}`);
        handler.response.body = '';
        return;
    }
    handler.response.type = item.mime;
    if (downloadName) handler.response.disposition = `attachment; filename*=UTF-8''${encodeURIComponent(downloadName)}`;
    if (range) {
        handler.response.status = 206;
        handler.response.addHeader('Content-Range', `bytes ${range.start}-${range.end}/${file.size}`);
    }
    handler.response.addHeader('Content-Length', String(range ? range.end - range.start + 1 : file.size));
    handler.response.body = createReadStream(path, range || {});
}

export async function inspectSegment(path: string, claimed: string) {
    const file = await open(path, 'r');
    try {
        const { size } = await file.stat();
        if (!size || size > 20 * 1024 * 1024) throw new RecordingError('录像段必须小于等于 20 MB', 413);
        const header = Buffer.alloc(12);
        await file.read(header, 0, header.length, 0);
        const mime = claimed.split(';')[0].toLowerCase().trim();
        const mp4 = mime === 'video/mp4' && header.toString('ascii', 4, 8) === 'ftyp';
        const webm = mime === 'video/webm' && header.readUInt32BE(0) === 0x1a45dfa3;
        if (!mp4 && !webm) throw new RecordingError('录像必须是独立的 MP4 或 WebM 文件', 415);
        return { bytes: size, mime, extension: mp4 ? 'mp4' : 'webm' };
    } finally { await file.close(); }
}
export const segmentId = (s: Pick<Segment, 'contestKey' | 'device' | 'teamUid' | 'kind' | 'stream' | 'startAt' | 'testId' | 'sourceKind'>) =>
    createHash('sha256').update(JSON.stringify([s.contestKey, s.teamUid, s.device, s.kind, s.stream, s.startAt, s.testId || '', s.sourceKind || ''])).digest('hex');

export class RecordingStore {
    readonly segments;
    readonly clips;
    readonly gaps;
    readonly tests;
    readonly counters;
    readonly videos;
    constructor(private ctx: Context) {
        const coll = (name: string): any => ctx.db.collection(name as never);
        this.segments = coll('xcpcio.recording.segments');
        this.clips = coll('xcpcio.recording.clips');
        this.gaps = coll('xcpcio.recording.gaps');
        this.tests = coll('xcpcio.recording.tests');
        this.counters = coll('xcpcio.recording.test-seconds');
        this.videos = coll('xcpcio.reactions.videos');
    }
    async ensureIndexes() {
        await Promise.all([
            this.segments.createIndex({ contestKey: 1, teamUid: 1, kind: 1, startAt: 1 }), this.segments.createIndex({ contestKey: 1, kind: 1, createdAt: -1 }),
            this.segments.createIndex({ testId: 1 }), this.segments.createIndex({ path: 1 }),
            this.clips.createIndex({ refreshToken: 1 }, { sparse: true }), this.clips.createIndex({ contestKey: 1, state: 1, priority: 1 }), this.clips.createIndex({ contestKey: 1, teamUid: 1, windowEnd: 1 }),
            this.gaps.createIndex({ contestKey: 1, teamUid: 1, from: 1 }), this.tests.createIndex({ contestKey: 1, startedAt: -1 }),
            this.tests.createIndex({ contestKey: 1, targets: 1 }, { unique: true, partialFilterExpression: { endedAt: null, targets: { $type: 'array' } } }),
            this.counters.createIndex({ testId: 1, at: 1 }), this.tests.createIndex({ endedAt: 1, deadline: 1 }),
        ]);
    }
    async freeBytes(): Promise<number | null> {
        const info = await this.ctx.storage.status();
        if (!('dir' in info) || typeof info.dir !== 'string') return null;
        const space = await statfs(info.dir);
        return space.bsize * space.bavail;
    }
    async save(segment: Omit<Segment, '_id' | 'path' | 'createdAt'>, file: string, ext: string) {
        const _id = segmentId(segment);
        const previous = await this.segments.findOne({ _id });
        if (previous?.deleting) throw new RecordingError('录像正在清理，请稍后重试', 409);
        if (previous) return { doc: previous as Segment, created: false };
        const base = `xcpcio/recordings/${segment.contestKey}/`;
        const directory = segment.kind === 'test' ? `tests/${segment.testId}/${segment.device}` : `${segment.teamUid}/${segment.kind}/${segment.stream}`;
        const path = `${base}${directory}/${segment.startAt}-${randomUUID()}.${ext}`;
        const doc: Segment = { _id, ...segment, path, createdAt: Date.now() };
        await this.ctx.storage.put(path, file, { 'Content-Type': doc.mime });
        try { await this.segments.insertOne(doc); }
        catch (e) {
            if ((e as { code?: number }).code !== 11000) throw e; // An ambiguous DB outcome is reconciled by the orphan audit.
            await this.ctx.storage.del(path);
            const winner = await this.segments.findOne({ _id });
            if (!winner || winner.deleting) throw new RecordingError('录像正在清理，请稍后重试', 409);
            return { doc: winner as Segment, created: false };
        }
        return { doc, created: true };
    }
    async finishClip(clip: Clip, reason: string) {
        const docs: Segment[] = await this.segments.find({ contestKey: clip.contestKey, kind: 'clip', teamUid: clip.teamUid, deleting: { $ne: true },
            startAt: { $lt: clip.windowEnd }, endAt: { $gt: clip.windowStart } }).sort({ startAt: 1 }).toArray();
        const streams: Clip['streams'] = {};
        let complete = true, any = false;
        for (const key of Object.keys(clip.streams) as StreamName[]) {
            const found = docs.filter((s) => s.stream === key);
            const missing = missingIntervals(clip.windowStart, clip.windowEnd, found);
            streams[key] = { segments: found.map((s) => s._id), missing };
            if (!found.length || missing.length) complete = false;
            if (found.length) any = true;
        }
        const state = complete && any ? 'ready' : any ? 'partial' : 'missing';
        await this.clips.updateOne({ _id: clip._id, refreshToken: clip.refreshToken || { $exists: false } },
            { $set: { state, streams, readyAt: Date.now(), reason: complete ? null : reason }, $unset: { refreshToken: '' } });
    }
    async removeSegments(filter: Record<string, unknown>, refresh = true) {
        let batch: Segment[] = [];
        const remove = async (rows: Segment[]) => {
            const paths = rows.map((row) => row.path);
            const result = await this.ctx.storage.del(paths);
            // S3 can return HTTP 200 with individual object failures. Keep metadata so the selection can be retried.
            if (result && 'Errors' in result && result.Errors?.length) throw new RecordingError('部分录像文件删除失败，请重试', 503);
            const clipSegments = refresh ? rows.filter((row) => row.kind === 'clip') : [];
            const token = randomUUID();
            if (clipSegments.length) {
                await this.segments.updateMany({ path: { $in: paths } }, { $set: { deleting: true } });
                const ids = clipSegments.map((s) => s._id);
                await this.clips.updateMany({ contestKey: { $in: [...new Set(clipSegments.map((s) => s.contestKey))] },
                    $or: [{ 'streams.screen.segments': { $in: ids } }, { 'streams.webcam.segments': { $in: ids } }] }, { $set: { refreshToken: token } });
            }
            // A competing upload may recreate a previously deleted segment ID with a new object path.
            await this.segments.deleteMany({ path: { $in: paths } });
            if (clipSegments.length) for await (const clip of this.clips.find({ refreshToken: token })) await this.finishClip(clip, 'deleted');
        };
        for await (const row of this.segments.find(filter) as AsyncIterable<Segment>) {
            batch.push(row);
            if (batch.length === 100) { await remove(batch); batch = []; }
        }
        if (batch.length) await remove(batch);
    }
    async deleteContest(contestKey: string | RegExp) {
        await this.removeSegments({ contestKey }, false);
        for (const coll of [this.clips, this.gaps, this.tests, this.counters]) await coll.deleteMany({ contestKey });
    }
    /** Reports unreferenced objects, skipping fresh uploads that may still be waiting for Mongo. */
    async auditOrphans() {
        const storage = this.ctx.storage;
        const cutoff = Date.now() - 86400000;
        const assets = this.ctx.db.collection('xcpcio.reactions.assets');
        const prefixes = ['xcpcio/recordings/', 'xcpcio/reactions/'];
        const visit = async (path: string, time: number) => {
            if (time >= cutoff) return;
            const collections = path.startsWith(prefixes[0]) ? [this.segments] : [this.videos, assets];
            for (const collection of collections) if (await collection.findOne({ path }, { projection: { _id: 1 } })) return;
            console.warn('[xcpcio recording] 未登记的媒体文件', path);
        };
        const info = await storage.status();
        if ('dir' in info && typeof info.dir === 'string') {
            const root = info.dir;
            async function walk(prefix: string) {
                for (const entry of await readdir(resolve(root, prefix), { withFileTypes: true }).catch((e) => { if (e.code === 'ENOENT') return []; throw e; })) {
                    const key = prefix + entry.name;
                    if (entry.isDirectory()) await walk(key + '/');
                    else if (entry.isFile()) await visit(key, (await stat(resolve(root, key))).mtimeMs);
                }
            }
            for (const prefix of prefixes) await walk(prefix);
        } else if ('bucket' in storage && storage.client) {
            // Resolve the SDK bundled with Hydro's S3 provider, including under pnpm's isolated layout.
            const { createRequire } = await import('node:module');
            const { ListObjectsV2Command } = createRequire(require.resolve('hydrooj/package.json'))('@aws-sdk/client-s3');
            for (const prefix of prefixes) {
                let token: string | undefined;
                do {
                    const page: any = await storage.client.send(new ListObjectsV2Command({ Bucket: storage.bucket, Prefix: prefix, ContinuationToken: token }));
                    for (const item of page.Contents || []) if (item.Key && item.LastModified) await visit(item.Key, item.LastModified.getTime());
                    token = page.NextContinuationToken;
                } while (token);
            }
        }
    }
}
