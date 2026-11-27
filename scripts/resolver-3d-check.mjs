import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tsImport } from 'tsx/esm/api';

const timeout = { timeout: 20000 };
const contest = '/contest/demo';
const active = (page, kind) => page.locator('#screen[data-renderer="' + kind + '"]').waitFor(timeout);

export async function resolver3D(browser, base) {
    const context = await browser.newContext({ viewport: { width: 1190, height: 800 } });
    try {
        const host = await context.newPage();
        const errors = [];
        host.on('pageerror', e => errors.push(e.message));
        await host.goto(base + contest + '/resolver');
        await host.getByLabel('滚榜样式').selectOption('3d');
        await host.locator('[name=freezeMode]').selectOption('custom');
        await host.locator('[name=freezeMinutes]').fill('250');
        await host.locator('#start-btn').click();
        await active(host, '3d');
        const proof = await host.evaluate(async () => {
            const api = window.ICPCResolver;
            const state = api.view;
            const url = new URL(document.querySelector('script[src$="/play.js"]').src);
            const { ResolverView } = await import(new URL('./render/resolver-view.js',url));
            const reference = new ResolverView(document.createElement('canvas'),api.game);
            const acted = new Set(), pixels = {};
            // Both views consume the entire server sequence, including unpainted pauses and awards.
            for (const step of api.steps) {
                state.applyStep(step); reference.applyStep(step);
                if (!acted.has(state.act)) {
                    acted.add(state.act);
                    state.update(40); state.render();
                    const gl = state.renderer.getContext(), rgb = new Uint8Array(4), colors = new Set();
                    for (let x = .1; x < .95; x += .12) for (let y = .1; y < .95; y += .12) {
                        gl.readPixels(Math.floor(gl.drawingBufferWidth*x),Math.floor(gl.drawingBufferHeight*y),1,1,gl.RGBA,gl.UNSIGNED_BYTE,rgb);
                        colors.add(Array.from(rgb).join(','));
                    }
                    pixels[state.act] = colors.size;
                }
            }
            const a = state.debugState(), b = reference.debugState();
            const equal = JSON.stringify([a.order,a.standings]) === JSON.stringify([b.order,b.standings]);
            reference.dispose(); state.seek(api.steps,api.index);
            return { acts: [...acted], pixels, equal, steps: api.steps.length, finale: api.steps.findLastIndex(step => step.role === 'finale') };
        });
        assert.deepEqual(proof.acts, [1,2,3,4]);
        assert.ok(proof.equal); assert.ok(Object.values(proof.pixels).every(n => n > 3), JSON.stringify(proof));
        await host.getByRole('button', { name: '投到观众屏' }).click();
        const audience = context.newPage();
        const link = host.locator('#audience-link:not([hidden])'); await link.waitFor();
        const screen = await audience; screen.on('pageerror', e => errors.push(e.message));
        await screen.goto(new URL(await link.getAttribute('href'),base).href);
        await active(screen, '3d');
        await host.evaluate(i => window.ICPCResolver.jumpTo(i), proof.finale);
        await screen.locator('#screen[data-act="4"]').waitFor(timeout);
        const standings = await host.evaluate(() => window.ICPCResolver.view.debugState().standings);
        await host.locator('#btn-display').click();
        await host.getByLabel('机位').selectOption('side'); await host.getByLabel('音效').check();
        assert.ok(await host.evaluate(() => window.ICPCResolver.view.cameraMode === 'side' && window.ICPCResolver.view.sound));
        await host.getByLabel('滚榜样式').selectOption('2d'); await active(host,'2d');
        assert.deepEqual(await host.evaluate(() => window.ICPCResolver.view.debugState().standings), standings);
        await host.getByLabel('滚榜样式').selectOption('3d'); await host.locator('#screen[data-act="4"]').waitFor(timeout);
        assert.equal(await host.evaluate(() => window.ICPCResolver.index), proof.finale);
        await screen.mouse.move(25,25);
        await screen.getByLabel('滚榜样式').selectOption('2d'); await active(screen,'2d');
        assert.equal(Number(await screen.locator('#screen').getAttribute('data-index')),proof.finale);
        await screen.getByLabel('滚榜样式').selectOption(''); await active(screen,'3d');
        const fallback = await context.newPage();
        await fallback.addInitScript(() => {
            const original = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type,...args) { return type.startsWith('webgl') ? null : original.call(this,type,...args); };
        });
        await fallback.goto(host.url()); await active(fallback,'2d');
        assert.equal(await fallback.evaluate(() => window.ICPCResolver.index),proof.finale);
        assert.deepEqual(errors,[]);
        console.log('Resolver 3D: ' + proof.steps + ' steps, four rendered acts, matching standings, presenter/audience switching and WebGL fallback');
    } finally { await context.close(); }
}

export async function powerPointExport(page, folder) {
    const saved = page.waitForEvent('download', timeout);
    await page.getByRole('button', { name: '导出 PowerPoint' }).click();
    const file = await saved;
    assert.ok(file.suggestedFilename().endsWith('.pptx'));
    const target = folder + '/awards.pptx'; await file.saveAs(target);
    const zip = await tsImport('../lib/ccs/zip.ts', import.meta.url);
    const entries = (zip.readZip || zip.default.readZip)(await readFile(target), { maxFiles: 3000, maxBytes: 100 * 1024 ** 2 });
    const parts = entries.filter(e => /\.xml$|\.rels$/.test(e.name)).map(e => [e.name, e.data.toString()]);
    const check = await page.evaluate(parts => {
        const result = { slides: 0, text: [], images: 0, errors: [] };
        for (const [file, body] of parts) {
            const doc = new DOMParser().parseFromString(body,'application/xml');
            if (doc.querySelector('parsererror')) result.errors.push(file);
            if (!/^ppt\/slides\/slide\d+\.xml$/.test(file)) continue;
            result.slides++;
            result.text.push(...Array.from(doc.getElementsByTagNameNS('*','t'), n => n.textContent));
            result.images += doc.getElementsByTagNameNS('*','pic').length;
        }
        return result;
    }, parts);
    assert.deepEqual(check.errors,[]);
    assert.equal(check.slides, await page.locator('#ceremony-strip .ce-thumb').count());
    assert.ok(check.text.some(t => /金奖|GOLD MEDAL/.test(t))); assert.ok(check.images > check.slides);
    assert.ok(entries.some(e => /^ppt\/media\/[a-f0-9]{12}\.png$/.test(e.name)));
    assert.ok(entries.some(e => /^ppt\/media\/background\.(png|jpeg)$/.test(e.name)));
}
