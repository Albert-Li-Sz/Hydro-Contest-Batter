import { describe, it, expect } from 'vitest';
// Browser-native ES modules. The same functions choose actual IndexedDB jobs in a capture tab.
// @ts-ignore JavaScript browser module
import { evictedSegments, nextUpload, segmentsFor } from '../resolver/public/js/hydro-recording-buffer.js';
// @ts-ignore JavaScript browser module
import { selectMime } from '../resolver/public/js/hydro-recording-media.js';

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
