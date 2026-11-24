import { evictedSegments, nextUpload, openBuffer, segmentsFor } from './hydro-recording-buffer.js';
import { ArchiveEncoderUnavailable, recordingSource, recordSegment } from './hydro-recording-media.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keyOf = (kind, stream) => kind + (stream === 'screen' ? 'Screen' : 'Webcam');
const sourceName = (stream) => stream === 'screen' ? '屏幕' : '摄像头';
const archiveFailure = (stream, error) => '高清' + sourceName(stream) + '留档已停止：' + error.message;
const reducedQuality = (quality) => ({ ...quality, preset: 'custom', height: Math.min(quality.height, 480),
    fps: Math.max(0.5, quality.fps / 2), kbps: Math.max(30, Math.round(quality.kbps / 2)) });

export class CaptureRecorder {
    constructor({ uploadUrl, send, show, sources }) {
        this.uploadUrl = uploadUrl;
        this.send = send;
        this.show = show;
        this.sources = sources;
        this.loops = new Map();
        this.blocked = new Map();
        this.pendingRequests = new Map();
        this.offset = 0;
        this.failures = 0;
        this.backlogSeconds = 0;
        this.timer = setInterval(() => this.tick(), 1500);
        this.clockTimer = setInterval(() => this.clock(), 60_000);
    }

    now = () => Math.round(Date.now() + this.offset);
    clock() { this.send({ type: 'clock', clientTime: Date.now() }); }
    warn(error) { this.error = error?.message || String(error); this.display(); }
    display() {
        this.show({ active: this.loops.size > 0, enabled: !!(this.settings?.clips?.enabled || this.settings?.archive?.enabled),
            backlogBytes: this.backlogBytes || 0, backlogSeconds: this.backlogSeconds, failures: this.failures,
            error: this.recordingError() || this.error, testing: !!this.test, supported: this.supported });
    }

    recordingError() {
        return [...this.blocked.values()].map((entry) => entry.message).join(' · ');
    }
    async config(profile) {
        this.settings = profile.recording;
        this.idleUntil = 0;
        this.begin = Number.isFinite(profile.beginAt) ? profile.beginAt : 0;
        this.end = Number.isFinite(profile.endAt) ? profile.endAt : Infinity;
        this.supported = typeof MediaRecorder === 'function' && !!globalThis.indexedDB;
        if (Number.isFinite(profile.serverTime)) this.offset = profile.serverTime - Date.now();
        const uid = profile.teamUid;
        const assigned = Number.isSafeInteger(uid);
        const binding = profile.deviceId && (assigned || uid === null) ? String(profile.deviceId) + ':' + (assigned ? uid : 'unassigned') : '';
        if (binding !== this.binding) {
            this.reset();
            this.binding = binding;
            this.deviceId = profile.deviceId;
            this.teamUid = uid;
        }
        if (!binding || !this.supported) {
            if (this.settings?.clips?.enabled || this.settings?.archive?.enabled) this.warn(binding ? '浏览器不支持本地录像' : '设备尚未绑定参赛队伍');
            return;
        }
        if (!assigned && (this.settings?.clips?.enabled || this.settings?.archive?.enabled)) this.warn('设备尚未绑定参赛队伍，可运行设备测试');
        this.clock();
        if (!this.db && !this.opening) {
            // Strip a shared device's secret. Rotating it preserves its own retry queue.
            const scope = this.uploadUrl.split('/live-capture/')[0];
            this.opening = openBuffer(scope + '/' + binding);
            try {
                const db = await this.opening;
                if (this.binding !== binding) { db.close(); return; }
                this.db = db;
            } catch (error) { this.warn(error); }
            finally { if (this.binding === binding) this.opening = null; }
        }
        this.sync();
        this.tick();
    }

    reset() {
        this.binding = '';
        this.opening = null;
        for (const entry of this.loops.values()) entry.abort.abort();
        this.loops.clear();
        this.blocked.clear();
        this.test?.abort.abort();
        this.test = null;
        this.db?.close();
        this.db = null;
        this.httpAbort?.abort();
        this.pendingRequests.clear();
        this.backlogBytes = this.backlogSeconds = this.failures = 0;
        this.error = '';
        this.display();
    }

    async message(message) {
        if (message.type === 'clock' && Number.isFinite(message.serverTime)) {
            const now = Date.now();
            if (Number.isFinite(message.clientTime) && now - message.clientTime >= 0 && now - message.clientTime < 5000) {
                this.offset = message.serverTime - (now + message.clientTime) / 2;
            }
        } else if (message.type === 'record-error') {
            this.warn(message.message || message.error || '录制请求失败');
        } else if (message.type === 'clip-request') {
            if (!Number.isSafeInteger(this.teamUid) || !this.binding || !message.rid || !Array.isArray(message.streams)) return;
            this.idleUntil = 0;
            this.pendingRequests.set(message.rid, message);
            this.tick();
        } else if (message.type === 'test-start') {
            if (this.opening) await this.opening;
            if (this.db && this.test?.id !== message.testId) this.runTest(message).catch((e) => this.warn(e));
        }
    }

    sync() {
        const desired = new Map();
        if (this.settings && this.db && Number.isSafeInteger(this.teamUid)) {
            for (const kind of ['clip', 'archive']) {
                const group = this.settings[kind === 'clip' ? 'clips' : kind];
                const now = this.now();
                const before = kind === 'clip' ? group?.beforeSeconds * 1000 : 0;
                const after = kind === 'clip' ? 120000 : 0;
                if (!group?.enabled || now < this.begin - before || now >= this.end + after) continue;
                for (const stream of ['screen', 'webcam']) {
                    const source = this.sources()[stream];
                    const quality = group[stream];
                    if (!source?.getVideoTracks().some((t) => t.readyState === 'live') || !quality) continue;
                    const congested = this.settings.autoDowngrade && this.backlogSeconds > 60;
                    const add = (low) => {
                        const q = low ? { ...reducedQuality(quality), requestedHeight: quality.height } : quality;
                        const key = kind + ':' + stream + (kind === 'clip' && low ? ':low' : '');
                        const archiveHd = kind === 'archive' && quality.preset === 'archiveHd';
                        const fixedOutput = archiveHd || (kind === 'archive' && stream === 'screen');
                        desired.set(key, { source, quality: q, kind, stream, fixedOutput, archiveHd, reduced: kind === 'clip' && low,
                            signature: JSON.stringify([archiveHd, q, this.begin, this.end]), configured: JSON.stringify(quality) });
                    };
                    add(kind === 'archive' && congested);
                    if (kind === 'clip' && congested && this.backlogSeconds > 120) add(true);
                }
            }
        }
        for (const [key, failure] of this.blocked) {
            const want = desired.get(key);
            if (want?.source === failure.source && want.configured === failure.configured) desired.delete(key);
            else this.blocked.delete(key);
        }
        for (const [key, active] of this.loops) {
            const want = desired.get(key);
            if (want?.source === active.source && want.signature === active.signature) desired.delete(key);
            else { active.abort.abort(); this.loops.delete(key); }
        }
        for (const [key, options] of desired) {
            const entry = { ...options, abort: new AbortController() };
            this.loops.set(key, entry);
            this.recordLoop(entry, this.db).catch((e) => {
                if (entry.abort.signal.aborted) return;
                if (e instanceof ArchiveEncoderUnavailable) {
                    this.blocked.set(key, { source: entry.source, configured: entry.configured, message: archiveFailure(entry.stream, e) });
                } else this.warn(e);
            }).finally(() => {
                if (this.loops.get(key) === entry) this.loops.delete(key);
                this.display();
            });
        }
        this.display();
    }

    async recordLoop(entry, db) {
        const { kind, stream, quality, reduced, abort } = entry;
        // A contest may be shortened or extended while the browser is live. sync() rotates
        // the encoder on a schedule change; the finishing segment also sees the new boundary.
        const cutoff = () => this.end + (kind === 'clip' ? 120000 : 0);
        const source = await recordingSource(entry.source, quality, stream === 'webcam', entry.fixedOutput, entry.archiveHd, () => this.now() < cutoff());
        if (kind === 'archive') source.onLost = (from, to) => {
            if (db !== this.db) return;
            const row = { id: crypto.randomUUID(), stream, startMs: from, endMs: to };
            return db.write([this.gap(row, 'failed')]).catch((error) => this.warn(error));
        };
        try {
            while (!abort.signal.aborted) {
                entry.segmentStart = this.now();
                const remaining = cutoff() - entry.segmentStart;
                const duration = Math.min(kind === 'clip' ? 10000 : 60000, remaining);
                if (duration <= 0) break;
                const segment = await recordSegment(source, quality, duration, abort.signal, this.now, false, cutoff);
                if (db !== this.db || source.stream.getVideoTracks()[0].readyState === 'ended' && !segment) break;
                if (!segment) continue;
                await this.save(db, segment, { kind, stream, quality, reduced });
            }
        } finally { source.close(); }
    }

    async save(db, segment, fields) {
        const { blob, dropRate, codec, width, height, ...timing } = segment;
        const id = crypto.randomUUID();
        const quality = { ...fields.quality, codec };
        if (width > 0 && height > 0) Object.assign(quality, { requestedHeight: fields.quality.requestedHeight || fields.quality.height, width, height });
        const row = { id, ...timing, ...fields, quality, bytes: blob.size };
        const entries = [['segments', id, row], ['blobs', id, blob]];
        if (fields.kind !== 'clip') entries.push(['jobs', id, { id, segment: id, created: Date.now(), priority: 3 }]);
        if (blob.size > 20 * 1024 * 1024) {
            if (row.kind === 'archive') await db.write([this.gap(row, 'failed')]);
            throw new Error('单段超过 20 MB，请调低录制码率');
        }
        try { await db.write(entries); }
        catch (error) {
            if (row.kind === 'archive') this.send({ type: 'record-status', gap: this.gap(row, 'failed')[2] });
            throw error;
        }
        if (fields.testId === this.test?.id && Number.isFinite(dropRate)) this.test.dropRates.push(dropRate);
        this.idleUntil = 0;
        this.tick();
    }

    gap(row, reason) {
        return ['gaps', row.id, { id: row.id, stream: row.stream, from: row.startMs, to: row.endMs, reason }];
    }

    async tick() {
        const db = this.db;
        if (!db || this.busy || Date.now() < (this.idleUntil || 0)) return;
        this.busy = true;
        try {
            const pending = [...this.pendingRequests.values()];
            this.pendingRequests.clear();
            for (const request of pending) {
                if (!await db.read('requests', request.rid)) await db.write([['requests', request.rid, { ...request, sent: [] }]]);
            }
            let [rows, jobs, requests, gaps] = await Promise.all(['segments', 'jobs', 'requests', 'gaps'].map((s) => db.read(s)));
            if (!this.settings?.archive?.enabled && !this.settings?.clips?.enabled && !this.test && !rows.length && !requests.length && !gaps.length && !jobs.length) {
                this.idleUntil = Date.now() + 60000;
                return;
            }
            for (const request of requests) {
                const matching = segmentsFor(request, rows);
                const missingJobs = matching.filter((s) => !request.sent.includes(s.id) && !jobs.some((j) => j.rid === request.rid && j.segment === s.id));
                for (const segment of missingJobs) {
                    const id = request.rid + '/' + segment.id;
                    const job = { id, segment: segment.id, rid: request.rid, created: Date.now(), priority: request.priority };
                    await db.write([['jobs', id, job]]);
                    jobs.push(job);
                }
                // The last recorder covering the end of this window must have had time to close.
                const closing = [...this.loops.values()].some((loop) => loop.kind === 'clip' && request.streams.includes(loop.stream)
                    && loop.segmentStart < request.windowEndMs && this.now() - loop.segmentStart <= 180_000);
                if (!closing && this.now() > request.windowEndMs + 12_000 && !jobs.some((j) => j.rid === request.rid)) {
                    if (this.send({ type: 'record-status', rid: request.rid, done: true, reason: request.reason || (request.sent.length ? undefined : 'evicted') })) {
                        await db.write([['requests', request.rid]]);
                    }
                }
            }
            const expired = evictedSegments(rows, this.now(), new Set(jobs.filter((j) => j.rid).map((j) => j.segment)));
            for (const row of expired) {
                const entries = [['segments', row.id], ['blobs', row.id], ...jobs.filter((j) => j.segment === row.id).map((j) => ['jobs', j.id])];
                if (row.kind === 'archive') entries.push(this.gap(row, 'evicted'));
                await db.write(entries);
            }
            if (expired.length) {
                const ids = new Set(expired.map((row) => row.id));
                jobs = jobs.filter((job) => !ids.has(job.segment));
                rows = rows.filter((row) => !ids.has(row.id));
            }
            for (const gap of gaps) {
                if (this.send({ type: 'record-status', gap })) await db.write([['gaps', gap.id]]);
            }
            const byId = new Map(rows.map((row) => [row.id, row]));
            this.backlogBytes = jobs.reduce((sum, j) => sum + (byId.get(j.segment)?.bytes || 0), 0);
            this.backlogSeconds = jobs.length ? Math.floor((Date.now() - Math.min(...jobs.map((j) => j.created))) / 1000) : 0;
            if (Date.now() - (this.lastStatus || 0) >= 5000) {
                this.send({ type: 'record-status', backlogBytes: this.backlogBytes, backlogSeconds: this.backlogSeconds, failures: this.failures, recordingError: this.recordingError() });
                this.lastStatus = Date.now();
                this.sync();
            }
            const job = nextUpload(jobs, Date.now());
            if (job && navigator.onLine && db === this.db) await this.upload(db, job, byId.get(job.segment));
        } catch (error) { if (db === this.db) this.warn(error); }
        finally { this.busy = false; this.display(); }
    }

    async upload(db, job, row) {
        if (!row) { await db.write([['jobs', job.id]]); return; }
        const blob = await db.read('blobs', row.id);
        const currentTest = row.kind === 'test' && this.test?.id === row.testId ? this.test : null;
        if (!blob || (row.kind === 'test' && !currentTest)) {
            await db.write([['jobs', job.id], ['blobs', row.id], ['segments', row.id]]);
            return;
        }
        const form = new FormData();
        form.set('file', blob, row.id + (row.mime === 'video/mp4' ? '.mp4' : '.webm'));
        for (const [key, value] of Object.entries({ kind: row.kind, stream: row.stream, startMs: row.startMs, endMs: row.endMs,
            rid: job.rid, testId: row.testId, sourceKind: row.sourceKind, quality: JSON.stringify(row.quality), deviceId: this.deviceId, teamUid: this.teamUid })) {
            if (value !== undefined && value !== null) form.set(key, String(value));
        }
        const began = performance.now();
        const abort = new AbortController();
        this.httpAbort = abort;
        const timeout = setTimeout(() => abort.abort(), 60_000);
        let permanent = false;
        try {
            const response = await fetch(this.uploadUrl, { method: 'POST', credentials: 'same-origin', headers: { Accept: 'application/json' }, body: form, signal: abort.signal });
            permanent = [400, 401, 403, 404, 410, 413, 415, 422].includes(response.status);
            const result = await response.json();
            if (!response.ok || !result.id) throw new Error(result.error?.message || '录像上传失败（' + response.status + '）');
            const entries = [['jobs', job.id]];
            if (job.rid) {
                const request = await db.read('requests', job.rid);
                if (request) entries.push(['requests', job.rid, { ...request, sent: [...request.sent, row.id] }]);
            } else entries.push(['segments', row.id], ['blobs', row.id]);
            await db.write(entries);
            if (currentTest) {
                currentTest.bytes += row.bytes;
                currentTest.uploadMs += performance.now() - began;
                currentTest.uploads++;
                if (row.sourceKind === 'archive') currentTest[keyOf('archive', row.stream) + 'Codec'] = row.quality?.codec;
                const meter = currentTest.rates[keyOf(row.sourceKind, row.stream)] ||= { bytes: 0, ms: 0 };
                meter.bytes += row.bytes;
                meter.ms += row.endMs - row.startMs;
            }
            this.error = '';
            setTimeout(() => this.tick(), 0);
        } catch (error) {
            if (db !== this.db) return;
            this.failures++;
            if (currentTest) currentTest.failures++;
            if (permanent) {
                const entries = [['jobs', job.id]];
                if (job.rid) {
                    const request = await db.read('requests', job.rid);
                    if (request) entries.push(['requests', job.rid, { ...request, reason: 'failed', sent: [...request.sent, row.id] }]);
                } else {
                    entries.push(['segments', row.id], ['blobs', row.id]);
                    if (row.kind === 'archive') entries.push(this.gap(row, 'failed'));
                }
                await db.write(entries);
            } else {
                const attempts = (job.attempts || 0) + 1;
                await db.write([['jobs', job.id, { ...job, attempts, retryAt: Date.now() + 1000 * 2 ** Math.min(attempts, 7) }]]);
            }
            this.warn(error);
        } finally { clearTimeout(timeout); }
    }

    async runTest(message) {
        if (this.test) return;
        const { testId: id, recording, kind } = message;
        const test = { id, abort: new AbortController(), bytes: 0, uploads: 0, failures: 0, uploadMs: 0, dropRates: [], rates: {}, errors: new Set(), pressure: null };
        const db = this.db;
        this.idleUntil = 0;
        this.test = test;
        this.display();
        let observer;
        const levels = ['nominal', 'fair', 'serious', 'critical'];
        if (typeof PressureObserver === 'function') {
            try {
                observer = new PressureObserver((items) => {
                    for (const item of items) if (levels.indexOf(item.state) > levels.indexOf(test.pressure)) test.pressure = item.state;
                });
                await observer.observe('cpu', { sampleInterval: 1000 });
            } catch { /* CPU pressure remains unknown when the browser or Permissions Policy disallows it. */ }
        }
        const report = (done) => {
            const bitrates = Object.fromEntries(Object.entries(test.rates).map(([key, r]) => [key, r.bytes * 8 / Math.max(1, r.ms)]));
            this.send({ type: 'test-report', testId: id, archiveScreenCodec: test.archiveScreenCodec, archiveWebcamCodec: test.archiveWebcamCodec,
                recordingError: [...test.errors].join(' · '), bytes: test.bytes, uploads: test.uploads, failures: test.failures, backlogBytes: this.backlogBytes || 0,
                pressure: test.pressure, dropRate: test.dropRates.length ? Math.max(...test.dropRates) : null,
                throughputMbps: test.uploadMs ? test.bytes * 8 / test.uploadMs / 1000 : 0, bitrates, done });
        };
        const timer = setInterval(() => report(false), 5000);
        const deadline = Date.now() + (kind === 'device' ? 30 : Math.max(180, Math.min(900, message.durationSeconds))) * 1000;
        const jobs = [];
        const groupsEnabled = recording?.clips?.enabled || recording?.archive?.enabled;
        for (const sourceKind of ['clip', 'archive']) {
            const group = recording?.[sourceKind === 'clip' ? 'clips' : 'archive'];
            if (!group || ((groupsEnabled || kind === 'venue') && !group.enabled)) continue;
            for (const stream of ['screen', 'webcam']) {
                const quality = group[stream];
                const raw = this.sources()[stream];
                if (!quality) continue;
                if (!raw) {
                    test.failures++;
                    const reason = sourceName(stream) + '未采集，无法测试该路画质';
                    test.errors.add(reason);
                    this.warn(reason);
                    continue;
                }
                jobs.push((async () => {
                    const archiveHd = sourceKind === 'archive' && quality.preset === 'archiveHd';
                    const fixedOutput = archiveHd || (sourceKind === 'archive' && stream === 'screen');
                    const source = await recordingSource(raw, quality, stream === 'webcam', fixedOutput, archiveHd);
                    try {
                        let nextClip = Date.now();
                        let clipLeft = 0;
                        while (!test.abort.signal.aborted && Date.now() < deadline - 100) {
                            let segmentMs = 30_000;
                            if (kind === 'venue') {
                                segmentMs = sourceKind === 'clip' ? 10_000 : 60_000;
                                if (sourceKind === 'clip' && clipLeft <= 0) {
                                    while (Date.now() < Math.min(deadline, nextClip) && !test.abort.signal.aborted) await delay(Math.min(1000, nextClip - Date.now()));
                                    if (Date.now() >= deadline || test.abort.signal.aborted) break;
                                    clipLeft = 1000 * (recording.clips.beforeSeconds + recording.clips.afterAcceptedSeconds);
                                    nextClip = Date.now() + 1000 * message.intervalSeconds / (message.mode === 'peak' ? Math.max(1, message.peakFactor) : 1);
                                }
                                if (sourceKind === 'clip') segmentMs = Math.min(segmentMs, Math.max(1000, clipLeft));
                            }
                            const part = await recordSegment(source, quality, Math.min(segmentMs, deadline - Date.now()), test.abort.signal, this.now, true);
                            if (!part || this.db !== db) break;
                            await this.save(db, part, { kind: 'test', sourceKind, stream, quality, testId: id });
                            clipLeft -= part.endMs - part.startMs;

                        }
                    } finally { source.close(); }
                })().catch((error) => {
                    test.failures++;
                    const reason = error instanceof ArchiveEncoderUnavailable ? archiveFailure(stream, error) : sourceName(stream) + '：' + error.message;
                    test.errors.add(reason);
                    this.warn(reason);
                }));
            }
        }
        try {
            if (!jobs.length) test.failures++;
            await Promise.all(jobs);
            // Include the last actual upload in the report. Bound the grace period for offline machines.
            const grace = Date.now() + 45_000;
            while (this.db === db && Date.now() < grace && (await db.read('segments')).some((s) => s.testId === id)) { await this.tick(); await delay(200); }
            if (this.db === db) {
                test.failures += (await db.read('segments')).filter((s) => s.testId === id).length;
                report(true);
            }
        } finally {
            clearInterval(timer);
            observer?.disconnect();
            if (this.test === test) this.test = null;
            this.display();
        }
    }
}
