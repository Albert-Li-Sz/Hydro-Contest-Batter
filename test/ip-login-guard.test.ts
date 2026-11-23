import type { Context } from 'hydrooj';
import { describe, expect, it, vi } from 'vitest';
import { applyIpLoginGuard } from '../lib/ip-login-guard';

const { getById } = vi.hoisted(() => ({ getById: vi.fn() }));
vi.mock('hydrooj', () => ({ UserModel: { getById } }));

function request(uid: number, mappedUid?: number, previousIp?: string) {
    const hooks = new Map<string, (...args: any[]) => unknown>();
    const findOne = vi.fn().mockResolvedValue(mappedUid === undefined ? null : { uid: mappedUid });
    applyIpLoginGuard({
        db: { collection: () => ({ findOne }) },
        on: (event: string, hook: (...args: any[]) => unknown) => hooks.set(event, hook),
        i18n: { load: vi.fn() },
    } as unknown as Context);

    const original = { _id: uid };
    const session = Object.create({ uid, ipLoggedIn: previousIp });
    const handler = {
        session, user: original, domain: { _id: 'system' }, request: { ip: '::ffff:192.0.2.2', method: 'post', json: true },
        response: { status: 200, redirect: '' }, translate: (message: string) => message,
        context: { HydroContext: { user: original }, originalPath: '/d/system/contest/test', search: '?x=1' },
    };
    hooks.get('handler/create')!(handler, 'http');
    return {
        handler, findOne,
        async finish(cachedUid?: number) {
            if (cachedUid !== undefined) {
                handler.user = { _id: cachedUid };
                Object.assign(session, { uid: cachedUid, ipLoggedIn: handler.request.ip, user: handler.user });
            }
            return hooks.get('handler/before-prepare')!(handler);
        },
    };
}

describe('IP login checks after onsite-toolkit', () => {
    it('discards a removed mapping at every request and leaves no new session state', async () => {
        const { handler, findOne, finish } = request(0);
        await finish(42);
        expect(findOne).toHaveBeenCalledWith({ _id: '192.0.2.2' }, { projection: { uid: 1 } });
        expect(handler.user._id).toBe(0);
        expect(handler.session.uid).toBe(0);
        expect(Object.keys(handler.session)).toEqual([]);
    });

    it('keeps a session that already existed when the mapping alone was removed', async () => {
        const { handler, finish } = request(42, undefined, '192.0.2.2');
        await finish(42);
        expect(handler.user._id).toBe(42);
        expect(handler.session.ipLoggedIn).toBe('192.0.2.2');
        expect(Object.keys(handler.session)).toEqual([]);
    });

    it('changes a warm reassignment and skips the route until Hydro checks the new session', async () => {
        const { handler, finish } = request(42, 74);
        getById.mockResolvedValueOnce({ _id: 74 });
        expect(await finish(42)).toBe('cleanup');
        expect(getById).toHaveBeenCalledWith('system', 74);
        expect(handler.user._id).toBe(74);
        expect(handler.session.uid).toBe(74);
        expect(handler.response.status).toBe(409);

        const next = request(74, 74);
        getById.mockResolvedValueOnce({ _id: 74 });
        expect(await next.finish(42)).toBeUndefined();
        expect(next.handler.user._id).toBe(74);
        expect(next.handler.response.status).toBe(200);
    });

    it('uses the existing authentication path for a current mapping or a password session', async () => {
        const mapped = request(0, 42);
        await mapped.finish(42);
        expect(mapped.handler.user._id).toBe(42);
        expect(mapped.handler.session.uid).toBe(42);

        const regular = request(51);
        await regular.finish();
        expect(regular.findOne).not.toHaveBeenCalled();
        expect(regular.handler.user._id).toBe(51);
    });

    it('reloads an HTML page on a warm reassignment while preserving its domain and query', async () => {
        const { handler, finish } = request(42, 74);
        handler.request.method = 'get';
        handler.request.json = false;
        getById.mockResolvedValueOnce({ _id: 74 });
        expect(await finish(42)).toBe('cleanup');
        expect(handler.response.redirect).toBe('/d/system/contest/test?x=1');
    });
});
