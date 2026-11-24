import { createHash } from 'node:crypto';
import { Context, ContestModel, Handler, ObjectId, param, RecordModel, Tdoc, Types } from 'hydrooj';
import { captureSecretMatches, deviceRecording, isCaptureOnline, type CaptureDevice, type CaptureSettings } from './live/capture';
import type { CaptureHelpers } from './live/capture-routes';
import { clipPriority, clipWindow, estimateRecording, missingIntervals, inScope, normalizeRecording, presets, uploadedRecordingQuality, RecordingError, type Measured, type SourceName, type StreamName } from './recording';
import { inspectSegment, RecordingStore, serveRecordingMedia, type Clip, type Segment } from './recording-store';
import { probeRecordingStorage, recordingTests } from './recording-tests';

interface Hooks extends CaptureHelpers {
    devices: any;
    teamSeats(tdoc: Tdoc): Promise<Map<number, string>>;
    loadSettings(contestKey: string): Promise<CaptureSettings>;
    contestantContext(handler: Handler, tid: ObjectId): Promise<{ tdoc: Tdoc; teamUid: number }>;
    participantDevice(tdoc: Tdoc, teamUid: number): Promise<CaptureDevice>;
    send(device: string, message: Record<string, unknown>): void;
}
const id24 = /^[a-f\d]{24}$/i;
const epoch = (at: Date | number) => +new Date(at);
const dateObjectId = (at: Date) => ObjectId.createFromTime(Math.floor(+at / 1000));
const warn = (error: unknown) => console.warn('[xcpcio recording]', error);
const bounded = (v: unknown, lo: number, hi: number) => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi;
const stream = (s: unknown): s is StreamName => s === 'screen' || s === 'webcam';
const exclude = <T extends object, K extends keyof T>(o: T, k: K) => { const { [k]: _, ...fields } = o; return fields; };
export function applyRecording(ctx: Context, hooks: Hooks) {
    const store = new RecordingStore(ctx);
    const tests = recordingTests(ctx, store, hooks.send);
    const on = ctx.on.bind(ctx) as unknown as (event: string, callback: (...args: any[]) => unknown) => void;
    const pendingSeats = new Map<string, Promise<Map<number, string>>>();
    function currentSeats(tdoc: Tdoc) {
        const key = hooks.key(tdoc);
        const pending = pendingSeats.get(key);
        if (pending) return pending;
        const query = hooks.teamSeats(tdoc).finally(() => pendingSeats.delete(key));
        pendingSeats.set(key, query);
        return query;
    }
    async function teamFor(tdoc: Tdoc, doc: CaptureDevice) {
        if (doc.teamUid !== null) return doc.teamUid;
        if (!doc.seat) return null;
        const seat = doc.seat.trim().toLowerCase();
        const matched = [...await currentSeats(tdoc)].filter(([, s]) => s.trim().toLowerCase() === seat);
        if (matched.length !== 1) return null;
        // A manual binding supersedes the seat even when the manually bound computer is offline.
        if (await hooks.devices.findOne({ contestKey: hooks.key(tdoc), teamUid: matched[0][0] }, { projection: { _id: 1 } })) return null;
        return matched[0][0];
    }
    async function finish(clip: Clip, reason: string) {
        await store.finishClip(clip, reason);
        (ctx as any).broadcast('xcpcio/recording-clip', clip.contestKey, clip.rid);
    }
    function request(clip: Clip, device: string) {
        hooks.send(device, { type: 'clip-request', rid: clip.rid, windowStartMs: clip.windowStart, windowEndMs: clip.windowEnd, priority: clip.priority, streams: Object.keys(clip.streams) });
    }
    async function judged(r: any) {
        if (!r?.contest || r.rejudged || !r.domainId || !id24.test(String(r._id)) || !((r.status >= 1 && r.status <= 11) || (r.status >= 30 && r.status <= 33))) return;
        const judgedAt = Date.now();
        const contestKey = `${r.domainId}/${r.contest}`;
        const settings = await hooks.loadSettings(contestKey);
        if (!settings.enabled || !settings.recording.clips.enabled) return;
        const tdoc = await ContestModel.get(r.domainId, r.contest);
        const submittedAt = parseInt(String(r._id).slice(0, 8), 16) * 1000;
        if (tdoc?.rule !== 'acm' || !tdoc.pids.includes(r.pid) || submittedAt < +tdoc.beginAt || submittedAt >= +tdoc.endAt) return;
        const uid = (tdoc as any).allowTeam ? (await ContestModel.getMultiStatus(r.domainId, { docId: tdoc.docId, members: r.uid }).project({ uid: 1 }).limit(1).toArray())[0]?.uid ?? r.uid : r.uid;
        const first = r.status === 1 && !await RecordModel.coll.findOne({ domainId: r.domainId, contest: r.contest, pid: r.pid, status: 1, _id: { $gte: dateObjectId(tdoc.beginAt), $lt: r._id } }, { projection: { _id: 1 } });
        const priority = clipPriority(r.status, first);
        if (!inScope(settings.recording.clips.scope, priority)) return;
        let device = await hooks.devices.findOne({ contestKey, teamUid: uid });
        if (!device) {
            const seat = (await hooks.teamSeats(tdoc)).get(uid);
            if (seat) device = await hooks.devices.findOne({ contestKey, teamUid: null, seat: new RegExp('^' + seat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i') });
        }
        const online = device && isCaptureOnline(device, judgedAt);
        const rid = String(r._id);
        const clip: Clip = {
            _id: `${contestKey}/${rid}`, contestKey, rid, pid: r.pid, status: r.status, firstSolve: first, priority, teamUid: uid, device: device?._id || null,
            submittedAt, judgedAt, ...clipWindow(submittedAt, judgedAt, r.status === 1, settings.recording.clips), requestedAt: judgedAt,
            streams: { screen: { segments: [], missing: [] }, ...(settings.webcam && settings.recording.clips.webcam ? { webcam: { segments: [], missing: [] } } : {}) },
            state: online ? 'requested' : 'missing', ...(!online ? { reason: 'offline' } : {}),
        };
        const result = await store.clips.updateOne({ _id: clip._id }, { $setOnInsert: clip }, { upsert: true });
        if (result.upsertedCount && online) request(clip, device._id);
        if (first) await store.clips.updateMany({ contestKey, pid: r.pid, rid: { $gt: rid }, firstSolve: true }, { $set: { firstSolve: false, priority: 1 } });
    }
    on('record/judge', (r) => judged(r).catch(warn));
    async function resume(tdoc: Tdoc, doc: CaptureDevice, uid: number, settings: CaptureSettings) {
        const contestKey = hooks.key(tdoc), now = Date.now();
        if (settings.recording.clips.enabled) {
            const pending = store.clips.find({ contestKey, teamUid: uid, windowEnd: { $gt: now - 600000 }, state: { $ne: 'ready' }, reason: { $nin: ['deleted', 'evicted'] } }).sort({ priority: 1 });
            for await (const clip of pending as AsyncIterable<Clip>) {
                await store.clips.updateOne({ _id: clip._id }, { $set: { device: doc._id, state: 'requested' } });
                request(clip, doc._id);
            }
        }
        const previous = doc as CaptureDevice & { offlineAt?: number; offlineTeam?: number; offlineReason?: string };
        const offline = previous.offlineAt || (doc.lastSeen && !isCaptureOnline(doc, now) ? epoch(doc.lastSeen) : 0);
        if (offline && (previous.offlineTeam ?? uid) === uid && settings.recording.archive.enabled) {
            const from = Math.max(offline, +tdoc.beginAt), to = Math.min(now, +tdoc.endAt);
            if (to > from) for (const s of ['screen', ...(settings.webcam && settings.recording.archive.webcam ? ['webcam'] : [])]) {
                await store.gaps.updateOne({ _id: `${contestKey}/${doc._id}/${s}/${from}` }, { $set: { contestKey, teamUid: uid, stream: s, from, to, reason: previous.offlineReason || 'offline' } }, { upsert: true });
            }
        }
        await hooks.devices.updateOne({ _id: doc._id, contestKey }, { $unset: { offlineAt: '', offlineReason: '', offlineTeam: '' } });
    }
    async function disconnect(tdoc: Tdoc, device: string, teamUid: number, reason: string) {
        await store.clips.updateMany({ contestKey: hooks.key(tdoc), device, teamUid, state: { $in: ['requested', 'uploading'] } }, { $set: { reason } });
    }
    async function online(contestKey: string) {
        const list = await hooks.devices.find({ contestKey, connection: { $ne: null }, lastSeen: { $gt: new Date(Date.now() - 45000) } }).project({ _id: 1 }).toArray();
        return list.map((x: { _id: string }) => x._id);
    }
    async function message(tdoc: Tdoc, doc: CaptureDevice, socketUid: number | null, msg: Record<string, any>) {
        const uid = socketUid, contestKey = hooks.key(tdoc);
        const settings = await hooks.loadSettings(contestKey);
        if (!settings.enabled) return;
        if (msg.type === 'test-request') {
            // Prevent a contestant retaining unlimited reports by repeatedly starting self-tests.
            if (await store.tests.findOne({ contestKey, initiator: doc._id, startedAt: { $gt: Date.now() - 60000 } })) throw new RecordingError('请稍后再试');
            await tests.start(contestKey, { kind: 'device', deviceIds: [doc._id] }, deviceRecording(settings), [doc._id], doc._id);
        } else if (msg.type === 'test-report') {
            if (typeof msg.testId === 'string') await tests.report(contestKey, doc._id, msg);
        } else if ((msg.rid || msg.gap) && (uid === null || uid !== await teamFor(tdoc, doc))) return;
        else if (msg.rid && typeof msg.rid === 'string' && id24.test(msg.rid) && msg.done) {
            const clip = await store.clips.findOne({ contestKey, rid: msg.rid, teamUid: uid, device: doc._id });
            if (clip && clip.reason !== 'deleted') await finish(clip, ['evicted', 'closed', 'failed'].includes(msg.reason) ? msg.reason : 'evicted');
        } else if (msg.gap && stream(msg.gap.stream) && settings.recording.archive.enabled) {
            const { from, to, reason } = msg.gap;
            if (bounded(from, +tdoc.beginAt - 1800000, Date.now()) && bounded(to, from + 1, Date.now() + 10000) && ['evicted', 'failed', 'closed', 'offline'].includes(reason)) {
                await store.gaps.updateOne({ _id: `${contestKey}/${doc._id}/${msg.gap.stream}/${from}` }, { $set: { contestKey, teamUid: uid, from, to, reason, stream: msg.gap.stream } }, { upsert: true });
            }
        } else {
            const { backlogBytes, backlogSeconds, failures } = msg;
            if (bounded(backlogBytes, 0, 1e13) && bounded(backlogSeconds, 0, 86400) && bounded(failures, 0, 1e9)) {
                const recordingError = typeof msg.recordingError === 'string' ? msg.recordingError.slice(0, 180) : '';
                await hooks.devices.updateOne({ _id: doc._id, contestKey }, { $set: { recordingStatus: { backlogBytes, backlogSeconds, failures, recordingError, at: Date.now() } } });
            }
        }
    }
    class RecordingHandler extends Handler {
        async onerror(err: Parameters<Handler['onerror']>[0] | RecordingError) {
            if (err instanceof RecordingError || err.name === 'CaptureError') {
                this.response.status = (err as RecordingError).status || 400;
                this.response.body = { error: err.message };
                return;
            }
            return super.onerror(err as Parameters<Handler['onerror']>[0]);
        }
    }
    class Upload extends RecordingHandler {
        noCheckPermView = true;
        notUsage = true;
        async upload(tdoc: Tdoc, device: CaptureDevice, teamUid: number | null) {
            const a = this.args, settings = await hooks.loadSettings(hooks.key(tdoc));
            // An unassigned desk may write to its own active test only. It cannot create team footage.
            const matchesTeam = teamUid === null ? a.kind === 'test' && (a.teamUid == null || a.teamUid === '') : Number(a.teamUid) === teamUid;
            if (!matchesTeam || a.deviceId !== device._id || !settings.enabled) throw new RecordingError('设备的参赛队伍或采集状态已改变', 403);
            await this.limitRate('xcpcio_recording_device_upload', 60, 180, device._id);
            const s = a.stream, kind = a.kind, startAt = Number(a.startMs), endAt = Number(a.endMs), now = Date.now(), contestKey = hooks.key(tdoc);
            if (!stream(s) || !['clip', 'archive', 'test'].includes(kind) || !Number.isSafeInteger(startAt) || !Number.isSafeInteger(endAt) || startAt >= endAt || endAt > now + 60000 || endAt - startAt > 180000) throw new RecordingError('录像类型、轨道或时间无效');
            let clip: Clip | null = null;
            const extra: { testId?: string; sourceKind?: string } = {};
            if (kind === 'clip') {
                if (!settings.recording.clips.enabled || !id24.test(String(a.rid))) throw new RecordingError('片段请求无效', 403);
                clip = await store.clips.findOne({ contestKey, rid: a.rid, device: device._id, teamUid, windowEnd: { $gt: startAt }, windowStart: { $lt: endAt }, reason: { $ne: 'deleted' } });
                if (!clip?.streams[s]) throw new RecordingError('该录像段不属于本队收到的请求', 403);
            } else if (kind === 'archive') {
                if (!settings.recording.archive.enabled || (s === 'webcam' && !(settings.webcam && settings.recording.archive.webcam))) throw new RecordingError('本场未开启该路留档', 403);
                if (endAt < +tdoc.beginAt || startAt >= +tdoc.endAt) throw new RecordingError('留档不在比赛时间内');
            } else {
                if (typeof a.testId !== 'string' || !['clip', 'archive'].includes(a.sourceKind)) throw new RecordingError('测试参数无效');
                const t = await store.tests.findOne({ _id: a.testId, contestKey, targets: device._id, endedAt: null, deadline: { $gte: now } });
                if (!t || startAt < t.startedAt - 15000) throw new RecordingError('测试未启动或已结束', 410);
                extra.testId = a.testId; extra.sourceKind = a.sourceKind;
            }
            const file = this.request.files?.file;
            if (!file?.filepath) throw new RecordingError('请选择录像段');
            const { bytes, mime, extension } = await inspectSegment(file.filepath, file.mimetype || '');
            const quality = uploadedRecordingQuality(a.quality);
            const begin = performance.now();
            const result = await store.save({ contestKey, device: device._id, teamUid: teamUid ?? 0, kind, stream: s, startAt, endAt, bytes, mime, ...extra, ...(quality ? { quality } : {}) }, file.filepath, extension);
            if (clip) await store.clips.updateOne({ _id: clip._id, state: { $in: ['requested', 'missing'] } }, { $set: { state: 'uploading' } });
            if (kind === 'test' && result.created) {
                const at = Math.floor(now / 1000), testId = extra.testId!;
                await store.counters.updateOne({ _id: `${testId}/${at}` }, { $setOnInsert: { contestKey, testId, at }, $inc: { bytes, writeMs: Math.max(1, performance.now() - begin) } }, { upsert: true });
                if (!await store.tests.findOne({ _id: testId, endedAt: null })) {
                    await store.removeSegments({ _id: result.doc._id, kind: 'test' }, false);
                    await store.counters.deleteMany({ testId });
                }
            }
            this.response.body = { id: result.doc._id };
        }
    }
    class SecretUpload extends Upload {
        @param('tid', Types.ObjectId)
        @param('device', Types.String)
        @param('secret', Types.String)
        async post(domainId: string, tid: ObjectId, id: string, secret: string) {
            const tdoc = await ContestModel.get(domainId, tid);
            const doc = tdoc?.rule === 'acm' && id24.test(id) ? await hooks.devices.findOne({ contestKey: hooks.key(tdoc), _id: id }) : null;
            if (!doc || !captureSecretMatches(secret, doc.secret)) throw new RecordingError('采集链接无效', 404);
            await this.upload(tdoc!, doc, await teamFor(tdoc!, doc));
        }
    }
    class OwnUpload extends Upload {
        @param('tid', Types.ObjectId)
        async post(_domainId: string, tid: ObjectId) {
            const { tdoc, teamUid } = await hooks.contestantContext(this, tid);
            const doc = await hooks.participantDevice(tdoc, teamUid);
            if (await teamFor(tdoc, doc) !== teamUid) throw new RecordingError('设备已绑定其他队伍', 403);
            await this.upload(tdoc, doc, teamUid);
        }
    }
    class Admin extends RecordingHandler {
        tdoc!: Tdoc;
        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            this.tdoc = await hooks.checkAdmin(this, tid);
            this.response.addHeader('Cache-Control', 'private, no-store');
        }
        input(): Record<string, any> {
            try {
                const text = this.args.payload || '{}';
                if (typeof text !== 'string' || text.length > 100000) throw new Error();
                const result = JSON.parse(text);
                if (!result || typeof result !== 'object' || Array.isArray(result)) throw new Error();
                return result;
            } catch { throw new RecordingError('请求内容无效'); }
        }
        page(hash: string) { this.response.redirect = `${hooks.contestBase(this.tdoc)}/live/capture#${hash}`; }
    }
    async function plan(tdoc: Tdoc, capture: CaptureSettings, input?: unknown) {
        const contestKey = hooks.key(tdoc), now = Date.now();
        const recording = input ? normalizeRecording(input, capture.recording, capture) : capture.recording;
        const filter = { domainId: tdoc.domainId, contest: tdoc.docId, _id: { $gte: dateObjectId(tdoc.beginAt), $lt: dateObjectId(tdoc.endAt) } };
        const seconds = Math.max(1, (+tdoc.endAt - +tdoc.beginAt) / 1000), elapsed = Math.max(0, Math.min(seconds, (now - +tdoc.beginAt) / 1000));
        const [teams, submissions, accepted, reports] = await Promise.all([
            ContestModel.countStatus(tdoc.domainId, { docId: tdoc.docId, attend: { $gt: 0 } }),
            elapsed ? RecordModel.coll.countDocuments(filter) : 0,
            elapsed ? RecordModel.coll.countDocuments({ ...filter, status: 1 }) : 0,
            store.tests.find({ contestKey, kind: { $ne: 'storage' }, endedAt: { $ne: null } }, { projection: { devices: 1, settings: 1, kind: 1, summary: 1 } }).sort({ endedAt: -1 }).limit(10).toArray(),
        ]);
        const stats = { teams, seconds, submissions, accepted, elapsed, problems: tdoc.pids.length };
        const measured: Measured = {};
        let measuredPeak: number | null = null;
        for (const report of reports) {
            const settings = report.settings;
            if (!settings?.clips || !settings?.archive) continue;
            for (const source of Object.keys(presets) as SourceName[]) {
                if (measured[source]) continue;
                const kind = source.startsWith('clip') ? 'clips' : 'archive', s = source.endsWith('Screen') ? 'screen' : 'webcam';
                if (JSON.stringify(settings[kind][s]) !== JSON.stringify(recording[kind][s])) continue;
                const values = Object.values(report.devices as Record<string, { bitrates?: Measured }>).map((d) => d.bitrates?.[source]).filter((x): x is number => !!x && Number.isFinite(x));
                if (values.length) measured[source] = values.reduce((sum, n) => sum + n, 0) / values.length;
            }
            if (!measuredPeak && report.kind === 'venue' && report.summary?.peakFactor >= 1 && JSON.stringify(settings) === JSON.stringify(recording)) measuredPeak = report.summary.peakFactor;
        }
        const effective = measuredPeak ? { ...recording, planning: { ...recording.planning, peakFactor: measuredPeak } } : recording;
        return { stats, measured, measuredPeak, estimate: estimateRecording(effective, stats, measured, capture.webcam) };
    }
    async function usage(contestKey: string) {
        const summary = (collection: any, match: Record<string, unknown>, kind: unknown) => collection.aggregate([
            { $match: { contestKey, ...match } },
            { $group: { _id: { teamUid: '$teamUid', kind }, count: { $sum: 1 }, bytes: { $sum: '$bytes' } } },
            { $project: { _id: 0, teamUid: '$_id.teamUid', kind: '$_id.kind', count: 1, bytes: 1 } },
        ]).toArray();
        const [recorded, outputs] = await Promise.all([summary(store.segments, { kind: { $ne: 'test' } }, '$kind'), summary(store.videos, { path: { $type: 'string' } }, { $literal: 'reaction' })]);
        return [...recorded, ...outputs];
    }
    class Data extends Admin {
        async get() {
            const key = hooks.key(this.tdoc), base = hooks.contestBase(this.tdoc);
            const capture = await hooks.loadSettings(key);
            const [p, freeBytes] = await Promise.all([plan(this.tdoc, capture), store.freeBytes()]);
            if (this.args.view === 'settings') { this.response.body = { ...p, freeBytes, presets }; return; }
            const [used, clipTeams, gapTeams, disconnectedRows] = await Promise.all([
                usage(key), store.clips.distinct('teamUid', { contestKey: key }), store.gaps.distinct('teamUid', { contestKey: key }),
                hooks.devices.find({ contestKey: key, $or: [
                    { offlineAt: { $type: 'number' }, offlineTeam: { $type: 'number' } },
                    { connection: { $ne: null }, lastSeen: { $lt: new Date(Date.now() - 45000) }, recordingTeam: { $type: 'number' } },
                ] }).project({ offlineAt: 1, offlineTeam: 1, offlineReason: 1, lastSeen: 1, recordingTeam: 1 }).toArray(),
            ]);
            const offlineDocs = disconnectedRows.map((d: any) => ({ offlineAt: d.offlineAt || +new Date(d.lastSeen), offlineTeam: d.offlineTeam ?? d.recordingTeam, offlineReason: d.offlineReason || 'offline' }));
            const teamIds: number[] = [...new Set<number>([...used.map((v: { teamUid: number }) => v.teamUid), ...clipTeams, ...gapTeams, ...offlineDocs.map((v: any) => v.offlineTeam)])].sort((a,b) => a-b);
            const teamLimit = Math.min(40, Math.max(1, Math.trunc(Number(this.args.teamLimit) || 12)));
            const teamPages = Math.max(1, Math.ceil(teamIds.length / teamLimit));
            const teamPage = Math.min(teamPages, Math.max(1, Math.trunc(Number(this.args.teamPage) || 1)));
            const teamUids = this.args.teamUid !== undefined && this.args.teamUid !== '' ? [Number(this.args.teamUid)] : teamIds.slice((teamPage - 1) * teamLimit, teamPage * teamLimit);
            if (teamUids.some((id) => !Number.isSafeInteger(id) || id === 0)) throw new RecordingError('队伍编号无效');
            const filter = { contestKey: key, teamUid: { $in: teamUids } };
            const [clips, segments, gaps] = await Promise.all([
                store.clips.find(filter, { projection: { _id: 0, contestKey: 0 } }).sort({ submittedAt: -1 }).toArray(),
                store.segments.find({ ...filter, kind: { $ne: 'test' } }, { projection: { kind: 1, teamUid: 1, startAt: 1, endAt: 1, bytes: 1, stream: 1, quality: 1 } }).sort({ startAt: 1 }).toArray(),
                store.gaps.find(filter, { projection: { _id: 0, contestKey: 0 } }).toArray(),
            ]);
            const disconnected = offlineDocs.filter((d: any) => teamUids.includes(d.offlineTeam));
            for (const doc of disconnected) if (capture.recording.archive.enabled) {
                const from = Math.max(doc.offlineAt, +this.tdoc.beginAt), to = Math.min(Date.now(), +this.tdoc.endAt);
                if (to > from) for (const s of ['screen', ...(capture.webcam && capture.recording.archive.webcam ? ['webcam'] : [])]) gaps.push({ teamUid: doc.offlineTeam, stream: s, from, to, reason: doc.offlineReason || 'offline' });
            }
            // Recovered offline uploads fill all or part of a previously inferred gap.
            const runs = new Map<string, { startAt: number; endAt: number }[]>();
            for (const s of segments) if (s.kind === 'archive') {
                const k = s.teamUid + '/' + s.stream, entries = runs.get(k) || [];
                entries.push(s); runs.set(k, entries);
            }
            const uncovered = gaps.flatMap((g: any) => {
                const candidates = runs.get(g.teamUid + '/' + g.stream) || [];
                return missingIntervals(g.from, g.to, candidates).map((r) => ({ ...g, ...r }));
            });
            this.response.body = { ...p, presets, teamPage, teamLimit, teamPages, teamUids, clips, gaps: uncovered, freeBytes, usage: used, segments: segments.map((s: Segment) => ({ ...exclude(s, '_id'), id: s._id, url: `${base}/live/capture/recordings/media/${s._id}` })) };
        }
    }
    class Media extends Admin {
        @param('id', Types.String)
        async get(_domainId: string, id: string) {
            const item = await store.segments.findOne({ contestKey: hooks.key(this.tdoc), _id: id, kind: { $ne: 'test' } });
            if (!item) throw new RecordingError('找不到录像段', 404);
            await serveRecordingMedia(ctx, this, item, this.args.download === '1' ? item.path.split('/').pop() : undefined);
        }
    }
    async function selection(contestKey: string, data: Record<string, any>) {
        const kind = data.kind, hasUid = data.teamUid !== undefined;
        if (kind !== undefined && !['archive', 'clip', 'reaction'].includes(kind)) throw new RecordingError('清理类型无效');
        if (hasUid && (!Number.isSafeInteger(data.teamUid) || !data.teamUid)) throw new RecordingError('队伍编号无效');
        const from = data.from, to = data.to;
        if ((from !== undefined && !Number.isSafeInteger(from)) || (to !== undefined && !Number.isSafeInteger(to)) || (from != null && to != null && from >= to)) throw new RecordingError('清理时间范围无效');
        if (!kind && !hasUid && from === undefined && to === undefined && data.all !== true) throw new RecordingError('请明确清理范围');
        if (data.all && (kind || hasUid || from !== undefined || to !== undefined)) throw new RecordingError('清理范围冲突');
        const range = { ...(from !== undefined ? { $gte: from } : {}), ...(to !== undefined ? { $lt: to } : {}) };
        const filtered = from !== undefined || to !== undefined;
        const common = { contestKey, ...(hasUid ? { teamUid: data.teamUid } : {}) };
        const projection = { _id: 1, bytes: 1, path: 1 };
        const [segments, products] = await Promise.all([
            kind === 'reaction' ? [] : store.segments.find({ ...common, kind: kind || { $in: ['archive', 'clip'] }, ...(filtered ? { startAt: range } : {}) }).project(projection).sort({ _id: 1 }).toArray(),
            kind && kind !== 'reaction' ? [] : store.videos.find({ ...common, path: { $type: 'string' }, ...(filtered ? { readyAt: range } : {}) }).project(projection).sort({ _id: 1 }).toArray(),
        ]);
        const rows = [...segments, ...products];
        const digest = createHash('sha256').update(contestKey);
        for (const row of rows) digest.update(JSON.stringify([row._id, row.path, row.bytes]));
        return { segments, products, result: { count: rows.length, bytes: rows.reduce((n, s) => n + s.bytes, 0), confirmation: digest.digest('hex') } };
    }
    class Manage extends Admin {
        async get() { this.page('recordings'); }
        async postEstimate() {
            const capture = await hooks.loadSettings(hooks.key(this.tdoc));
            this.response.body = await plan(this.tdoc, capture, this.input().recording);
        }
        async postPreviewDelete() { this.response.body = (await selection(hooks.key(this.tdoc), this.input())).result; }
        async postDelete() {
            const key = hooks.key(this.tdoc), data = this.input();
            if (data.all && data.title !== this.tdoc.title) throw new RecordingError('比赛名称不匹配');
            const { result, segments, products } = await selection(key, data);
            if (data.confirmation !== result.confirmation) throw new RecordingError('文件清单已改变，请重新预览', 409);
            for (let i = 0; i < segments.length; i += 250) await store.removeSegments({ contestKey: key, _id: { $in: segments.slice(i, i + 250).map((s: Segment) => s._id) } });
            for (const v of products) {
                await ctx.storage.del(v.path);
                await store.videos.updateOne({ _id: v._id, contestKey: key, path: v.path }, {
                    $set: { state: 'removed', error: '成品已被管理员清理', hidden: { at: Date.now(), by: this.user._id } },
                    $unset: { path: '', bytes: '', readyAt: '', durationMs: '' }, $inc: { generation: 1 },
                });
            }
            this.response.body = { deleted: result.count, bytes: result.bytes };
        }
    }
    class TestPage extends Admin {
        async get() {
            if (!this.request.json) { this.page('tests'); return; }
            this.response.body = { tests: await tests.rows(hooks.key(this.tdoc)) };
        }
        async postStart() {
            const key = hooks.key(this.tdoc), capture = await hooks.loadSettings(key);
            if (!capture.enabled) throw new RecordingError('请先启用画面采集');
            this.response.body = await tests.start(key, this.input(), deviceRecording(capture), await online(key));
        }
        async postStorage() {
            await this.limitRate('xcpcio_recording_storage_probe', 60, 3);
            const key = hooks.key(this.tdoc), startedAt = Date.now(), storage = await probeRecordingStorage(ctx, key);
            await store.tests.insertOne({ _id: String(new ObjectId()), contestKey: key, kind: 'storage', startedAt, endedAt: Date.now(), storage, devices: {}, targets: [], series: [] });
            this.response.body = { storage };
        }
    }
    const base = '/contest/:tid/live/capture';
    ctx.Route('contest_xcpcio_recording_own_upload', '/contest/:tid/live-capture/me/segments', OwnUpload);
    ctx.Route('contest_xcpcio_recording_device_upload', '/contest/:tid/live-capture/:device/:secret/segments', SecretUpload);
    ctx.Route('contest_xcpcio_recordings', base + '/recordings', Manage);
    ctx.Route('contest_xcpcio_recordings_data', base + '/recordings/data', Data);
    ctx.Route('contest_xcpcio_recording_media', base + '/recordings/media/:id', Media);
    ctx.Route('contest_xcpcio_recording_tests', base + '/tests', TestPage);
    on('app/started', async () => {
        await store.ensureIndexes().catch(warn);
        ctx.interval(() => { void (async () => {
            await tests.tick();
            for await (const c of store.clips.find({ refreshToken: { $exists: true } }).limit(200)) await finish(c, 'deleted');
            const pending = store.clips.find({ state: { $in: ['requested', 'uploading'] }, windowEnd: { $lt: Date.now() - 600000 } }).limit(1000);
            for await (const c of pending) await finish(c, c.reason || 'failed');
        })().catch(warn); }, 10000);
        if (!process.env.NODE_APP_INSTANCE || process.env.NODE_APP_INSTANCE === '0') ctx.interval(() => { void store.auditOrphans().catch(warn); }, 86400000);
    });
    on('contest/del', (domain: string, tid: ObjectId) => store.deleteContest(`${domain}/${tid}`));
    on('domain/delete', (domain: string) => store.deleteContest(new RegExp('^' + domain.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/')));
    return { teamFor, resume, disconnect, message };
}
