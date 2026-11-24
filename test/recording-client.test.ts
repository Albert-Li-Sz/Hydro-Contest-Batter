import { readFileSync } from 'node:fs';
import { describe, it, expect, vi } from 'vitest';
// Browser-native ES modules. The same functions choose actual IndexedDB jobs in a capture tab.
// @ts-ignore JavaScript browser module
import { evictedSegments, nextUpload, segmentsFor } from '../resolver/public/js/hydro-recording-buffer.js';
// @ts-ignore JavaScript browser module
import { ArchiveEncoderUnavailable, mp4VideoInfo, outputSize, recordSegment, selectMime, webmVideoInfo } from '../resolver/public/js/hydro-recording-media.js';
// @ts-ignore JavaScript browser module
import { CaptureRecorder } from '../resolver/public/js/hydro-capture-recorder.js';

describe('采集页的录制缓存和上传顺序', () => {
    it('保留已请求的旧片段，同时将留档限制在 30 分钟或 300 MiB', () => {
        const now = 10_000_000;
        const rows = [
            { id: 'protected', kind: 'clip', bytes: 300, endMs: now - 1e6 },
            { id: 'oldClip', kind: 'clip', bytes: 300, endMs: now - 1e6 },
            { id: 'old', kind: 'archive', bytes: 20, endMs: now - 1800001 },
            ...Array.from({ length: 4 }, (_, n) => ({ id: String(n), kind: 'archive', bytes: 100 * 1024 ** 2, endMs: now - n * 1000 })),
        ];
        expect(evictedSegments(rows, now, new Set(['protected'])).map((r: {id: string}) => r.id).sort()).toEqual(['3', 'old', 'oldClip']);
    });
    it('先上传一血，退避中的请求不阻塞可上传文件，同优先级按入队顺序', () => {
        const rows = [{ id: 'archive', priority: 3, created: 0 }, { id: 'first', priority: 0, created: 90, retryAt: 50 },
            { id: 'newAC', priority: 1, created: 50 }, { id: 'oldAC', priority: 1, created: 10 }];
        expect(nextUpload(rows, 40).id).toBe('oldAC');
        expect(nextUpload(rows, 50).id).toBe('first');
    });
    it('一血与通过取高画质，其他结果在完整覆盖时可使用降档版本，窗口端点不相交不上传', () => {
        const request = { streams: ['screen'], windowStartMs: 1000, windowEndMs: 5000, priority: 0 };
        const sample = { id: 'high', kind: 'clip', stream: 'screen', startMs: 0, endMs: 5000 };
        const samples = [sample, { ...sample, id: 'low', reduced: true }, { ...sample, id: 'late', startMs: 5000, endMs: 10000 },
            { ...sample, id: 'webcam', stream: 'webcam' }];
        expect(segmentsFor(request, samples)).toEqual([sample]);
        expect(segmentsFor({ ...request, priority: 1 }, samples)).toEqual([sample]);
        expect(segmentsFor({ ...request, priority: 2 }, samples)).toEqual([samples[1]]);
    });
    it('按浏览器声明的编码能力回退', () => {
        expect(selectMime(() => true)).toMatch(/^video\/mp4/);
        expect(selectMime((m: string) => m.includes('vp8'))).toContain('vp8');
        expect(selectMime(() => false)).toBeUndefined();
    });
});

describe('归档屏幕的画布与编码策略', () => {
    it('将 4K 画面按比例缩小到 720p，并保留竖屏、小源以及偶数边长', () => {
        expect(outputSize(3840, 2160, 720)).toEqual({ width: 1280, height: 720 });
        expect(outputSize(1080, 1920, 720)).toEqual({ width: 404, height: 720 });
        expect(outputSize(639, 479, 720)).toEqual({ width: 636, height: 478 });
        expect(outputSize(0, 720, 720)).toBeNull();
    });
    it('高清档只选择 H.265、AV1 或 AVC，普通档沿用已有 WebM 兼容路径', () => {
        expect(selectMime(() => true, true)).toContain('hvc1');
        expect(selectMime((m: string) => !/hvc1|hev1/.test(m), true)).toContain('av01');
        expect(selectMime((m: string) => /avc1/.test(m), true)).toContain('avc1');
        expect(selectMime((m: string) => m.includes('vp9') || m === 'video/mp4', true)).toBeUndefined();
        expect(selectMime((m: string) => m.includes('vp9'))).toContain('vp9');
    });
    it('读取实际 MP4 视频轨道信息，拒绝仅在文件文本中出现的编码名', async () => {
        const data = readFileSync(new URL('../preview/media/reaction-demo.mp4', import.meta.url));
        const info = await mp4VideoInfo(new Blob([data]));
        expect(info.codec).toBe('h264');
        expect(info.width).toBeGreaterThan(0);
        expect(info.height).toBeGreaterThan(0);
        expect(await mp4VideoInfo(new Blob(['xxxxftypmhvc1xxxxstsdhev1']))).toBeNull();
    });
    it('从 WebM 的视频 TrackEntry 提取 AV1 及分辨率', async () => {
        const ebml = (id: number[], payload: number[]) => [...id, 0x80 | payload.length, ...payload];
        const codec = ebml([0x86], [...new TextEncoder().encode('V_AV1')]);
        const size = ebml([0xe0], [...ebml([0xb0], [5, 0]), ...ebml([0xba], [2, 208])]);
        const entry = ebml([0xae], [...ebml([0x83], [1]), ...codec, ...size]);
        const blob = new Blob([new Uint8Array(ebml([0x18, 0x53, 0x80, 0x67], ebml([0x16, 0x54, 0xae, 0x6b], entry)))]);
        expect(await webmVideoInfo(blob)).toEqual({ codec: 'av1', width: 1280, height: 720 });
    });
    it('编码器构造、启动失败后改选下一编码，并用实际文件核对上报值', async () => {
        const data = readFileSync(new URL('../preview/media/reaction-demo.mp4', import.meta.url));
        const attempts: string[] = [];
        class Recorder {
            static isTypeSupported(type: string) { return ['video/mp4;codecs=hvc1', 'video/mp4;codecs=av01', 'video/mp4;codecs=avc1'].includes(type); }
            state = 'inactive';
            onstop?: () => void;
            ondataavailable?: (ev: {data: Blob}) => void;
            constructor(_stream: unknown, private opts: {mimeType: string}) {
                attempts.push(opts.mimeType);
                if (opts.mimeType.endsWith('hvc1')) throw new Error('编码器初始化失败');
            }
            start() {
                if (this.opts.mimeType.endsWith('av01')) throw new Error('编码器启动失败');
                this.state = 'recording';
            }
            stop() {
                this.state = 'inactive';
                this.ondataavailable?.({ data: new Blob([data], { type: 'video/mp4' }) });
                this.onstop?.();
            }
        }
        vi.stubGlobal('MediaRecorder', Recorder);
        try {
            const track = Object.assign(new EventTarget(), { readyState: 'live' });
            const source = { archiveHd: true, stream: { getVideoTracks: () => [track] } };
            const result = await recordSegment(source, { kbps: 1200 }, 25, new AbortController().signal, Date.now);
            expect(result.codec).toBe('h264');
            expect(result.height).toBeGreaterThan(0);
            expect(attempts).toEqual(['video/mp4;codecs=hvc1', 'video/mp4;codecs=av01', 'video/mp4;codecs=avc1']);
            await recordSegment(source, { kbps: 1200 }, 20, new AbortController().signal, Date.now);
            expect(attempts.slice(3)).toEqual(['video/mp4;codecs=avc1']);
            const past = await recordSegment(source, { kbps: 1200 }, 20000, new AbortController().signal, Date.now, false, Date.now() - 1);
            expect(past).toBeNull();
            expect(attempts).toHaveLength(4);
        } finally { vi.unstubAllGlobals(); }
    });
    it('比赛时间更新时立即切段，延长后新段继续，提前结束会停止编码', () => {
        vi.useFakeTimers();
        try {
            const track = { getVideoTracks: () => [{ readyState: 'live' }] };
            const recorder = new CaptureRecorder({ uploadUrl: '', sources: () => ({screen: track}), send() {}, show() {} });
            recorder.settings = { archive: { enabled: true, screen: { preset: 'archiveHd', height: 720, fps: 24, kbps: 1200 } } };
            recorder.db = {};
            recorder.teamUid = 1;
            recorder.begin = Date.now() - 10000;
            recorder.end = Date.now() + 10000;
            recorder.recordLoop = vi.fn(() => new Promise(() => {}));
            recorder.sync();
            const first = recorder.loops.get('archive:screen');
            recorder.end += 10000;
            recorder.sync();
            const next = recorder.loops.get('archive:screen');
            expect(first.abort.signal.aborted).toBe(true);
            expect(next.abort.signal.aborted).toBe(false);
            recorder.end = Date.now() - 1;
            recorder.sync();
            expect(next.abort.signal.aborted).toBe(true);
            expect(recorder.loops.size).toBe(0);
        } finally { vi.useRealTimers(); }
    });
    it('档位自动降画质时仍受高清编码规则约束，持续故障仅停该路直至重新启用', async () => {
        vi.useFakeTimers();
        try {
            const track = { getVideoTracks: () => [{ readyState: 'live' }] };
            const recorder = new CaptureRecorder({ uploadUrl: '', sources: () => ({screen: track}), send() {}, show() {} });
            const quality = { preset: 'archiveHd', height: 720, fps: 24, kbps: 1500 };
            recorder.settings = { archive: { enabled: true, screen: quality }, autoDowngrade: true };
            recorder.db = {};
            recorder.teamUid = 1;
            recorder.backlogSeconds = 80;
            recorder.recordLoop = vi.fn(async () => { throw new ArchiveEncoderUnavailable('编码器启动失败'); });
            recorder.sync();
            await vi.advanceTimersByTimeAsync(0);
            expect(recorder.recordLoop.mock.calls[0][0]).toMatchObject({ archiveHd: true, quality: { preset: 'custom' } });
            recorder.sync();
            expect(recorder.recordLoop).toHaveBeenCalledTimes(1);
            expect(recorder.recordingError()).toContain('编码器启动失败');
            recorder.settings.archive.enabled = false;
            recorder.sync();
            expect(recorder.recordingError()).toBe('');
            recorder.settings.archive.enabled = true;
            recorder.sync();
            expect(recorder.recordLoop).toHaveBeenCalledTimes(2);
        } finally { vi.useRealTimers(); }
    });
});
