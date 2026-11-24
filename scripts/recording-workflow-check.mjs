import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';

async function until(label, probe, timeout = 30000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        const value = await probe();
        if (value) return value;
        await delay(400);
    }
    throw new Error(label);
}

async function recoverArchive(manage, device, context, url) {
    const deviceUrl = device.url();
    const json = async () => (await context.request.get(url + '/recordings/data')).json();
    const reports = await json();
    const before = new Set(reports.segments.filter((row) => row.kind === 'archive').map((row) => row.id));
    await manage.getByRole('tab', { name: '录制设置' }).click();
    await manage.getByLabel('录制全程留档', { exact: true }).check();
    await manage.getByRole('button', { name: '保存录制设置' }).click();
    await manage.getByText('录制设置已保存', { exact: true }).waitFor();
    await delay(4500);
    await context.setOffline(true);
    try {
        // End the current real screen recording while disconnected. Its final segment must
        // survive closing this document and reopening the authenticated capture page.
        await device.locator('#screen-video').evaluate((video) => {
            const track = video.srcObject.getVideoTracks()[0];
            track.stop();
            track.dispatchEvent(new Event('ended'));
        });
        const stored = await until('archive was not persisted while offline', () => device.evaluate(async () => {
            const {name} = (await indexedDB.databases()).find((db) => db.name?.startsWith('hydro-recording-v1:')) || {};
            if (!name) return null;
            const db = await new Promise((resolve) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); });
            try {
                const rows = await new Promise((resolve) => { const r = db.transaction('segments').objectStore('segments').getAll(); r.onsuccess = () => resolve(r.result); });
                return rows.find((row) => row.kind === 'archive' && row.bytes > 0);
            } finally { db.close(); }
        }));
        device.once('dialog', (dialog) => dialog.accept());
        await device.goto('about:blank');
        await context.setOffline(false);
        await device.goto(deviceUrl);
        const uploaded = await until('reopened device did not drain its offline archive', async () => {
            const { segments } = await json();
            return segments.find((row) => row.kind === 'archive' && !before.has(row.id) && row.startAt === stored.startMs);
        });
        assert.equal(uploaded.bytes, stored.bytes);
        const reply = await context.request.get(new URL(uploaded.url, url).href);
        assert.equal((await reply.body()).length, stored.bytes);
        console.log('Recovered archive after offline capture and page reopen', uploaded.bytes);
    } finally { await context.setOffline(false); }
}


// Project Chromium regression with synthetic media. A device and manager use the shipped JS,
// real MediaRecorder / IndexedDB, multipart HTTP, reports, Range playback and cleanup.
export async function recordingWorkflow(manage, device, context, base, contest) {
    const url = base + contest + '/live/capture';
    await manage.getByRole('tab', { name: '录制设置' }).click();
    await manage.getByLabel('录制提交片段', { exact: true }).check();
    await manage.getByLabel('录制范围').selectOption('all');
    await manage.getByLabel('提交前 / 秒', { exact: true }).fill('2');
    await manage.getByLabel('通过后 / 秒', { exact: true }).fill('3');
    await manage.getByLabel('其他结果后 / 秒', { exact: true }).fill('3');
    await manage.getByRole('button', { name: '保存录制设置' }).click();
    await manage.getByText('录制设置已保存', { exact: true }).waitFor();
    await device.locator('#record-status').filter({ hasText: '录像中' }).waitFor({ timeout: 15000 });
    await device.getByRole('button', { name: '设备自检' }).click();
    await manage.getByRole('tab', { name: '录像', exact: true }).click();
    await manage.getByLabel('状态', { exact: true }).selectOption('ready');
    const view = manage.getByRole('button', { name: '查看', exact: true }).first();
    await view.click();
    const player = manage.locator('dialog video').first();
    await player.waitFor();
    const src = await player.getAttribute('src');
    const range = await context.request.get(src, { headers: { Range: 'bytes=0-31' } });
    assert.equal(range.status(), 206);
    assert.equal((await range.body()).length, 32);
    await manage.getByRole('button', { name: '完成', exact: true }).click();
    await manage.getByRole('tab', { name: '测试', exact: true }).click();
    let report;
    const deadline = Date.now() + 85000;
    while (!report && Date.now() < deadline) {
        const response = await context.request.get(url + '/tests', { headers: { Accept: 'application/json' } });
        const test = (await response.json()).tests.find((t) => t.kind === 'device' && t.endedAt && t.targets.length);
        if (test) {
            const metric = Object.values(test.devices)[0];
            report = { bytes: metric.bytes, uploads: metric.uploads, throughput: metric.throughputMbps, bitrates: metric.bitrates, failures: metric.failures };
        } else await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(report, 'No self-test result. Device: ' + await device.locator('#record-status').innerText());
    assert.ok(report.bytes > 0 && report.uploads > 0 && report.throughput > 0, 'self-test must actually upload encoded media: ' + JSON.stringify(report));
    assert.ok(Object.values(report.bitrates).some((n) => n > 0));
    assert.equal(report.failures, 0, JSON.stringify(report));
    await manage.getByRole('button', { name: '刷新报告' }).click();
    await manage.getByText(/本次测试.*达标/).first().waitFor();
    await manage.getByRole('tab', { name: '录像', exact: true }).click();
    await manage.getByLabel('类型', { exact: true }).selectOption('archive');
    await manage.getByRole('button', { name: '预览删除范围' }).click();
    await manage.getByRole('dialog').getByText(/将永久删除 1 个文件/).waitFor();
    await manage.getByRole('dialog').getByRole('button', { name: '永久删除' }).click();
    await manage.locator('.record-segment').waitFor({ state: 'detached' });
    assert.ok((await context.request.get(src)).ok(), 'scoped archive cleanup removed the unrelated clip');
    const clip = await until('judged preview submission did not upload independently playable segments', async () => {
        const data = await (await context.request.get(url + '/recordings/data')).json();
        return data.clips.find((c) => c.rid !== 'fixture' && ['ready', 'partial'].includes(c.state) && c.streams.screen?.segments.length);
    });
    console.log('Uploaded judged clip', clip.state, clip.streams.screen.segments.length);
    await recoverArchive(manage, device, context, url);
    await manage.getByRole('tab', { name: '录制设置' }).click();
    await manage.getByLabel('录制全程留档', { exact: true }).uncheck();
    await manage.getByLabel('录制提交片段', { exact: true }).uncheck();
    await manage.getByRole('button', { name: '保存录制设置' }).click();
    await manage.getByText('录制设置已保存', { exact: true }).waitFor();
    await manage.getByRole('tab', { name: '采集设备' }).click();
    console.log('Recording browser workflow', JSON.stringify(report));
}

// A venue run takes at least three real minutes. Run it separately from the regular UI sweep
// with UI_SMOKE=venue; all participants below use separate browser contexts and real encoders.
export async function venueWorkflow(browser, base, contest) {
    const manager = await browser.newContext();
    const contexts = [];
    const path = base + contest + '/live/capture';
    const request = manager.request;
    const get = async (url) => {
        const r = await request.get(url, { headers: { Accept: 'application/json' } });
        assert.ok(r.ok(), await r.text()); return r.json();
    };
    const post = async (url, operation, data) => {
        const r = await request.post(url, { headers: { Accept: 'application/json' }, data: { operation, payload: JSON.stringify(data) } });
        assert.ok(r.ok(), await r.text()); return r.json();
    };
    try {
        const { settings, teams } = await get(path + '/data');
        const recording = settings.recording;
        recording.clips = { ...recording.clips, enabled: true, webcam: null, screen: { preset: 'low' }, beforeSeconds: 2, afterAcceptedSeconds: 3, afterOtherSeconds: 3 };
        recording.archive = { ...recording.archive, enabled: true, webcam: null, screen: { preset: 'low' } };
        recording.planning.peakFactor = 2;
        await post(path, 'settings', { settings: { enabled: true, webcam: false, recording } });
        for (const team of teams.slice(0, 2)) {
            const context = await browser.newContext({ permissions: ['camera', 'microphone'] });
            contexts.push(context);
            const device = await context.newPage();
            await device.goto(base + contest + '/live-capture/me?as=' + team.uid);
            await device.locator('#record-status').filter({ hasText: '录像中' }).waitFor();
        }
        assert.equal(contexts.length, 2);
        const { testId } = await post(path + '/tests', 'start', { kind: 'venue', mode: 'peak', intervalSeconds: 30, durationSeconds: 180 });
        const sample = () => get(path + '/tests').then((data) => data.tests.find((t) => t.testId === testId));
        const report = await until('two-device venue run did not complete within the grace period', async () => {
            const row = await sample();
            return row?.endedAt && row;
        }, 235000);
        assert.equal(report.targets.length, 2);
        assert.ok(report.endedAt - report.startedAt >= 178000, 'duration was truncated');
        for (const id of report.targets) {
            const d = report.devices[id];
            assert.ok(d.done && d.uploads >= 3 && d.bitrates.archiveScreen > 0 && d.bitrates.clipScreen > 0, JSON.stringify(d));
            assert.equal(d.failures, 0);
        }
        assert.ok(report.series.length > 0 && report.summary.peakMbps > 0);
        assert.equal(report.summary.failureRate, 0);
        console.log('Venue recording', JSON.stringify({ durationSeconds: (report.endedAt - report.startedAt) / 1000,
            devices: report.targets.map((id) => { const d = report.devices[id]; return { uploads: d.uploads, bytes: d.bytes, failures: d.failures }; }) }));
    } finally {
        for (const context of contexts) await context.close();
        await manager.close();
    }
}
