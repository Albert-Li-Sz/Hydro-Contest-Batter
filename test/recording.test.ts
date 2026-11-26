import { mkdir, mkdtemp, open, rm, stat, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Context, Handler } from 'hydrooj';
import { describe, expect, it, vi } from 'vitest';
import {
    clipPriority, clipWindow, defaultRecordingSettings, estimateRecording, gradeTest, inScope, MIN_TEAM_STORAGE_BYTES, missingIntervals, normalizeRecording, presets, readRange,
    teamStorageLimit, uploadedRecordingQuality,
} from '../lib/recording';
import { inspectSegment, RecordingStore, segmentId, serveRecordingMedia } from '../lib/recording-store';
import { defaultCaptureSettings, normalizeCaptureSettings, readCaptureSettings } from '../lib/live/capture';

describe('recording settings and match planning', () => {
    it('makes old capture settings opt in, preserves recording independently of edits to capture', () => {
        const old = normalizeCaptureSettings({ webcam: false, screenHeight: 720 });
        expect(old.recording.clips.enabled).toBe(false);
        expect(old.recording.archive.enabled).toBe(false);
        const s = normalizeCaptureSettings({ recording: { archive: { enabled: true } } }, old);
        expect(normalizeCaptureSettings({ prompt: false }, s).recording.archive.enabled).toBe(true);
        expect(() => normalizeCaptureSettings({ recording: { clips: { enabled: true, screen: { preset: 'high' } } } }, s)).toThrow('不能超过');
    });
    it('defaults new contests to 1080p30 capture and independent opt-in 60-second HD archives for both streams', () => {
        const settings = readCaptureSettings(undefined);
        const hd = { preset: 'archiveHd', height: 720, fps: 24, kbps: 1200 };
        expect(settings).toMatchObject({
            enabled: false, screenHeight: 1080, screenFps: 30, webcamHeight: 1080, webcamFps: 30, webcamAudio: false,
            recording: { autoDowngrade: false, clips: { enabled: false }, archive: { enabled: false, webcam: hd, segmentSeconds: 60, screen: hd } },
        });
        expect(readCaptureSettings(settings)).toEqual(settings);
        const active = normalizeCaptureSettings({ enabled: true, recording: { archive: { enabled: true } } }, settings);
        const totals = estimateRecording(active.recording, { teams: 1, seconds: 60 });
        expect(totals.sources.archiveScreen).toBe(9_000_000);
        expect(totals.sources.archiveWebcam).toBe(9_000_000);
        expect(totals.storageBytes).toBe(18_900_000);
        expect(totals.averageMbps).toBe(2.4);
        expect(estimateRecording(active.recording, { teams: 1, seconds: 60 }, {}, false).storageBytes).toBe(9_450_000);
        // A five-hour contest with both HD archives (about 5.7 GB per team) stays well inside the team's limit.
        const fiveHours = 5 * 3600;
        const archiveOnly = estimateRecording(active.recording, { teams: 1, seconds: fiveHours }).storageBytes;
        expect(archiveOnly).toBeGreaterThan(5 * 1024 ** 3);
        expect(teamStorageLimit(active.recording, fiveHours)).toBe(Math.ceil(archiveOnly * 3));
        expect(teamStorageLimit(settings.recording, 60)).toBe(MIN_TEAM_STORAGE_BYTES);
    });
    it('preserves saved capture, archive and congestion choices, including historical partial documents', () => {
        const old = readCaptureSettings({ enabled: true, screenFps: 5, recording: { archive: { enabled: true, screen: { preset: 'standard' } } } });
        expect(old).toMatchObject({ screenHeight: 720, screenFps: 5, webcamHeight: 480, webcamFps: 15,
            recording: { autoDowngrade: true, archive: { screen: { fps: 1, kbps: 100 }, webcam: null } } });
        const custom = { preset: 'custom', height: 480, fps: 12, kbps: 750 };
        const saved = readCaptureSettings({ screenHeight: 720, screenFps: 15, recording: { autoDowngrade: false, archive: { screen: custom, webcam: custom } } });
        expect(normalizeCaptureSettings({ prompt: false }, saved)).toMatchObject({
            screenHeight: 720, screenFps: 15, recording: { autoDowngrade: false, archive: { screen: custom, webcam: custom } },
        });
        const oldScreenOnly = { ...defaultCaptureSettings(), webcamHeight: 480, recording: { archive: { screen: { preset: 'archiveHd' }, webcam: null } } };
        expect(readCaptureSettings(oldScreenOnly).recording.archive.webcam).toBeNull();
    });
    it('advertises the HD archive preset for both archives and preserves independent clip profiles', () => {
        expect(Object.entries(presets).filter(([, choices]) => choices.archiveHd).map(([source]) => source)).toEqual(['archiveScreen', 'archiveWebcam']);
        for (const stream of ['screen', 'webcam']) {
            expect(() => normalizeCaptureSettings({ recording: { clips: { [stream]: { preset: 'archiveHd' } } } })).toThrow('不支持');
        }
    });
    it('projects aggregate bandwidth and storage from actual rates, enabled streams and live submission counts', () => {
        const s = normalizeRecording({ clips: { enabled: true }, archive: { enabled: true, screen: { preset: 'standard' }, webcam: null }, planning: { uplinkMbps: 5 } }, defaultRecordingSettings(), defaultCaptureSettings());
        const q = estimateRecording(s, { teams: 2, seconds: 3600 }, { clipScreen: 500 });
        expect(q.sources.clipScreen).toBe(500 * 125 * 2 * (10 * 60 + 30 * 30));
        expect(q.sources.archiveScreen).toBe(100 * 125 * 2 * 3600);
        expect(q.sources.archiveWebcam).toBe(0);
        expect(q.averageMbps).toBeCloseTo(1.033333);
        expect(q.storageBytes).toBe(488250000);
        expect(q.utilization).toBeCloseTo(.62);
        const real = estimateRecording(s, { teams: 2, seconds: 3600, elapsed: 900, accepted: 1, submissions: 5 }, {}, false);
        expect(real.real).toBe(true);
        expect(real.sources.clipWebcam).toBe(0);
        expect(real.sources.clipScreen).toBe(1000 * 125 * (4 * 60 + 16 * 30));
    });
    it('limits a delayed judgement window to two minutes, retaining the reaction to the verdict', () => {
        const { clips } = defaultRecordingSettings();
        expect(clipWindow(90000, 92000, true, clips)).toEqual({ windowStart: 70000, windowEnd: 132000 });
        expect(clipWindow(90000, 900000, false, clips)).toEqual({ windowStart: 790000, windowEnd: 910000 });
        expect([clipPriority(1, true), clipPriority(1, false), clipPriority(2, false)]).toEqual([0, 1, 2]);
        expect(inScope('first', 1)).toBe(false);
        expect(inScope('accepted', 0)).toBe(true);
        expect(inScope('all', 2)).toBe(true);
    });
    it('uses real segment bounds, tolerates a recorder restart and preserves missing heads and tails', () => {
        expect(missingIntervals(1000, 5000, [{ startAt: 1800, endAt: 3000 }, { startAt: 3120, endAt: 4300 }, { startAt: 100, endAt: 400 }]))
            .toEqual([{ from: 1000, to: 1800 }, { from: 4300, to: 5000 }]);
        expect(missingIntervals(0, 3000, [])).toEqual([{ from: 0, to: 3000 }]);
    });
    it('reports failure and unknown diagnostics distinctly', () => {
        expect(gradeTest(.05, 'nominal', 10, 1)).toBe('fail');
        expect(gradeTest(0, 'serious', 10, 1)).toBe('fail');
        expect(gradeTest(0, 'nominal', 2, 1)).toBe('fail');
        expect(gradeTest(null, 'unknown', 3, 1)).toBe('unknown');
        expect(gradeTest(.042, 'nominal', 3, 1)).toBe('marginal');
        expect(gradeTest(.01, 'nominal', 3, 1)).toBe('pass');
    });
});

describe('recording file boundaries', () => {
    it('preserves legacy quality and exposes measured dimensions and codec only when valid', () => {
        const legacy = { height: 480, fps: 1, kbps: 100 };
        expect(uploadedRecordingQuality(JSON.stringify(legacy))).toEqual(legacy);
        for (const codec of ['hevc', 'av1', 'h264']) {
            const measured = { height: 720, width: 1280, requestedHeight: 720, fps: 24, kbps: 1200, codec };
            expect(uploadedRecordingQuality(JSON.stringify(measured))).toEqual(measured);
        }
        expect(uploadedRecordingQuality(JSON.stringify({ ...legacy, width: -1, codec: 'other' }))).toEqual(legacy);
        expect(uploadedRecordingQuality(undefined)).toBeUndefined();
        expect(() => uploadedRecordingQuality('{')).toThrow('画质格式无效');
    });
    it('validates single, suffix and open-ended HTTP ranges', () => {
        expect(readRange('bytes=2-4', 10)).toEqual({ start: 2, end: 4 });
        expect(readRange('bytes=-5', 10)).toEqual({ start: 5, end: 9 });
        expect(readRange('bytes=8-', 10)).toEqual({ start: 8, end: 9 });
        expect(readRange('bytes=0-50', 10)).toEqual({ start: 0, end: 9 });
        for (const s of ['bytes=-0', 'bytes=-', 'bytes=10-', 'bytes=5-1', 'bytes=0-1,4-8']) expect(() => readRange(s, 10)).toThrow();
    });
    it('streams exactly the requested bytes and returns 416 for unsatisfiable local reads', async () => {
        const root = await mkdtemp(join(tmpdir(), 'recording-media-'));
        try {
            await writeFile(join(root, 'clip'), '0123456789');
            const ctx = { storage: { status: async () => ({ dir: root }) } } as unknown as Context;
            const headers: Record<string, string> = {};
            const h = { request: { headers: { range: 'bytes=3-5' } }, response: { addHeader: (key: string, value: string) => { headers[key] = value; } } } as unknown as Handler;
            const item = { path: 'clip', bytes: 10, mime: 'video/mp4' };
            await serveRecordingMedia(ctx, h, item);
            let result = '';
            for await (const data of h.response.body as NodeJS.ReadableStream) result += data.toString();
            expect([h.response.status, headers['Content-Range'], result]).toEqual([206, 'bytes 3-5/10', '345']);
            h.request.headers.range = 'bytes=20-';
            await serveRecordingMedia(ctx, h, item);
            expect([h.response.status, headers['Content-Range']]).toEqual([416, 'bytes */10']);
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('uses the configured short-lived S3 user endpoint for playback and downloads', async () => {
        const sign = vi.fn(async () => 'https://objects.test/signed');
        const ctx = { storage: { status: async () => ({ type: 'S3' }), signDownloadLink: sign } } as unknown as Context;
        const h = { request: { headers: { range: 'bytes=2-4' } }, response: {} } as unknown as Handler;
        const file = { path: 'xcpcio/recordings/domain/tid/clip/file.mp4', bytes: 1024, mime: 'video/mp4' };
        await serveRecordingMedia(ctx, h, file);
        expect(sign).toHaveBeenLastCalledWith(file.path, '', false, 'user');
        expect(h.response.redirect).toBe('https://objects.test/signed');
        await serveRecordingMedia(ctx, h, file, 'clip.mp4');
        expect(sign).toHaveBeenLastCalledWith(file.path, 'clip.mp4', false, 'user');
    });
    it('preserves metadata for a retry when S3 reports a per-object batch deletion error', async () => {
        const segments = {
            find: async function* () { yield { _id: 'a', kind: 'archive', path: 'xcpcio/recordings/s/c/1.mp4' }; },
            deleteMany: vi.fn(),
        };
        const del = vi.fn(async () => ({ Errors: [{ Key: 'xcpcio/recordings/s/c/1.mp4', Code: 'SlowDown' }] }));
        const ctx = { storage: { del }, db: { collection: () => segments } } as unknown as Context;
        await expect(new RecordingStore(ctx).removeSegments({ contestKey: 's/c' })).rejects.toMatchObject({ status: 503 });
        expect(segments.deleteMany).not.toHaveBeenCalled();
    });
    it('audits aged unreferenced recordings, finished videos and assets without removing files', async () => {
        const root = await mkdtemp(join(tmpdir(), 'recording-audit-'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
        try {
            const old = (Date.now() - 2 * 86400000) / 1000;
            const referenced = new Set(['xcpcio/reactions/known', 'xcpcio/recordings/known']);
            for (const kind of ['recordings', 'reactions']) {
                const dir = join(root, 'xcpcio', kind);
                await mkdir(dir, { recursive: true });
                for (const name of ['old', 'fresh', 'known']) {
                    const path = join(dir, name);
                    await writeFile(path, 'media');
                    if (name !== 'fresh') await utimes(path, old, old);
                }
            }
            const ctx = { db: { collection: () => ({ findOne: async ({ path }: { path: string }) => referenced.has(path) }) }, storage: { status: async () => ({ dir: root }) } } as unknown as Context;
            await new RecordingStore(ctx).auditOrphans();
            expect(warn.mock.calls.map((args) => args[1]).sort()).toEqual(['xcpcio/reactions/old', 'xcpcio/recordings/old']);
            expect((await stat(join(root, 'xcpcio/reactions/old'))).isFile()).toBe(true);
        } finally { warn.mockRestore(); await rm(root, { recursive: true, force: true }); }
    });
    it('checks the saved file header and exact size, even for an asserted video MIME type', async () => {
        const root = await mkdtemp(join(tmpdir(), 'recording-upload-'));
        try {
            const file = join(root, 'test');
            await writeFile(file, Buffer.from('000000186674797069736f6d', 'hex'));
            expect(await inspectSegment(file, 'video/mp4;codecs=avc1')).toMatchObject({ mime: 'video/mp4', extension: 'mp4', bytes: 12 });
            await expect(inspectSegment(file, 'video/webm')).rejects.toMatchObject({ status: 415 });
            const f = await open(file, 'r+');
            try { await f.truncate(20 * 1024 * 1024 + 1); } finally { await f.close(); }
            await expect(inspectSegment(file, 'video/mp4')).rejects.toMatchObject({ status: 413 });
        } finally { await rm(root, { recursive: true, force: true }); }
    });
    it('deduplicates a shared segment while separating teams, tests and test tracks', () => {
        const s = { contestKey: 'a/b', teamUid: -10, device: 'desk', kind: 'clip', stream: 'screen', startAt: 12345 } as const;
        expect(segmentId(s)).toBe(segmentId({ ...s }));
        expect(segmentId(s)).not.toBe(segmentId({ ...s, teamUid: -11 }));
        expect(segmentId({ ...s, kind: 'test', testId: 't', sourceKind: 'archive' })).not.toBe(segmentId({ ...s, kind: 'test', testId: 't', sourceKind: 'clip' }));
    });
});
