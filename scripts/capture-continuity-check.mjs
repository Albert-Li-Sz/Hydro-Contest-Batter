// Regression for a contestant keeping the independent capture window open. The media inputs
// of the project's Chrome test are synthetic. Exercise the production device page and tracks.
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

export async function captureContinuity(device, contestPage, stateOf, { minimize = false } = {}) {
    const until = async (expected) => {
        for (let count = 0; count < 40; count++) {
            if (await stateOf() === expected) return;
            await delay(400);
        }
        assert.equal(await stateOf(), expected);
    };
    const screen = device.locator('#screen-video');
    const reauthorize = async () => {
        if (!(await screen.evaluate((v) => v.srcObject?.getVideoTracks()[0]?.readyState === 'live'))) {
            await device.locator('#start').click();
        }
        await device.waitForFunction(() => document.querySelector('#screen-video')?.srcObject?.getVideoTracks()[0]?.readyState === 'live');
        await until('recording');
    };
    await reauthorize();
    await contestPage.bringToFront();
    const session = minimize ? await device.context().newCDPSession(device) : null;
    let id;
    try {
        if (session) {
            id = (await session.send('Browser.getWindowForTarget')).windowId;
            await session.send('Browser.setWindowBounds', { windowId: id, bounds: { windowState: 'minimized' } });
        }
        await contestPage.close();
        // Three independent device heartbeats, spanning the 45-second liveness threshold.
        for (let i = 0; i < 3; i++) {
            await delay(16_000);
            assert.equal(await stateOf(), 'recording');
        }
    } finally {
        if (session && id) await session.send('Browser.setWindowBounds', { windowId: id, bounds: { windowState: 'normal' } });
        await session?.detach();
    }
    await device.bringToFront();
    await screen.evaluate((v) => {
        // MediaStreamTrack.stop itself does not dispatch the browser's stop-sharing event.
        const track = v.srcObject.getVideoTracks()[0];
        track.stop();
        track.dispatchEvent(new Event('ended'));
    });
    await until('connected');
    await reauthorize();
    await device.close({ runBeforeUnload: false });
    await until('disconnected');
}
