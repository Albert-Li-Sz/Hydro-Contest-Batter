import { describe, expect, it, vi } from 'vitest';
import { previewDatabase } from '../preview/resolver-memory-db';

const state = vi.hoisted(() => ({ attend: new Set<number>([7]), team: { _id: 7, uname: 'team7' } as any, started: true }));
vi.mock('hydrooj', () => {
    class Handler {
        domain = { _id: 'system' };
        user: any = { _id: 1, own: () => true, hasPerm: () => true };
        request: any = { method: 'get', path: '/', headers: {} };
        response: any = { addHeader: vi.fn() };
        context: any = { cookies: { get: () => undefined, set: vi.fn() }, querystring: '' };
        checkPerm(_perm: bigint) { if (!this.user.hasPerm()) throw new Error('Forbidden'); }
        checkPriv(_priv: number) {}
    }
    class ObjectId { constructor(public value: string) {} toString() { return this.value; } }
    return {
        Handler, ObjectId, param: () => () => {}, Types: { ObjectId: [(v: string) => new ObjectId(v)], Int: [(v: unknown) => Number(v)] },
        PERM: { PERM_EDIT_CONTEST: 1n }, PRIV: { PRIV_USER_PROFILE: 1 },
        ForbiddenError: class extends Error {}, NotFoundError: class extends Error {},
        ContestModel: {
            get: vi.fn(async (domainId: string, tid: ObjectId) => ({ domainId, docId: tid, rule: 'acm', title: '演示' })),
            getStatus: vi.fn(async (_d: string, _t: unknown, uid: number) => state.attend.has(uid) ? { attend: 1 } : null),
            isNotStarted: () => !state.started,
        },
        UserModel: { getById: vi.fn(async (_d: string, uid: number) => uid === state.team._id ? state.team : null) },
    };
});
import { Handler } from 'hydrooj';
import { applyPerspective, perspectiveAction, perspectiveCookie, perspectiveScope, Perspectives, perspectiveTtl } from '../lib/perspective';

const tid = '0123456789abcdef01234567';
const q = (s = '') => new URLSearchParams(s);

describe('选手视角', () => {
    it('covers the contest pages a team reads, and only the participant actions of that contest', () => {
        for (const path of [`/contest/${tid}`, `/d/system/contest/${tid}/problems`, `/contest/${tid}/scoreboard`, `/contest/${tid}/scoreboard/xcpcio-plus`,
            `/contest/${tid}/clarification`, `/contest/${tid}/file/public/a.pdf`, '/record/0123456789abcdef01234567', '/record-detail-conn']) {
            expect(perspectiveScope(path, q(), tid), path).toBe(true);
        }
        expect(perspectiveScope('/p/P1001', q(`tid=${tid}`), tid)).toBe(true);
        expect(perspectiveScope('/d/x/record', q(`tid=${tid}`), tid)).toBe(true);
        expect(perspectiveScope('/record-conn', q(`tid=${tid}`), tid)).toBe(true);
        for (const [path, query] of [['/p/P1001', ''], ['/record', ''], [`/contest/${tid}/xcpcio-settings`, ''], [`/contest/${tid}/edit`, ''],
            ['/contest/ffffffffffffffffffffffff/problems', ''], [`/contest/${tid}/resolver`, ''], ['/home', ''], ['/record', 'tid=other']]) {
            expect(perspectiveScope(path, q(query), tid), path + query).toBe(false);
        }
        expect(perspectiveAction(`/contest/${tid}`, q(), tid)).toBe(true);
        expect(perspectiveAction(`/contest/${tid}/clarification`, q(), tid)).toBe(true);
        expect(perspectiveAction('/p/P1001/submit', q(`tid=${tid}`), tid)).toBe(true);
        expect(perspectiveAction(`/contest/${tid}/xcpcio-settings`, q(), tid)).toBe(false);
        expect(perspectiveAction('/p/P1001/submit', q(), tid)).toBe(false);
    });
    it('keeps views for two hours and forgets an ended one', async () => {
        const store = new Perspectives(previewDatabase().db);
        const now = Date.UTC(2026, 10, 27);
        const token = await store.start(1, 'system', tid, 7, '星河', now);
        expect(await store.find(token, now + 1)).toMatchObject({ adminUid: 1, uid: 7, tid, name: '星河' });
        expect(await new Perspectives(previewDatabase().db).find(token, now)).toBeNull();
        expect(await store.find(token, now + perspectiveTtl)).toBeNull();
        expect(await store.find('not a token', now)).toBeNull();
        await store.end(token);
        expect(await store.find(token, now + 1)).toBeNull();
    });
    function harness() {
        const listeners = new Map<string, ((...args: any[]) => any)[]>();
        const routes = new Map<string, any>();
        const ctx: any = {
            db: previewDatabase().db, i18n: { load() {} },
            on: (name: string, fn: (...args: any[]) => any) => listeners.set(name, [...listeners.get(name) || [], fn]),
            Route: (name: string, _path: string, Class: any) => routes.set(name, Class),
        };
        const { store } = applyPerspective(ctx, { teams: async () => [{ uid: 7, name: '星河', school: '东大' }] });
        const emit = async (name: string, ...args: unknown[]) => { for (const fn of listeners.get(name) || []) await fn(...args); };
        const admin = { _id: 1, own: () => true, hasPerm: () => true };
        const request = (token: string, path: string, { method = 'get', query = '', user = admin as any, domain = 'system' } = {}) => {
            const h: any = new (Handler as any)();
            Object.assign(h, { user, domain: { _id: domain }, UiContext: {}, request: { method, path } });
            h.context = { cookies: { get: (name: string) => name === perspectiveCookie ? token : undefined, set: vi.fn() }, originalPath: path, querystring: query };
            return h;
        };
        return { store, emit, routes, request, admin };
    }
    it('shows the contest as the team to its manager, read-only, without starting the team\'s clock', async () => {
        const { store, emit, request, admin } = harness();
        const token = await store.start(1, 'system', tid, 7, '星河');
        const page = request(token, `/d/system/contest/${tid}/problems`);
        await emit('handler/create', page, 'http');
        expect(page.user).toBe(state.team);
        page.tsdoc = { attend: 1 };
        await emit('handler/before', page);
        expect(page.tsdoc.startAt).toBeInstanceOf(Date);
        await emit('handler/after', page);
        expect(page.UiContext.xcpcioPerspective).toEqual({ name: '星河', exit: '/xcpcio-perspective/exit', back: `/d/system/contest/${tid}/scoreboard/xcpcio-plus` });
        const socket = request(token, '/record-conn', { query: `tid=${tid}` });
        await emit('handler/create', socket, 'ws');
        expect(socket.user).toBe(state.team);
        // Outside the contest's pages, in another domain, for another user or without the right, nothing changes.
        for (const other of [request(token, `/contest/${tid}/xcpcio-settings`), request(token, `/contest/${tid}`, { domain: 'other' }),
            request(token, `/contest/${tid}`, { user: { ...admin, _id: 2 } }), request(token, `/contest/${tid}`, { user: { _id: 1, own: () => false, hasPerm: () => false } }),
            request('f'.repeat(64), `/contest/${tid}`)]) {
            const before = other.user;
            await emit('handler/create', other, 'http');
            expect(other.user).toBe(before);
            expect(other.xcpcioPerspective).toBeUndefined();
        }
        await expect(emit('handler/create', request(token, '/p/P1/submit', { method: 'post', query: `tid=${tid}` }), 'http')).rejects.toThrow('只读');
        await expect(emit('handler/create', request(token, `/contest/${tid}`, { method: 'post' }), 'http')).rejects.toThrow('只读');
        const manage = request(token, `/contest/${tid}/xcpcio-settings`, { method: 'post' });
        await emit('handler/create', manage, 'http');
        expect(manage.user).toBe(admin);
    });
    it('starts a view only for an attending team and ends it on exit', async () => {
        const { store, routes, request } = harness();
        const Start = routes.get('contest_xcpcio_perspective');
        const start = Object.assign(new Start(), { tdoc: { domainId: 'system', docId: tid, rule: 'acm' } });
        start.context = { cookies: { get: () => undefined, set: vi.fn() }, secure: false };
        await expect(start.post('system', 9)).rejects.toThrow('未参加');
        await start.post('system', 7);
        expect(start.response.redirect).toBe(`/d/system/contest/${tid}/problems`);
        const [name, token, options] = start.context.cookies.set.mock.calls[0];
        expect([name, options]).toEqual([perspectiveCookie, expect.objectContaining({ httpOnly: true, path: '/', maxAge: perspectiveTtl })]);
        expect(await store.find(token)).toMatchObject({ uid: 7, name: '星河', adminUid: 1 });
        const Exit = routes.get('xcpcio_perspective_exit');
        const exit = Object.assign(new Exit(), request(token, '/xcpcio-perspective/exit', { method: 'post' }));
        await exit.post();
        expect(await store.find(token)).toBeNull();
        expect(exit.context.cookies.set).toHaveBeenCalledWith(perspectiveCookie, '', expect.objectContaining({ maxAge: 0 }));
    });
});
