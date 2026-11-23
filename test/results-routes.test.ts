import type { Context, Tdoc } from 'hydrooj';
import { describe, expect, it, vi } from 'vitest';
import { applyResults } from '../lib/results-routes';
import { ResultsStore, resultKey } from '../lib/results-store';
import { defaultSettings } from '../lib/settings';
import { previewDatabase } from '../preview/resolver-memory-db';
import { demoData } from './fixture';

const { getContest } = vi.hoisted(() => ({ getContest: vi.fn() }));
vi.mock('hydrooj', () => ({
    ContestModel: { get: getContest }, DocumentModel: { TYPE_CONTEST: 30 },
    Handler: class {}, NotFoundError: Error, ValidationError: Error, ObjectId: String,
    param: () => () => {}, Types: {}, PERM: {}, PRIV: {}, StorageService: {},
}));

describe('automatic results snapshots', () => {
    it('loads a full contest after scanning IDs, deduplicates the end snapshot and skips an extended contest', async () => {
        const now = Date.now();
        const endAt = new Date(now - 5000);
        const db = previewDatabase().db;
        const scope = { domainId: 'system', contestId: '1' };
        const tdoc = {
            ...scope, docId: '1', docType: 30, rule: 'acm', beginAt: new Date(now - 10000), endAt,
            title: '比赛', pids: [101, 102, 103], allowTeam: true, balloon: { 101: 'red' },
        } as unknown as Tdoc;
        await db.collection('document').insertOne({ _id: '1', domainId: 'system', docId: '1', rule: 'acm', docType: 30, endAt } as never);
        await db.collection('document').insertOne({ _id: '2', domainId: 'system', docId: '2', rule: 'acm', docType: 30, endAt } as never);
        getContest.mockImplementation(async (_domainId, id) => id === '1' ? tdoc : { ...tdoc, docId: '2', endAt: new Date(now + 2000) });

        const hooks = new Map<string, () => Promise<void>>();
        const ctx = {
            db: { collection: (name: never) => ({ ...db.collection(name), distinct: async () => [] }) },
            Route: vi.fn(), i18n: { load: vi.fn() }, interval: vi.fn(),
            on: (event: string, fn: () => Promise<void>) => { hooks.set(event, fn); },
        } as unknown as Context;
        const loadData = vi.fn(async (doc: Tdoc) => {
            expect(doc).toBe(tdoc);
            return demoData();
        });
        applyResults(ctx, { loadData, loadSettings: async () => defaultSettings, statusOf: () => '' });
        await hooks.get('app/started')!();

        expect(loadData).toHaveBeenCalledExactlyOnceWith(tdoc, true, true, true);
        const store = new ResultsStore(db);
        const saved = await store.list(scope);
        expect(saved).toHaveLength(1);
        expect(saved[0]).toMatchObject({ reason: 'end', eventAt: endAt });
        expect((await store.read(scope, resultKey(scope, `end-${endAt.getTime()}`)))?.problemIds).toEqual(tdoc.pids);
        expect(await store.list({ ...scope, contestId: '2' })).toHaveLength(0);
        await hooks.get('app/started')!();
        expect(loadData).toHaveBeenCalledTimes(1);
    });
});
