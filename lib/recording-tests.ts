import { randomBytes, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Context } from 'hydrooj';
import { gradeTest, qualityPreset, reportedVideoCodec, RecordingError, type Measured, type RecordingSettings, type SourceName } from './recording';
import type { RecordingStore } from './recording-store';

const sources: SourceName[] = ['clipScreen', 'clipWebcam', 'archiveScreen', 'archiveWebcam'];
function finite(n: unknown, max: number, fallback: number | null = null) {
    return typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= max ? n : fallback;
}
function testQualities(settings: RecordingSettings) {
    const bothOff = !(settings.clips.enabled || settings.archive.enabled);
    const clips = bothOff || settings.clips.enabled;
    const archive = bothOff || settings.archive.enabled;
    return [clips ? settings.clips.screen : null, clips ? settings.clips.webcam : null,
        archive ? settings.archive.screen : null, archive ? settings.archive.webcam : null];
}
function testedPeak(settings: RecordingSettings, measured: Measured) {
    const q = testQualities(settings);
    return sources.reduce((sum, key, i) => sum + (q[i] ? measured[key] || q[i]!.kbps : 0), 0) / 1000;
}
export async function probeRecordingStorage(ctx: Context, contestKey: string) {
    const size = 50 * 1024 * 1024;
    const key = `xcpcio/tests/${contestKey}/${randomUUID()}.bin`;
    const dir = await mkdtemp(join(tmpdir(), 'hydro-recording-'));
    try {
        const file = join(dir, 'sample');
        const block = randomBytes(1024 * 1024);
        await pipeline(Readable.from(Array.from({ length: 50 }, () => block)), createWriteStream(file));
        const start = performance.now();
        await ctx.storage.put(key, file);
        const written = performance.now();
        const stream = await ctx.storage.get(key);
        if (!stream) throw new RecordingError('无法读取存储测试文件');
        let read = 0;
        for await (const chunk of stream) read += Buffer.byteLength(chunk);
        if (read !== size) throw new RecordingError('存储读回字节数不一致');
        return { bytes: size, writeMBps: size / 1000 / Math.max(1, written - start), readMBps: size / 1000 / Math.max(1, performance.now() - written), at: Date.now() };
    } finally { try { await ctx.storage.del(key); } finally { await rm(dir, { recursive: true, force: true }); } }
}

export function recordingTests(ctx: Context, store: RecordingStore, send: (device: string, message: Record<string, unknown>) => void) {
    const tests = store.tests;
    async function start(contestKey: string, raw: Record<string, any>, settings: RecordingSettings, onlineIds: string[], initiator?: string) {
        const kind = raw.kind;
        if (kind !== 'venue' && kind !== 'device') throw new RecordingError('测试类型无效');
        if (kind === 'venue' && !(settings.clips.enabled || settings.archive.enabled)) throw new RecordingError('请至少启用一路录制再进行全场压力测试');
        const durationSeconds = kind === 'device' ? 30 : Number(raw.durationSeconds ?? 180);
        const intervalSeconds = Number(raw.intervalSeconds ?? 180), mode = raw.mode || 'normal';
        if (!(durationSeconds >= 3 * 60 && durationSeconds <= 15 * 60 || kind === 'device') || !(intervalSeconds >= 5 && intervalSeconds <= 3600) || !['normal', 'peak'].includes(mode)) throw new RecordingError('测试时长、频率或模式无效');
        const ids = raw.deviceIds;
        if (ids !== undefined && (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string'))) throw new RecordingError('设备列表无效');
        const targets = onlineIds.filter((id) => !ids?.length || ids.includes(id));
        if (!targets.length) throw new RecordingError('没有可测试的在线设备');
        if (await tests.findOne({ contestKey, endedAt: null, targets: { $in: targets } })) throw new RecordingError('选中设备已有测试正在运行', 409);
        const startedAt = Date.now();
        const _id = randomUUID();
        const payload = { testId: _id, kind, durationSeconds, intervalSeconds, mode, peakFactor: settings.planning.peakFactor, recording: settings };
        try {
            await tests.insertOne({ _id, contestKey, settings, startedAt, deadline: startedAt + durationSeconds * 1000 + 45000, endedAt: null, targets, devices: {}, ...(initiator ? { initiator } : {}), ...payload });
        } catch (error) {
            if ((error as { code?: number }).code === 11000) throw new RecordingError('选中设备已有测试正在运行', 409);
            throw error;
        }
        for (const device of targets) send(device, { type: 'test-start', ...payload });
        if (kind === 'venue') void probeRecordingStorage(ctx, contestKey).then((storage) => tests.updateOne({ _id }, { $set: { storage } })).catch((e) => tests.updateOne({ _id }, { $set: { storageError: String(e) } }));
        return { testId: _id };
    }
    async function report(contestKey: string, device: string, raw: Record<string, unknown>) {
        const test = await tests.findOne({ _id: raw.testId, contestKey, targets: device, endedAt: null });
        if (!test) return;
        const rawRates = raw.bitrates && typeof raw.bitrates === 'object' ? raw.bitrates as Measured : {};
        const bitrates: Measured = {};
        for (const source of sources) {
            const n = finite(rawRates[source], 100000);
            if (n && n > 0) bitrates[source] = n;
        }
        const dropRate = finite(raw.dropRate, 1), throughputMbps = finite(raw.throughputMbps, 1e6);
        const pressure = ['nominal', 'fair', 'serious', 'critical'].includes(String(raw.pressure)) ? String(raw.pressure) : 'unknown';
        const recordingError = typeof raw.recordingError === 'string' ? raw.recordingError.slice(0, 180) : '';
        const archiveScreenCodec = reportedVideoCodec(raw.archiveScreenCodec);
        const grade = recordingError ? 'fail' : gradeTest(dropRate, pressure, throughputMbps, testedPeak(test.settings, bitrates));
        const value = { bytes: finite(raw.bytes, 1e13, 0), backlogBytes: finite(raw.backlogBytes, 1e12, 0), failures: finite(raw.failures, 1e9, 0), uploads: finite(raw.uploads, 1e9, 0),
            dropRate, throughputMbps, pressure, bitrates, grade, recordingError, ...(archiveScreenCodec ? { archiveScreenCodec } : {}), done: raw.done === true, at: Date.now(), recommendation: grade === 'fail' ? 'low' : grade === 'unknown' ? null : 'current' };
        await tests.updateOne({ _id: test._id, endedAt: null, [`devices.${device}.done`]: { $ne: true } }, {
            $set: { [`devices.${device}`]: value }, $max: { maxBacklog: value.backlogBytes },
        });
        if (value.done) await finish(test._id);
    }
    async function observations(test: any) {
        const points: { at: number; bytes: number; writeMs: number }[] = await store.counters.find({ testId: test._id }).sort({ at: 1 }).toArray();
        const buckets = new Map(points.map((p) => [p.at, p]));
        const start = Math.floor(test.startedAt / 1000), end = Math.floor(Math.min(test.deadline, Date.now()) / 1000);
        const series = Array.from({ length: Math.max(0, end - start + 1) }, (_, index) => {
            const at = start + index, p = buckets.get(at);
            return { at: at * 1000, bytes: p?.bytes || 0, mbps: (p?.bytes || 0) * 8 / 1e6, writeMBps: p?.writeMs ? p.bytes / p.writeMs / 1000 : 0 };
        });
        return series;
    }
    async function finish(id: string) {
        const test = await tests.findOne({ _id: id, endedAt: null });
        if (!test || Date.now() < test.deadline && test.targets.some((d: string) => !test.devices[d]?.done)) return;
        const series = await observations(test);
        const rates = series.map((p) => p.mbps).sort((a, b) => a - b);
        const failedDevices = test.targets.filter((id: string) => !test.devices[id]?.done || !['pass', 'marginal'].includes(test.devices[id]?.grade));
        const totals = (field: string) => test.targets.reduce((sum: number, id: string) => sum + (test.devices[id]?.[field] || 0), 0);
        const peakMbps = rates.at(-1) || 0, failed = totals('failures'), attempts = totals('uploads') + failed;
        const avg = rates.reduce((s, n) => s + n, 0) / (rates.length || 1);
        const uplink = test.settings.planning.uplinkMbps;
        const passed = !failedDevices.length && !failed && peakMbps > 0 && (uplink == null || peakMbps < uplink * .8);
        const budget = uplink == null ? null : uplink * .8;
        const candidates = ['archiveHd', 'high', 'standard', 'low'] as const;
        const baseline = testedPeak(test.settings, {});
        const active = testQualities(test.settings);
        const recommended = budget && peakMbps > 0 ? candidates.find((preset) => {
            if (preset === 'archiveHd' && !active[2]) return false;
            const sum = sources.reduce((n, source, i) => {
                const channelPreset = preset === 'archiveHd' && source !== 'archiveScreen' ? 'high' : preset;
                return n + (active[i] ? qualityPreset(source, channelPreset).kbps : 0);
            }, 0) / 1000;
            return sum / baseline * peakMbps < budget;
        }) || null : null;
        const summary = { peakMbps, p95Mbps: rates[Math.max(0, Math.ceil(rates.length * .95) - 1)] || 0, peakFactor: avg > 0 ? peakMbps / avg : null,
            maxBacklog: test.maxBacklog || 0, failureRate: attempts ? failed / attempts : null, failedDevices, passed, recommended };
        await tests.updateOne({ _id: id, endedAt: null }, { $set: { endedAt: Date.now(), series, summary, cleanupPending: true } });
        await cleanup(id);
    }
    async function cleanup(testId: string) {
        await store.removeSegments({ kind: 'test', testId }, false);
        await store.counters.deleteMany({ testId });
        await tests.updateOne({ _id: testId, endedAt: { $ne: null } }, { $unset: { cleanupPending: '' } });
    }
    async function tick() {
        for await (const t of tests.find({ endedAt: null, deadline: { $lte: Date.now() } })) await finish(t._id);
        for await (const t of tests.find({ cleanupPending: true })) await cleanup(t._id);
    }
    async function rows(contestKey: string) {
        const ts = await tests.find({ contestKey }).sort({ startedAt: -1 }).limit(100).toArray();
        for (const test of ts) if (!test.endedAt) test.series = await observations(test);
        return ts;
    }
    return { start, report, tick, rows };
}
