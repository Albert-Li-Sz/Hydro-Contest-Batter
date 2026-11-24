import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import { deviceRecording, type CaptureDevice, type CaptureSettings } from '../lib/live/capture';
import { clipPriority, clipWindow, estimateRecording, gradeTest, inScope, missingIntervals, normalizeRecording, presets, readRange, uploadedRecordingQuality } from '../lib/recording';

interface Sample { id: string; kind: string; stream: string; teamUid: number; startAt: number; endAt: number; bytes: number; mime: string; file: Buffer; testId?: string; quality?: ReturnType<typeof uploadedRecordingQuality> }
export function recordingPreview(base: string, config: () => CaptureSettings, contest: {title: string; beginAt: Date; endAt: Date},
    teams: () => {uid: number; seat: string}[], devices: Map<string, CaptureDevice>, send: (id: string, data: any) => void) {
    const endpoint = base + '/live/capture/recordings';
    const testUrl = base + '/live/capture/tests';
    const segments = new Map<string, Sample>();
    const reports = new Map<string, any>();
    const clips = new Map<string, any>();
    const gaps: any[] = [];
    const uidOf = (d: CaptureDevice) => d.teamUid ?? teams().find((t) => t.seat === d.seat)?.uid;
    const sample = readFileSync(path.join(__dirname, 'media/reaction-demo.mp4'));
    const uid = teams()[0]?.uid;
    if (uid !== undefined) {
        const start = +contest.beginAt + 300000;
        for (const kind of ['archive', 'clip']) for (const stream of ['screen', 'webcam']) {
            const id = 'fixture-' + kind + (stream === 'webcam' ? '-webcam' : '');
            segments.set(id, { id, kind, stream, teamUid: uid, startAt: start, endAt: start + 3000, bytes: sample.length, mime: 'video/mp4', file: sample });
        }
        clips.set('fixture', { rid: 'fixture', teamUid: uid, pid: 1, status: 1, firstSolve: true, state: 'ready', submittedAt: start,
            windowStart: start, windowEnd: start + 3000, streams: { screen: { segments: ['fixture-clip'], missing: [] }, webcam: { segments: ['fixture-clip-webcam'], missing: [] } } });
        gaps.push({ teamUid: uid, stream: 'screen', from: start + 3000, to: start + 60000, reason: 'offline' });
    }
    function activeTeams() {
        if (!config().enabled || !config().recording.clips.enabled) return [];
        return [...devices.values()].filter((d) => d.connection).map(uidOf).filter((id): id is number => Number.isSafeInteger(id));
    }
    function judged(run: {submission_id: string; team_id: string; problem_id: number; status: string; timestamp: number}) {
        const settings = config();
        const teamUid = Number(run.team_id), device = [...devices.values()].find((d) => d.connection && uidOf(d) === teamUid);
        if (!device || !settings.enabled || !settings.recording.clips.enabled) return;
        const rid = createHash('sha256').update(run.submission_id).digest('hex').slice(0, 24);
        const status = run.status === 'CORRECT' ? 1 : run.status === 'TIME_LIMIT_EXCEEDED' ? 3 : 2;
        const firstSolve = status === 1 && ![...clips.values()].some((c) => c.pid === run.problem_id && c.firstSolve);
        const priority = clipPriority(status, firstSolve);
        if (!inScope(settings.recording.clips.scope, priority)) return;
        const submittedAt = +contest.beginAt + run.timestamp, judgedAt = Date.now();
        const {windowStart, windowEnd} = clipWindow(submittedAt, judgedAt, status === 1, settings.recording.clips);
        const streams = settings.webcam && settings.recording.clips.webcam ? ['screen', 'webcam'] : ['screen'];
        clips.set(rid, { rid, teamUid, device: device._id, pid: run.problem_id, status, firstSolve, priority, submittedAt, judgedAt, windowStart, windowEnd,
            state: 'requested', streams: Object.fromEntries(streams.map((s) => [s, { segments: [], missing: [] }])) });
        send(device._id, { type: 'clip-request', rid, windowStartMs: windowStart, windowEndMs: windowEnd, priority, streams });
    }
    function start(payload: any) {
        const targets = [...devices.values()].filter((d) => d.connection && (!payload.deviceIds?.length || payload.deviceIds.includes(d._id))).map((d) => d._id);
        if (!targets.length) throw new Error('没有可测试的在线设备');
        const id = randomUUID();
        const settings = deviceRecording(config());
        const test = { _id: id, testId: id, targets, devices: {}, startedAt: Date.now(), endedAt: null, series: [], settings,
            kind: payload.kind, mode: payload.mode || 'normal', durationSeconds: payload.kind === 'venue' ? Number(payload.durationSeconds) : 30, intervalSeconds: payload.intervalSeconds || 180 };
        reports.set(id, test);
        for (const device of targets) send(device, { type: 'test-start', ...test, peakFactor: settings.planning.peakFactor, recording: settings });
        return { testId: id };
    }
    function message(d: CaptureDevice, msg: any) {
        if (msg.type === 'clock') { send(d._id, { type: 'clock', serverTime: Date.now(), clientTime: msg.clientTime }); return true; }
        if (msg.type === 'test-request') { start({ kind: 'device', deviceIds: [d._id] }); return true; }
        if (msg.type === 'test-report') {
            const t = reports.get(msg.testId);
            if (!t || !t.targets.includes(d._id) || t.endedAt) return true;
            t.devices[d._id] = { ...msg, grade: msg.recordingError ? 'fail' : gradeTest(msg.dropRate, msg.pressure, msg.throughputMbps, 1) };
            if (t.targets.every((id: string) => t.devices[id]?.done)) {
                t.endedAt = Date.now();
                const rates = t.series.map((s: any) => s.mbps).sort((a: number, b: number) => a - b);
                const failedDevices = t.targets.filter((id: string) => t.devices[id].grade !== 'pass');
                t.summary = { peakMbps: rates.at(-1) || 0, p95Mbps: rates[Math.floor(rates.length * .95)] || 0, maxBacklog: msg.backlogBytes,
                    failureRate: msg.failures / Math.max(1, msg.uploads + msg.failures), failedDevices, passed: !failedDevices.length };
                for (const [id, row] of segments) if (row.testId === t._id) segments.delete(id);
            }
            return true;
        }
        if (msg.type === 'record-status') {
            if ([msg.backlogBytes, msg.backlogSeconds, msg.failures].every((n) => Number.isFinite(n) && n >= 0)) {
                d.recordingStatus = { backlogBytes: msg.backlogBytes, backlogSeconds: msg.backlogSeconds, failures: msg.failures,
                    recordingError: typeof msg.recordingError === 'string' ? msg.recordingError.slice(0, 180) : '', at: Date.now() };
            }
            if (msg.gap) gaps.push({ ...msg.gap, teamUid: uidOf(d) });
            if (msg.rid && msg.done) {
                const c = clips.get(msg.rid);
                if (c) {
                    for (const track of Object.values(c.streams) as any[]) track.missing = missingIntervals(c.windowStart, c.windowEnd, track.segments.map((id: string) => segments.get(id)).filter(Boolean));
                    const tracks = Object.values(c.streams) as any[];
                    c.state = tracks.every((t) => !t.missing.length) ? 'ready' : tracks.some((t) => t.segments.length) ? 'partial' : 'missing';
                }
            }
            return true;
        }
        return false;
    }
    function plan(settings = config().recording) {
        const stats = { teams: teams().length, seconds: (+contest.endAt - +contest.beginAt) / 1000, elapsed: 0 };
        return { stats, measured: {}, estimate: estimateRecording(settings, stats, {}, config().webcam) };
    }
    async function handle(req: IncomingMessage, res: ServerResponse, u: URL, readBody: (r: IncomingMessage) => Promise<any>, device?: CaptureDevice) {
        const url = u.pathname;
        if (![endpoint, testUrl, endpoint + '/data'].includes(url) && !url.startsWith(endpoint + '/media/') && !device) return false;
        const json = (value: unknown, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value)); return true; };
        try {
            if (device) {
                if (req.method !== 'POST' || !config().enabled) return json({ error: '采集未开启' }, 403);
                const parts: Buffer[] = [];
                let size = 0;
                for await (const chunk of req) {
                    size += chunk.length;
                    if (size > 21 * 1024 * 1024) return json({ error: '文件过大' }, 413);
                    parts.push(chunk);
                }
                const form = await new Response(Buffer.concat(parts), { headers: { 'Content-Type': req.headers['content-type'] || '' } }).formData();
                const blob = form.get('file') as File;
                const kind = String(form.get('kind')), stream = String(form.get('stream')), assigned = uidOf(device);
                const teamUid = assigned ?? 0;
                if ((assigned === undefined && kind !== 'test') || Number(form.get('teamUid')) !== teamUid || form.get('deviceId') !== device._id) return json({ error: '设备绑定已改变' }, 403);
                const startAt = Number(form.get('startMs')), endAt = Number(form.get('endMs'));
                const testId = String(form.get('testId') || ''), rid = String(form.get('rid') || '');
                if (kind === 'test' && (!reports.get(testId)?.targets?.includes(device._id) || reports.get(testId).endedAt)) return json({ error: '测试未启动' }, 410);
                if (kind === 'clip' && clips.get(rid)?.teamUid !== teamUid) return json({ error: '片段不属于该队' }, 403);
                if (!blob || !['video/webm', 'video/mp4'].includes(blob.type)) return json({ error: '录像格式无效' }, 415);
                const file = Buffer.from(await blob.arrayBuffer());
                const id = createHash('sha256').update([kind, stream, testId, form.get('sourceKind'), teamUid, startAt].join('/')).digest('hex');
                if (!segments.has(id)) {
                    if (segments.size >= 100 || [...segments.values()].reduce((n, r) => n + r.bytes, file.length) > 256 * 1024 * 1024) return json({ error: '预览缓存已满' }, 507);
                    segments.set(id, { id, kind, stream, teamUid, startAt, endAt, bytes: file.length, file, mime: blob.type, testId, quality: uploadedRecordingQuality(form.get('quality')) });
                    if (testId) reports.get(testId)?.series.push({ at: Date.now(), bytes: file.length, mbps: file.length * 8 / 1e6, writeMBps: 0 });
                }
                if (rid && !clips.get(rid).streams[stream].segments.includes(id)) clips.get(rid).streams[stream].segments.push(id);
                return json({ id });
            }
            if (req.method === 'GET' && (url === endpoint || url === testUrl && !req.headers.accept?.includes('application/json'))) {
                res.writeHead(302, { Location: base + '/live/capture#' + (url === endpoint ? 'recordings' : 'tests') }).end(); return true;
            }
            if (req.method === 'GET' && url.startsWith(endpoint + '/media/')) {
                const row = segments.get(url.slice((endpoint + '/media/').length));
                if (!row || row.kind === 'test') return json({ error: '找不到录像' }, 404);
                const range = readRange(req.headers.range, row.file.length);
                res.writeHead(range ? 206 : 200, { 'Content-Type': row.mime, 'Accept-Ranges': 'bytes',
                    ...(range ? { 'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + row.bytes } : {}) }).end(range ? row.file.subarray(range.start, range.end + 1) : row.file);
                return true;
            }
            if (req.method === 'GET' && url === testUrl) return json({ tests: [...reports.values()].reverse() });
            const rows = [...segments.values()].filter((s) => s.kind !== 'test');
            if (req.method === 'GET' && url === endpoint + '/data') {
                const usage = new Map<string, any>();
                for (const s of rows) { const k = s.kind + s.teamUid, g = usage.get(k) || { kind: s.kind, teamUid: s.teamUid, count: 0, bytes: 0 }; g.count++; g.bytes += s.bytes; usage.set(k, g); }
                return json({ ...plan(), presets, clips: [...clips.values()].reverse(), segments: rows.map(({ file, ...r }) => ({ ...r, url: endpoint + '/media/' + r.id })), gaps, usage: [...usage.values()], freeBytes: null });
            }
            const body = await readBody(req), payload = JSON.parse(body.payload || '{}');
            if (url === endpoint && body.operation === 'estimate') return json(plan(normalizeRecording(payload.recording, config().recording, config())));
            if (url === testUrl && body.operation === 'start') return json(start(payload));
            if (url === testUrl && body.operation === 'storage') return json({ error: '存储读写测试需在 Hydro 环境运行' }, 400);
            if (url === endpoint && ['preview_delete', 'delete'].includes(body.operation)) {
                if (!payload.all && !payload.teamUid && !payload.kind && !payload.from && !payload.to) return json({ error: '请选择范围' }, 400);
                const match = rows.filter((s) => (!payload.kind || payload.kind === s.kind) && (!payload.teamUid || s.teamUid === payload.teamUid)
                    && (!payload.from || s.startAt >= payload.from) && (!payload.to || s.startAt < payload.to));
                const confirmation = createHash('sha256').update(match.map((s) => s.id).join('|')).digest('hex');
                if (body.operation === 'delete') {
                    if (payload.confirmation !== confirmation || (payload.all && payload.title !== contest.title)) return json({ error: '确认信息不匹配' }, 409);
                    for (const s of match) segments.delete(s.id);
                    for (const c of clips.values()) for (const t of Object.values(c.streams) as any[]) {
                        const left = t.segments.filter((id: string) => segments.has(id));
                        if (left.length !== t.segments.length) { t.segments = left; c.state = 'partial'; }
                    }
                }
                return json({ confirmation, count: match.length, bytes: match.reduce((sum, s) => sum + s.bytes, 0) });
            }
            return json({ error: '未知操作' }, 400);
        } catch (error) { return json({ error: (error as Error).message }, 400); }
    }
    return { handle, message, uidOf, activeTeams, judged };
}
