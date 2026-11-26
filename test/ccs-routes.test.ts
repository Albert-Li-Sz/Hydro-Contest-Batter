import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import type { CcsSource } from '../lib/ccs/model';
import { ccsFixture } from './ccs-fixture';
import { previewDatabase } from '../preview/resolver-memory-db';
import { readZip, writeZip } from '../lib/ccs/zip';
import { abstime } from '../lib/ccs/types';
const state = vi.hoisted(() => ({ source: null as unknown as CcsSource, contest: null as any, users: {} as Record<number, any>, uid: 0, record: 0, docs: [] as any[] }));
vi.mock('hydrooj', () => {
    class ObjectId {
        value: string;
        constructor(value?: string) { this.value = value || `${Math.floor(Date.now() / 1000).toString(16)}${(++state.record).toString(16).padStart(16, '0')}`; }
        toString() { return this.value; }
        toHexString() { return this.value; }
        getTimestamp() { return new Date(Number.parseInt(this.value.slice(0, 8), 16) * 1000); }
    }
    class Handler {
        domain = { _id: 'system' };
        user: any = state.users[state.uid] || { _id: 0, hasPerm: () => false, hasPriv: () => false, own: () => false };
        request: any = { method: 'get', path: '/ccsapi', host: 'localhost', ip: '127.0.0.1', query: {}, headers: {}, body: undefined };
        response: any = { addHeader: (key: string, value: string) => { this.response.headers[key.toLowerCase()] = value; }, headers: {} };
        context = { res: new EventEmitter() };
        limitRate = vi.fn();
    }
    const addRecord = async (domainId: string, pid: number, uid: number, lang: string, code: string) => {
        const rid = new ObjectId();
        state.source.records.push({ rid: String(rid), submissionId: String(rid), uid, teamUid: state.source.teamOfUser.get(uid) ?? uid, pid, lang,
            submittedAt: rid.getTimestamp().getTime(), judgings: [{ status: 0, startAt: null, judgeAt: null, time: null, cases: [] }] });
        state.docs.push({ _id: rid, domainId, pid, uid, lang, code });
        return rid;
    };
    return {
        Handler, ObjectId, PERM: { PERM_EDIT_CONTEST: 1n, PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD: 2n }, PRIV: { PRIV_USER_PROFILE: 1 },
        ContestModel: {
            get: vi.fn(async (_domain: string, id: any) => String(id) === state.source.contest.id ? state.contest : null),
            getMultiStatus: vi.fn((_domain: string, query: any) => ({ toArray: async () => query.$or.flatMap((filter: any) => state.source.full.teams
                .filter(t => Number(t.team_id) === filter.uid || [...state.source.teamOfUser].some(([uid, team]) => uid === filter.members && team === Number(t.team_id)))
                .map(t => ({ uid: Number(t.team_id), attend: 1 }))) })),
            getStatus: vi.fn(async () => ({ attend: 1 })), updateStatus: vi.fn(), recalcStatus: vi.fn(),
            edit: vi.fn(async (_domain: string, _tid: any, patch: any) => {
                Object.assign(state.contest, patch);
                state.source.contest.beginAt = state.contest.beginAt.getTime(); state.source.contest.endAt = state.contest.endAt.getTime();
                state.source.contest.lockAt = state.contest.lockAt?.getTime() ?? null;
            }),
            unlockScoreboard: vi.fn(async () => { state.contest.unlocked = true; state.source.contest.unlocked = true; }),
        },
        UserModel: {
            getByUname: vi.fn(async (_d: string, uname: string) => Object.values(state.users).find((u: any) => u.uname === uname)),
            getById: vi.fn(async (_d: string, uid: number) => state.users[uid]),
        },
        SystemModel: { get: () => 128 * 1024 }, SettingModel: { langs: { 'cc.cc17o2': { code_file: 'foo.cpp' } } },
        ProblemModel: { get: vi.fn(async () => ({ config: { type: 'default' } })), inc: vi.fn() },
        DomainModel: { incUserInDomain: vi.fn() },
        DocumentModel: { add: vi.fn(async (...args: any[]) => { state.docs.push(args); return new ObjectId(); }), push: vi.fn() },
        RecordModel: { add: vi.fn(addRecord), get: vi.fn(async (_d: string, id: any) => state.docs.find(d => String(d._id) === String(id)) || { code: 'int main(){}', lang: 'cc.cc17o2' }),
            coll: { insertOne: vi.fn(async (r: any) => { state.docs.push(r); state.source.records.push({ rid: String(r._id), submissionId: String(r._id), uid: r.uid, teamUid: r.uid, pid: r.pid, lang: r.lang, submittedAt: r.ccsTime.getTime(), judgings: [{ status: 0, startAt: null, judgeAt: null, time: null, cases: [] }] }); }) },
            submissionPriority: async () => 50, judge: vi.fn() },
        StorageModel: { get: vi.fn() },
    };
});
vi.mock('../lib/ccs/source', () => ({
    logoRegistry: () => ({ names: {}, png: {} }),
    createCcsSourceLoader: () => ({ problemLanguages: async () => ['cc.cc17o2'], loadCcsSource: async (_ctx: unknown, store: any, _dependencies: unknown, tdoc: any) => {
        const key = `${tdoc.domainId}/${tdoc.docId}`;
        const frozen = await store.frozenSource(key);
        if (frozen) return frozen;
        const source = structuredClone(state.source);
        source.now = Date.now(); source.meta = (await store.contest(tdoc.domainId, String(tdoc.docId))).meta || {};
        source.extraClarifications = await store.clarifications(key); source.comments = await store.comments(key); source.awardOverrides = await store.awardOverrides(key);
        const ids = await store.mappedIds(key, 'submissions');
        source.records.forEach((r: any) => { r.submissionId = ids.get(r.rid) || r.submissionId; });
        return source;
    } }),
}));
import { applyCcs } from '../lib/ccs/routes';
import { ContestModel, DocumentModel, RecordModel, StorageModel } from 'hydrooj';
let dispose: (() => Promise<void>)[] = [];
const user = (uid: number, role: string) => ({ _id: uid, uname: `${role}${uid}`, displayName: role, _hash: 'hash', _salt: 'salt',
    own: () => false, hasPriv: () => true, hasPerm: (p: bigint) => role === 'admin' || role === 'judge' && p === 2n,
    checkPassword: vi.fn(async (pw: string) => { if (pw !== 'secret') throw new Error('Invalid password'); }),
});
function setup(webhookLookup?: (host: string) => Promise<string[]>) {
    const memory = previewDatabase();
    const listeners = new Map<string, ((...args: any[]) => void)[]>();
    const ctx: any = { db: memory.db, Route: vi.fn(), on: (name: string, fn: any) => { listeners.set(name, [...(listeners.get(name) || []), fn]); },
        effect: (fn: any) => dispose.push(fn()), broadcast: (name: string, ...args: any[]) => listeners.get(name)?.forEach(fn => fn(...args)) };
    const defaultLookup = async (host: string) => host === 'callback.example' ? ['93.184.216.34'] : [];
    const app = applyCcs(ctx, { loadData: async () => state.source.full, loadSettings: async () => state.source.settings, loadJury: async () => ({ holds: [], credits: [] }), webhookLookup: webhookLookup ?? defaultLookup });
    const key = `system/${state.source.contest.id}`;
    memory.tables.get('xcpcio.enhanced.settings')!.set(key, { _id: key, settings: { ccsApi: true } });
    // ccsStore cached the collection object at construction, so populate that same table.
    const table = (ctx.db.collection('xcpcio.enhanced.settings') as any);
    const request = async (route = '', options: { uid?: number; method?: string; body?: unknown; query?: object; headers?: object; root?: boolean } = {}) => {
        state.uid = options.uid ?? 0;
        const handler: any = new (app.handler as any)();
        handler.request = { ...handler.request, method: options.method || 'get', path: options.root ? `/ccsapi${route}` : `/ccsapi/contests/${state.source.contest.id}${route}`,
            body: options.body, query: options.query || {}, headers: { ...(options.body !== undefined ? { 'content-type': 'application/json' } : {}), ...options.headers } };
        try { await handler.all(); } catch (error) { await handler.onerror(error); }
        const response = handler.response;
        return { handler, status: response.status || 200, headers: response.headers, body: typeof response.body === 'string' ? JSON.parse(response.body || 'null') : response.body };
    };
    return { ...app, request, memory, key, table };
}
beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    state.source = ccsFixture(); vi.setSystemTime(state.source.now); state.record = 100; state.docs = [];
    state.contest = { docId: state.source.contest.id, domainId: 'system', title: '比赛', rule: 'acm', owner: 99,
        beginAt: new Date(state.source.contest.beginAt), endAt: new Date(state.source.contest.endAt), lockAt: null, pids: [100, 101, 102] };
    state.users = { 1: user(1, 'team'), 2: user(2, 'team'), 98: user(98, 'judge'), 99: user(99, 'admin') };
    vi.clearAllMocks();
});
afterEach(async () => { for (const stop of dispose) await stop(); dispose = []; vi.useRealTimers(); });
const submission = () => ({ language_id: 'cc.cc17o2', problem_id: '100', files: [{ data: writeZip([{ name: 'main.cpp', data: Buffer.from('int main(){}') }]).toString('base64') }] });

describe('CCS HTTP routes', () => {
    it('is opt-in, uses Basic auth, rejects invalid credentials and avoids a 2FA bypass', async () => {
        const app = setup();
        expect((await app.request('', { root: true })).body.version).toBe('2026-01');
        state.source.settings.ccsApi = false;
        expect((await app.request()).status).toBe(404);
        state.source.settings.ccsApi = true; state.source.settings.publicAccess = false;
        expect((await app.request()).status).toBe(401);
        const auth = (pw: string) => ({ authorization: `Basic ${Buffer.from(`admin99:${pw}`).toString('base64')}` });
        expect((await app.request('/access', { headers: auth('bad') })).status).toBe(401);
        expect((await app.request('/access', { headers: auth('secret') })).body.capabilities).toContain('admin_submit');
        state.users[99].tfa = true;
        expect((await app.request('/access', { headers: auth('secret') })).status).toBe(401);
        state.users[99].tfa = false;
        state.users[99]._hash = 'changed'; state.users[99].checkPassword = async () => { throw new Error(); };
        expect((await app.request('/access', { headers: auth('secret') })).status).toBe(401);
        state.users[98].tfa = true;
        expect((await app.request('/access', { headers: { authorization: `Basic ${Buffer.from('judge98:secret').toString('base64')}` } })).status).toBe(401);
    });
    it('answers HEAD like GET and rejects a malformed Origin on session writes', async () => {
        const app = setup();
        const head = await app.request('/state', { method: 'head' });
        expect(head.status).toBe(200);
        expect(head.body).toHaveProperty('started');
        const write = await app.request('/clarifications', { uid: 99, method: 'post', body: { text: 'x' }, headers: { origin: 'not a url' } });
        expect(write.status).toBe(403);
    });
    it('public and other teams cannot download a team source file', async () => {
        const app = setup(); const rid = state.source.records[0].submissionId;
        expect((await app.request(`/submissions/${rid}/files`)).status).toBe(403);
        expect((await app.request(`/submissions/${rid}/files`, { uid: 2 })).status).toBe(403);
        const own = await app.request(`/submissions/${rid}/files`, { uid: 1 });
        expect(own.status).toBe(200); expect(readZip(own.body, { maxFiles: 1, maxBytes: 100 })[0].data.toString()).toBe('int main(){}');
        expect((await app.request('/submissions')).body.every((s: any) => s.files === undefined)).toBe(true);
        const nativeArchive = writeZip([{ name: 'main.cpp', data: Buffer.from('int main(){}') }]);
        vi.mocked(RecordModel.get).mockResolvedValueOnce({ files: { code: '1/native#source.zip' }, lang: 'cc.cc17o2' } as any);
        vi.mocked(StorageModel.get).mockResolvedValueOnce(Readable.from([nativeArchive]) as any);
        expect((await app.request(`/submissions/${rid}/files`, { uid: 1 })).body).toEqual(nativeArchive);
    });
    it('supports team/proxy/admin submissions and rejects malformed PUTs before mutation', async () => {
        const app = setup(); vi.setSystemTime(state.source.contest.beginAt + 900_000);
        expect((await app.request('/submissions', { uid: 1, method: 'post', body: submission() })).status).toBe(201);
        expect(RecordModel.add).toHaveBeenCalledTimes(1);
        expect((await app.request('/submissions', { uid: 1, method: 'post', body: { ...submission(), team_id: '2' } })).status).toBe(400);
        expect((await app.request('/submissions', { uid: 99, method: 'post', body: { ...submission(), team_id: '2' } })).status).toBe(201);
        expect((await app.request('/submissions/chosen', { uid: 99, method: 'put', body: { ...submission(), time: abstime(Date.now()), team_id: '1' } })).status).toBe(400);
        const imported = { ...submission(), id: 'chosen', time: abstime(Date.now()), team_id: '1' };
        expect((await app.request('/submissions/chosen', { uid: 99, method: 'put', body: imported })).body.id).toBe('chosen');
        expect((await app.request('/submissions/chosen', { uid: 99, method: 'put', body: imported })).status).toBe(409);
    });
    it('validates clocks and supports zero countdown pause and scheduled thaw', async () => {
        const app = setup(); vi.setSystemTime(state.source.contest.beginAt - 120_000);
        const id = state.source.contest.id;
        expect((await app.request('', { uid: 99, method: 'patch', body: { id, start_time: '2026-02-30T00:00:00Z' } })).status).toBe(400);
        const paused = await app.request('', { uid: 99, method: 'patch', body: { id, start_time: null, countdown_pause_time: '0:00:00.000' } });
        expect(paused.body.start_time).toBeNull(); expect(paused.body.countdown_pause_time).toBe('0:00:00.000');
        expect((await app.request('/state', { uid: 99 })).body.started).toBeNull();
        expect((await app.request('', { uid: 98, method: 'patch', body: { id, start_time: abstime(Date.now() + 90_000) } })).status).toBe(403);
        expect((await app.request('', { uid: 99, method: 'patch', body: { id, start_time: abstime(Date.now() + 90_000) } })).status).toBe(200);
    });
    it('reserves imported submission IDs before concurrent native writes', async () => {
        const app = setup(); vi.setSystemTime(state.source.contest.beginAt + 900_000);
        const body = { ...submission(), id: 'concurrent', time: abstime(Date.now()), team_id: '1' };
        const results = await Promise.all([app.request('/submissions/concurrent', { uid: 99, method: 'put', body }), app.request('/submissions/concurrent', { uid: 99, method: 'put', body })]);
        expect(results.map(result => result.status).sort()).toEqual([201, 409]);
        expect(RecordModel.coll.insertOne).toHaveBeenCalledTimes(1);
    });
    it('maps virtual teams to legal IDs and credits member submissions to the team', async () => {
        state.contest.allowTeam = state.source.contest.allowTeam = true;
        state.source.teamOfUser.set(1, -1001);
        for (const data of [state.source.full, state.source.public]) {
            data.teams.find(team => team.team_id === '1')!.team_id = '-1001';
            data.submissions.forEach(submission => { if (submission.team_id === '1') submission.team_id = '-1001'; });
        }
        state.source.records.forEach(record => { if (record.uid === 1) record.teamUid = -1001; });
        state.source.accounts.forEach(account => { if (account.uid === 1) account.teamUid = -1001; });
        state.source.persons.forEach(person => { if (person.uid === 1) person.teamUid = -1001; });
        const app = setup(); vi.setSystemTime(state.source.contest.beginAt + 900_000);
        expect((await app.request('/account', { uid: 1 })).body.team_id).toBe('t1001');
        const response = await app.request('/submissions', { uid: 1, method: 'post', body: { ...submission(), team_id: 't1001' } });
        expect(response.status).toBe(201); expect(response.body.team_id).toBe('t1001');
        expect(ContestModel.updateStatus).toHaveBeenCalledWith('system', state.contest.docId, -1001, expect.anything(), 100);
    });
    it('handles private, multicast and imported clarifications without publishing private threads', async () => {
        const app = setup(); vi.setSystemTime(state.source.contest.beginAt + 900_000);
        const question = await app.request('/clarifications', { uid: 1, method: 'post', body: { text: 'Question', problem_id: '100' } });
        expect(question.status).toBe(201);
        expect((await app.request('/clarifications')).body).toEqual([]);
        expect((await app.request('/clarifications', { uid: 2 })).body).toEqual([]);
        const reply = await app.request('/clarifications/reply', { uid: 99, method: 'put', body: { id: 'reply', text: 'Answer', time: abstime(Date.now()), reply_to_id: question.body.id, to_team_ids: ['1', '2'] } });
        expect(reply.status).toBe(201);
        const other = await app.request('/clarifications', { uid: 2 });
        expect(other.body).toHaveLength(1); expect(other.body[0].reply_to_id).toBeNull();
        expect((await app.request('/clarifications', { uid: 1, method: 'post', body: { text: 'bad', to_group_ids: ['official'] } })).status).toBe(400);
        const calls = vi.mocked(DocumentModel.add).mock.calls.length;
        expect((await app.request('/clarifications/reply', { uid: 99, method: 'put', body: { id: 'reply', text: 'Again', time: abstime(Date.now()) } })).status).toBe(409);
        expect(DocumentModel.add).toHaveBeenCalledTimes(calls);
        await app.request('/clarifications', { uid: 99, method: 'post', body: { text: 'No recipients', to_team_ids: [] } });
        expect((await app.request('/clarifications')).body).toEqual([]);
    });
    it('award ownership, commentary references, filtering and CSRF checks work', async () => {
        const app = setup();
        expect((await app.request('/awards/winner', { uid: 99, method: 'patch', body: { team_ids: ['2'], citation: 'Special' } })).body.team_ids).toEqual(['2']);
        expect((await app.request('/awards/winner', { uid: 99, method: 'patch', body: { team_ids: null } })).body.team_ids).toBeNull();
        expect((await app.request('/awards/winner', { uid: 99, method: 'delete' })).status).toBe(204);
        expect((await app.request('/awards/winner', { uid: 99, method: 'delete' })).status).toBe(404);
        expect((await app.request('/commentary', { uid: 98, method: 'post', body: { message: 'Hello', tags: [], team_ids: ['missing'] } })).status).toBe(400);
        expect((await app.request('/commentary', { uid: 98, method: 'post', body: { message: 'Hello', tags: [], team_ids: ['1'] } })).status).toBe(201);
        expect((await app.request('/submissions', { query: { team_id: '1' } })).body.every((r: any) => r.team_id === '1')).toBe(true);
        expect((await app.request('/commentary', { uid: 99, method: 'post', body: { message: 'bad', tags: [] }, headers: { origin: 'https://evil.example' } })).status).toBe(403);
    });
});


describe('CCS writer and callbacks', () => {
    it('executes scheduled thaw and refuses finalization until ended, thawed and judged', async () => {
        const app = setup(); const id = state.source.contest.id;
        state.contest.lockAt = new Date(state.source.contest.endAt - 60_000);
        state.source.contest.lockAt = state.contest.lockAt.getTime();
        expect((await app.request('/finalize', { uid: 99, method: 'post', body: {} })).status).toBe(409);
        expect((await app.request('', { uid: 99, method: 'patch', body: { id, scoreboard_thaw_time: abstime(Date.now() + 30_000) } })).status).toBe(204);
        vi.setSystemTime(Date.now() + 30_001); await app.writer.tick();
        expect(ContestModel.unlockScoreboard).toHaveBeenCalledTimes(1);
        expect((await app.request('/state', { uid: 99 })).body.thawed).toBeTruthy();
        state.source.records[0].judgings.at(-1)!.status = 0;
        expect((await app.request('/finalize', { uid: 99, method: 'post', body: {} })).status).toBe(409);
        state.source.records[0].judgings.at(-1)!.status = 1;
        expect((await app.request('/finalize', { uid: 99, method: 'post', body: {} })).status).toBe(202);
    });
    it('automatically finalizes only after the configured quiet period', async () => {
        state.source.settings.ccsAutoFinalize = true;
        const app = setup(); await app.writer.tick();
        expect((await app.store.contest('system', state.source.contest.id)).snapshotId).toBeUndefined();
        vi.setSystemTime(Date.now() + 20_000);
        state.source.full.teams[0].name = 'Changed during quiet period'; app.writer.touch(app.key); await app.writer.tick();
        vi.setSystemTime(Date.now() + 20_000); app.writer.touch(app.key); await app.writer.tick();
        expect((await app.store.contest('system', state.source.contest.id)).snapshotId).toBeUndefined();
        vi.setSystemTime(Date.now() + 11_000); app.writer.touch(app.key); await app.writer.tick();
        expect((await app.store.contest('system', state.source.contest.id)).snapshotId).toBeTruthy();
    });
    it('produces team views, persists rejudgements and closes finalized feeds', async () => {
        const app = setup();
        await app.store.registerTeamView(app.key, '1');
        await app.writer.tick();
        expect(await app.store.lastSeq(app.key, 'full')).toBeGreaterThan(0);
        expect(await app.store.lastSeq(app.key, 'team-1')).toBeGreaterThan(0);
        const initial = await app.store.lastSeq(app.key, 'full');
        state.source.records[0].judgings.push({ status: 2, startAt: Date.now() - 20, judgeAt: Date.now() - 10, time: 10, cases: [{ status: 2, time: 10 }] });
        app.writer.touch(app.key); await app.writer.tick();
        const updates = await app.store.eventsAfter(app.key, 'full', initial);
        expect(updates.some(e => e.type === 'judgements' && (e.data as any).current === false)).toBe(true);
        expect(updates.some(e => e.type === 'judgements' && (e.data as any).judgement_type_id === 'WA')).toBe(true);
        expect((await app.request('/finalize', { uid: 99, method: 'post', body: {} })).status).toBe(202);
        await app.writer.tick();
        const tail = await app.store.eventsAfter(app.key, 'full', initial);
        expect(tail.at(-1)?.type).toBe('state'); expect((tail.at(-1)?.data as any).end_of_updates).toBeTruthy();
        const final = await app.request('/teams', { uid: 99 });
        state.source.full.teams[0].name = 'Edited after final';
        vi.setSystemTime(Date.now() + 5000);
        expect((await app.request('/teams', { uid: 99 })).body).toEqual(final.body);
        expect((await app.request('/commentary', { uid: 99, method: 'post', body: { message: 'late', tags: [] } })).status).toBe(409);
    });
    it('registers callbacks from the current cursor, retries in order and deactivates sustained failures', async () => {
        const app = setup(); await app.writer.tick();
        const request = vi.fn(async () => ({ ok: false, status: 503, body: null }));
        vi.stubGlobal('fetch', request);
        try {
            const hook = await app.request('/webhooks', { root: true, uid: 99, method: 'post', body: { url: 'https://callback.example/ccs', token: 'test-only', endpoints: ['teams'] } });
            expect(hook.status).toBe(201); expect(hook.body.token).toBeUndefined();
            await app.writer.tick(); expect(request).not.toHaveBeenCalled();
            state.source.full.teams[0].name = 'First'; app.writer.touch(app.key); await app.writer.tick();
            expect(request).toHaveBeenCalledTimes(1);
            const call = request.mock.calls[0] as any;
            expect(call[1].headers['Webhook-Token']).toBe('test-only');
            expect(JSON.parse(call[1].body).notifications[0].data.name).toBe('First');
            await app.writer.tick(); expect(request).toHaveBeenCalledTimes(2);
            expect((request.mock.calls[1] as any)[1].body).toBe(call[1].body);
            vi.setSystemTime(Date.now() + 31 * 60_000); await app.writer.tick();
            expect((await app.request(`/webhooks/${hook.body.id}`, { root: true, uid: 99 })).body.active).toBe(false);
        } finally { vi.unstubAllGlobals(); }
    });
    it('stops callbacks after the owner loses permission and rejects invalid registration', async () => {
        const app = setup(); await app.writer.tick();
        const request = vi.fn(); vi.stubGlobal('fetch', request);
        try {
            const register = (body: any) => app.request('/webhooks', { root: true, uid: 99, method: 'post', body: { url: 'https://callback.example', token: 'test-only', ...body } });
            expect((await register({ url: 'http://name:password@example.com' })).status).toBe(400);
            expect((await register({ token: 'bad\r\nHeader: x' })).status).toBe(400);
            expect((await register({ contest_ids: ['000000000000000000000000'] })).status).toBe(400);
            const hook = await register({});
            state.users[99].hasPerm = () => false;
            state.source.full.teams[0].name = 'Changed'; app.writer.touch(app.key); await app.writer.tick();
            expect(request).not.toHaveBeenCalled();
            expect((await app.store.webhooks.findOne({ _id: hook.body.id }))?.active).toBe(false);
        } finally { vi.unstubAllGlobals(); }
    });
    it('allows a contest owner without domain edit permission to register a scoped webhook', async () => {
        state.users[1].own = (contest: any) => contest.owner === 1;
        state.contest.owner = 1;
        const app = setup();
        const body = { url: 'https://callback.example', token: 'test-only', contest_ids: [state.source.contest.id] };
        expect((await app.request('/webhooks', { root: true, uid: 1, method: 'post', body })).status).toBe(201);
        expect((await app.request('/webhooks', { root: true, uid: 2 })).body).toEqual([]);
        expect((await app.request('/webhooks', { root: true, uid: 2, method: 'post', body })).status).toBe(403);
    });
    it('blocks SSRF webhook targets statically and on DNS resolution to private or metadata IPs', async () => {
        let resolvedIp = '169.254.169.254';
        const app = setup(async (host) => host === 'rebind.example' ? [resolvedIp] : ['93.184.216.34']);
        await app.writer.tick();
        const request = vi.fn(async () => ({ ok: true, status: 200, body: null }));
        vi.stubGlobal('fetch', request);
        try {
            const register = (url: string) => app.request('/webhooks', { root: true, uid: 99, method: 'post', body: { url, token: 'test-only', endpoints: ['teams'] } });
            for (const bad of [
                'http://127.0.0.1:8080/hook',
                'http://localhost/hook',
                'http://169.254.169.254/latest/meta-data/',
                'http://10.0.0.5/internal',
                'http://[::ffff:127.0.0.1]/hook',
                'http://service.internal/hook',
            ]) {
                expect((await register(bad)).status, bad).toBe(400);
            }
            const hook = await register('https://rebind.example/ccs');
            expect(hook.status).toBe(201);
            state.source.full.teams[0].name = 'SSRF Trigger'; app.writer.touch(app.key); await app.writer.tick();
            expect(request).not.toHaveBeenCalled();
            resolvedIp = '93.184.216.34';
            await app.writer.tick();
            expect(request).toHaveBeenCalledTimes(1);
        } finally { vi.unstubAllGlobals(); }
    });
});
