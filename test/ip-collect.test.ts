import { describe, expect, it, vi } from 'vitest';
import { bindCollectedIp, collectDeadline, collectionAddress, collectOpen, collectSettings, type CollectedIp } from '../lib/ip-collect';
import { previewDatabase } from '../preview/resolver-memory-db';

const begin = new Date('2026-11-28T01:00:00Z'), cutoff = collectDeadline(begin);
const open = collectSettings(true, '10.0.16.0/20,2001:db8:1::/64', begin, cutoff - 1);

describe('contest IP collection', () => {
    it('requires a valid explicit network and enforces IPv4 and IPv6 ranges', () => {
        for (const value of ['', '10.0.0.1/33', '10.0.0', '::/hello', '10.0.0.1/', '0.0.0.0/0']) {
            expect(() => collectSettings(true, value, begin, cutoff - 1)).toThrow();
        }
        expect(collectionAddress(open, begin, '::ffff:10.0.31.254', cutoff - 1)).toBe('10.0.31.254');
        expect(collectionAddress(open, begin, '2001:db8:1::5', cutoff - 1)).toBe('2001:db8:1::5');
        for (const remote of ['10.0.32.1', '2001:db8:2::1', 'bad']) expect(() => collectionAddress(open, begin, remote, cutoff - 1)).toThrow('允许');
    });

    it('closes exactly ten minutes before the start, including after a schedule change or manual shutdown', () => {
        expect(collectOpen(open, begin, cutoff - 1)).toBe(true);
        expect(collectOpen(open, begin, cutoff)).toBe(false);
        expect(collectOpen(open, new Date(+begin - 60000), cutoff - 1)).toBe(false);
        expect(collectOpen({ ...open, enabled: false }, begin, cutoff - 1)).toBe(false);
        expect(() => collectSettings(true, '10.0.0.0/8', begin, cutoff)).toThrow('截止');
    });

    it('reassigns only this contest’s collected bindings and preserves manual, changed and other-contest records', async () => {
        const store = previewDatabase().db.collection('iplogin' as never) as any;
        const ip = '10.0.16.3', key = 'system/contest';
        await bindCollectedIp(store, key, ip, 123);
        await bindCollectedIp(store, key, ip, 124);
        await bindCollectedIp(store, key, ip, 124);
        expect((await store.findOne({ _id: ip })).uid).toBe(124);
        await expect(bindCollectedIp(store, 'another/contest', ip, 123)).rejects.toThrow('已有');
        await store.updateOne({ _id: ip }, { $set: { uid: 200 } });
        await expect(bindCollectedIp(store, key, ip, 123)).rejects.toThrow('已有');
        await store.insertOne({ _id: '10.0.16.4', uid: 300 });
        await bindCollectedIp(store, key, '10.0.16.4', 300);
        await expect(bindCollectedIp(store, key, '10.0.16.4', 123)).rejects.toThrow('已有');
        expect(await store.findOne({ _id: '10.0.16.4' })).toEqual({ _id: '10.0.16.4', uid: 300 });
    });

    it('keeps a manual mapping written between the collection read and insert or update', async () => {
        const manual = { _id: '10.0.16.3', uid: 8 };
        for (const prior of [null, { ...manual, uid: 9, xcpcioCollect: { contest: 'c', uid: 9 } }]) {
            const store = {
                findOne: vi.fn<() => Promise<CollectedIp | null>>().mockResolvedValueOnce(prior).mockResolvedValue(manual),
                insertOne: vi.fn().mockRejectedValue(Object.assign(new Error('duplicate'), { code: 11000 })),
                updateOne: vi.fn().mockResolvedValue({ matchedCount: 0 }),
            };
            await expect(bindCollectedIp(store, 'c', manual._id, 10)).rejects.toThrow('已有');
            expect(store.findOne).toHaveBeenCalledTimes(2);
        }
    });
});
