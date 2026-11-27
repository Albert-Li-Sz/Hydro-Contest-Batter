import type { Context, Tdoc } from 'hydrooj';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { applyAutoUnfreeze, unfreezeAt } from '../lib/auto-unfreeze';
import { defaultSettings, normalizeSettings } from '../lib/settings';
import { previewDatabase } from '../preview/resolver-memory-db';

const native = vi.hoisted(() => ({ get: vi.fn(), unlockScoreboard: vi.fn() }));
vi.mock('hydrooj', () => ({ ContestModel: native, ObjectId: String }));

const end = new Date('2026-11-21T06:00:00Z');
const at = (minutes: number) => new Date(end.getTime() + minutes * 60000);
const id = 'school/1234567890abcdef12345678';
const fixture = () => ({ domainId: 'school', docId: id.split('/')[1], rule: 'acm',
    lockAt: at(-60), endAt: end, unlocked: false } as unknown as Tdoc);
const disposers: (() => void)[] = [];

async function setup(minutes: number | null, initial = fixture()) {
    const db = previewDatabase().db;
    const settings = db.collection('xcpcio.enhanced.settings');
    await settings.insertOne({ _id: id, settings: normalizeSettings({ ...defaultSettings, autoUnfreezeMinutes: minutes }),
        updatedAt: new Date(), updatedBy: 1, unlockCheckAt: unfreezeAt(initial, minutes) });
    let contest = initial;
    native.get.mockImplementation(async () => contest);
    function worker() {
        const hooks = new Map<string, (doc: Tdoc) => Promise<void>>();
        const check = applyAutoUnfreeze({ db, on: (key: string, fn: (doc: Tdoc) => Promise<void>) => hooks.set(key, fn),
            effect: (setup: () => () => void) => disposers.push(setup()) } as unknown as Context);
        return { check, edit: async (patch: Partial<Tdoc>) => {
            contest = { ...contest, ...patch };
            await hooks.get('contest/edit')!(contest);
        } };
    }
    return { settings, worker };
}

describe('automatic scoreboard unfreeze', () => {
    beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(at(5)); vi.resetAllMocks(); });
    afterEach(() => { disposers.splice(0).forEach(dispose => dispose()); vi.useRealTimers(); });

    it('only claims the due contest once across two Hydro workers and clears its schedule on native unlock', async () => {
        const { settings, worker } = await setup(5);
        const first = worker();
        const second = worker();
        native.unlockScoreboard.mockImplementation(async () => first.edit({ unlocked: true }));
        await first.check(at(4));
        expect(native.unlockScoreboard).not.toHaveBeenCalled();
        await Promise.all([first.check(), second.check()]);
        await second.check(at(10));
        expect(native.unlockScoreboard).toHaveBeenCalledTimes(1);
        expect(String(native.unlockScoreboard.mock.calls[0][1])).toBe(id.split('/')[1]);
        expect(native.unlockScoreboard.mock.calls[0][0]).toBe('school');
        expect(await settings.findOne({ _id: id })).toMatchObject({ unlockCheckAt: null });
    });

    it('uses the edited end time and rechecks the current native contest before unlocking', async () => {
        const { settings, worker } = await setup(0);
        const a = worker();
        await a.edit({ endAt: at(25) });
        expect((await settings.findOne({ _id: id }))?.unlockCheckAt).toEqual(at(25));
        await a.check();
        expect(native.unlockScoreboard).not.toHaveBeenCalled();
        // An extension is visible in Hydro before another process finishes the schedule update.
        native.get.mockResolvedValue({ ...fixture(), endAt: at(40) });
        await a.check(at(25));
        expect(native.unlockScoreboard).not.toHaveBeenCalled();
        expect((await settings.findOne({ _id: id }))?.unlockCheckAt).toEqual(at(40));
        vi.setSystemTime(at(40));
        await a.check();
        expect(native.unlockScoreboard).toHaveBeenCalledTimes(1);
    });

    it('retries a transient failure after the worker lease expires and respects a manual unlock', async () => {
        const { worker } = await setup(0);
        const a = worker(), b = worker();
        native.get.mockRejectedValueOnce(new Error('unavailable'));
        await a.check();
        await b.check();
        expect(native.get).toHaveBeenCalledTimes(1);
        vi.setSystemTime(at(7));
        await b.check();
        expect(native.unlockScoreboard).toHaveBeenCalledTimes(1);
        await a.edit({ unlocked: true });
        await a.check(at(90));
        expect(native.unlockScoreboard).toHaveBeenCalledTimes(1);
    });

    it('leaves disabled, manually unlocked, non-ACM and unfrozen contests unscheduled', async () => {
        expect(normalizeSettings({ ...defaultSettings, autoUnfreezeMinutes: undefined }).autoUnfreezeMinutes).toBeNull();
        for (const value of [-1, 0.5, '3', Infinity]) expect(() => normalizeSettings({ ...defaultSettings, autoUnfreezeMinutes: value })).toThrow();
        const contest = fixture();
        expect(unfreezeAt(contest, 0)).toEqual(end);
        for (const doc of [{ ...contest, lockAt: undefined }, { ...contest, rule: 'oi' }, { ...contest, unlocked: true }]) {
            expect(unfreezeAt(doc, 1)).toBeNull();
        }
        const { worker } = await setup(null);
        await worker().check();
        expect(native.get).not.toHaveBeenCalled();
    });
});
