import type { Context, Tdoc } from 'hydrooj';
import { describe, expect, it, vi } from 'vitest';
import { ContestLinks } from '../lib/links';
import { previewDatabase } from '../preview/resolver-memory-db';

const { get, status, getByUname } = vi.hoisted(() => ({ get: vi.fn(), status: vi.fn(), getByUname: vi.fn() }));
vi.mock('hydrooj', () => ({
    ContestModel: { get, getMultiStatus: status }, UserModel: { getByUname }, Handler: class {}, NotFoundError: Error,
    ObjectId: class {}, param: () => () => {}, Types: { ObjectId: true, String: true }, PERM: { PERM_EDIT_CONTEST: 1n }, PRIV: { PRIV_USER_PROFILE: 1, PRIV_EDIT_SYSTEM: 2, PRIV_JUDGE: 4 },
}));
import { applyIpCollection } from '../lib/ip-collect-routes';

describe('public IP collection handler', () => {
    it('scopes permitted accounts, applies per-IP rate limits before lookup, and revokes the public link', async () => {
        let H: any;
        const db = previewDatabase().db;
        const links = new ContestLinks<Tdoc>();
        const { save } = applyIpCollection({ db, on: vi.fn(), Route: (_name: string, _path: string, handler: unknown) => { H = handler; } } as unknown as Context, links, '/code');
        const tdoc = { domainId: 'system', docId: 'c', rule: 'acm', beginAt: new Date(Date.now() + 3600_000), title: '校赛' } as unknown as Tdoc;
        get.mockResolvedValue(tdoc);
        const ip = '192.0.2.10', nonce = 'b'.repeat(48);
        await save(tdoc, true, '192.0.2.0/24');
        const h = Object.assign(new H(), { request: { ip, path: '/contest/c/ip-collect' }, response: { addHeader: vi.fn() }, limitRate: vi.fn(),
            context: { cookies: { get: () => nonce, set: vi.fn() } } });
        await h.prepare('system', 'c');
        await h.get();
        expect(h.noCheckPermView).toBe(true);
        expect(h.context.cookies.set).toHaveBeenCalledWith('xcpcio_collect', expect.stringMatching(/^[a-f0-9]{48}$/), expect.objectContaining({ httpOnly: true, sameSite: 'strict' }));
        await expect(h.post('system', 'team', 'wrong')).rejects.toThrow('重新打开');
        expect(getByUname).not.toHaveBeenCalled();
        h.limitRate.mockRejectedValueOnce(new Error('限流'));
        await expect(h.post('system', 'team', nonce)).rejects.toThrow('限流');
        expect(h.limitRate).toHaveBeenCalledWith('xcpcio_ip_collect', 60, 8, ip);
        expect(getByUname).not.toHaveBeenCalled();
        const player = { _id: 70, uname: 'team', displayName: '星火', hasPriv: (flag: number) => flag === 1, hasPerm: () => false, own: () => false };
        getByUname.mockResolvedValue(player);
        const next = vi.fn().mockResolvedValue(null);
        status.mockReturnValue({ next });
        await expect(h.post('system', 'team', nonce)).rejects.toThrow('参赛账号');
        expect(status).toHaveBeenCalledWith('system', { docId: 'c', attend: { $gte: 1 }, $or: [{ uid: 70 }, { members: 70 }] });
        next.mockResolvedValue({ uid: 70 });
        await h.post('system', 'team', nonce);
        expect(h.response.body).toEqual({ name: '星火', account: 'team', ip });
        expect(await links.status(tdoc)).toMatchObject([{ id: 'ip-collect', count: 1 }]);
        await links.revoke(tdoc);
        await expect(h.prepare('system', 'c')).rejects.toThrow('关闭');
    });
});
