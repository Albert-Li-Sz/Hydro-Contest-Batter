import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Context, Tdoc } from 'hydrooj';
import { awardsFor, defaultSettings } from '../lib/settings';
import { defaultProfileFields } from '../lib/roster';
import { verdictFor } from '../lib/live/model';
import { ResolverSessions } from '../lib/resolver-sessions';
import { previewDatabase } from '../preview/resolver-memory-db';

const state = vi.hoisted(() => ({ entries: [] as any[], users: {} as Record<number, any>, locked: false, ended: true, started: true, contest: null as any, director: null as any, records: [] as any[], judges: [] as any[] }));
vi.mock('hydrooj', () => {
    class ObjectId {
        constructor(public value: string) {}
        getTimestamp() { return new Date(Number.parseInt(`${this.value}`.slice(0, 8), 16) * 1000); }
        toString() { return `${this.value}`; }
    }
    class Handler {
        domain = { _id: 'system' };
        user = { _id: 10, own: () => false, hasPerm: (_perm: bigint) => false };
        request = { json: false, headers: {} as Record<string, string> };
        response: any = { addHeader: vi.fn() };
        checkPerm(perm: bigint) { if (!this.user.hasPerm(perm)) throw new Error('Forbidden'); }
        checkPriv(_priv: number) { if (!this.user._id) throw new Error('PrivilegeError: login required'); }
        close = vi.fn();
        send = vi.fn();
    }
    class ConnectionHandler extends Handler {}
    const schema = () => new Proxy({}, { get: () => (..._args: any[]) => schema() });
    const names = ['ACCEPTED', 'WRONG_ANSWER', 'COMPILING', 'WAITING', 'JUDGING', 'TIME_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED', 'RUNTIME_ERROR', 'SYSTEM_ERROR', 'COMPILE_ERROR', 'FETCHED', 'OUTPUT_LIMIT_EXCEEDED', 'ETC', 'CANCELED', 'HACKED', 'FORMAT_ERROR', 'IGNORED'];
    return {
        ObjectId, Handler, ConnectionHandler, Schema: { object: schema, boolean: schema, number: schema, string: schema, array: schema },
        param: () => () => {},
        Types: { ObjectId: [(value: any) => new ObjectId(value)], Boolean: [(value: unknown) => value === true || value === 'true'], String: [(value: unknown) => String(value)] },
        STATUS: Object.fromEntries(names.map((name, index) => [`STATUS_${name}`, index + 1])),
        PERM: { PERM_EDIT_CONTEST: 1n, PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD: 2n, PERM_VIEW_USER_PRIVATE_INFO: 4n },
        PRIV: { PRIV_USER_PROFILE: 1 },
        BUILTIN_ROLES: {}, DocumentModel: {}, DomainModel: {}, ProblemModel: {}, StorageModel: {},
        SettingModel: { langs: {} }, SystemModel: { get: () => undefined },
        avatar: () => '/avatar.png', getAlphabeticId: (index: number) => String.fromCharCode(65 + index),
        NotFoundError: class extends Error {}, ValidationError: class extends Error {}, ForbiddenError: class extends Error {},
        ContestModel: {
            get: vi.fn(async (domainId: string, tid: any) => ({ ...state.contest, domainId, docId: tid })),
            getStatus: vi.fn(async (_domain: string, _tid: any, uid: number) => state.entries.find(entry => entry.uid === uid)),
            getMultiStatus: vi.fn(() => { const cursor: any = { project: () => cursor, toArray: async () => state.entries }; return cursor; }),
            isDone: () => state.ended, isLocked: () => state.locked,
            canShowScoreboard(this: any, tdoc: any, allowPermOverride = true) { return state.started || (allowPermOverride && (this.user.own(tdoc) || this.user.hasPerm(2n))); },
        },
        RecordModel: { getMulti: vi.fn(() => ({ toArray: async () => state.records })) },
        TaskModel: { count: vi.fn(async () => 2) },
        UserModel: { getList: vi.fn(async (_domainId: string, uids: number[]) => Object.fromEntries(uids.filter((uid) => state.users[uid]).map((uid) => [uid, state.users[uid]]))), getById: vi.fn(async () => state.director) },
    };
});
import { ObjectId, STATUS } from 'hydrooj';
import { apply, loadContestData, loadRoster } from '../index';
const cleanup: (() => unknown)[] = [];
afterEach(async () => { for (const stop of cleanup.splice(0)) await stop(); });

function record(second: number, status = STATUS.STATUS_ACCEPTED, suffix = 1) {
    return { rid: `${Math.floor(second).toString(16)}${suffix.toString(16).padStart(16, '0')}`, pid: 100, status };
}

function setup(saved = new Map<string, any>(), config: Record<string, unknown> = {}, resolverDb = previewDatabase()) {
    const routes = new Map<string, any>();
    let view: any;
    let middleware: any;
    const collection = {
        distinct: async () => [],
        findOne: async ({ _id }: { _id: string }) => saved.get(_id),
        updateOne: async ({ _id }: { _id: string }, { $set }: any) => { saved.set(_id, structuredClone($set)); },
        find: () => { const cursor: any = { project: () => cursor, sort: () => cursor, limit: () => cursor, toArray: async () => [] }; return cursor; },
        deleteOne: async () => {},
    };
    const ctx: any = {
        db: { collection: (name: string) => (name === 'status' ? { find: () => ({ toArray: async () => state.judges }) }
            : name.startsWith('xcpcio.resolver.') || name.startsWith('xcpcio.ccs.') || name.startsWith('xcpcio.screens') || name === 'xcpcio.ceremony' || name.startsWith('xcpcio.live')
            || name === 'xcpcio.presence' || name === 'iplogin' ? resolverDb.db.collection(name as any) : collection) },
        Route: (name: string, _path: string, handler: any) => { routes.set(name, handler); },
        Connection: (name: string, _path: string, handler: any) => { routes.set(name, handler); },
        effect: vi.fn((factory: () => () => unknown) => { const stop = factory(); if (typeof stop === 'function') cleanup.push(stop); }),
        broadcast: vi.fn(),
        i18n: { load: vi.fn() },
        injectUI: vi.fn(),
        inject: (_deps: string[], callback: any) => callback({
            scoreboard: { addView: (_id: string, _name: string, args: any, next: any) => { view = { ...next, args }; } },
            server: { addHandlerLayer: (_name: string, handler: any) => { middleware = handler; } },
        }),
        on: vi.fn(),
    };
    return {
        saved,
        init: () => apply(ctx as Context, { asDefault: true, publicByDefault: true, refreshInterval: 15000, resolverSessionDays: 0, live: true, liveCapture: true, liveCaptureStunPort: 0, profileFields: defaultProfileFields, ...config }),
        settings: () => new (routes.get('contest_xcpcio_plus_settings'))(),
        publicBoard: () => new (routes.get('contest_xcpcio_plus_public'))(),
        middleware: () => middleware,
        view: () => view,
        resolver: (name = '') => new (routes.get(`contest_resolver${name}`))(),
        screens: (name = 's') => new (routes.get(`contest_xcpcio_screen${name}`))(),
        live: (name = '') => new (routes.get(`contest_xcpcio_live${name}`))(),
        monitor: (name = '') => new (routes.get(`contest_xcpcio_monitor${name}`))(),
        overview: (name = '') => new (routes.get(`contest_xcpcio_overview${name}`))(),
        presence: (name = '') => new (routes.get(`contest_xcpcio_presence${name}`))(),
        resolverTables: resolverDb.tables,
        hooks: ctx.on,
        injectUI: ctx.injectUI,
        broadcast: ctx.broadcast,
        route: (name: string) => new (routes.get(name))(),
        routeNames: () => [...routes.keys()],
    };
}

beforeEach(() => {
    state.contest = {
        domainId: 'system', docId: new ObjectId('68ea00000000000000000000'), title: '测试比赛', rule: 'acm',
        beginAt: new Date('2026-10-27T01:00:00Z'), endAt: new Date('2026-10-27T06:00:00Z'),
        lockAt: new Date('2026-10-27T05:00:00Z'), pids: [100], owner: 10,
    };
    const begin = state.contest.beginAt.getTime() / 1000;
    state.entries = [{ uid: 1, unrank: false, journal: [record(begin + 600)] }];
    state.users = { 1: { _id: 1, uname: '测试选手', school: '南京晓庄学院', avatar: '' } };
    state.locked = false; state.ended = true; state.started = true;
});

describe('Hydro 数据与权限', () => {
    it('loads detailed Live verdicts from Hydro journals and keeps scores, identity and frozen runs private', async () => {
        state.ended = false;
        state.locked = true;
        const freeze = state.contest.lockAt.getTime() / 1000;
        const statuses = [STATUS.STATUS_WRONG_ANSWER, STATUS.STATUS_TIME_LIMIT_EXCEEDED, STATUS.STATUS_MEMORY_LIMIT_EXCEEDED,
            STATUS.STATUS_OUTPUT_LIMIT_EXCEEDED, STATUS.STATUS_RUNTIME_ERROR, STATUS.STATUS_COMPILE_ERROR, STATUS.STATUS_SYSTEM_ERROR,
            STATUS.STATUS_IGNORED, STATUS.STATUS_CANCELED, STATUS.STATUS_FORMAT_ERROR, STATUS.STATUS_HACKED, STATUS.STATUS_ETC];
        const journal = statuses.map((status, index) => ({ ...record(freeze - statuses.length + index + 1, status), score: 83 }));
        state.entries[0].journal = [...journal, record(freeze + 1), record(freeze + 2, STATUS.STATUS_JUDGING)];
        const live = () => loadContestData(state.contest, false, false, 'live');
        const before = await live();
        expect(before.submissions.slice(0, statuses.length).map((r) => verdictFor(r.status)?.shortName))
            .toEqual(['WA', 'TLE', 'MLE', 'OLE', 'RE', 'CE', 'SE', 'IGN', 'CANCEL', 'FE', 'HK', 'UNK']);
        expect(before.submissions.slice(-2).map((r) => r.status)).toEqual(['FROZEN', 'FROZEN']);
        expect(JSON.stringify(before)).not.toMatch(/"score":|南京晓庄学院/);
        expect((await loadContestData(state.contest, false)).submissions[0].status).toBe('REJECTED');
        state.ended = true;
        expect((await live()).submissions.at(-2)?.status).toBe('FROZEN');
        state.locked = false;
        state.entries[0].journal.push({ ...journal[0], status: STATUS.STATUS_ACCEPTED });
        const after = await live();
        expect(after.submissions).toHaveLength(before.submissions.length);
        expect(after.submissions[0]).toMatchObject({ submission_id: journal[0].rid, status: 'CORRECT' });
        expect(after.submissions.slice(-2).map((r) => r.status)).toEqual(['CORRECT', 'PENDING']);
    });

    it('机位监控：参赛者的页面上报在线，工作人员与未报名者不上报，管理员看到座位图与告警', async () => {
        const now = Date.now();
        state.ended = false;
        state.contest.beginAt = new Date(now - 3600_000);
        state.contest.endAt = new Date(now + 3600_000);
        state.entries = [{ uid: 3, attend: 1, journal: [] }, { uid: 4, attend: 1, journal: [] }];
        state.users = { 3: { _id: 3, uname: 'a', displayName: '甲队' }, 4: { _id: 4, uname: 'b', displayName: '乙队' } };
        const app = setup();
        app.init();
        const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
        const beat = (user: any, hidden = false) => {
            const handler = app.presence('_beat');
            handler.user = { own: () => false, hasPerm: () => false, ...user };
            handler.request = { ip: '10.0.0.5', headers: { 'user-agent': ua } };
            handler.limitRate = vi.fn();
            return handler.post('system', state.contest.docId, hidden).then(() => handler.response.body);
        };
        expect(await beat({ _id: 3 }, true)).toEqual({ ok: true, interval: 20000 });
        expect(await beat({ _id: 10, own: () => true })).toEqual({ ok: false });
        state.entries = [{ uid: 3, attend: 1, journal: [] }];
        expect(await beat({ _id: 0 })).toEqual({ ok: false });
        expect(await beat({ _id: 9 })).toEqual({ ok: false });
        // A participant's contest page carries the reporting script.
        const after = app.hooks.mock.calls.filter(([name]: [string]) => name === 'handler/after').map(([, listener]: [string, any]) => listener);
        const page: any = { user: { _id: 3, own: () => false, hasPerm: () => false }, UiContext: {}, request: { ip: '10.0.0.5', headers: {} }, response: { body: { tdoc: state.contest } } };
        for (const listener of after) await listener(page);
        expect(page.UiContext.xcpcioPresence).toEqual({ url: `/d/system/contest/${state.contest.docId}/presence/beat`, interval: 20000 });
        state.entries = [{ uid: 3, attend: 1, journal: [] }, { uid: 4, attend: 1, journal: [] }];
        const data = app.presence('_data');
        data.user.own = () => true;
        await data.prepare('system', state.contest.docId);
        await data.get();
        // Old clients may still send hidden=true.
        expect(data.response.body.counts).toMatchObject({ online: 1, never: 1 });
        expect(data.response.body.alerts.map((alert: any) => `${alert.kind}:${alert.uid}`)).toEqual(['never:4']);
        const guest = app.presence('_data');
        await expect(guest.prepare('system', state.contest.docId)).rejects.toThrow('Forbidden');
    });

    it('评测监控：只有比赛管理员可看，按队伍统计组队比赛的提交，实时跟踪每台评测机', async () => {
        state.contest.allowTeam = true;
        const begin = state.contest.beginAt.getTime() / 1000;
        state.entries = [{ uid: -1001, unrank: false, displayName: '星火队', members: [2, 3], journal: [] }];
        state.users = { [-1001]: { _id: -1001, uname: 'team:2:ab', displayName: '星火队' }, 2: { _id: 2, uname: 'lin', displayName: '林澈' }, 3: { _id: 3, uname: 'zhou' } };
        const rid = (second: number, n: number) => `${Math.floor(begin + second).toString(16)}${n.toString(16).padStart(16, '0')}`;
        state.records = [
            { _id: rid(600, 1), status: 1, uid: 2, pid: 100, lang: 'cc', judgeAt: new Date((begin + 610) * 1000) },
            { _id: rid(700, 2), status: 0 /* Hydro STATUS_WAITING (the mock numbers its STATUS differently) */, uid: 3, pid: 100, lang: 'py' },
        ];
        // judge-1 reports (status collection); judge-2 reported but is not connected now.
        state.judges = [
            { mid: 'mid-1', type: 'judge', updateAt: new Date(), memory: { total: 8, active: 2 }, load: { currentLoad: 35 }, osinfo: { hostname: 'judge-1' } },
            { mid: 'mid-2', type: 'judge', updateAt: new Date(Date.now() - 10 * 60_000), osinfo: { hostname: 'judge-2' } },
        ];
        const app = setup(); await app.init();
        const guest = app.monitor('_data'); guest.user._id = 0;
        await expect(guest.prepare('system', state.contest.docId)).rejects.toThrow('PrivilegeError');
        await expect(app.monitor('_data').prepare('system', state.contest.docId)).rejects.toThrow('Forbidden');
        const page = app.monitor(); page.user.own = () => true;
        await page.prepare('system', state.contest.docId); await page.get();
        expect(JSON.parse(page.response.body.runtimeJson).dataUrl).toBe(`/d/system/contest/${state.contest.docId}/monitor/data`);

        // A judge daemon connects: Hydro's JudgeConnectionHandler as the framework hands it over.
        const listener = (name: string) => app.hooks.mock.calls.filter(([event]: [string]) => event === name).map(([, handler]: [string, any]) => handler)[0];
        const seen: unknown[] = [];
        let finish = () => {};
        const daemon = {
            category: '#judge', user: { uname: 'judge' }, request: { ip: '10.0.0.2' },
            message: (msg: unknown) => { seen.push(msg); },
            newTask: (_task: Record<string, unknown>) => new Promise<void>((resolve) => { finish = resolve; }),
        };
        listener('connection/active')(daemon);
        daemon.message({ key: 'config', concurrency: 3 });
        daemon.message({ key: 'status', info: { mid: 'mid-1' } });
        const running = daemon.newTask({ rid: rid(700, 2), domainId: 'system', uid: 3, pid: 100, lang: 'py', contest: state.contest.docId, code: 'print(1)' });
        daemon.message({ key: 'next', rid: rid(700, 2), status: 20, case: { status: 1 } });
        expect(seen).toHaveLength(3); // Hydro still gets every message
        const data = app.monitor('_data'); data.user.own = () => true;
        await data.prepare('system', state.contest.docId); await data.get();
        const body = JSON.parse(data.response.body);
        expect(body.summary).toMatchObject({ total: 2, accepted: 1, pending: 1, queueLength: 2, judgesOnline: 1, activeTasks: 1, capacity: 3 });
        expect(body.pending[0]).toMatchObject({ team: '星火队', problem: 'A', lang: 'py' });
        expect(body.machines.map((machine: any) => [machine.name, machine.state, machine.account, machine.ip, machine.metrics?.cpu ?? null])).toEqual([
            ['judge-1', 'busy', 'judge', '10.0.0.2', 35], ['judge-2', 'offline', null, null, null],
        ]);
        expect(body.live).toEqual([expect.objectContaining({ judge: 'judge-1', inContest: true, team: '星火队', problem: 'A', status: '评测中', casesDone: 1 })]);
        expect(body.alerts.map((alert: any) => alert.text)).toContain('评测机 judge-2 没有连接到 Hydro（10 分钟前还有上报）');
        daemon.message({ key: 'end', rid: rid(700, 2), status: 1, time: 20, memory: 512 });
        finish(); await running;
        listener('connection/close')(daemon);

        // With the hydrojudge addon loaded, Hydro itself judges: listed online with this server's live numbers.
        const hydro = globalThis as { Hydro?: unknown };
        const previous = hydro.Hydro;
        hydro.Hydro = { version: { hydrojudge: '5.1.0' } };
        try {
            await new Promise((resolve) => setTimeout(resolve, 2100)); // past the shared 2 s cache
            const local = app.monitor('_data'); local.user.own = () => true;
            await local.prepare('system', state.contest.docId); await local.get();
            const machines = JSON.parse(local.response.body).machines;
            expect(machines[0]).toMatchObject({ kind: 'builtin', online: true, metrics: { live: true } });
            expect(machines.find((machine: any) => machine.name === 'judge-1')).toMatchObject({ state: 'offline', totalJudged: 1 });
        } finally {
            hydro.Hydro = previous;
        }
    }, 10_000);
    it('系统管理：用户配置排在“导入用户”下方，评测机控制与批量重测追加到控制面板', async () => {
        const app = setup(); await app.init();
        expect(app.routeNames()).toEqual(expect.arrayContaining([
            'manage_xcpcio_users', 'manage_xcpcio_users_data', 'manage_xcpcio_judges', 'manage_xcpcio_judges_data', 'manage_xcpcio_rejudge', 'manage_xcpcio_rejudge_data', 'manage_xcpcio_rejudge_history', 'manage_xcpcio_printers', 'manage_xcpcio_printers_data', 'xcpcio_print_heartbeat', 'xcpcio_print_next', 'xcpcio_print_report',
        ]));
        const calls = app.injectUI.mock.calls;
        expect(calls).toContainEqual(['ControlPanel', 'manage_xcpcio_users', { before: 'manage_user_priv' }, undefined]);
        expect(calls.map((call: unknown[]) => call[1])).toEqual(expect.arrayContaining(['manage_xcpcio_judges', 'manage_xcpcio_rejudge']));
        // 打印服务器管理 right below 评测机控制.
        expect(calls).toContainEqual(['ControlPanel', 'manage_xcpcio_printers', { before: 'manage_xcpcio_rejudge' }, undefined]);
        // Judge daemons are watched on connect so dispatch rules apply before they start taking tasks.
        expect(app.hooks.mock.calls.filter(([name]: [string]) => name === 'connection/active').length).toBeGreaterThanOrEqual(2);
        // Rejudged records' new results are captured for the rejudge history.
        expect(app.hooks.mock.calls.filter(([name]: [string]) => name === 'record/judge').length).toBeGreaterThanOrEqual(2);
    });
    it('赛况总览：只有比赛管理员可看，封榜期间也给实时数字', async () => {
        const begin = state.contest.beginAt.getTime() / 1000;
        state.locked = true; state.ended = false;
        state.entries = [
            { uid: 1, unrank: false, journal: [record(begin + 600)] },
            { uid: 2, unrank: true, journal: [record(begin + 4.5 * 3600, STATUS.STATUS_ACCEPTED, 2)] }, // after the freeze
        ];
        state.users[2] = { _id: 2, uname: '打星', school: '东南大学', avatar: '' };
        state.judges = [{ mid: 'judge-1', type: 'judge', updateAt: new Date(), memory: { total: 8, active: 2 }, load: { currentLoad: 20 } }];
        const app = setup(); await app.init();
        expect(app.routeNames()).toEqual(expect.arrayContaining(['contest_xcpcio_overview', 'contest_xcpcio_overview_data']));
        const guest = app.overview('_data'); guest.user._id = 0;
        await expect(guest.prepare('system', state.contest.docId)).rejects.toThrow('PrivilegeError');
        await expect(app.overview('_data').prepare('system', state.contest.docId)).rejects.toThrow('Forbidden');
        const page = app.overview(); page.user.own = () => true;
        await page.prepare('system', state.contest.docId); await page.get();
        expect(page.response.template).toBe('xcpcio_overview.html');
        expect(JSON.parse(page.response.body.runtimeJson).dataUrl).toBe(`/d/system/contest/${state.contest.docId}/overview/data`);
        const data = app.overview('_data'); data.user.hasPerm = () => true;
        await data.prepare('system', state.contest.docId); await data.get();
        const body = JSON.parse(data.response.body);
        expect(body).toMatchObject({ title: '测试比赛', teams: 2, officialTeams: 1, unofficialTeams: 1, schools: 2, submissions: 2, accepted: 2, solvedTeams: 2 });
        expect(body.topTeams).toEqual([{ rank: 1, name: '测试选手', school: '南京晓庄学院', solved: 1, penaltyMinutes: 10 }]);
        // Machine pressure: this server live, judges from Hydro's status collection, the whole judge queue.
        expect(body.system.host.cores).toBeGreaterThan(0);
        expect(body.system.queue).toBe(2);
        expect(body.system.judges.map((judge: { name: string }) => judge.name)).toEqual(['judge-1']);
        state.contest.rule = 'oi';
        const oi = app.overview(); oi.user.own = () => true;
        await expect(oi.prepare('system', state.contest.docId)).rejects.toThrow('ACM');
    });
    it('组队比赛：队伍用公开队名，队员显示显示名，单人参赛仍是一人一队', async () => {
        state.contest.allowTeam = true;
        const begin = state.contest.beginAt.getTime() / 1000;
        state.entries = [
            { uid: -1001, unrank: false, displayName: '星火队', members: [2, 3], journal: [record(begin + 600)] },
            { uid: 1, unrank: false, journal: [record(begin + 900, STATUS.STATUS_ACCEPTED, 2)] },
        ];
        state.users = {
            [-1001]: { _id: -1001, uname: 'team:2:ab12cd', displayName: '星火队' },
            1: { _id: 1, uname: '测试选手', school: '南京晓庄学院', avatar: '' },
            2: { _id: 2, uname: 'lin', displayName: '林澈', school: '东南大学' },
            3: { _id: 3, uname: 'zhou', displayName: '周宁', school: '东南大学' },
        };
        const pub = await loadContestData(state.contest as Tdoc, false);
        expect(pub.teams).toEqual([
            { team_id: '-1001', name: '星火队', organization: undefined, group: ['official'], school_key: 's1', members: ['林澈', '周宁'] },
            { team_id: '1', name: '测试选手', organization: undefined, group: ['official'], school_key: 's2' },
        ]);
        expect(pub.submissions.map((item) => item.team_id)).toEqual(['-1001', '1']);
        const full = await loadContestData(state.contest as Tdoc, false, true);
        expect(full.teams[0]).toMatchObject({ organization: '东南大学', members: ['林澈', '周宁'] });
        const roster = await loadRoster(state.contest as Tdoc);
        expect(roster[0]).toMatchObject({ team_id: '-1001', name: '星火队', organization: '东南大学', members: ['林澈', '周宁'] });
        // Not a team contest: members are not loaded, nobody gets a member list.
        state.contest.allowTeam = false;
        expect((await loadContestData(state.contest as Tdoc, false)).teams.every((team) => !team.members)).toBe(true);
    });
    it('匿名用户可访问公开 HTML 和 JSON，不需要域或比赛权限', async () => {
        const app = setup(); await app.init(); const handler = app.publicBoard();
        handler.user._id = 0;
        expect(handler.noCheckPermView).toBe(true);
        await handler.prepare('system', state.contest.docId);
        await handler.get('system', false, false);
        expect(handler.response.template).toBe('xcpcio_plus_board.html');
        expect(handler.response.body.settingsUrl).toBeNull();
        expect(JSON.parse(handler.response.body.runtimeJson).dataSource).toContain('/xcpcio-public?json=true');
        await handler.get('system', true, false);
        expect(handler.response.body.teams[0].team_id).toBe('1');
    });
    it('公开接口拒绝实时查询，封榜 JSON 不包含隐藏结果或管理资料', async () => {
        const app = setup(); await app.init(); const handler = app.publicBoard();
        state.locked = true; state.entries[0].journal = [record(state.contest.lockAt.getTime() / 1000 + 10)];
        state.users[1].group = ['内部用户组']; state.users[1].grade = '2026'; state.users[1].getFields = () => ['grade'];
        await handler.prepare('system', state.contest.docId);
        await expect(handler.get('system', true, true)).rejects.toThrow();
        await handler.get('system', true, false);
        expect(handler.response.body.submissions[0].status).toBe('FROZEN');
        expect(JSON.stringify(handler.response.body)).not.toContain('内部用户组');
        expect(handler.response.body.teams[0].fields).toBeUndefined();
        expect((await loadRoster(state.contest))[0].fields['profile:grade']).toEqual(['2026']);
    });
    it('关闭公开访问后匿名链接失效，管理权限仍受保护', async () => {
        const app = setup(); await app.init(); const admin = app.settings(); admin.user.own = () => true;
        await admin.prepare('system', state.contest.docId);
        await admin.post('system', JSON.stringify({ ...defaultSettings, publicAccess: false }));
        await expect(app.publicBoard().prepare('system', state.contest.docId)).rejects.toThrow();
        await expect(app.settings().prepare('system', state.contest.docId)).rejects.toThrow('Forbidden');
    });
    it('默认榜单在原生权限检查前跳转，保留查询和域', async () => {
        const app = setup(); await app.init(); const redirect = vi.fn(); const next = vi.fn(() => { throw new Error('Native checker reached'); });
        const response: any = { redirect: null };
        const context: any = { path: `/contest/${state.contest.docId}/scoreboard`, method: 'GET', querystring: 'group=official&json=true', HydroContext: { domain: { _id: 'private' }, args: { domainId: 'spoofed' }, response }, redirect };
        await app.middleware()(context, next);
        expect(next).not.toHaveBeenCalled();
        // Hydro's response layer sends the 302; a direct ctx.redirect() would be overwritten with `200 {}`.
        expect(redirect).not.toHaveBeenCalled();
        expect(response.redirect).toBe(`/d/private/contest/${state.contest.docId}/xcpcio-public?group=official&json=true`);
        expect(context.handler).toBeDefined();
    });
    it('非 ACM、其他视图、实时访问和关闭默认替换不接管', async () => {
        const app = setup(new Map(), { asDefault: false }); await app.init(); const next = vi.fn();
        const context = { path: `/contest/${state.contest.docId}/scoreboard`, method: 'GET', querystring: '', HydroContext: { domain: { _id: 'system' }, args: { domainId: 'system' } }, redirect: vi.fn() };
        await app.middleware()(context, next); expect(next).toHaveBeenCalledOnce();
        const enabled = setup(); await enabled.init();
        for (const change of [{ querystring: 'realtime=true' }, { method: 'POST' }, { path: `${context.path}/csv` }, { pendingError: new Error('Unknown domain') }]) {
            next.mockClear(); await enabled.middleware()({ ...context, ...change }, next); expect(next).toHaveBeenCalledOnce();
        }
        state.contest.rule = 'oi'; next.mockClear(); await enabled.middleware()(context, next); expect(next).toHaveBeenCalledOnce();
    });
    it('公开页不把受限比赛的分配信息带给浏览器', async () => {
        state.contest.assign = ['内部']; state.contest.content = '内部题面';
        const app = setup(); await app.init(); const handler = app.publicBoard();
        await handler.prepare('system', state.contest.docId); await handler.get('system');
        expect(handler.response.body.tdoc.assign).toBeUndefined();
        expect(handler.response.body.tdoc.content).toBeUndefined();
    });
    it('查询参数不能改变管理设置和公开入口所属的域', async () => {
        const app = setup(); await app.init();
        const admin = app.settings(); admin.user.own = () => true;
        await admin.prepare('spoofed', state.contest.docId);
        expect(admin.tdoc.domainId).toBe('system');
        const guest = app.publicBoard(); await guest.prepare('spoofed', state.contest.docId);
        expect(guest.tdoc.domainId).toBe('system');
    });
    it('每场比赛可关闭替换，或在不公开时跳转回受保护视图', async () => {
        const app = setup(); await app.init(); const admin = app.settings(); admin.user.own = () => true;
        await admin.prepare('system', state.contest.docId);
        const next = vi.fn(); const response: any = { redirect: null };
        const context = { path: `/contest/${state.contest.docId}/scoreboard`, method: 'GET', querystring: '', HydroContext: { domain: { _id: 'system' }, args: { domainId: 'system' }, response }, redirect: vi.fn() };
        await admin.post('system', JSON.stringify({ ...defaultSettings, replaceNative: false }));
        await app.middleware()(context, next); expect(next).toHaveBeenCalledOnce();
        await admin.post('system', JSON.stringify({ ...defaultSettings, publicAccess: false }));
        await app.middleware()(context, next);
        expect(response.redirect).toBe(`/d/system/contest/${state.contest.docId}/scoreboard/xcpcio-plus`);
    });
    it('封榜时隐藏边界之后的结果（边界当秒与 Hydro 一样可见），实时模式保留结果', async () => {
        const lock = state.contest.lockAt.getTime() / 1000;
        state.entries[0].journal = [record(lock), record(lock + 1, STATUS.STATUS_ACCEPTED, 2)];
        state.locked = true;
        expect((await loadContestData(state.contest as Tdoc, false)).submissions.map((record) => record.status)).toEqual(['CORRECT', 'FROZEN']);
        expect((await loadContestData(state.contest as Tdoc, true)).submissions.every((record) => record.status === 'CORRECT')).toBe(true);
    });
    it('重判使用最新记录，同一提交不重复计罚', async () => {
        const first = state.entries[0].journal[0];
        state.entries[0].journal.push({ ...first, status: STATUS.STATUS_WRONG_ANSWER });
        const result = await loadContestData(state.contest as Tdoc, false);
        expect(result.submissions).toHaveLength(1); expect(result.submissions[0].status).toBe('WRONG_ANSWER');
    });
    it('过滤赛前、结束边界和非本场题目的提交', async () => {
        const start = state.contest.beginAt.getTime() / 1000;
        const end = state.contest.endAt.getTime() / 1000;
        state.entries[0].journal.push(record(start - 1, STATUS.STATUS_ACCEPTED, 2), record(end, STATUS.STATUS_ACCEPTED, 3), { ...record(start + 100, STATUS.STATUS_ACCEPTED, 4), pid: 999 });
        expect((await loadContestData(state.contest as Tdoc, false)).submissions).toHaveLength(1);
    });
    it('未保存设置的比赛默认不公开，需在插件配置或比赛设置中开启', async () => {
        const app = setup(new Map(), { publicByDefault: false }); await app.init();
        await expect(app.publicBoard().prepare('system', state.contest.docId)).rejects.toThrow();
        const admin = app.settings(); admin.user.own = () => true;
        await admin.prepare('system', state.contest.docId);
        await admin.post('system', JSON.stringify({ ...defaultSettings, publicAccess: true }));
        await app.publicBoard().prepare('system', state.contest.docId);
    });
    it('与 Hydro 原生规则一致地计罚：系统错误与 Hack 计罚，格式错误不计', async () => {
        const begin = state.contest.beginAt.getTime() / 1000;
        state.entries[0].journal = [record(begin + 60, STATUS.STATUS_SYSTEM_ERROR, 2), record(begin + 70, STATUS.STATUS_HACKED, 3),
            record(begin + 80, STATUS.STATUS_FORMAT_ERROR, 4), record(begin + 90, STATUS.STATUS_ETC, 5)];
        expect((await loadContestData(state.contest as Tdoc, false)).submissions.map((item) => item.status))
            .toEqual(['JUDGEMENT_FAILED', 'HACKED', 'PRESENTATION_ERROR', 'JUDGEMENT_FAILED']);
        state.ended = false;
        expect((await loadContestData(state.contest as Tdoc, false)).submissions[1].status).toBe('REJECTED');
    });
    it('个人计时比赛与 Hydro 原生一致，从比赛开始时间计时', async () => {
        const begin = state.contest.beginAt.getTime() / 1000;
        state.contest.duration = 1;
        state.entries[0].startAt = new Date((begin + 3600) * 1000);
        state.entries[0].journal = [record(begin + 3600 + 600), record(begin + 3600 + 3700, STATUS.STATUS_ACCEPTED, 2)];
        const result = await loadContestData(state.contest as Tdoc, false);
        expect(result.submissions.map((item) => item.timestamp)).toEqual([4200000, 7300000]);
    });
    it('保存时移除已退出比赛的成员，而不是拒绝整份设置', async () => {
        const app = setup(); await app.init(); const handler = app.settings(); handler.user.own = () => true;
        await handler.prepare('system', state.contest.docId);
        await handler.post('system', JSON.stringify({ ...defaultSettings, manualBoards: [{ id: 'a', name: '甲', teamIds: ['1', '999'] }] }));
        expect([...app.saved.values()][0].settings.manualBoards[0].teamIds).toEqual(['1']);
    });
    it('公开 JSON 在短时间内复用计算结果，保存设置后立即失效', async () => {
        const app = setup(); await app.init(); const guest = app.publicBoard();
        await guest.prepare('system', state.contest.docId);
        const { UserModel } = await import('hydrooj');
        const before = vi.mocked(UserModel.getList).mock.calls.length;
        await guest.get('system', true, false); await guest.get('system', true, false);
        expect(vi.mocked(UserModel.getList).mock.calls.length).toBe(before + 1);
        const admin = app.settings(); admin.user.own = () => true;
        await admin.prepare('system', state.contest.docId);
        await admin.post('system', JSON.stringify({ ...defaultSettings, publicAccess: true, schoolBoards: false }));
        const after = vi.mocked(UserModel.getList).mock.calls.length;
        const fresh = app.publicBoard(); await fresh.prepare('system', state.contest.docId); await fresh.get('system', true, false);
        expect(vi.mocked(UserModel.getList).mock.calls.length).toBe(after + 1);
        expect(Object.values(fresh.response.body.contest.group)).not.toContain('南京晓庄学院榜');
    });
    it('选手名对所有观众显示显示名；学校默认只给有私有资料权限的用户，开启后才对所有观众显示', async () => {
        state.users[1].displayName = '张三';
        const saved = new Map([[`system/${state.contest.docId}`, { settings: { ...defaultSettings, publicAccess: true, schoolBoards: true } }]]);
        const app = setup(saved); await app.init(); const guest = app.publicBoard();
        await guest.prepare('system', state.contest.docId); await guest.get('system', true, false);
        expect(guest.response.body.teams[0].name).toBe('张三');
        expect(JSON.stringify(guest.response.body)).not.toMatch(/测试选手|南京晓庄学院/);
        expect(guest.response.body.contest.options.enable_organization).toBe(false);
        const member = app.settings();
        await app.view().display.call(member, { tdoc: state.contest, realtime: false, json: true });
        expect(member.response.body.teams[0].name).toBe('张三');
        expect(JSON.stringify(member.response.body)).not.toContain('南京晓庄学院');
        member.user.hasPerm = (perm: bigint) => perm === 4n;
        await app.view().display.call(member, { tdoc: state.contest, realtime: false, json: true });
        expect(member.response.body.teams[0].name).toBe('张三');
        expect(Object.values(member.response.body.contest.group)).toContain('南京晓庄学院榜');
        const admin = app.settings(); admin.user.own = () => true;
        await admin.prepare('system', state.contest.docId);
        await admin.post('system', JSON.stringify({ ...defaultSettings, publicAccess: true, showIdentity: true }));
        const open = app.publicBoard(); await open.prepare('system', state.contest.docId); await open.get('system', true, false);
        expect(open.response.body.teams[0]).toMatchObject({ name: '张三', organization: '南京晓庄学院' });
    });
    it('开赛前公开榜不可见，有隐藏榜权限的用户除外', async () => {
        state.started = false;
        const app = setup(); await app.init();
        await expect(app.publicBoard().prepare('system', state.contest.docId)).rejects.toThrow('比赛开始后');
        const owner = app.publicBoard(); owner.user.own = () => true;
        await owner.prepare('system', state.contest.docId);
    });
    it('缺少公开与身份字段的旧设置按关闭处理', async () => {
        const { publicAccess, showIdentity, ...legacy } = defaultSettings;
        const app = setup(new Map([[`system/${state.contest.docId}`, { settings: legacy }]])); await app.init();
        await expect(app.publicBoard().prepare('system', state.contest.docId)).rejects.toThrow();
    });
    it('忽略与未知状态和 Hydro 一样计罚', async () => {
        const begin = state.contest.beginAt.getTime() / 1000;
        state.entries[0].journal = [record(begin + 60, STATUS.STATUS_IGNORED, 2), record(begin + 70, 999 as never, 3)];
        expect((await loadContestData(state.contest as Tdoc, false)).submissions.map((item) => item.status)).toEqual(['REJECTED', 'JUDGEMENT_FAILED']);
    });
    it('封榜期间只给有权限的用户显示实时榜入口，实时榜提供返回入口', async () => {
        const app = setup(); await app.init(); state.locked = true;
        const guest = app.publicBoard(); await guest.prepare('system', state.contest.docId); await guest.get('system');
        expect(guest.response.body.realtimeUrl).toBeNull();
        const owner = app.publicBoard(); owner.user.own = () => true;
        await owner.prepare('system', state.contest.docId); await owner.get('system');
        expect(owner.response.body.realtimeUrl).toContain('/scoreboard/xcpcio-plus?realtime=true');
        await app.view().display.call(owner, { tdoc: state.contest, realtime: true, json: false });
        expect(owner.response.body.realtimeUrl).toBeNull();
        expect(owner.response.body.frozenUrl).toContain('/scoreboard/xcpcio-plus');
        state.locked = false; await owner.get('system');
        expect(owner.response.body.realtimeUrl).toBeNull();
    });
    it('其他进程保存设置后，本进程的公开缓存随设置版本失效', async () => {
        const saved = new Map<string, any>();
        const first = setup(saved); await first.init(); const second = setup(saved); await second.init();
        const admin = second.settings(); admin.user.own = () => true;
        await admin.prepare('system', state.contest.docId);
        await admin.post('system', JSON.stringify({ ...defaultSettings, publicAccess: true, manualBoards: [{ id: 'a', name: '甲组', teamIds: [] }] }));
        const before = first.publicBoard(); await before.prepare('system', state.contest.docId); await before.get('system', true, false);
        expect(Object.values(before.response.body.contest.group)).toContain('甲组');
        await new Promise((resolve) => { setTimeout(resolve, 5); });
        await admin.post('system', JSON.stringify({ ...defaultSettings, publicAccess: true, manualBoards: [{ id: 'a', name: '乙组', teamIds: [] }] }));
        const after = first.publicBoard(); await after.prepare('system', state.contest.docId); await after.get('system', true, false);
        expect(Object.values(after.response.body.contest.group)).toContain('乙组');
    });
    it('保存时拒绝重名的手动分榜，以及与自动分榜同名的手动分榜', async () => {
        const app = setup(); await app.init(); const admin = app.settings(); admin.user.own = () => true;
        await admin.prepare('system', state.contest.docId);
        const post = (names: string[], extra = {}) => admin.post('system', JSON.stringify({ ...defaultSettings, schoolBoards: true, participationBoards: true, ...extra,
            manualBoards: names.map((name, index) => ({ id: `b${index}`, name, teamIds: [] })) }));
        await expect(post(['新生榜', ' 新生榜'])).rejects.toThrow();
        await expect(post(['正式参赛'])).rejects.toThrow();
        await expect(post(['南京晓庄学院榜'])).rejects.toThrow();
        await post(['南京晓庄学院榜'], { schoolBoards: false });
        // Settings saved before the rule existed must still load.
        app.saved.set(`system/${state.contest.docId}`, { settings: { ...defaultSettings, manualBoards: [{ id: 'x', name: '同名', teamIds: [] }, { id: 'y', name: '同名', teamIds: [] }] } });
        await admin.get();
        expect(JSON.parse(admin.response.body.settingsJson).settings.manualBoards).toHaveLength(2);
    });
    it('题目颜色取自 Hydro 的气球颜色，未设置或无效时使用占位色', async () => {
        const { problemColor, UNSET_PROBLEM_COLOR } = await import('../lib/board');
        state.contest.pids = [100, 101, 102, 103];
        state.contest.balloon = { 100: { color: '#FF8800', name: '橙' }, 101: 'abc', 102: { color: 'not-a-colour', name: '' } };
        const colors = (await loadContestData(state.contest as Tdoc, false)).contest.balloon_color as { background_color: string }[];
        expect(colors.map((item) => item.background_color)).toEqual(['#ff8800', '#aabbcc', UNSET_PROBLEM_COLOR, UNSET_PROBLEM_COLOR]);
        expect(problemColor({ color: ' 1e90ff ' })).toBe('#1e90ff');
    });
    it('比赛进行中只有管理人员能看到提交页，结束后对所有人开放；榜单数据不含头像', async () => {
        const app = setup(); await app.init(); state.ended = false;
        const guest = app.publicBoard(); await guest.prepare('system', state.contest.docId); await guest.get('system');
        expect(guest.response.body.hideSubmissions).toBe(true);
        const owner = app.publicBoard(); owner.user.own = () => true;
        await owner.prepare('system', state.contest.docId); await owner.get('system');
        expect(owner.response.body.hideSubmissions).toBe(false);
        state.ended = true; await guest.get('system');
        expect(guest.response.body.hideSubmissions).toBe(false);
        const data = await loadContestData(state.contest as Tdoc, false, true);
        expect(data.teams[0].badge).toBeUndefined();
        expect(data.contest.badge).toBeUndefined();
    });
    it('普通参赛者不能修改设置或读取实时榜', async () => {
        const app = setup(); await app.init();
        const handler = app.settings();
        await expect(handler.prepare('system', state.contest.docId)).rejects.toThrow('Forbidden');
        await expect(app.view().display.call(handler, { tdoc: state.contest, realtime: true, json: true })).rejects.toThrow('Forbidden');
    });
    it('所有者可以保存设置，插件重新加载后仍然生效', async () => {
        const app = setup(); await app.init();
        const handler = app.settings(); handler.user.own = () => true;
        await handler.prepare('system', state.contest.docId);
        await handler.post('system', JSON.stringify({ ...defaultSettings, unofficialFirstSolve: true, medals: { gold: 0, silver: 1, bronze: 0 }, manualBoards: [{ id: 'new', name: '新生榜', teamIds: ['1'] }] }));
        const restarted = setup(app.saved); await restarted.init();
        await restarted.view().display.call(handler, { tdoc: state.contest, realtime: false, json: true });
        expect(handler.response.body.contest.group['manual-new']).toBe('新生榜');
        expect(handler.response.body.contest.medal.all).toMatchObject({ gold: 0, silver: 1, bronze: 0 });
        expect(handler.response.addHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
        const manager = restarted.settings(); manager.user.own = () => true;
        await manager.prepare('system', state.contest.docId); await manager.get();
        expect(JSON.parse(manager.response.body.settingsJson).settings.unofficialFirstSolve).toBe(true);
    });
    it('同 ID 比赛在不同域中使用各自设置', async () => {
        const app = setup(); await app.init();
        const handler = app.settings(); handler.user.own = () => true;
        await handler.prepare('system', state.contest.docId);
        await handler.post('system', JSON.stringify({ ...defaultSettings, schoolBoards: true }));
        handler.domain._id = 'another';
        await handler.prepare('another', state.contest.docId);
        await handler.get();
        expect(JSON.parse(handler.response.body.settingsJson).settings.schoolBoards).toBe(false);
    });
    it('HTML 输出使用正确的刷新变量，并保留实时权限标识', async () => {
        const app = setup(); await app.init(); const handler = app.settings(); handler.user.own = () => true;
        await app.view().display.call(handler, { tdoc: state.contest, realtime: true, json: false });
        expect(JSON.parse(handler.response.body.runtimeJson).dataSource).toContain('realtime=true');
        expect(handler.response.body.realtime).toBe(true);
    });
});

describe('Hydro Resolver routes', () => {
    const tid = () => state.contest.docId;
    const config = JSON.stringify({ freezeMode: 'custom', freezeAtSeconds: 3000 });
    it('requires login and current ownership or edit permission, even with hidden-scoreboard permission', async () => {
        const app = setup(); await app.init();
        const anonymous = app.resolver(); anonymous.user._id = 0; anonymous.user.own = () => true;
        await expect(anonymous.prepare('system', tid())).rejects.toThrow('请登录');
        const viewer = app.resolver(); viewer.user.hasPerm = (perm: bigint) => perm === 2n;
        await expect(viewer.prepare('system', tid())).rejects.toThrow('Forbidden');
        const owner = app.resolver(); owner.user.own = () => true;
        await owner.prepare('spoofed', tid()); await owner.get();
        expect(JSON.parse(owner.response.body.runtimeJson).base).toBe(`/d/system/contest/${tid()}/resolver`);
        expect(owner.response.addHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
        const editor = app.resolver(); editor.user.hasPerm = (perm: bigint) => perm === 1n;
        await editor.prepare('system', tid());
        state.contest.rule = 'oi';
        await expect(owner.prepare('system', tid())).rejects.toThrow('ACM');
    });
    it('captures final staff verdicts during rehearsal while public data stays masked', async () => {
        state.ended = false; state.locked = true;
        state.entries[0].journal = [record(state.contest.lockAt.getTime() / 1000 + 20, STATUS.STATUS_HACKED)];
        const app = setup(); await app.init(); const preview = app.resolver('_preview'); preview.user.own = () => true;
        await preview.prepare('system', tid()); await preview.post('system', config);
        expect(preview.response.body.config.rehearsal).toBe(true);
        expect((await preview.payload(config)).snapshot.submissions[0]).toMatchObject({ status: 'failed', penalty: true });
        expect([...app.resolverTables.values()].every((table) => table.size === 0)).toBe(true);
        expect((await loadContestData(state.contest, false)).submissions[0].status).toBe('FROZEN');
    });
    it('checks ownership, domain, revoked permissions and control token on every session request', async () => {
        const app = setup(); await app.init(); const creator = app.resolver('_sessions'); creator.user.own = () => true;
        await creator.prepare('system', tid()); await creator.post('system', config);
        const sid = creator.response.body.id;
        const play = app.resolver('_play'); play.user.own = () => true;
        await play.prepare('system', tid(), sid); await play.get();
        const token = JSON.parse(play.response.body.runtimeJson).controlToken;
        const other = app.resolver('_data'); other.user._id = 11; other.user.own = () => true;
        await expect(other.prepare('system', tid(), sid)).rejects.toThrow('不属于');
        const foreign = app.resolver('_data'); foreign.domain._id = 'foreign'; foreign.user.own = () => true;
        await expect(foreign.prepare('system', tid(), sid)).rejects.toThrow('不属于');
        const revoked = app.resolver('_data'); revoked.request.headers['x-resolver-control'] = token;
        await expect(revoked.prepare('system', tid(), sid)).rejects.toThrow('Forbidden');
        const data = app.resolver('_data'); data.user.own = () => true;
        await data.prepare('system', tid(), sid);
        await expect(data.get()).rejects.toThrow('令牌');
        data.request.headers['x-resolver-control'] = token;
        await data.get(); expect(data.response.body.steps.length).toBeGreaterThan(0);
        const list = app.resolver('_sessions'); list.user.own = () => true;
        await list.prepare('system', tid()); await list.get();
        expect(JSON.stringify(list.response.body)).not.toContain(token);
        const remove = app.resolver('_delete'); remove.user.own = () => true;
        await remove.prepare('system', tid(), sid); await remove.post();
        expect([...app.resolverTables.values()].every((table) => table.size === 0)).toBe(true);
    });
    it('manages big-screen links: managers only, one shared token, frozen public data, revocable', async () => {
        state.locked = true;
        state.entries[0].journal = [record(state.contest.lockAt.getTime() / 1000 + 20)];
        const app = setup(); await app.init();
        await expect(app.screens().prepare('system', tid())).rejects.toThrow('Forbidden');
        const admin = app.screens(); admin.user.own = () => true;
        await admin.prepare('system', tid()); await admin.get();
        const runtime = JSON.parse(admin.response.body.runtimeJson);
        const token = runtime.linkBase.split('/').pop();
        expect(runtime.linkBase).toBe(`/d/system/contest/${tid()}/screen/${token}`);
        const again = app.screens(); again.user.own = () => true; await again.prepare('system', tid()); await again.get();
        expect(JSON.parse(again.response.body.runtimeJson).linkBase).toBe(runtime.linkBase);
        await admin.post('system', JSON.stringify({ items: { message: { text: '封榜' } } }));
        expect(admin.response.body.config.items.message.text).toBe('封榜');

        const guest = app.screens('_data'); guest.user._id = 0;
        expect(guest.noCheckPermView).toBe(true);
        await expect(guest.prepare('system', tid(), 'x'.repeat(48), 'scoreboard')).rejects.toThrow('作废');
        await expect(guest.prepare('system', tid(), token, 'nope')).rejects.toThrow('作废');
        await guest.prepare('system', tid(), token, 'scoreboard'); await guest.get('system');
        const body = guest.response.body;
        expect(body.item).toEqual({ type: 'scoreboard' });
        expect(body.data.frozen).toBe(true);
        expect(body.data.results['1'][0].status).toBe('pending');
        expect(JSON.stringify(body)).not.toMatch(/张三|南京晓庄学院/);
        const queue = app.screens('_data'); await queue.prepare('system', tid(), token, 'queue'); await queue.get('system');
        expect(queue.response.body.item).toEqual({ type: 'queue', variant: 'queue' });
        expect(queue.response.body.data.contest.submissions[0]).toMatchObject({ teamId: '1', status: 'pending' });
        const message = app.screens('_data'); await message.prepare('system', tid(), token, 'message'); await message.get('system');
        expect(message.response.body.item).toEqual({ type: 'message', text: '封榜' });

        state.started = false;
        const early = app.screens('_data'); await early.prepare('system', tid(), token, 'scoreboard'); await early.get('system');
        expect(early.response.body.notice).toBe('比赛尚未开始');

        await admin.postResetToken();
        expect(admin.response.body.linkBase).not.toContain(token);
        await expect(app.screens('_view').prepare('system', tid(), token, 'clock')).rejects.toThrow('作废');
    });
    it('runs the live module: console for managers only, a revocable token for OBS, public data', async () => {
        state.locked = true;
        state.entries[0].journal = [record(state.contest.lockAt.getTime() / 1000 + 20)];
        const app = setup(); await app.init();
        const base = `/d/system/contest/${tid()}`;
        await expect(app.live().prepare('system', tid())).rejects.toThrow('Forbidden');
        const guest = app.live(); guest.user._id = 0;
        await expect(guest.prepare('system', tid())).rejects.toThrow('PrivilegeError');
        const admin = app.live(); admin.user.own = () => true;
        await admin.prepare('system', tid()); await admin.get();
        const runtime = JSON.parse(admin.response.body.runtimeJson);
        const token = runtime.overlay.split('/').pop();
        expect(runtime.overlay).toBe(`${base}/live-overlay/${token}`);
        expect(runtime.admin).toBe(`${base}/live/admin`);

        const api = app.live('_admin_api'); api.user.own = () => true; api.user.uname = 'director';
        await api.prepare('system', tid());
        Object.assign(api.request, { method: 'POST', path: `/contest/${tid()}/live/api/admin/queue/show`, body: {}, query: {}, querystring: '' });
        await api.all();
        expect(JSON.parse(api.response.body)).toEqual({ status: 'ok', response: null });
        const info = app.live('_admin_api'); info.user.own = () => true;
        await info.prepare('system', tid());
        Object.assign(info.request, { method: 'GET', path: `/contest/${tid()}/live/api/admin/contestInfo`, body: {}, query: {}, querystring: '' });
        await info.all();
        const contest = JSON.parse(info.response.body);
        // Ended but not unlocked: over, still frozen.
        expect(contest.status).toMatchObject({ type: 'over', frozenAtUnixMs: state.contest.lockAt.getTime() });
        // Same identity rule as the public board: no private names or schools.
        expect(JSON.stringify(contest)).not.toMatch(/张三|南京晓庄学院/);
        await expect(app.live('_admin_api').prepare('system', tid())).rejects.toThrow('Forbidden');

        const overlay = app.live('_overlay_api'); overlay.user._id = 0;
        expect(overlay.noCheckPermView).toBe(true);
        await expect(overlay.get('system', tid(), 'x'.repeat(48))).rejects.toThrow('作废');
        overlay.request.path = `/contest/${tid()}/live-overlay/${token}/api/overlay/runs`;
        await overlay.get('system', tid(), token);
        // Frozen submission: in progress, its result not revealed.
        expect(JSON.parse(overlay.response.body)).toEqual([expect.objectContaining({ teamId: '1', result: { type: 'IN_PROGRESS', testedPart: 0, isAfterFirstOk: false, frozen: true } })]);
        const screen = app.live('_overlay_api'); screen.request.path = `/contest/${tid()}/live-overlay/${token}/api/overlay/mainScreen`;
        await screen.get('system', tid(), token);
        expect(JSON.parse(screen.response.body).widgets.map((item: any) => item.widget.type)).toEqual(['QueueWidget']);

        await admin.postResetToken();
        expect(admin.response.body.overlay).not.toContain(token);
        await expect(app.live('_overlay').get('system', tid(), token)).rejects.toThrow('作废');
        await expect(app.live('_media').get('system', tid(), 'wrong', 'awards-gold.svg')).rejects.toThrow('media');
    });
    it('keeps live overlays honest: revoked links disconnect, processes stay in sync, nothing before the start', async () => {
        const app = setup(); await app.init();
        const admin = app.live(); admin.user.own = () => true;
        await admin.prepare('system', tid()); await admin.get();
        const token = JSON.parse(admin.response.body.runtimeJson).overlay.split('/').pop();
        const contestKey = `system/${tid()}`;
        const doc = () => app.resolverTables.get('xcpcio.live')!.get(contestKey)!;

        // An overlay websocket already open is closed when its link is revoked, and told to other processes.
        const socket = app.live('_overlay_ws');
        socket.request.path = `/contest/${tid()}/live-overlay/${token}/ws/overlay/mainScreen`;
        await socket.prepare('system', tid(), token);
        expect(socket.send).toHaveBeenCalledWith(JSON.stringify({ type: 'MainScreenSnapshot', widgets: [] }));
        const console_ = app.live('_admin_ws'); console_.user.own = () => true;
        console_.request.path = `/contest/${tid()}/live/ws/admin/adminActions`;
        await console_.prepare('system', tid());

        // Another Hydro process saved a change: this one applies it without saving it again.
        const sync = app.hooks.mock.calls.find(([event]: [string]) => event === 'xcpcio/live-sync')![1];
        doc().stateEntries = { 'controller/queue': { settings: { horizontal: true }, showOrder: 7 } };
        doc().stateRevision = 1;
        await sync(contestKey, 'state', 'another-process', { patch: doc().stateEntries, revision: 1 });
        expect(socket.send).toHaveBeenLastCalledWith(expect.stringContaining('"type":"QueueWidget"'));
        expect(app.broadcast).not.toHaveBeenCalled();
        // A change made here is saved and announced.
        const api = app.live('_admin_api'); api.user.own = () => true; api.user.uname = 'director';
        await api.prepare('system', tid());
        Object.assign(api.request, { method: 'POST', path: `/contest/${tid()}/live/api/admin/queue/hide`, body: {}, query: {}, querystring: '' });
        await api.all();
        await new Promise((resolve) => setTimeout(resolve, 600));
        expect(doc().stateEntries['controller/queue'].showOrder).toBeNull();
        expect(app.broadcast).toHaveBeenCalledWith('xcpcio/live-sync', contestKey, 'state', expect.any(String), expect.objectContaining({ revision: 2, patch: { 'controller/queue': expect.objectContaining({ showOrder: null }) } }));

        await admin.postResetToken();
        expect(socket.close).toHaveBeenCalledWith(4004, '直播链接已作废');
        expect(app.broadcast).toHaveBeenCalledWith('xcpcio/live-sync', contestKey, 'token', expect.any(String), undefined);
        await socket.cleanup(); await console_.cleanup();

        // Media: built-in templates and uploads, served with the media key; Chinese names stay distinct.
        const file = path.join(os.tmpdir(), `live-upload-${Date.now()}.png`);
        fs.writeFileSync(file, 'png-bytes');
        const upload = app.live('_admin_api'); upload.user.own = () => true; upload.user.uname = 'director';
        await upload.prepare('system', tid());
        Object.assign(upload.request, { method: 'POST', path: `/contest/${tid()}/live/api/admin/media/upload`, body: {}, query: {}, querystring: '',
            files: { file: { filepath: file, originalFilename: '校徽.png', size: 9 } } });
        await upload.all();
        expect(JSON.parse(upload.response.body)).toEqual({ status: 'ok', response: ['校徽.png'] });
        const media = app.live('_media');
        await media.get('system', tid(), doc().mediaKey, '校徽.png');
        expect([media.response.type, Buffer.from(media.response.body).toString()]).toEqual(['image/png', 'png-bytes']);
        const builtin = app.live('_media');
        await builtin.get('system', tid(), doc().mediaKey, 'awards-gold.svg');
        expect(builtin.response.type).toBe('image/svg+xml');
        expect(builtin.response.addHeader).toHaveBeenCalledWith('Content-Security-Policy', expect.stringContaining('sandbox'));

        // The console page is the built ICPC Live admin, told where its backend is.
        const page = app.live('_admin_page'); page.user.own = () => true;
        await page.get('system', tid());
        expect(page.response.type).toBe('text/html');
        expect(page.response.body).toContain(`"adminApi":"/d/system/contest/${tid()}/live/api/admin"`);
        // Its overlay preview does not depend on the OBS token.
        expect(page.response.body).toContain(`"overlay":"/d/system/contest/${tid()}/live/preview"`);
        expect(page.response.body).toContain("e.data==='ping'");

        // Before the start the overlay knows the clock, but no teams (like the public board);
        // the director still sees them, to prepare team views.
        state.started = false;
        const fresh = setup(); await fresh.init();
        const early = fresh.live('_admin_api'); early.user.own = () => true;
        await early.prepare('system', tid());
        Object.assign(early.request, { method: 'GET', path: `/contest/${tid()}/live/api/admin/contestInfo`, body: {}, query: {}, querystring: '' });
        await early.all();
        expect(JSON.parse(early.response.body).teams).toHaveLength(1);
        const owner = fresh.live(); owner.user.own = () => true;
        await owner.prepare('system', tid()); await owner.get();
        const freshToken = JSON.parse(owner.response.body.runtimeJson).overlay.split('/').pop();
        const publicInfo = fresh.live('_overlay_api'); publicInfo.request.path = `/contest/${tid()}/live-overlay/${freshToken}/api/overlay/contestInfo`;
        await publicInfo.get('system', tid(), freshToken);
        expect(JSON.parse(publicInfo.response.body)).toMatchObject({ teams: [], organizations: [] });
        // The console previews through its own login: the same overlay data, no token involved.
        const preview = fresh.live('_preview_api'); preview.user.own = () => true;
        preview.request.path = `/contest/${tid()}/live/api/overlay/contestInfo`;
        await preview.get('system', tid());
        expect(JSON.parse(preview.response.body).teams).toEqual([]);
        const guestPreview = fresh.live('_preview_api'); guestPreview.user._id = 0;
        await expect(guestPreview.get('system', tid())).rejects.toThrow('PrivilegeError');
    });
    it('disconnects a director whose permission was revoked', async () => {
        vi.useFakeTimers();
        try {
            const app = setup(); await app.init();
            const socket = app.live('_admin_ws'); socket.user.own = () => true;
            socket.request.path = `/contest/${tid()}/live/ws/admin/adminActions`;
            await socket.prepare('system', tid());
            state.director = { own: () => true, hasPerm: () => false };
            await vi.advanceTimersByTimeAsync(60_000);
            expect(socket.close).not.toHaveBeenCalled();
            state.director = { own: () => false, hasPerm: () => false };
            await vi.advanceTimersByTimeAsync(60_000);
            expect(socket.close).toHaveBeenCalledWith(4003, '直播导播权限已撤销');
            await socket.cleanup();
        } finally {
            vi.useRealTimers();
        }
    });
    it('merges concurrent directors per item, migrates legacy state and restores a new process', async () => {
        vi.useFakeTimers();
        const database = previewDatabase();
        const sharedSettings = new Map<string, any>();
        const apps = [setup(sharedSettings, {}, database), setup(sharedSettings, {}, database)];
        await Promise.all(apps.map((app) => app.init()));
        const contestKey = `system/${tid()}`;
        const table = database.tables.get('xcpcio.live')!;
        table.set(contestKey, {
            _id: contestKey, token: 'old-token', mediaKey: 'old-media', visualConfig: '{}',
            state: { presets: { picture: [{ id: 1, settings: { url: '/old.png', name: '旧图片' }, showOrder: null }] } },
        });
        const delivery: Promise<unknown>[] = [];
        for (const sender of apps) sender.broadcast.mockImplementation((event: string, ...args: any[]) => {
            for (const receiver of apps) {
                const hook = receiver.hooks.mock.calls.find(([name]: [string]) => name === event)?.[1];
                if (hook) delivery.push(hook(...args));
            }
        });
        const api = async (app: typeof apps[number], subpath: string, method = 'GET', body = {}, query = {}) => {
            const handler = app.live('_admin_api'); handler.user.own = () => true;
            await handler.prepare('system', tid());
            Object.assign(handler.request, { method, path: `/contest/${tid()}/live/api/admin/${subpath}`, body, query, querystring: '' });
            await handler.all();
            expect(handler.response.status).toBe(200);
            return JSON.parse(handler.response.body);
        };
        const settle = async (ms = 600) => {
            await vi.advanceTimersByTimeAsync(ms);
            await Promise.all(delivery.splice(0));
        };
        try {
            await Promise.all(apps.map((app) => api(app, 'picture')));
            expect(table.get(contestKey)!.state).toBeUndefined();
            expect(table.get(contestKey)!.stateEntries['preset/picture/1'].settings.name).toBe('旧图片');
            // Exact reported reproduction: different workers act 100 ms apart, before either save.
            await api(apps[0], 'queue/show', 'POST');
            await settle(100);
            const image = (await api(apps[1], 'picture', 'POST', { url: '/new.png', name: '新图片' })).response;
            await settle();
            for (const app of apps) {
                expect((await api(app, 'queue')).shown).toBe(true);
                expect((await api(app, 'picture')).map((item: any) => item.id)).toEqual(expect.arrayContaining([1, image]));
            }
            expect(table.get(contestKey)!.stateEntries[`preset/picture/${image}`]).toBeDefined();
            // Simultaneous creation in each list uses different IDs, including temporary commentary.
            const created = await Promise.all(apps.map(async (app, index) => ({
                picture: (await api(app, 'picture', 'POST', { url: `/p${index}.png`, name: `p${index}` })).response,
                title: (await api(app, 'title', 'POST', { preset: 'lower_third_icpc_left.svg', data: { text: `t${index}` } })).response,
                ticker: (await api(app, 'tickerMessage/create_and_show_with_ttl', 'POST', { type: 'text', part: 'long', periodMs: 1000, text: `tick${index}` }, { ttl: '3000' })).response,
                ad: (await api(app, 'advertisement/create_and_show_with_ttl', 'POST', { text: `ad${index}` }, { ttl: '3000' })).response,
            })));
            for (const group of ['picture', 'title', 'ticker', 'ad'] as const) expect(created[0][group]).not.toBe(created[1][group]);
            await settle();
            for (const group of ['picture', 'title', 'tickerMessage', 'advertisement']) {
                const sort = (items: any[]) => items.sort((a, b) => String(a.id).localeCompare(String(b.id)));
                expect(sort(await api(apps[0], group))).toEqual(sort(await api(apps[1], group)));
            }
            // Editing one image and deleting another cannot bring the deleted image back.
            await api(apps[0], 'picture/1', 'POST', { url: '/edited.png', name: '编辑旧图片' });
            await api(apps[1], `picture/${image}`, 'DELETE');
            await settle();
            for (const app of apps) {
                const pictures = await api(app, 'picture');
                expect(pictures.find((item: any) => item.id === 1).settings.name).toBe('编辑旧图片');
                expect(pictures.some((item: any) => item.id === image)).toBe(false);
            }
            const restarted = setup(sharedSettings, {}, database); await restarted.init();
            expect(await api(restarted, 'picture')).toEqual(expect.arrayContaining(await api(apps[0], 'picture')));
            await settle(3500);
            for (const app of apps) {
                expect(await api(app, 'tickerMessage')).toEqual([]);
                expect(await api(app, 'advertisement')).toEqual([]);
            }
            expect(Object.keys(table.get(contestKey)!.stateEntries).some((key) => key.startsWith('preset/tickerMessage/'))).toBe(false);
        } finally {
            vi.useRealTimers();
        }
    });

    it('offers 画面采集 with the live module, and leaves it out when its own setting is off', async () => {
        const on = setup(); await on.init();
        expect(on.routeNames()).toEqual(expect.arrayContaining(['contest_xcpcio_live_capture', 'contest_xcpcio_live_capture_page', 'contest_xcpcio_live_capture_device_ws', 'contest_xcpcio_live_capture_overlay_ws', 'contest_xcpcio_live_capture_own', 'contest_xcpcio_live_capture_own_ws']));
        const off = setup(new Map(), { liveCapture: false }); await off.init();
        expect(off.routeNames().some((name) => name.startsWith('contest_xcpcio_live_capture'))).toBe(false);
        expect(off.routeNames()).toContain('contest_xcpcio_live');
    });
    it('leaves the live module out when it is switched off', async () => {
        const app = setup(new Map(), { live: false }); await app.init();
        expect(app.routeNames().some((name) => name.startsWith('contest_xcpcio_live'))).toBe(false);
        expect(app.routeNames()).toContain('contest_xcpcio_screens');
    });
    it('shows a resolver session read-only to the audience screen, without future steps', async () => {
        const app = setup(); await app.init();
        const creator = app.resolver('_sessions'); creator.user.own = () => true;
        creator.user.hasPerm = (perm: bigint) => perm === 4n; // sees private identity
        await creator.prepare('system', tid()); await creator.post('system', config);
        const sid = creator.response.body.id;
        expect(JSON.stringify((await creator.payload(config)).snapshot.teams)).toContain('南京晓庄学院');
        const admin = app.screens(); admin.user.own = () => true; admin.user._id = 99;
        await admin.prepare('system', tid()); await admin.get();
        const token = JSON.parse(admin.response.body.runtimeJson).linkBase.split('/').pop();
        await admin.post('system', JSON.stringify({ items: { resolver: { sessionId: sid } } }));
        const screen = app.screens('_data'); await screen.prepare('system', tid(), token, 'resolver'); await screen.get('system');
        const { game, playback, session } = screen.response.body;
        expect(session).toBe(sid);
        expect(game.steps).toHaveLength(playback.index + 1);
        expect(game.contest.awards).toEqual([]);
        expect(JSON.stringify(screen.response.body)).not.toMatch(/controlToken|autoStopTeamId/);
        // The venue display shows the snapshot as the presenter sees it, identity included.
        expect(JSON.stringify(game.contest.teams)).toContain('南京晓庄学院');
        // A second audience screen at the same progress reuses the snapshot instead of rebuilding it.
        const { UserModel } = await import('hydrooj');
        const before = vi.mocked(UserModel.getList).mock.calls.length;
        const reads = vi.spyOn(ResolverSessions.prototype, 'read');
        const other = app.screens('_data'); await other.prepare('system', tid(), token, 'resolver'); await other.get('system');
        expect(other.response.body.game.steps).toHaveLength(game.steps.length);
        expect(vi.mocked(UserModel.getList).mock.calls.length).toBe(before);
        expect(reads).not.toHaveBeenCalled();
        reads.mockRestore();
        const poll = app.screens('_data'); await poll.prepare('system', tid(), token, 'resolver'); await poll.get('system', playback.revision, sid);
        expect(poll.response.body.game).toBeUndefined();
        expect(poll.response.body.playback).toEqual(playback);
        // A presenter may cast their own session, and a spectator with the matching baseline gets only new reveals.
        const presenter = app.screens(); presenter.user.own = () => true;
        await presenter.prepare('system', tid());
        presenter.request.body = { operation: 'bind_resolver', sessionId: sid };
        await presenter.post('system');
        await presenter.postBindResolver('system', sid);
        expect(presenter.response.body).toMatchObject({ sessionId: sid, audienceUrl: expect.stringContaining('/resolver') });
        await expect(admin.postBindResolver('system', sid)).rejects.toThrow('不属于');
        const dbSession = [...app.resolverTables.get('xcpcio.resolver.sessions')!.values()][0] as any;
        const next = dbSession.actions.find((index: number) => index > playback.index);
        const host = app.resolver('_playback'); host.user.own = () => true;
        host.request.headers['x-resolver-control'] = dbSession.controlToken;
        await host.prepare('system', tid(), sid); await host.post('system', next, playback.revision);
        await poll.get('system', playback.revision, sid, playback.index);
        expect(poll.response.body.game).toBeUndefined();
        expect(poll.response.body.delta).toMatchObject({ from: playback.index, steps: expect.any(Array) });
        const delta = poll.response.body.delta;
        await poll.get('system', playback.revision, sid);
        expect([...game.steps, ...delta.steps]).toEqual(poll.response.body.game.steps);
        await poll.get('system', playback.revision, sid, next);
        expect(poll.response.body.game).toBeDefined();
    });
    it('asks a contestant (not contest staff) to open the capture window while 画面采集 is on and the contest has not ended', async () => {
        const db = previewDatabase();
        const app = setup(new Map(), {}, db); await app.init();
        const hooks = app.hooks.mock.calls.filter(([name]: string[]) => name === 'handler/after').map(([, hook]: any[]) => hook);
        const run = async (tdoc: any, user: any) => {
            const handler = app.resolver(); handler.UiContext = {}; handler.response.body = { tdoc }; handler.user = user;
            for (const hook of hooks) await hook(handler);
            return handler.UiContext.xcpcioCapture;
        };
        const tdoc = { ...state.contest, endAt: new Date(Date.now() + 3600_000) };
        const contestant = { _id: 12, own: () => false, hasPerm: () => false };
        state.entries = [{ uid: 12, attend: 1, journal: [] }];
        expect(await run(tdoc, contestant)).toBeUndefined();
        await db.db.collection('xcpcio.live.capture.config' as never).updateOne({ _id: `system/${tdoc.docId}` } as never, { $set: { settings: { enabled: true } } } as never, { upsert: true });
        vi.useFakeTimers({ now: Date.now() + 10_000, toFake: ['Date'] });
        try {
            expect(await run(tdoc, contestant)).toEqual({ url: `/d/system/contest/${tdoc.docId}/live-capture/me`, channel: `xcpcio-capture-${tdoc.docId}`, contest: '测试比赛', screenPublic: true, webcam: true });
            // Contest staff, people who did not join, and a contest that is over get no prompt.
            expect(await run(tdoc, { ...contestant, own: () => true })).toBeUndefined();
            expect(await run({ ...tdoc, endAt: new Date(Date.now() - 1000) }, contestant)).toBeUndefined();
            state.entries = [{ uid: 12, journal: [] }];
            expect(await run(tdoc, contestant)).toBeUndefined();
        } finally { vi.useRealTimers(); }
    });
    it('only supplies the sidebar URL to managers of ACM contests', async () => {
        const app = setup(); await app.init();
        const hook = app.hooks.mock.calls.find(([name]: string[]) => name === 'handler/after')[1];
        const handler = app.resolver(); handler.UiContext = {}; handler.response.body = { tdoc: state.contest };
        hook(handler); expect(handler.UiContext.xcpcioResolverUrl).toBeUndefined();
        handler.user.own = () => true; hook(handler);
        expect(handler.UiContext.xcpcioResolverUrl).toContain(`/contest/${tid()}/resolver`);
        // 直播 and 画面采集 appear beside 大屏 for the same managers.
        for (const [name, other] of app.hooks.mock.calls) if (name === 'handler/after' && other !== hook) await other(handler);
        expect(handler.UiContext).toMatchObject({ xcpcioLiveEnabled: true, xcpcioCaptureEnabled: true });
    });
    it('inherits selected-board medal defaults for partial API configurations', async () => {
        const app = setup(); await app.init(); const settings = app.settings(); settings.user.own = () => true;
        await settings.prepare('system', tid());
        await settings.post('system', JSON.stringify({ ...defaultSettings, manualBoards: [{ id: 'one', name: '一组', teamIds: ['1'], medals: { gold: 4, silver: 3, bronze: 2 } }] }));
        const preview = app.resolver('_preview'); preview.user.own = () => true;
        await preview.prepare('system', tid());
        await preview.post('system', JSON.stringify({ boardId: 'manual-one' }));
        expect(preview.response.body.config).toMatchObject({ goldCount: 4, silverCount: 3, bronzeCount: 2 });
    });
    it('shares independently saved board rules with preview and new sessions while preserving snapshots', async () => {
        const app = setup(); await app.init();
        const admin = app.settings(); admin.user.own = () => true;
        await admin.prepare('system', tid());
        const rules = { ...awardsFor(defaultSettings, 'all'), medals: { gold: 0, silver: 1, bronze: 0 }, silverCitation: '分榜奖', firstSolve: true, unofficialFirstSolve: true, podiumEnabled: true, medalSameScore: false };
        const saved = { ...defaultSettings, manualBoards: [{ id: 'one', name: '一组', teamIds: ['1'] }], boardAwards: { 'manual-one': rules } };
        await admin.post('system', JSON.stringify(saved));
        const preview = app.resolver('_preview'); preview.user.own = () => true; await preview.prepare('system', tid());
        const chosen = JSON.stringify({ boardId: 'manual-one', goldCount: 99, firstSolve: false });
        await preview.post('system', chosen);
        expect(preview.response.body.config).toMatchObject({ goldCount: 0, silverCount: 1, silverCitation: '分榜奖', firstSolve: true, podiumEnabled: true, medalSameScore: false });
        const live = app.settings(); live.user.own = () => true;
        await app.view().display.call(live, { tdoc: state.contest, realtime: true, json: true });
        expect(live.response.body.contest.medal['manual-one'].hydroAwards).toEqual(rules);
        const creator = app.resolver('_sessions'); creator.user.own = () => true;
        await creator.prepare('system', tid()); await creator.post('system', chosen);
        const sid = creator.response.body.id;
        const metadata = app.resolverTables.get('xcpcio.resolver.sessions')!.get(sid)!;
        metadata.updatedAt = new Date(0);
        const startup = app.hooks.mock.calls.find(([name]: string[]) => name === 'app/started')[1];
        await startup();
        expect(app.resolverTables.get('xcpcio.resolver.sessions')!.has(sid)).toBe(true);
        await admin.post('system', JSON.stringify({ ...saved, boardAwards: {} }));
        await preview.post('system', chosen);
        expect(preview.response.body.config).toMatchObject({ goldCount: 1, firstSolve: false });
        expect(metadata.config).toMatchObject({ goldCount: 0, firstSolve: true });
    });

});

describe('闭幕式观众与设备路由', () => {
    it('限制观众视角为管理员，关闭公开榜也能访问，HTML 和 JSON 始终使用公开投影', async () => {
        state.locked = true; state.ended = false;
        state.entries[0].journal = [record(state.contest.lockAt.getTime() / 1000 + 10)];
        state.users[1].displayName = '张三';
        const app = setup(new Map(), { publicByDefault: false }); await app.init();
        const member = app.settings(), admin = app.settings();
        const display = (user: any, json = false, realtime = false) => app.view().display.call(user, { tdoc: state.contest, json, realtime });
        member.request.querystring = 'view=audience';
        await expect(display(member)).rejects.toThrow('Forbidden');
        member.user._id = 0;
        await expect(display(member, true)).rejects.toThrow('login');
        admin.user.hasPerm = () => true;
        admin.request.querystring = 'view=manager';
        await display(admin);
        expect(admin.response.body.audienceUrl).toContain('view=audience');
        await display(admin, true, true);
        expect(JSON.stringify(admin.response.body)).toContain('南京晓庄学院');
        admin.request.querystring = 'json=true&view=audience&realtime=true';
        await display(admin, false, true);
        expect(admin.response.body).toMatchObject({ hideSubmissions: true, realtime: false, settingsUrl: null, realtimeUrl: null, unlock: null, audienceUrl: null });
        expect(admin.response.body.managerUrl).toContain('view=manager');
        expect(JSON.parse(admin.response.body.runtimeJson).dataSource).toMatch(/json=true&view=audience#/);
        await display(admin, true, true);
        expect(admin.response.body.teams[0].name).toBe('张三');
        expect(JSON.stringify(admin.response.body)).not.toMatch(/南京晓庄学院|测试选手/);
        expect(admin.response.body.submissions[0].status).toBe('FROZEN');
        await admin.prepare('system', state.contest.docId);
        await admin.post('system', JSON.stringify({ ...defaultSettings, publicAccess: true, showIdentity: true }));
        const guest = app.publicBoard();
        await guest.prepare('system', state.contest.docId); await guest.get('system', true, false);
        await display(admin, true);
        expect(admin.response.body).toEqual(guest.response.body);
        expect(admin.response.body.teams[0].organization).toBe('南京晓庄学院');
        state.started = false;
        await expect(display(admin, true)).rejects.toThrow('比赛开始后');
    });
    it('protects slides and photo changes, serves an opaque photo anonymously and persists ceremony appearance independently', async () => {
        const app = setup(); await app.init();
        const tid = state.contest.docId;
        const owner = async (name: string) => {
            const h = app.route(name);
            await expect(h.prepare('system', tid)).rejects.toThrow('Forbidden');
            h.user.own = () => true; await h.prepare('system', tid);
            return h;
        };
        const ceremony = await owner('contest_xcpcio_ceremony');
        const config = { theme: 'red', boards: ['all'], header: 8 };
        await ceremony.post('system', JSON.stringify(config), true);
        expect(ceremony.response.body.title).toBe(state.contest.title);
        const logos = JSON.parse(fs.readFileSync(path.join(__dirname, '../logos/index.json'), 'utf8')).names;
        const image = fs.readFileSync(path.join(__dirname, '../logos/' + logos['南京晓庄学院'] + '.webp'));
        const background = await owner('contest_xcpcio_ceremony_background');
        await background.post('system', image.toString('base64'));
        await background.get(); expect(background.response.body).toEqual(image);
        await ceremony.get('system');
        const saved = JSON.parse(ceremony.response.body.runtimeJson);
        expect(saved.config).toMatchObject(config); expect(saved.background).toContain('/ceremony/background');
        const edit = await owner('contest_resolver_photos');
        await expect(edit.post('system', 77, image.toString('base64'))).rejects.toThrow('未参加');
        state.entries[0].attend = 1;
        await edit.post('system', 1, image.toString('base64'));
        const file = edit.response.body.url.split('/').pop();
        const guest = app.route('contest_resolver_photo'); guest.user._id = 0;
        expect(guest.noCheckPermView).toBe(true); await guest.get('system', tid, file);
        expect(guest.response.body).toEqual(image);
        await edit.post('system', 1);
        await expect(guest.get('system', tid, file, true)).rejects.toThrow();
    });
    it('uses the same frozen board for fixed-token and cookie screens and isolates the two credentials', async () => {
        state.locked = true;
        const app = setup(); await app.init();
        const tid = state.contest.docId;
        const admin = app.screens(); admin.user.own = () => true;
        await admin.prepare('system', tid); await admin.get();
        const token = JSON.parse(admin.response.body.runtimeJson).linkBase.split('/').pop();
        let cookie: string | undefined;
        const jar = { get: () => cookie, set: vi.fn((_key, value) => { cookie = value; }) };
        const pair = app.route('xcpcio_screen_pair');
        pair.context = { cookies: jar, secure: true }; pair.request.ip = '127.0.0.1';
        await pair.post();
        expect(jar.set).toHaveBeenCalledWith('xcpcio_screen', expect.stringMatching(/^[0-9a-f]{64}$/), expect.objectContaining({
            httpOnly: true, secure: true, path: '/xcpcio-screen', maxAge: 365 * 86400000,
        }));
        const devices = app.route('contest_xcpcio_screen_devices');
        await expect(devices.prepare('system', tid)).rejects.toThrow('Forbidden');
        devices.user.own = () => true;
        await devices.prepare('system', tid);
        await devices.post('system', JSON.stringify({ action: 'claim', code: pair.response.body.code, name: '大屏', type: 'scoreboard' }));
        const fixed = app.screens('_data'), bound = app.route('xcpcio_screen_data');
        bound.context = { cookies: jar }; bound.request.ip = '127.0.0.1'; bound.request.query = { client: '{"width":1920}' };
        await fixed.prepare('system', tid, token, 'scoreboard'); await fixed.get('system');
        await bound.get();
        const { serverTime: a, ...one } = fixed.response.body;
        const { serverTime: b, paired, device, ...two } = bound.response.body;
        expect(two).toEqual(one); expect(paired).toBe(true);
        expect(JSON.stringify(bound.response.body)).not.toContain(token);
        await devices.get();
        expect(devices.response.body.devices).toMatchObject([{ id: device.id, online: true, client: { width: 1920 } }]);
        await devices.post('system', JSON.stringify({ action: 'delete', id: device.id }));
        await bound.get(); expect(bound.response.body).toEqual({ paired: false });
        await fixed.prepare('system', tid, token, 'scoreboard'); await fixed.get('system');
        expect(fixed.response.body.type).toBe('scoreboard');
    });
});
