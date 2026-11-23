import { createRequire } from 'node:module';
import type { Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminApi, type LiveStore } from '../lib/live/api';
import { LiveHub } from '../lib/live/hub';
import { defaultSettings } from '../lib/settings';
import { demoData } from './fixture';

// Exercise Hydro's installed request parser, including its default text limit and strict JSON.
const hydroRequire = createRequire(createRequire(import.meta.url).resolve('hydrooj/package.json'));
const frameworkRequire = createRequire(hydroRequire.resolve('@hydrooj/framework/package.json'));
const Koa = frameworkRequire('koa');
const { koaBody } = frameworkRequire('koa-body');

describe('live HTTP request transport', () => {
    let server: Server;
    let base: string;
    let visual = '{}';
    const hub = new LiveHub({
        load: async () => ({
            contest: { title: 'demo', beginAt: new Date(Date.now() - 3600_000), endAt: new Date(Date.now() + 3600_000) },
            data: demoData(), settings: defaultSettings, boards: [], identity: false, logoNames: {}, now: Date.now(),
        }),
        persist: async () => 1,
        template: async () => null,
    });
    const store: LiveStore = {
        visualConfig: async () => visual,
        saveVisualConfig: async (value) => { visual = value; },
        mediaNames: async () => [],
        saveMedia: async () => {},
        mediaUrl: async (name) => `/media/${name}`,
    };

    beforeAll(async () => {
        await hub.refresh();
        const app = new Koa();
        app.on('error', () => {});
        app.use(koaBody({ jsonLimit: '8mb', formLimit: '8mb' }));
        app.use(async (ctx: any) => {
            const response = await adminApi(hub, store, {
                method: ctx.method, subpath: ctx.path.slice(1), body: ctx.request.body,
                query: {}, querystring: '', files: [], user: 'test',
            });
            ctx.status = response?.status || 404;
            ctx.type = response?.type;
            ctx.body = response?.body;
        });
        await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
        base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });
    afterAll(async () => {
        await hub.dispose();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
    });

    it('saves a 70 KB config through Hydro as a JSON object', async () => {
        const value = JSON.stringify({ caption: 'x'.repeat(70_000) });
        const old = await fetch(`${base}/visualConfig`, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: value });
        expect(old.status).toBe(413);
        const response = await fetch(`${base}/visualConfig`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ visualConfig: value }),
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ status: 'ok' });
        expect(visual).toBe(value);
    });

    it('returns an explicit byte limit error for oversized JSON config', async () => {
        const response = await fetch(`${base}/visualConfig`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ visualConfig: JSON.stringify({ caption: '中'.repeat(70_000) }) }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ status: 'error', message: '画面配置不能超过 200 KB（UTF-8 编码）' });
    });

    it('lets Featured run reach the plugin and report the missing camera', async () => {
        const message = hub.analytics.list()[0];
        const url = `${base}/analytics/${message.id}/featuredRun`;
        const old = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '"camera"' });
        expect(old.status).toBe(400);
        const response = await fetch(url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mediaType: 'camera' }),
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({ status: 'error', message: '该队伍没有摄像头画面，无法使用 Featured run' });
    });
});
