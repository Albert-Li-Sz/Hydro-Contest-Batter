import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { demoData } from './fixture';
import { awardsFor, defaultSettings } from '../lib/settings';
import { defaultResolverConfig, parseResolverConfig, prepareResolver, resolverBoards } from '../lib/resolver-data';
import { computeCells } from '../resolver/server/lib/engine.js';
import { ResolverSessions, resolverChunkBytes } from '../lib/resolver-sessions';
import { previewDatabase } from '../preview/resolver-memory-db';

it('keeps the bundled school crest at source resolution for award presentations', () => {
    const registry = JSON.parse(readFileSync(new URL('../logos/index.json', import.meta.url), 'utf8'));
    expect(registry.resolution).toBe('original');
    const id = registry.names['南京晓庄学院'];
    const image = readFileSync(new URL(`../logos/${id}.webp`, import.meta.url));
    // This registry source is a lossless 1024px WebP. Guard against the old
    // asset pipeline silently shrinking it to a 96px thumbnail again.
    expect(image.subarray(12, 16).toString()).toBe('VP8L');
    const dimensions = image.readUInt32LE(21);
    expect((dimensions & 0x3fff) + 1).toBeGreaterThanOrEqual(1024);
    expect(((dimensions >>> 14) & 0x3fff) + 1).toBeGreaterThanOrEqual(1024);
    const hash = createHash('sha256').update(image).digest('hex');
    expect(hash).toBe(registry.images[id].sourceSha256);
    expect(hash).toBe(registry.images[id].sha256);
});

const settings = {
    ...defaultSettings, showIdentity: true, schoolBoards: true, participationBoards: true, firstSolve: true,
    manualBoards: [{ id: 'mixed', name: '混合榜', teamIds: ['1', '4', '7'], medals: { gold: 2, silver: 0, bronze: 1 } }],
};
const context = { contestId: 'contest-a', ended: true, capturedAt: new Date('2026-11-14T00:00:00Z'), logoNames: {} };
const config = { ...defaultResolverConfig(settings, true), freezeMode: 'custom' as const, freezeAtSeconds: 2000 };
function prepare(overrides = {}, data = demoData(), env = context) {
    return prepareResolver(data, resolverBoards(data, settings, true), { ...config, ...overrides }, env);
}

describe('Resolver Hydro data adapter', () => {
    it('retains only selected members and preserves starred identity', () => {
        const payload = prepare({ boardId: 'manual-mixed' });
        expect(payload.snapshot.teams.map((team) => team.id)).toEqual(['1', '4', '7']);
        expect(payload.snapshot.teams.find((team) => team.id === '4')?.unrank).toBe(true);
        expect(payload.snapshot.submissions.every((record) => ['1', '4', '7'].includes(record.teamId))).toBe(true);
    });
    it('keeps every team while only original official members of a board rank and receive awards', () => {
        const data = demoData();
        const before = structuredClone(data);
        const payload = prepare({ mode: 'official', boardId: 'manual-mixed', firstSolve: true, podiumEnabled: true }, data);
        expect(payload.snapshot.teams.filter((team) => !team.unrank).map((team) => team.id)).toEqual(['1', '7']);
        expect(payload.snapshot.teams).toHaveLength(8);
        const awards = payload.game.contest.awards as { teamIds: string[] }[];
        expect(awards.length).toBeGreaterThan(0);
        expect(awards.every((award) => award.teamIds.every((id) => ['1', '7'].includes(id)))).toBe(true);
        expect(data).toEqual(before);
    });
    it('preserves starred identity and formal ranks when first-solve eligibility is enabled', () => {
        const allowed = { ...settings, unofficialFirstSolve: true, podiumEnabled: true };
        const data = demoData();
        data.submissions.unshift({ submission_id: 'star-first', team_id: '4', problem_id: 1, timestamp: 1000, status: 'CORRECT' });
        const payload = prepareResolver(data, resolverBoards(data, allowed, true), config, context);
        expect(payload.snapshot.teams.find((team) => team.id === '4')?.unrank).toBe(true);
        expect(payload.overview.officialCount).toBe(6);
        expect(payload.game.contest.awards.filter((award: any) => award.teamIds.includes('4')).map((award: any) => award.awardType)).toEqual(['first-to-solve']);
        expect((computeCells(payload.snapshot).results['4'][1] as any).firstToSolve).toBe(true);
        const official = prepareResolver(data, resolverBoards(data, allowed, true), { ...config, mode: 'official', boardId: 'manual-mixed' }, context);
        expect(official.snapshot.teams.filter((team) => !team.unrank).map((team) => team.id)).toEqual(['1', '7']);
        expect(official.game.contest.awards.filter((award: any) => award.awardType !== 'first-to-solve').every((award: any) => award.teamIds.every((id: string) => ['1', '7'].includes(id)))).toBe(true);
    });
    it('marks every equal-time eligible first solve consistently with the award recipients', () => {
        const data = demoData();
        data.submissions = ['1', '4'].map((team_id) => ({ submission_id: team_id, team_id, problem_id: 0, timestamp: 1000, status: 'CORRECT' }));
        const shared = { ...settings, unofficialFirstSolve: true };
        const payload = prepareResolver(data, resolverBoards(data, shared, true), config, context);
        const cells = computeCells(payload.snapshot).results as Record<string, any[]>;
        expect(['1', '4'].every((id) => cells[id][0].firstToSolve)).toBe(true);
        expect((payload.game.contest.awards.find((award: any) => award.id === 'first-to-solve-0') as any).teamIds.sort()).toEqual(['1', '4']);
    });
    it('uses the chosen board rules for both modes and ignores stale per-session award overrides', () => {
        const rules = { ...awardsFor(settings, 'all'), medals: { gold: 0, silver: 1, bronze: 1 }, goldCitation: '特等奖',
            silverCitation: '优秀奖', medalSameScore: false, firstSolve: false, podiumEnabled: true, unofficialFirstSolve: true };
        const shared = { ...settings, boardAwards: { 'manual-mixed': rules } };
        for (const mode of ['board', 'official'] as const) {
            const payload = prepareResolver(demoData(), resolverBoards(demoData(), shared, true),
                { ...config, boardId: 'manual-mixed', mode, goldCount: 99, firstSolve: true }, context);
            expect(payload.config).toMatchObject({ goldCount: 0, silverCount: 1, goldCitation: '特等奖', silverCitation: '优秀奖', firstSolve: false, podiumEnabled: true, medalSameScore: false });
            expect(payload.game.contest.awards.some((award: any) => award.awardType === 'first-to-solve')).toBe(false);
            expect(Object.values(computeCells(payload.snapshot).results).flat().every((cell: any) => !cell.firstToSolve)).toBe(true);
        }
    });
    it('keeps first-solve eligibility fixed in a saved session', async () => {
        const { db } = previewDatabase(); const store = new ResolverSessions(db);
        const shared = { ...settings, unofficialFirstSolve: true };
        const data = demoData();
        data.submissions.unshift({ submission_id: 'star-first', team_id: '4', problem_id: 1, timestamp: 1000, status: 'CORRECT' });
        const payload = prepareResolver(data, resolverBoards(data, shared, true), config, context);
        const saved = await store.create({ domainId: 'test', contestId: 'contest-a', ownerId: 1 }, payload);
        shared.unofficialFirstSolve = false;
        expect((await store.read(saved)).snapshot.unofficialFirstSolve).toBe(true);
        expect(prepareResolver(data, resolverBoards(data, shared, true), config, context).snapshot.unofficialFirstSolve).toBe(false);
    });
    it('appends the school to the displayed name only when asked and known', () => {
        const shown = prepare().snapshot.teams;
        expect(shown.find((team) => team.id === '1')).toMatchObject({ name: '林澈', displayName: '林澈（南京晓庄学院）' });
        expect(shown.find((team) => team.id === '8')?.displayName).toBe('陆川');
        expect(prepare({ showSchool: false }).snapshot.teams.find((team) => team.id === '1')?.displayName).toBe('林澈');
    });
    it('reuses manual medals and hides school groups without identity access', () => {
        const boards = resolverBoards(demoData(), settings, false);
        expect(boards.find((board) => board.id === 'manual-mixed')?.medals).toEqual({ gold: 2, silver: 0, bronze: 1 });
        expect(boards.some((board) => board.id.startsWith('school-'))).toBe(false);
    });
    it('requires an explicit freeze point when the contest has none', () => {
        expect(() => prepare({ freezeMode: 'contest' })).toThrow('未设置封榜时间');
        expect(() => prepare({ freezeAtSeconds: 18000 })).toThrow('结束之前');
        expect(prepare({ freezeAtSeconds: 0 }).overview.freezeAtSeconds).toBe(0);
    });
    it('uses a contest freeze without changing its configuration', () => {
        const data = demoData();
        data.contest.frozen_time = 3600;
        expect(prepare({ freezeMode: 'contest' }, data).overview.freezeAtSeconds).toBe(14400);
        expect(data.contest.frozen_time).toBe(3600);
    });
    it('shows a submission exactly at freeze and hides all later verdicts, including CE', () => {
        const data = demoData();
        data.submissions = [
            { submission_id: 'a', team_id: '1', problem_id: 0, timestamp: 1999000, status: 'CORRECT' },
            { submission_id: 'b', team_id: '2', problem_id: 0, timestamp: 2000000, status: 'CORRECT' },
            { submission_id: 'c', team_id: '3', problem_id: 0, timestamp: 2001000, status: 'CORRECT' },
            { submission_id: 'd', team_id: '5', problem_id: 0, timestamp: 2001000, status: 'COMPILATION_ERROR' },
        ];
        const payload = prepare({}, data);
        const frozen = computeCells(payload.snapshot, { frozen: true });
        expect(frozen.results['1'][0].status).toBe('solved');
        expect(frozen.results['2'][0].status).toBe('solved');
        expect(frozen.results['3'][0].status).toBe('pending');
        expect(frozen.results['5'][0].status).toBe('pending');
        expect(payload.game.meta.pendingCount).toBe(2);
        expect(payload.game.steps.filter((step) => step.type === 'resolve').map((step) => step.teamId)).toEqual(expect.arrayContaining(['3', '5']));
    });
    it.each([
        ['WRONG_ANSWER', 1200], ['TIME_LIMIT_EXCEEDED', 1200], ['MEMORY_LIMIT_EXCEEDED', 1200],
        ['RUNTIME_ERROR', 1200], ['OUTPUT_LIMIT_EXCEEDED', 1200], ['JUDGEMENT_FAILED', 1200],
        ['REJECTED', 1200], ['HACKED', 1200], ['COMPILATION_ERROR', 0], ['PRESENTATION_ERROR', 0], ['CANCELED', 0],
    ])('maps %s penalty consistently with Hydro', (status, penalty) => {
        const data = demoData();
        data.submissions = [
            { submission_id: 'a', team_id: '1', problem_id: 0, timestamp: 1000, status },
            { submission_id: 'b', team_id: '1', problem_id: 0, timestamp: 121000, status: 'CORRECT' },
        ];
        const result = computeCells(prepare({}, data).snapshot).standings.find((team) => team.teamId === '1');
        expect(result?.timeSeconds).toBe(121 + penalty);
    });
    it('deduplicates rejudged IDs and excludes out-of-range submissions', () => {
        const data = demoData();
        const record = { submission_id: 'same', team_id: '1', problem_id: 0, timestamp: 120000, status: 'WRONG_ANSWER' };
        data.submissions = [record, { ...record, status: 'CORRECT' }, { ...record, submission_id: 'early', timestamp: -1 },
            { ...record, submission_id: 'late', timestamp: 18000000 }, { ...record, submission_id: 'other-problem', problem_id: 99 }];
        const snapshot = prepare({}, data).snapshot;
        expect(snapshot.submissions).toHaveLength(1);
        expect(computeCells(snapshot).standings[0].timeSeconds).toBe(120);
    });
    it('counts seconds and shares ranks without an ICPC last-solve tiebreak', () => {
        const data = demoData();
        data.submissions = [
            { submission_id: 'a', team_id: '1', problem_id: 0, timestamp: 100000, status: 'CORRECT' },
            { submission_id: 'b', team_id: '1', problem_id: 1, timestamp: 200000, status: 'CORRECT' },
            { submission_id: 'c', team_id: '2', problem_id: 0, timestamp: 140000, status: 'CORRECT' },
            { submission_id: 'd', team_id: '2', problem_id: 1, timestamp: 160000, status: 'CORRECT' },
        ];
        const payload = prepare({ goldCount: 1, silverCount: 0, bronzeCount: 0 }, data);
        expect(computeCells(payload.snapshot).standings.slice(0, 2).map((row) => row.rank)).toEqual([1, 1]);
        expect((payload.game.contest.awards[0] as { teamIds: string[] }).teamIds.sort()).toEqual(['1', '2']);
    });
    it('excludes zero-solve teams from medals and podium', () => {
        const payload = prepare({ goldCount: 100, podiumEnabled: true });
        expect((payload.game.contest.awards as { teamIds: string[] }[]).every((award) => !award.teamIds.includes('8'))).toBe(true);
    });
    it('rejects pending formal results, forces rehearsal while running and records ignored count', () => {
        const data = demoData();
        data.submissions.push({ submission_id: 'waiting', team_id: '1', problem_id: 1, timestamp: 2200000, status: 'PENDING' });
        expect(() => prepare({}, data)).toThrow('未完成评测');
        const payload = prepare({}, data, { ...context, ended: false });
        expect(payload.config.rehearsal).toBe(true);
        expect(payload.overview.unjudgedCount).toBe(1);
        expect(payload.game.meta.discardedUnjudged).toBe(1);
        expect(prepare({ rehearsal: true }, data).config.rehearsal).toBe(true);
    });
    it('never inserts external logo URLs', () => {
        const payload = prepare({}, demoData(), { ...context, logoNames: { '南京晓庄学院': '0123456789ab' } });
        expect(payload.snapshot.teams[0].logo).toBe('/hydro-resolver/logos/0123456789ab.webp');
        expect(payload.game.contest.teams[0].logo).toBe('/hydro-resolver/logos/0123456789ab.webp');
        expect(payload.game.contest.teams.every((team) => team.logo.startsWith('/hydro-resolver/'))).toBe(true);
    });
    it('rejects invalid config and stale/empty board selections', () => {
        expect(() => parseResolverConfig({ autoplay: 'true' }, config)).toThrow();
        expect(() => parseResolverConfig({ freezeAtSeconds: NaN }, config)).toThrow();
        expect(() => prepare({ boardId: 'deleted' })).toThrow('已不存在');
        expect(() => prepare({ mode: 'official' })).toThrow('请选择一个分榜');
    });
});

describe('Resolver persistent session contract', () => {
    const scope = { domainId: 'system', contestId: 'contest-a', ownerId: 1 };
    it('isolates administrators, contests, domains and multiple sessions of one administrator', async () => {
        const { db } = previewDatabase();
        const store = new ResolverSessions(db);
        const a = await store.create(scope, prepare());
        const b = await store.create({ ...scope, ownerId: 2 }, prepare());
        const c = await store.create(scope, prepare());
        expect(new Set([a._id, b._id, c._id]).size).toBe(3);
        expect((await store.list(scope)).map((row) => row.id).sort()).toEqual([a._id, c._id].sort());
        for (const changed of [{ ownerId: 2 }, { domainId: 'other' }, { contestId: 'other' }]) {
            await expect(store.get({ ...scope, ...changed }, a._id)).rejects.toThrow('不存在');
        }
        expect(() => store.checkToken(a, b.controlToken)).toThrow('令牌');
        expect(() => store.checkToken(a, undefined)).toThrow('令牌');
        expect(() => store.checkToken(a, a.controlToken)).not.toThrow();
        expect(JSON.stringify(await store.list(scope))).not.toContain(a.controlToken);
    });
    it('prunes sessions idle past the retention period together with their snapshot blocks', async () => {
        const { db, tables } = previewDatabase();
        const store = new ResolverSessions(db);
        const old = await store.create(scope, prepare());
        const fresh = await store.create({ ...scope, ownerId: 2 }, prepare());
        const day = 24 * 3600 * 1000;
        tables.get('xcpcio.resolver.sessions')!.get(old._id)!.updatedAt = new Date(Date.now() - 8 * day);
        expect(await store.prune(7 * day)).toBe(1);
        await expect(store.get(scope, old._id)).rejects.toThrow('不存在');
        expect([...tables.get('xcpcio.resolver.chunks')!.values()].every((block) => block.sessionId === fresh._id)).toBe(true);
        expect((await store.read(await store.get({ ...scope, ownerId: 2 }, fresh._id))).game.steps.length).toBeGreaterThan(0);
        // Opening a session counts as use and keeps it alive.
        tables.get('xcpcio.resolver.sessions')!.get(fresh._id)!.updatedAt = new Date(Date.now() - 6 * day);
        await store.get({ ...scope, ownerId: 2 }, fresh._id);
        expect(await store.prune(7 * day, Date.now() + 2 * day)).toBe(0);
    });
    it('keeps sessions indefinitely when automatic cleanup is disabled', async () => {
        const { db, tables } = previewDatabase();
        const store = new ResolverSessions(db);
        const session = await store.create(scope, prepare());
        tables.get('xcpcio.resolver.sessions')!.get(session._id)!.updatedAt = new Date(0);
        expect(await store.prune(0)).toBe(0);
        expect((await store.read(await store.get(scope, session._id))).game.steps.length).toBeGreaterThan(0);
    });
    it.each(['open', 'move'])('does not prune a session refreshed by a concurrent %s after the scan', async (operation) => {
        const { db, tables } = previewDatabase();
        const other = new ResolverSessions(db);
        const session = await other.create(scope, prepare());
        tables.get('xcpcio.resolver.sessions')!.get(session._id)!.updatedAt = new Date(0);
        const original = db.collection.bind(db);
        vi.spyOn(db, 'collection').mockImplementation(((name: string) => {
            const collection = original(name as never);
            if (name === 'xcpcio.resolver.sessions') {
                const find = collection.find.bind(collection);
                collection.find = ((filter: any) => {
                    const cursor = find(filter); const toArray = cursor.toArray.bind(cursor);
                    cursor.toArray = async () => {
                        const rows = await toArray();
                        if (operation === 'open') await other.get(scope, session._id);
                        else expect((await other.move(session, session.actions[1], 0)).status).toBe(200);
                        return rows;
                    };
                    return cursor;
                }) as typeof collection.find;
            }
            return collection;
        }) as unknown as typeof db.collection);
        expect(await new ResolverSessions(db).prune(86400000)).toBe(0);
        expect((await other.read(await other.get(scope, session._id))).game.steps.length).toBeGreaterThan(0);
    });
    it('rejects an open if cleanup has already claimed the session', async () => {
        const { db, tables } = previewDatabase();
        const cleaner = new ResolverSessions(db);
        const session = await cleaner.create(scope, prepare());
        tables.get('xcpcio.resolver.sessions')!.get(session._id)!.updatedAt = new Date(0);
        const original = db.collection.bind(db);
        vi.spyOn(db, 'collection').mockImplementation(((name: string) => {
            const collection = original(name as never);
            if (name === 'xcpcio.resolver.sessions') {
                const findOne = collection.findOne.bind(collection);
                collection.findOne = (async (filter: any) => {
                    const row = await findOne(filter);
                    expect(await cleaner.prune(86400000)).toBe(1);
                    return row;
                }) as typeof collection.findOne;
            }
            return collection;
        }) as unknown as typeof db.collection);
        await expect(new ResolverSessions(db).get(scope, session._id)).rejects.toThrow('正在删除');
    });
    it('retries an interrupted cleanup and preserves unfinished snapshot writes', async () => {
        const { db, tables } = previewDatabase();
        const store = new ResolverSessions(db);
        const session = await store.create(scope, prepare());
        const writing = await store.create(scope, prepare());
        const rows = tables.get('xcpcio.resolver.sessions')!;
        rows.get(session._id)!.updatedAt = new Date(0);
        Object.assign(rows.get(writing._id)!, { updatedAt: new Date(0), ready: false });
        vi.spyOn(store, 'remove').mockRejectedValueOnce(new Error('interrupted'));
        await expect(store.prune(86400000)).rejects.toThrow('interrupted');
        expect(rows.get(session._id)).toMatchObject({ ready: false, deleting: true });
        expect(await store.prune(86400000)).toBe(1);
        expect(rows.has(writing._id)).toBe(true);
        expect([...tables.get('xcpcio.resolver.chunks')!.values()].every((chunk) => chunk.sessionId === writing._id)).toBe(true);
    });
    it('persists an immutable copy and resumes through a fresh store instance', async () => {
        const { db } = previewDatabase();
        const first = new ResolverSessions(db);
        const payload = prepare();
        const session = await first.create(scope, payload);
        payload.snapshot.teams[0].name = 'changed';
        payload.game.steps.length = 0;
        const second = new ResolverSessions(db);
        const result = await second.move(await second.get(scope, session._id), session.actions[1], 0);
        expect(result.status).toBe(200);
        const resumed = await first.get(scope, session._id);
        expect(resumed.index).toBe(session.actions[1]);
        expect(resumed.revision).toBe(1);
        expect((await second.read(resumed)).snapshot.teams[0].name).not.toBe('changed');
        expect((await second.read(resumed)).game.steps.length).toBeGreaterThan(0);
    });
    it('only accepts one concurrent write per revision and returns current progress on conflict', async () => {
        const { db } = previewDatabase();
        const first = new ResolverSessions(db);
        const second = new ResolverSessions(db);
        const session = await first.create(scope, prepare());
        const results = await Promise.all([
            first.move(session, session.actions[1], 0), second.move(session, session.actions[2], 0),
        ]);
        expect(results.map((result) => result.status).sort()).toEqual([200, 409]);
        expect(results[1].playback).toEqual(results[0].playback);
        await expect(first.move(session, 999999, 1)).rejects.toThrow('步骤');
    });
    it('chunks oversized UTF-8 snapshots, reconstructs them and removes all blocks', async () => {
        const { db, tables } = previewDatabase();
        const store = new ResolverSessions(db);
        const payload = prepare();
        payload.snapshot.name = '中文'.repeat(resolverChunkBytes);
        const session = await store.create(scope, payload);
        expect(session.chunks).toBeGreaterThan(4);
        const blocks = [...tables.get('xcpcio.resolver.chunks')!.values()];
        expect(blocks.every((block) => Buffer.byteLength(block.data) <= 4 * 1024 * 1024)).toBe(true);
        expect((await store.read(session)).snapshot.name).toBe(payload.snapshot.name);
        await store.remove(session);
        expect(tables.get('xcpcio.resolver.chunks')!.size).toBe(0);
        expect(await store.list(scope)).toEqual([]);
    });
    it('cleans up partial creation when a chunk write fails', async () => {
        const { db, tables } = previewDatabase();
        const original = db.collection.bind(db);
        vi.spyOn(db, 'collection').mockImplementation(((name: string) => {
            const collection = original(name as never);
            if (name === 'xcpcio.resolver.chunks') collection.insertOne = vi.fn().mockRejectedValue(new Error('write failed'));
            return collection;
        }) as unknown as typeof db.collection);
        const store = new ResolverSessions(db);
        await expect(store.create(scope, prepare())).rejects.toThrow('write failed');
        expect(tables.get('xcpcio.resolver.sessions')!.size).toBe(0);
        expect(tables.get('xcpcio.resolver.chunks')!.size).toBe(0);
    });
    it('allows the owner to retry an interrupted deletion while playback stays closed', async () => {
        const { db, tables } = previewDatabase();
        const original = db.collection.bind(db);
        let fail = true;
        vi.spyOn(db, 'collection').mockImplementation(((name: string) => {
            const collection = original(name as never);
            if (name === 'xcpcio.resolver.chunks') {
                const remove = collection.deleteMany.bind(collection);
                collection.deleteMany = vi.fn(async (...args: any[]) => {
                    if (fail) throw new Error('delete failed');
                    return remove(...args);
                });
            }
            return collection;
        }) as unknown as typeof db.collection);
        const store = new ResolverSessions(db);
        const session = await store.create(scope, prepare());
        await expect(store.remove(session)).rejects.toThrow('delete failed');
        await expect(store.get(scope, session._id)).rejects.toThrow('删除');
        expect(await store.list(scope)).toHaveLength(1);
        fail = false;
        await store.remove(await store.get(scope, session._id, true));
        expect([...tables.values()].every((table) => table.size === 0)).toBe(true);
    });
});

it('matches every recorded modified upstream file hash', () => {
    const manifest = JSON.parse(readFileSync(new URL('../resolver/UPSTREAM.json', import.meta.url), 'utf8'));
    for (const entry of manifest.files) {
        const bytes = readFileSync(new URL(`../${entry.destination}`, import.meta.url));
        expect(createHash('sha256').update(bytes).digest('hex'), entry.destination).toBe(entry.modifiedSha256);
    }
});

import { matchPhoto } from '../resolver/public/js/photo-matching.js';
import { actionIndicesFor, awardStops, nextAwardStop, confirmPrevious } from '../resolver/public/js/playback-model.js';
import { usableAsset } from '../resolver/server/lib/engine.js';
import { decodeTeamPhoto, ResolverPhotos, photoUrl } from '../lib/resolver-photos';

describe('队伍照片和主持控制', () => {
    const teams = [{ uid: '-3', name: '星河', account: 'Team.One' }, { uid: '2', name: '星河', account: 'ABC' }];
    it('matches account, uid and unique names after normalization, and leaves ambiguity for the operator', () => {
        expect(matchPhoto('ＴＥＡＭ．ＯＮＥ.JPG', teams)).toBe('-3');
        expect(matchPhoto('－３.webp', teams)).toBe('-3');
        expect(matchPhoto('星河.png', teams)).toBeNull();
        expect(matchPhoto('星河.png', teams.slice(1))).toBe('2');
        expect(matchPhoto('none.jpg', teams)).toBeNull();
    });
    it('accepts precisely the contest-scoped photo capability path and snapshots it', async () => {
        const base = '/d/system/contest/0123456789abcdef01234567/resolver';
        const link = photoUrl(base, 'a'.repeat(32));
        expect(usableAsset(link)).toBe(link);
        for (const path of [link + '?next=x', link + '/x', link.replace('.jpg', '.svg'), link.replace('/system/', '/../'), link.replace('system', '%2e%2e'), link.replace('system', 'a%2Fb'), link.replace('photos/', 'images/')]) {
            expect(usableAsset(path)).toBeNull();
        }
        const file = readFileSync(new URL('../logos/' + JSON.parse(readFileSync(new URL('../logos/index.json', import.meta.url), 'utf8')).names['南京晓庄学院'] + '.webp', import.meta.url)).toString('base64');
        expect(decodeTeamPhoto(file)).toMatchObject({ width: 1024, height: 1024, mime: 'image/webp' });
        expect(() => decodeTeamPhoto(Buffer.from('not a photo').toString('base64'))).toThrow();
        const store = new ResolverPhotos(previewDatabase().db);
        await store.ensureIndexes();
        const id = await store.put('s/c', '1', file, 4);
        const payload = prepareResolver(demoData(), resolverBoards(demoData(), settings, true), config,
            { ...context, photos: await store.urls('s/c', base) });
        expect(payload.game.contest.teams.find(t => t.id === '1')?.photo).toBe(photoUrl(base, id));
        expect(await store.get('other/c', id)).toBeNull();
        await store.rotate('s/c');
        expect(await store.get('s/c', id)).toBeNull();
        expect((await store.urls('s/c', base))['1']).not.toEqual(payload.snapshot.teams[0].photo);
        await store.delete('s/c', '1'); expect(await store.urls('s/c', base)).toEqual({});
    });
    it.each(['retire', 'publish'])('recovers a photo replacement interrupted at %s on a new store instance', async phase => {
        const { db } = previewDatabase();
        const file = readFileSync(new URL('../logos/' + JSON.parse(readFileSync(new URL('../logos/index.json', import.meta.url), 'utf8')).names['南京晓庄学院'] + '.webp', import.meta.url));
        const first = new ResolverPhotos(db);
        const previous = await first.put('s/c', '-1', file.toString('base64'), 1);
        const collection = db.collection('xcpcio.resolver.photos');
        const update = collection.updateOne.bind(collection);
        vi.spyOn(collection, 'updateOne').mockImplementation(((filter: any, ...args: any[]) => {
            if (phase === 'publish' ? filter.staged : filter.uid === '-1') throw new Error('connection interrupted');
            return (update as Function)(filter, ...args);
        }) as typeof collection.updateOne);
        const failing = new ResolverPhotos({ collection: () => collection } as any);
        await expect(failing.put('s/c', '-1', file.toString('base64'), 2)).rejects.toThrow('interrupted');
        if (phase === 'publish') expect(await first.get('s/c', previous)).toBeNull();
        const restarted = new ResolverPhotos(db);
        const url = (await restarted.urls('s/c', '/resolver'))['-1'];
        const id = url.split('/').pop()!.slice(0, -4);
        expect(await restarted.get('s/c', previous)).toBeNull();
        expect(await restarted.get('s/c', id)).toMatchObject({ uid: '-1', updatedBy: 2 });
        expect(await restarted.status('s/c')).toMatchObject({ count: 1 });
        expect(await collection.countDocuments({ contestKey: 's/c' })).toBe(1);
    });
    it('stops on the previous visible action in reveal order, omitting setup and non-tier awards', () => {
        const game = prepare().game;
        game.contest.awards = [{ id: 'bronze-medal', teamIds: ['b', 'c'] }, { id: 'high-honors', teamIds: ['h'] },
            { id: 'first-solve-a', teamIds: ['x'] }, { id: 'silver-medal', teamIds: ['s'] }, { id: 'winner', teamIds: ['s'] }];
        game.steps = [{ type: 'presentation', screen: 'scoreboard' }, { type: 'selectTeam', role: 'setup', teamIds: ['b'] },
            ...['x', 'h', 'b', 'c', 's'].flatMap(id => [{ type: 'scroll' }, { type: 'delay' }, { type: 'selectTeam', teamIds: [id] }])];
        const actions = actionIndicesFor(game.steps);
        expect(awardStops(game)).toEqual([5, 8, 14]);
        expect(nextAwardStop(game, actions, actions.indexOf(5))).toBe(8);
        expect(nextAwardStop(game, actions, actions.indexOf(14))).toBeNull();
        expect(confirmPrevious(null, 0)).toBe(false);
        expect(confirmPrevious(0, 1500)).toBe(true);
        expect(confirmPrevious(20, 1521)).toBe(false);
    });
});

import { teamJump, hasRows } from '../resolver/public/js/playback-model.js';
import { cropBox } from '../resolver/public/js/image-upload.js';

describe('奖区边界与按队跳转', () => {
    const real = () => prepare({ freezeAtSeconds: 2000 }).game;
    const rowsOf = (game: ReturnType<typeof real>) => game.steps.map((step, index) => ({ step, index }))
        .filter(({ step }) => step.type === 'selectTeam' && Number.isInteger(step.row));
    it('stops each award zone before the cursor first reaches its lowest row, with every lower row resolved', () => {
        const game = real();
        const actions = actionIndicesFor(game.steps);
        const rows = rowsOf(game);
        const stops = awardStops(game);
        expect(stops.length).toBeGreaterThan(1);
        for (const stop of stops) {
            const next = game.steps[actions[actions.indexOf(stop) + 1]];
            expect(next).toMatchObject({ type: 'selectTeam', selectType: 'NORMAL' });
            const row = next.row as number;
            // The cursor had not reached this row before the stop, and it is the lowest row of some award zone.
            expect(rows.filter(({ index }) => index <= stop).every(({ step }) => (step.row as number) > row)).toBe(true);
            const finals = rows.filter(({ step }) => step.selectType !== 'NORMAL').map(({ step }) => ({ team: (step.teamIds as string[])[0], row: step.row as number }));
            const awards = game.contest.awards as { id: string; teamIds: string[] }[];
            const zone = awards.filter(a => /medal|winner|honors|podium|rank/.test(a.id))
                .some(a => Math.max(...finals.filter(f => a.teamIds.includes(f.team)).map(f => f.row)) === row);
            expect(zone).toBe(true);
        }
        // A medal team selected low before climbing no longer places its tier's stop inside a lower zone.
        expect(new Set(stops).size).toBe(stops.length);
        expect([...stops].sort((a, b) => a - b)).toEqual(stops);
    });
    it('keeps the 2.0.0 rule for sessions without rows', () => {
        const game = real();
        game.steps = game.steps.map(({ row: _row, ...step }) => step);
        expect(hasRows(game)).toBe(false);
        expect(awardStops(game).length).toBeGreaterThan(0);
        expect(teamJump(game, actionIndicesFor(game.steps), 0, 10)).toBeNull();
    });
    it('jumps ten rows forward short of the top row, and back to where the cursor was', () => {
        const game = real();
        const actions = actionIndicesFor(game.steps);
        const rows = rowsOf(game).filter(({ step }) => step.selectType === 'NORMAL');
        const top = rows.find(({ step }) => step.row === 0)!.index;
        // Fewer than ten rows: forward stops before the top row is selected.
        expect(teamJump(game, actions, 0, 10)).toBe(actions[actions.indexOf(top) - 1]);
        expect(teamJump(game, actions, actions.indexOf(actions[actions.indexOf(top) - 1]), 10)).toBeNull();
        const two = teamJump(game, actions, 0, 2)!;
        const next = game.steps[actions[actions.indexOf(two) + 1]];
        expect(next.row).toBe((rows[0].step.row as number) + 1 - 2);
        const end = actions.length - 1;
        const back = teamJump(game, actions, end, -2)!;
        expect(game.steps[actions[actions.indexOf(back) + 1]]).toMatchObject({ type: 'selectTeam', row: 2 });
        expect(teamJump(game, actions, 0, -10)).toBeNull();
    });
    it('frames a 4:3 crop on the focus, clamped to the picture', () => {
        expect(cropBox(1600, 1200, 4 / 3)).toEqual({ x: 0, y: 0, width: 1600, height: 1200 });
        expect(cropBox(2000, 1000, 4 / 3)).toMatchObject({ y: 0, height: 1000, width: 4000 / 3 });
        expect(cropBox(2000, 1000, 4 / 3).x).toBeCloseTo((2000 - 4000 / 3) / 2);
        const tall = cropBox(900, 1600, 4 / 3);
        expect([tall.width, tall.height]).toEqual([900, 675]);
        expect(tall.y + tall.height / 2).toBeCloseTo(1600 * 0.35);
        expect(cropBox(900, 1600, 4 / 3, { x: 0.5, y: 0 }).y).toBe(0);
        expect(cropBox(900, 1600, 4 / 3, { x: 0.5, y: 1 }).y).toBe(1600 - 675);
        expect(cropBox(2000, 1000, 4 / 3, { x: 0.9, y: 0.5 }).x).toBeCloseTo(2000 - 4000 / 3);
    });
});
