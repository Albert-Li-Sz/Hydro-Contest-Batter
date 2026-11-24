// Browser regression for the independent venue screen. BASELINE_PREVIEW may point to a
// running v1.18.0 preview to measure the two protocols on the same deterministic wide contest.
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { actionIndicesFor } from '../resolver/public/js/playback-model.js';

const contest = '/contest/demo';
const screen = contest + '/screen/preview0000000000000000000000000000000000000000/resolver';
const audienceData = (url) => new URL(url).pathname === screen + '/data';

export async function resolverAudience(browser, base, legacy = false) {
    const director = await browser.newContext();
    const publicDisplay = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const post = async (route, data, headers) => {
        const response = await director.request.post(base + route, { data, headers });
        const body = await response.json();
        assert.ok(response.ok(), body.error || response.statusText());
        return body;
    };
    try {
        const config = { boardId: 'all', freezeMode: 'custom', freezeAtSeconds: 3600, startScreen: 'scoreboard', rehearsal: true };
        const session = await post(contest + '/resolver/sessions?fixture=wide', { config: JSON.stringify(config) });
        const host = await director.newPage();
        await host.goto(base + session.url);
        const runtime = await host.locator('#resolver-runtime').evaluate((el) => JSON.parse(el.textContent));
        const headers = { 'x-resolver-control': runtime.controlToken };
        const game = await (await director.request.get(base + session.url + '/data', { headers })).json();
        const actions = actionIndicesFor(game.steps);
        assert.equal(game.steps.length, 2592);
        if (legacy) {
            await post(contest + '/screens', { operation: 'save', config: JSON.stringify({ items: { resolver: { sessionId: session.id } } }) });
        } else {
            await host.getByRole('button', { name: '投到观众屏' }).click();
            await host.locator('#audience-link:not([hidden])').waitFor();
            assert.equal(await host.locator('#audience-link').getAttribute('href'), screen);
        }
        const viewer = await publicDisplay.newPage();
        // A physical paint of contest text, including on the old client which exposes no playback
        // metadata. Capture the draw after a response has been consumed, not just network arrival.
        await viewer.addInitScript(() => {
            const fill = CanvasRenderingContext2D.prototype.fillText;
            const json = Response.prototype.json;
            window.__venuePaint = { consumed: -1, revision: -1, text: new Set(), paint: 0 };
            Response.prototype.json = async function (...args) {
                const data = await json.apply(this, args);
                if (data?.session && data.playback && (data.game || data.delta)) {
                    window.__venuePaint.consumed = data.playback.revision;
                    window.__venuePaint.text.clear();
                }
                return data;
            };
            CanvasRenderingContext2D.prototype.fillText = function (label, ...args) {
                const proof = window.__venuePaint;
                if (this.canvas.id === 'screen' && proof.consumed >= 0) {
                    if (proof.consumed !== proof.revision) proof.paint = performance.now();
                    proof.revision = proof.consumed;
                    proof.text.add(String(label));
                }
                return fill.call(this, label, ...args);
            };
        });
        const awaitPaint = async (revision) => {
            await viewer.waitForFunction((r) => window.__venuePaint.revision === r && window.__venuePaint.text.size > 2, revision);
            return viewer.evaluate(() => window.__venuePaint.paint);
        };
        const nextPayload = (revision) => viewer.waitForResponse(async (response) => audienceData(response.url())
            && response.ok() && (await response.json()).playback?.revision === revision, { timeout: 12000 });
        const initial = nextPayload(0);
        await viewer.goto(base + screen);
        const snapshot = await (await initial).json();
        assert.equal(snapshot.game.steps.length, snapshot.playback.index + 1);
        assert.deepEqual(snapshot.game.contest.awards, []);
        const firstPaint = await awaitPaint(0);
        const move = async (position, revision) => {
            const response = nextPayload(revision + 1);
            const start = performance.now();
            await post(session.url + '/playback', { revision, index: actions.at(position) }, headers);
            const acknowledged = performance.now() - start;
            const packet = await response;
            const body = await packet.body();
            const data = JSON.parse(body);
            await awaitPaint(revision + 1);
            return { data, bytes: body.length, acknowledged: Math.round(acknowledged), visible: Math.round(performance.now() - start) };
        };
        const jump = await move(-2, 0);
        const last = await move(-1, 1);
        if (legacy) assert.equal(last.data.game.steps.length, actions.at(-1) + 1);
        else {
            assert.equal(last.data.delta.from, actions.at(-2));
            assert.equal(last.data.delta.steps.length, 2);
            assert.equal(last.data.game, undefined);
            assert.deepEqual([...snapshot.game.steps, ...jump.data.delta.steps, ...last.data.delta.steps].map((s) => s.type),
                game.steps.slice(0, actions.at(-1) + 1).map((s) => s.type));
        }
        assert.deepEqual(last.data.game?.steps.at(-1) ?? last.data.delta.steps.at(-1), game.steps[actions.at(-1)]);
        const fresh = nextPayload(2);
        await viewer.reload();
        const freshPayload = await (await fresh).json();
        assert.equal(freshPayload.game.steps.length, actions.at(-1) + 1);
        await awaitPaint(2);
        const back = await move(0, 2);
        assert.equal(back.data.game.steps.length, actions[0] + 1);
        if (!legacy) {
            await publicDisplay.setOffline(true);
            await viewer.locator('#screen-status:not([hidden])').waitFor({ timeout: 12000 });
            await post(session.url + '/playback', { revision: 3, index: actions[1] }, headers);
            const caughtUp = nextPayload(4);
            await publicDisplay.setOffline(false);
            await caughtUp;
            await awaitPaint(4);
            const other = await post(contest + '/resolver/sessions?running=1', { config: JSON.stringify({ ...config, rehearsal: true }) });
            await post(contest + '/screens', { operation: 'bind_resolver', sessionId: other.id });
            await viewer.locator('canvas[data-session="' + other.id + '"][data-revision="0"]').waitFor();
            await post(other.url + '/delete', {});
            await viewer.waitForResponse(async (response) => audienceData(response.url()) && !!(await response.json()).notice?.includes('删除'));
        }
        return { teams: session.overview.teamCount, problems: session.overview.problemCount, steps: game.steps.length,
            firstPaintMs: Math.round(firstPaint), jumpAckMs: jump.acknowledged, jumpVisibleMs: jump.visible,
            lastStepBytes: last.bytes, lastStepVisibleMs: last.visible };
    } finally {
        await publicDisplay.close();
        await director.close();
    }
}
