import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { tsImport } from 'tsx/esm/api';

const timeout = { timeout: 20000 };
const contest = '/contest/demo';
const active = (page, kind) => page.locator('#screen[data-renderer="' + kind + '"]').waitFor(timeout);

export async function resolverCcpcoj(browser, base) {
    const context = await browser.newContext({ viewport: { width: 1190, height: 800 } });
    try {
        const host = await context.newPage();
        const errors = [];
        host.on('pageerror', e => errors.push(e.message));
        await host.goto(base + contest + '/resolver');
        await host.getByLabel('滚榜样式').selectOption('ccpcoj2');
        await host.locator('[name=freezeMode]').selectOption('custom');
        await host.locator('[name=freezeMinutes]').fill('250');
        await host.locator('#preview-screen[data-renderer="ccpcoj2"][data-act="1"]').waitFor(timeout);
        await host.locator('#preview-next').click();
        await host.locator('#preview-screen[data-act="2"]').waitFor(timeout);
        await host.locator('#start-btn').click();
        await active(host, 'ccpcoj2');
        const proof = await host.evaluate(async () => {
            const api = window.ICPCResolver;
            const url = new URL(document.querySelector('script[src$="/play.js"]').src);
            const { ResolverView } = await import(new URL('./render/resolver-view.js',url));
            const { ResolverViewCcpcoj } = await import(new URL('./ccpcoj/resolver-view-ccpcoj.js', url));
            const { rendererKind } = await import(new URL('./render/renderer.js', url));
            const movingIndex = api.steps.findIndex(step => step.type === 'resolve' && step.move && step.move.to < step.move.from);
            // Each generation runs the whole server sequence, including unpainted pauses and awards.
            function exercise(state) {
                const reference = new ResolverView(document.createElement('canvas'),api.game);
                state.seek(api.steps, -1);
                const acted = new Set(), pixels = {};
                for (const step of api.steps) {
                    state.applyStep(step); reference.applyStep(step);
                    if (!acted.has(state.act)) {
                        acted.add(state.act);
                        state.update(40); state.render();
                        const ctx = state.canvas.getContext('2d'), colors = new Set();
                        for (let x = .05; x < .96; x += .05) for (let y = .05; y < .96; y += .05) {
                            colors.add(Array.from(ctx.getImageData(Math.floor(state.canvas.width*x),Math.floor(state.canvas.height*y),1,1).data).join(','));
                        }
                        pixels[state.act] = colors.size;
                    }
                }
                const a = state.debugState(), b = reference.debugState();
                const equal = JSON.stringify([a.order,a.standings]) === JSON.stringify([b.order,b.standings]);
                reference.dispose();
                const phases = [];
                if (movingIndex >= 0) {
                    state.seek(api.steps, movingIndex - 1);
                    state.render();
                    phases.push(state.canvas.dataset.reveal);
                    state.applyStep(api.steps[movingIndex]);
                    state.render();
                    for (let frame = 0; frame < 400; frame++) {
                        const phase = state.canvas.dataset.reveal;
                        if (phases.at(-1) !== phase) phases.push(phase);
                        if (phase === 'result') break;
                        state.update(16);
                        state.render();
                    }
                    state.seek(api.steps, movingIndex - 1);
                    state.render();
                    phases.push(state.canvas.dataset.reveal);
                }
                // Steps faster than the animation must never pull a row or the scroll back: every
                // frame moves each of them by a fraction of a row at most.
                let jumps = 0;
                const last = new Map();
                let lastScroll = null;
                const sample = () => {
                    for (const id of state.board.stageState().order) {
                        const place = state.placeOf(id);
                        if (place == null) continue;
                        if (last.has(id) && Math.abs(place - last.get(id)) > .6) jumps++;
                        last.set(id, place);
                    }
                    const scroll = state.scrollOf();
                    if (scroll != null && lastScroll != null && Math.abs(scroll - lastScroll) > .6) jumps++;
                    if (scroll != null) lastScroll = scroll;
                };
                const from = Math.max(0, movingIndex - 6);
                state.seek(api.steps, from);
                state.render(); sample();
                for (let i = from + 1; i < Math.min(api.steps.length, movingIndex + 40); i++) {
                    state.applyStep(api.steps[i]); sample();
                    for (let frame = 0; frame < 6; frame++) { state.update(16); state.render(); sample(); }
                }
                return { acts: [...acted], pixels, equal, phases, jumps };
            }
            const modern = exercise(api.view);
            const widths = [];
            const state = api.view, originalWidth = state.canvas.dataset.logicalWidth;
            for (const width of [1080, 4320]) {
                state.canvas.dataset.logicalWidth = String(width);
                state.resize();
                state.render();
                widths.push(Math.round(state.canvas.width / state.canvas.height * 1080));
            }
            if (originalWidth) state.canvas.dataset.logicalWidth = originalWidth;
            else delete state.canvas.dataset.logicalWidth;
            state.resize();
            const classicView = new ResolverViewCcpcoj(document.createElement('canvas'), api.game, 1);
            const classic = { ...exercise(classicView), kind: classicView.debugState().renderer };
            classicView.dispose();
            const saved = structuredClone(api.game);
            saved.options.startScreen = 'scoreboard';
            const legacy = new ResolverViewCcpcoj(document.createElement('canvas'), saved, 2);
            const legacyStartsFrozen = legacy.act === 3;
            legacy.dispose();
            state.seek(api.steps,api.index);
            return { modern, classic, widths, legacyStartsFrozen, legacyName: rendererKind('3d'), steps: api.steps.length,
                finale: api.steps.findLastIndex(step => step.role === 'finale') };
        });
        for (const run of [proof.modern, proof.classic]) {
            assert.deepEqual(run.acts, [1,2,3,4]);
            assert.ok(run.equal); assert.ok(Object.values(run.pixels).every(n => n > 3), JSON.stringify(run));
            assert.deepEqual(run.phases, ['pending', 'turning', 'rising', 'result', 'pending']);
            assert.equal(run.jumps, 0, 'rows or scroll jumped during fast steps');
        }
        assert.equal(proof.classic.kind, 'ccpcoj');
        assert.deepEqual(proof.widths, [1080, 4320]);
        assert.equal(proof.legacyStartsFrozen, true);
        assert.equal(proof.legacyName, 'ccpcoj2');
        await host.getByRole('button', { name: '投到观众屏' }).click();
        const audience = context.newPage();
        const link = host.locator('#audience-link:not([hidden])'); await link.waitFor();
        const screen = await audience; screen.on('pageerror', e => errors.push(e.message));
        await screen.goto(new URL(await link.getAttribute('href'),base).href);
        await active(screen, 'ccpcoj2');
        await host.evaluate(i => window.ICPCResolver.jumpTo(i), proof.finale);
        await screen.locator('#screen[data-act="4"]').waitFor(timeout);
        const standings = await host.evaluate(() => window.ICPCResolver.view.debugState().standings);
        await host.locator('#btn-display').click();
        assert.equal(await host.getByLabel('机位').count(), 0);
        await host.getByLabel('音效').check();
        assert.ok(await host.evaluate(() => window.ICPCResolver.view.sound));
        await host.getByLabel('滚榜样式').selectOption('2d'); await active(host,'2d');
        assert.deepEqual(await host.evaluate(() => window.ICPCResolver.view.debugState().standings), standings);
        await host.getByLabel('滚榜样式').selectOption('ccpcoj'); await active(host,'ccpcoj');
        await host.locator('#screen[data-act="4"]').waitFor(timeout);
        assert.equal(await host.evaluate(() => window.ICPCResolver.index), proof.finale);
        await screen.mouse.move(25,25);
        await screen.getByLabel('滚榜样式').selectOption('2d'); await active(screen,'2d');
        assert.equal(Number(await screen.locator('#screen').getAttribute('data-index')),proof.finale);
        await screen.getByLabel('滚榜样式').selectOption('ccpcoj'); await active(screen,'ccpcoj');
        await screen.getByLabel('滚榜样式').selectOption(''); await active(screen,'ccpcoj2');
        // Both CCPCOJ styles draw with Canvas 2D only: a device without WebGL still shows them.
        const noWebGL = await context.newPage();
        await noWebGL.addInitScript(() => {
            const original = HTMLCanvasElement.prototype.getContext;
            HTMLCanvasElement.prototype.getContext = function (type,...args) { return type.startsWith('webgl') ? null : original.call(this,type,...args); };
        });
        await noWebGL.goto(host.url()); await active(noWebGL,'ccpcoj2');
        assert.equal(await noWebGL.evaluate(() => window.ICPCResolver.index),proof.finale);
        // When the CCPCOJ module cannot load, the session falls back to the original 2D.
        const fallback = await context.newPage();
        await fallback.route('**/ccpcoj/resolver-view-ccpcoj.js', route => route.abort());
        await fallback.goto(host.url()); await active(fallback,'2d');
        assert.equal(await fallback.evaluate(() => window.ICPCResolver.index),proof.finale);
        assert.deepEqual(errors,[]);
        console.log('Resolver CCPCOJ styles: ' + proof.steps + ' steps, four acts in both generations, chip then climb and rewind, no jumps under fast steps, legacy style name, matching standings, audience sync, no WebGL needed and 2D fallback');
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
