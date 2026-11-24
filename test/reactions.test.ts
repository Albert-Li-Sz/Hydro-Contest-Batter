import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    canPublish,
    defaultLayouts,
    defaultReactionPublic,
    layoutsAt,
    layoutWarnings,
    matchesLayout,
    needsRender,
    normalizeLayout,
    publicSettings,
} from '../lib/reactions';
import { defaultSettings } from '../lib/settings';
import { proxyReactionMedia } from '../lib/reaction-media';
import type { Handler } from 'hydrooj';

const [portrait, landscape] = defaultLayouts();
const base = { state: 'ready', hidden: null, accepted: true, firstSolve: true, submittedAt: 3000, layout: portrait };
const contest = { title: 'ACM', beginAt: new Date(1000), endAt: new Date(8000), lockAt: new Date(6000), unlocked: false };
const live = { ...defaultReactionPublic, enabled: true, timing: 'live' as const };
describe('renderer layouts and task generations', () => {
    it('validates all three predefined geometries and bounds custom canvases, element count and local assets', () => {
        for (const layout of [portrait, landscape, { ...portrait, canvas: { width: 1080, height: 1080 } }])
            expect(normalizeLayout(layout, layout.id, 1)).toEqual(layout);
        for (const change of [
            { canvas: { width: 1000, height: 1000 } },
            { canvas: { width: 3841, height: 16 } },
            { applies: {} },
            { items: [...portrait.items, ...portrait.items] },
            { items: [{ ...portrait.items[0], props: { image: 'http://external/image' } }] },
            { background: { ...portrait.background, image: '../a.png' } },
        ]) {
            expect(() => normalizeLayout({ ...portrait, ...change }, 'custom', 1)).toThrow();
        }
    });
    it('detects composite occlusion and only rejects out-of-bounds nvidia_full geometry', () => {
        const item = { ...portrait.items[0], x: 0, y: 0, width: 100, height: 100, z: 0 };
        const a = { ...item, id: 'card', kind: 'card' as const, width: 50, z: 1 };
        const b = { ...item, id: 'screen', kind: 'screen' as const, fit: 'cover' as const, x: 50, width: 50, z: 2 };
        expect(layoutWarnings({ ...portrait, items: [item, a, b] })).toContain('webcam 完全被遮挡');
        expect(layoutWarnings({ ...portrait, items: [item, a, { ...b, x: 51 }] })).toEqual([]);
        expect(() => layoutWarnings({ ...portrait, items: [{ ...item, x: -1 }] }, true)).toThrow('nvidia_full');
    });
    it('keeps existing and future-only snapshots distinct and deliberately backfills the chosen revision', () => {
        const history = [
            { effectiveAt: 0, layout: portrait },
            { effectiveAt: 10, layout: { ...portrait, revision: 2 } },
            { effectiveAt: 0, layout: landscape },
        ];
        expect(layoutsAt(history, 9).map((l) => l.revision)).toEqual([1, 1]);
        expect(layoutsAt(history, 10).map((l) => l.revision)).toEqual([2, 1]);
        expect(layoutsAt([...history, { effectiveAt: 0, layout: { ...portrait, revision: 3 } }], 9)[0].revision).toBe(3);
    });
    it('rejudges and first-to-solve changes invalidate an old product while unchanged and deleted generations stay settled', () => {
        const old = { state: 'ready', layoutRevision: 1, verdict: 'AC', firstSolve: true };
        expect(needsRender(old, 'AC', true, 1)).toBe(false);
        for (const [verdict, first, revision] of [
            ['AC', false, 1],
            ['WA', false, 1],
            ['AC', true, 2],
        ] as const)
            expect(needsRender(old, verdict, first, revision)).toBe(true);
        expect(needsRender({ ...old, state: 'removed' }, 'WA', false, 1)).toBe(false);
        expect(matchesLayout({ ...portrait, applies: ['first'] }, true, false)).toBe(false);
        expect(matchesLayout({ ...portrait, applies: ['accepted'] }, true, true)).toBe(true);
    });
});
describe('identical audience policy for listings and direct media', () => {
    it('requires explicit publication, and independently gates freeze, end and unfreeze', () => {
        expect(canPublish(base, defaultReactionPublic, contest, defaultSettings, true, 20000)).toBe(false);
        const unlock = { ...defaultReactionPublic, enabled: true },
            end = { ...unlock, timing: 'end' as const };
        expect(canPublish(base, unlock, contest, defaultSettings, true, 8000)).toBe(false);
        expect(canPublish(base, unlock, { ...contest, unlocked: true }, defaultSettings, true, 8000)).toBe(true);
        expect(canPublish(base, end, contest, defaultSettings, true, 7999)).toBe(false);
        expect(canPublish(base, end, contest, defaultSettings, true, 8000)).toBe(true);
        expect(canPublish({ ...base, submittedAt: 6001 }, end, contest, defaultSettings, true, 8000)).toBe(false);
        expect(canPublish({ ...base, submittedAt: 6000 }, live, contest, defaultSettings, true, 7000)).toBe(true);
    });
    it('withholds hidden or stale videos, non-matching scopes and CCPC hidden columns', () => {
        for (const v of [
            { ...base, hidden: {} },
            { ...base, state: 'stale' },
            { ...base, firstSolve: false },
            { ...base, layout: landscape },
        ])
            expect(canPublish(v, live, contest, defaultSettings, true, 4000)).toBe(false);
        expect(
            canPublish(base, live, contest, { ...defaultSettings, ccpcBoard: { ...defaultSettings.ccpcBoard, enabled: true } }, true, 4000),
        ).toBe(false);
    });
    it('tests privacy against the rendered layout snapshot, including private information inside the MP4', () => {
        const policy = { ...live, layoutId: landscape.id, screen: 'capture' as const };
        expect(canPublish({ ...base, layout: landscape }, policy, contest, defaultSettings, false, 4500)).toBe(false);
        expect(canPublish({ ...base, layout: landscape }, policy, contest, defaultSettings, true, 4500)).toBe(true);
        for (const f of ['school', 'logo'])
            expect(
                canPublish(
                    { ...base, layout: { ...portrait, card: { ...portrait.card, fields: [f] } } },
                    { ...live, school: 'hide' },
                    contest,
                    defaultSettings,
                    true,
                    4500,
                ),
            ).toBe(false);
        expect(() => publicSettings({ layoutId: '../x' }, live)).toThrow();
    });
});
describe('public S3 range proxy', () => {
    afterEach(() => vi.unstubAllGlobals());
    function handler(range?: string) {
        const headers = new Map<string, string>(),
            response = { addHeader: (k: string, v: string) => headers.set(k, v), body: null, status: 0 };
        return { headers, response, h: { response, request: { headers: { range } } } as unknown as Handler };
    }
    it('forwards a byte range and streams the body without exposing a signed URL', async () => {
        const fn = vi.fn(async () => new Response(new Uint8Array([1, 2]), { status: 206, headers: { 'Content-Range': 'bytes 2-3/5' } }));
        vi.stubGlobal('fetch', fn);
        const { h, headers, response } = handler('bytes=2-3');
        await proxyReactionMedia(h, 5, async () => 'https://storage.test/private?signature=secret');
        expect(fn.mock.calls[0]).toEqual([
            'https://storage.test/private?signature=secret',
            { redirect: 'error', headers: { Range: 'bytes=2-3' } },
        ]);
        expect(headers.get('Cache-Control')).toContain('no-store');
        expect(headers.has('Location')).toBe(false);
        expect(response.status).toBe(206);
        const chunks = [];
        for await (const chunk of h.response.body) chunks.push(chunk);
        expect([...Buffer.concat(chunks)]).toEqual([1, 2]);
    });
    it('rejects impossible ranges without requesting storage, and fails closed on a bad upstream range', async () => {
        let state = handler('bytes=100-');
        const getUrl = vi.fn(async () => 'https://storage.test/x');
        await proxyReactionMedia(state.h, 5, getUrl);
        expect(getUrl).not.toHaveBeenCalled();
        expect(state.response.status).toBe(416);
        vi.stubGlobal('fetch', async () => new Response('all bytes', { status: 200 }));
        state = handler('bytes=0-1');
        await expect(proxyReactionMedia(state.h, 5, getUrl)).rejects.toThrow('存储读取失败');
    });
});
