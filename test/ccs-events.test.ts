import { describe, it, expect } from 'vitest';
import type { Context } from 'hydrooj';
import { previewDatabase } from '../preview/resolver-memory-db';
import { ccsStore } from '../lib/ccs/store';
import { ccsFixture } from './ccs-fixture';
import { buildObjects } from '../lib/ccs/model';
import { endpointProperties } from '../lib/ccs/access';
import { diffNotifications, notificationsOf, eventLine, feedToken, tokenPrefix } from '../lib/ccs/events';
import { openFeed } from '../lib/ccs/feed';

const key = 'system/68ea00000000000000000000';
function setup() { const memory = previewDatabase(); return { memory, store: ccsStore({ db: memory.db } as Context) }; }
async function readLines(stream: NodeJS.ReadableStream, count: number): Promise<any[]> {
    return new Promise((resolve, reject) => {
        let text = ''; const timer = setTimeout(() => reject(new Error('stream timeout')), 2000);
        stream.on('error', reject);
        stream.on('data', chunk => {
            text += String(chunk); const lines = text.split('\n').filter(Boolean);
            if (lines.length >= count) { clearTimeout(timer); resolve(lines.map(line => JSON.parse(line))); }
        });
    });
}

describe('CCS persistent events', () => {
    it('streams a complete snapshot, resumes exactly and rejects foreign/malformed tokens', async () => {
        const { store } = setup();
        const initial = diffNotifications(notificationsOf(buildObjects(ccsFixture(), 'public')), new Map());
        const last = await store.append(key, 'public', initial.notifications);
        const access = { role: 'public' as const, identity: true, teamContest: false };
        const stream = await openFeed({ store, key, view: 'public', access, authorized: async () => true, pollMs: 5 });
        const lines = await readLines(stream, initial.notifications.length - initial.notifications.filter(n => ['accounts', 'runs'].includes(n.type)).length);
        stream.destroy();
        expect(lines.some(n => n.type === 'contest')).toBe(true);
        expect(lines.every(n => typeof n.token === 'string')).toBe(true);
        const prefix = tokenPrefix(key, 'public', true);
        await store.append(key, 'public', [{ type: 'teams', id: '1', data: { id: '1', name: 'Changed' } }]);
        const resumed = await openFeed({ store, key, view: 'public', access, since: feedToken(prefix, last), authorized: async () => true, pollMs: 5 });
        const change = await readLines(resumed, 1); resumed.destroy();
        expect(change[0]).toMatchObject({ type: 'teams', id: '1', data: { name: 'Changed' } });
        for (const since of ['bad', '1', feedToken(prefix, 99999), feedToken(tokenPrefix(key, 'full', true), 1)]) {
            await expect(openFeed({ store, key, view: 'public', access, since, authorized: async () => true })).rejects.toThrow('since_token');
        }
    });
    it('redacts historic girl membership, winner and deletion notifications on public feeds', () => {
        const publicProperties = endpointProperties({ role: 'public', identity: false, teamContest: true });
        const group = { type: 'groups' as const, id: 'girl', seq: 1, data: { id: 'girl', name: '女队' } };
        const award = { type: 'awards' as const, id: 'group-winner-girl', seq: 2, data: { id: 'group-winner-girl', team_ids: ['1'] } };
        const team = { type: 'teams' as const, id: '1', seq: 3, data: { id: '1', group_ids: ['official', 'girl', 'manual-first'] } };
        for (const event of [group, award, { ...group, data: null }, { ...award, data: null }]) {
            expect(eventLine(event, publicProperties, false)).toBeNull();
        }
        expect(eventLine(team, publicProperties, false)?.data).toMatchObject({ group_ids: ['official', 'manual-first'] });
        const visibleProperties = endpointProperties({ role: 'public', identity: true, teamContest: true });
        expect(eventLine(team, visibleProperties, true)?.data).toMatchObject({ group_ids: ['official', 'girl', 'manual-first'] });

        const objects = buildObjects(ccsFixture(), 'public');
        objects.awards.push({ id: 'special-best', citation: '最佳女队', team_ids: ['1'] });
        const created = diffNotifications(notificationsOf(objects, new Set(['special-best'])), new Map());
        const before = new Map(created.changed.map(item => [item.key, item.hash]));
        objects.awards = objects.awards.filter(item => item.id !== 'special-best');
        const removed = diffNotifications(notificationsOf(objects), before).notifications.find(item => item.id === 'special-best')!;
        expect(removed.data).toBeNull();
        expect(eventLine({ ...removed, seq: 4 }, publicProperties, false)).toBeNull();
        expect(eventLine({ ...removed, seq: 4 }, visibleProperties, true)).toMatchObject({ id: 'special-best', data: null });
    });
    it('recovers a partially persisted batch without exposing it or losing events', async () => {
        const { memory, store } = setup();
        const first = [{ type: 'teams' as const, id: '1', data: { id: '1', name: 'First' } }];
        await store.append(key, 'public', first);
        memory.tables.get('xcpcio.ccs.contests')!.get(key)!.pending = { public: { first: 2, notifications: first, at: new Date() } };
        memory.tables.get('xcpcio.ccs.contests')!.get(key)!.seq.public = 2;
        expect(await store.lastSeq(key, 'public')).toBe(1);
        const restarted = ccsStore({ db: memory.db } as Context);
        await restarted.append(key, 'public', [{ type: 'teams', id: '2', data: { id: '2' } }]);
        expect((await restarted.eventsAfter(key, 'public', 0)).map(e => e.seq)).toEqual([1, 2, 3]);
    });
    it('keeps end_of_updates last, and stores an immutable source independently of live Hydro changes', async () => {
        const { store } = setup(); const source = ccsFixture();
        source.meta = { finalizedAt: source.now, endOfUpdatesAt: source.now + 1 };
        const objects = buildObjects(source, 'full');
        const previous = new Map([['teams/removed', 'hash']]);
        const diff = diffNotifications(notificationsOf(objects), previous);
        expect(diff.notifications.at(-1)?.type).toBe('state');
        await store.freezeSource(key, source);
        source.full.teams[0].name = 'Later native edit';
        expect((await store.frozenSource(key))!.full.teams[0].name).not.toBe('Later native edit');
        expect((await store.frozenSource(key))!.teamOfUser).toBeInstanceOf(Map);
        const last = await store.append(key, 'full', diff.notifications);
        // A crash after logging the terminal event but before saving object hashes must not
        // cause a restarted writer to append another snapshot after end_of_updates.
        await store.append(key, 'full', diff.notifications);
        expect(await store.lastSeq(key, 'full')).toBe(last);
    });
    it('maintains references and a single current judgement while replaying a rejudge', () => {
        const source = ccsFixture();
        const database = new Map<string, Map<string, any>>();
        const previous = new Map<string, string>();
        const references: Record<string, string> = { language_id: 'languages', problem_id: 'problems', team_id: 'teams', account_id: 'accounts',
            judgement_type_id: 'judgement-types', simplified_judgement_type_id: 'judgement-types', submission_id: 'submissions', judgement_id: 'judgements',
            organization_id: 'organizations', person_id: 'persons', from_team_id: 'teams', reply_to_id: 'clarifications', source_id: 'persons',
            main_scoreboard_group_id: 'groups', team_ids: 'teams', to_team_ids: 'teams', group_ids: 'groups', to_group_ids: 'groups', problem_ids: 'problems', submission_ids: 'submissions' };
        const replay = () => {
            const diff = diffNotifications(notificationsOf(buildObjects(structuredClone(source), 'full')), previous);
            for (const event of diff.notifications) {
                if (!database.has(event.type)) database.set(event.type, new Map());
                if (event.data === null) database.get(event.type)!.delete(event.id || '');
                else database.get(event.type)!.set(event.id || '', event.data);
                for (const objects of database.values()) for (const object of objects.values()) for (const [field, target] of Object.entries(references)) {
                    const values = Array.isArray(object[field]) ? object[field] : [object[field]];
                    for (const id of values) if (id != null) expect(database.get(target)?.has(id), `${event.type}: ${field}=${id}`).toBe(true);
                }
                const judged = new Set();
                for (const judgement of database.get('judgements')?.values() || []) if (judgement.current) {
                    expect(judged.has(judgement.submission_id)).toBe(false); judged.add(judgement.submission_id);
                }
            }
            for (const item of diff.changed) previous.set(item.key, item.hash);
            for (const key of diff.removed) previous.delete(key);
        };
        replay();
        source.records[0].judgings.push({ ...source.records[0].judgings[0], status: 2 });
        replay();
        source.full.teams.splice(0, 1); source.public.teams.splice(0, 1);
        replay();
    });
    it('lease renewal excludes another process, release permits takeover', async () => {
        const { store } = setup();
        expect(await store.acquireLease('test', 'a', 15000)).toBe(true);
        expect(await store.acquireLease('test', 'b', 15000)).toBe(false);
        expect(await store.acquireLease('test', 'a', 15000)).toBe(true);
        await store.releaseLease('test', 'b'); expect(await store.ownsLease('test', 'a')).toBe(true);
        await store.releaseLease('test', 'a'); expect(await store.acquireLease('test', 'b', 15000)).toBe(true);
    });
});
