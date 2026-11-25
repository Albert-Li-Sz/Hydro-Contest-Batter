/** Isolated Hydro simulator for exercising the production CCS handlers over real HTTP. No remote OJ is contacted. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { randomBytes } from 'node:crypto';
import type { Context } from 'hydrooj';
import type { BoardData } from '../lib/board';
import { emptyJury, type JuryState } from '../lib/jury';
import type { BoardSettings } from '../lib/settings';
import { applyCcsApi } from '../lib/ccs/service';
import type { HydroApi } from '../lib/ccs/source';
import { previewDatabase } from './resolver-memory-db';

export const previewCcsId = '68ea00000000000000000000';
export function createCcsPreview(data: BoardData, getSettings: () => BoardSettings, getJury: () => JuryState = emptyJury) {
    class ObjectId {
        constructor(public value = `${Math.floor(Date.now() / 1000).toString(16)}${randomBytes(8).toString('hex')}`) {}
        toString() { return this.value; }
        toHexString() { return this.value; }
        getTimestamp() { return new Date(parseInt(this.value.slice(0, 8), 16) * 1000); }
    }
    const begin = data.contest.start_time * 1000;
    const contest: any = { docId: new ObjectId(previewCcsId), domainId: 'system', title: data.contest.contest_name,
        rule: 'acm', owner: 99, pids: [100, 101, 102], beginAt: new Date(begin), endAt: new Date(data.contest.end_time * 1000), lockAt: null };
    const guest = { _id: 0, hasPerm: () => false, hasPriv: () => false, own: () => false };
    const account = (uid: number, uname: string, displayName: string, role: string, school = '') => ({ _id: uid, uname, displayName, school,
        _hash: 'preview', _salt: 'preview', own: (tdoc: any) => uid === tdoc.owner, hasPriv: () => true,
        hasPerm: (perm: bigint) => role === 'admin' || role === 'judge' && perm === 2n,
        checkPassword: async (password: string) => { if (password !== 'preview') throw new Error('Invalid password'); } });
    const users: Record<number, any> = Object.fromEntries(data.teams.map(t => [Number(t.team_id), account(Number(t.team_id), `team${t.team_id}`, t.name, 'team', t.organization)]));
    users[99] = account(99, 'admin', '演示管理员', 'admin'); users[98] = account(98, 'judge', '演示裁判', 'judge');
    const entries = data.teams.map(t => ({ uid: Number(t.team_id), attend: 1, unrank: t.group.includes('unofficial') }));
    const records = data.submissions.map((s, i) => ({ _id: new ObjectId(`${Math.floor((begin + s.timestamp) / 1000).toString(16)}${i.toString(16).padStart(16, '0')}`),
        uid: Number(s.team_id), pid: 100 + s.problem_id, lang: 'cc.cc17o2', status: 1, time: 12,
        code: 'int main() { return 0; }', judgeAt: new Date(begin + s.timestamp + 1000), testCases: [{ status: 1, time: 12 }], domainId: 'system', contest: contest.docId }));
    const memory = previewDatabase();
    const hooks = new Map<string, ((...args: any[]) => unknown)[]>();
    const stops: (() => Promise<void>)[] = [];
    const ctx: any = { db: memory.db, Route: () => {}, on: (name: string, listener: any) => hooks.set(name, [...(hooks.get(name) || []), listener]),
        broadcast: (name: string, ...args: any[]) => hooks.get(name)?.forEach(listener => listener(...args)), effect: (factory: any) => stops.push(factory()) };
    class Handler {
        domain = { _id: 'system' };
        user: any;
        request: any;
        response: any;
        constructor(public context: any) { this.user = context.user || guest; this.request = context.request; this.response = context.response; }
        async limitRate() {}
    }
    const host = {
        Handler, ObjectId, PERM: { PERM_EDIT_CONTEST: 1n, PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD: 2n }, PRIV: { PRIV_USER_PROFILE: 1, PRIV_MANAGE_ALL_DOMAIN: 2 }, BUILTIN_ROLES: { root: 3n },
        ContestModel: {
            get: async (_domain: string, id: unknown) => String(id) === previewCcsId ? contest : null,
            getMultiStatus: (_domain: string, filter: any) => ({ toArray: async () => filter.$or ? entries.filter(e => filter.$or.some((part: any) => part.uid === e.uid)) : entries }),
            getStatus: async (_domain: string, _id: unknown, uid: number) => entries.find(e => e.uid === uid),
            getMultiClarification: async () => [], canShowScoreboard: () => Date.now() >= contest.beginAt.getTime(),
            edit: async (_domain: string, _id: unknown, update: any) => Object.assign(contest, update), recalcStatus: async () => {},
            unlockScoreboard: async () => { contest.unlocked = true; }, updateStatus: async () => {},
        },
        UserModel: { getList: async (_d: string, ids: number[]) => Object.fromEntries(ids.filter(id => users[id]).map(id => [id, users[id]])),
            getById: async (_d: string, uid: number) => users[uid], getByUname: async (_d: string, uname: string) => Object.values(users).find(user => user.uname === uname),
            getMulti: () => ({ toArray: async () => [{ _id: 99 }] }) },
        DomainModel: { get: async () => ({ roles: { judge: 2n, admin: 3n } }), getMultiUserInDomain: () => ({ toArray: async () => [{ uid: 98 }, { uid: 99 }] }), incUserInDomain: async () => {} },
        SettingModel: { langs: { 'cc.cc17o2': { display: 'C++17', code_file: 'foo.cpp', compile: 'g++ -std=c++17 foo.cpp -o foo', execute: './foo' } } },
        SystemModel: { get: () => 128 * 1024 }, getAlphabeticId: (i: number) => String.fromCharCode(65 + i),
        ProblemModel: { PROJECTION_PUBLIC: [], getList: async () => Object.fromEntries(contest.pids.map((pid: number, i: number) => [pid, { title: `演示题 ${String.fromCharCode(65 + i)}`, config: { timeMax: '1s', memoryMax: '256m', count: 1 } }])),
            get: async () => ({ config: { type: 'default' } }), inc: async () => {} },
        RecordModel: { getMulti: () => ({ toArray: async () => records }), get: async (_d: string, id: unknown) => records.find(r => String(r._id) === String(id)),
            add: async (domainId: string, pid: number, uid: number, lang: string, code: string) => {
                const id = new ObjectId(); records.push({ _id: id, domainId, pid, uid, lang, code, status: 0, time: 0, judgeAt: null as any, testCases: [], contest: contest.docId }); return id;
            }, coll: { insertOne: async (record: any) => records.push(record) }, submissionPriority: async () => 50, judge: async () => {} },
        DocumentModel: { add: async () => new ObjectId(), push: async () => {} }, StorageModel: { get: async () => Readable.from([]) },
    } as unknown as HydroApi;
    const app = applyCcsApi(host, ctx as Context, {
        loadSettings: async () => getSettings(),
        loadJury: async () => getJury(),
        loadData: async (_tdoc, realtime, identity) => {
            const board = structuredClone(data);
            board.teams = board.teams.map(t => ({ ...t, organization: identity ? t.organization : undefined }));
            board.submissions = records.map(r => ({ submission_id: String(r._id), team_id: String(r.uid), problem_id: r.pid - 100,
                timestamp: r._id.getTimestamp().getTime() - contest.beginAt.getTime(), status: r.status === 1 ? 'CORRECT' : r.status === 0 ? 'PENDING' : 'WRONG_ANSWER' }));
            return board;
        },
    });
    const key = `system/${previewCcsId}`;
    const sync = async () => {
        await (memory.db.collection('xcpcio.enhanced.settings' as never) as any).updateOne({ _id: key }, { $set: { settings: { ccsApi: getSettings().ccsApi } } }, { upsert: true });
    };
    return {
        app, sync, close: async () => { for (const stop of stops) await stop(); },
        async handle(request: IncomingMessage, response: ServerResponse, url: URL) {
            if (!url.pathname.startsWith('/d/system/ccsapi')) return false;
            await sync();
            const headers: Record<string, string> = {};
            let body: any;
            let raw = '';
            for await (const chunk of request) { raw += chunk; if (raw.length > 1024 * 1024) { response.writeHead(413).end(); return true; } }
            try { body = raw ? JSON.parse(raw) : undefined; } catch { response.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ code: 400, message: 'Invalid JSON' })); return true; }
            const context: any = { req: request, res: response, user: undefined, request: {
                method: request.method?.toLowerCase(), path: url.pathname, headers: request.headers, host: request.headers.host, query: Object.fromEntries(url.searchParams), body, ip: '127.0.0.1',
            }, response: { headers, addHeader: (name: string, value: string) => { headers[name] = value; } } };
            // The local settings page simulates the admin's logged-in Hydro session for its action.
            if (url.pathname.endsWith('/finalize') && request.headers.origin === `http://${request.headers.host}`) context.user = users[99];
            const handler = new app.handler(context, ctx);
            try { await handler.all(); } catch (error) { await handler.onerror(error); }
            const result = context.response;
            response.writeHead(result.status || 200, { ...headers, 'Content-Type': result.type || 'application/json' });
            if (result.body?.pipe) result.body.pipe(response);
            else response.end(result.body ?? '');
            return true;
        },
    };
}
