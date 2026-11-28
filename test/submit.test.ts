import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import nunjucks from 'nunjucks';
import { describe, expect, it } from 'vitest';
import type { Context } from 'hydrooj';
import { applySubmitApi } from '../lib/submit-api';
import { alphabeticId, parsePrint, parseSubmit, problemByLabel, requireIpLogin, statusOf } from '../lib/submit';
import { createSubmitPreview, submitPreviewTid } from '../preview/submit';

describe('contestant commands', () => {
    it('registers the API, installation page and ZIP with the router shipped by Hydro', () => {
        const require = createRequire(import.meta.url);
        const hydro = createRequire(require.resolve('hydrooj/package.json'));
        const framework = createRequire(hydro.resolve('@hydrooj/framework/package.json'));
        const Router = framework('@koa/router');
        const router = new Router();
        const context = { db: { collection: () => ({}) }, on() {}, withHandlerClass() {},
            Route: (name: string, path: string) => router.get(name, path, () => {}) } as unknown as Context;
        applySubmitApi({ Handler: class {}, PERM: { PERM_VIEW_CONTEST: 1n } } as unknown as typeof import('hydrooj'), context, async () => null);
        for (const url of ['/xcpcio-submit/info', '/contest/demo/submit-client', '/contest/demo/submit-client/linux-amd64']) {
            expect(router.match(url, 'GET').path).toHaveLength(1);
        }
    });

    it('matches the current normalized IP binding and refuses supplied credentials', () => {
        expect(() => requireIpLogin('::ffff:192.0.2.1', '192.0.2.1', 123, 123, {})).not.toThrow();
        for (const [loggedIn, uid, mapped, headers] of [
            [undefined, 123, 123, {}], ['192.0.2.1', 123, 345, {}], ['192.0.2.2', 123, 123, {}],
            ['192.0.2.1', 0, 0, {}], ['192.0.2.1', 123, 123, { cookie: 'sid=fixture' }], ['192.0.2.1', 123, 123, { authorization: 'fixture' }],
        ] as const) expect(() => requireIpLogin('192.0.2.1', loggedIn, uid, mapped, headers)).toThrow(/未绑定/);
    });

    it('maps letters by contest order and validates native print and submission limits', () => {
        expect(alphabeticId(26)).toBe('AA');
        expect(problemByLabel([304, 99], ' b ')).toEqual({ pid: 99, label: 'B' });
        expect(problemByLabel([304, 99], '304')).toBeNull();
        expect(parsePrint({ filename: 'folder/name.cpp', code: '  test  ' })).toMatchObject({ filename: 'name.cpp', code: 'test' });
        expect(() => parsePrint({ code: 'x'.repeat(65536) })).toThrow(/64 K/);
        expect(() => parseSubmit({ problem: 'A', lang: 'cpp', code: 'xxxx' }, 3)).toThrow(/限制/);
        expect(statusOf(1, false).code).toBe('HIDDEN');
    });

    it('uses the production routes for team submissions, visibility, enrollment, start time, and print deliveries', async () => {
        const app = await createSubmitPreview(new nunjucks.Environment(), '测试赛');
        const server = createServer((req, res) => { void app.handle(req, res, new URL(req.url!, 'http://localhost')); });
        server.listen(0, '127.0.0.1');
        await once(server, 'listening');
        const port = (server.address() as AddressInfo).port;
        async function api(action: string, body?: unknown) {
            const response = await fetch(`http://127.0.0.1:${port}/d/system/xcpcio-submit/${action}`, body === undefined ? {} : {
                method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
            });
            return { code: response.status, data: await response.json() };
        }
        const table = (name: string) => app.db.collection(name as never) as any;
        const sample = { problem: 'B', lang: 'cc.cc17o2', code: 'int main(){}' };
        try {
            expect((await api('info')).data.account).toEqual({ uid: 101, name: 'team01' });
            expect((await table('status').findOne({ _id: 'team' })).startAt).toBeNull();
            const first = await api('submit', sample);
            const start = (await table('status').findOne({ _id: 'team' })).startAt;
            expect(first.data).toMatchObject({ submitted: true, problem: 'B' });
            expect(start).toBeInstanceOf(Date);
            expect(await table('record').findOne({ _id: first.data.rid })).toMatchObject({ uid: 101, pid: 203, code: sample.code });
            await api('submit', sample);
            expect((await table('status').findOne({ _id: 'team' })).startAt).toEqual(start);
            const shared = { domainId: 'system', contest: submitPreviewTid, pid: 203, status: 1, lang: 'py3' };
            for (const [suffix, values] of [['1', { uid: 102 }], ['2', { uid: 987 }],
                ['3', { uid: 102, domainId: 'elsewhere' }], ['4', { uid: 102, contest: 'another' }]] as const) {
                await table('record').insertOne({ _id: '68ea0000000000000000000' + suffix, ...shared, ...values });
            }
            const { records } = (await api('status')).data;
            expect(records).toHaveLength(3);
            expect(records).toContainEqual(expect.objectContaining({ rid: '68ea00000000000000000001', code: 'AC' }));
            expect((await api('print', { code: 'paper', filename: 'dir/paper.cpp' })).data.queued).toBe(true);
            expect(await table('print').findOne({ uid: 101 })).toMatchObject({ title: 'paper.cpp', content: 'paper' });
            expect((await api('print', { operation: 'delete', code: 'paper' })).code).toBe(405);
            await table('document').updateOne({ _id: submitPreviewTid }, { $set: { hideSelfRecord: true } });
            expect((await api('status')).data).toEqual({ hidden: true, records: [] });
            await table('status').updateOne({ _id: 'team' }, { $set: { endAt: new Date(Date.now() - 500) } });
            expect((await api('submit', sample)).code).toBe(403);
            await table('status').updateOne({ _id: 'team' }, { $set: { attend: 0, endAt: null } });
            expect((await api('info')).data.contests).toEqual([]);
            expect((await api('print', { code: 'paper' })).code).toBe(403);
        } finally {
            server.closeAllConnections();
            await new Promise<void>(resolve => server.close(() => resolve()));
        }
    });
});
