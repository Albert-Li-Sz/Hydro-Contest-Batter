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

const streams = ['screen', 'webcam'];

// Exercise the manager's real media elements. A decoded frame verifies the media behind each URL.
async function playDialog(manage, context) {
    const videos = manage.locator('dialog video');
    await until('dialog did not expose both recordings', async () => (await videos.count()) === 2);
    const urls = [];
    for (const video of await videos.all()) {
        const src = await video.getAttribute('src');
        const range = await context.request.get(src, { headers: { Range: 'bytes=0-31' } });
        assert.equal(range.status(), 206);
        assert.equal((await range.body()).length, 32);
        await video.evaluate(async (v) => {
            v.muted = true;
            const firstFrame = new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('no decoded video frame')), 10000);
                v.requestVideoFrameCallback(() => { clearTimeout(timer); resolve(); });
            });
            await Promise.all([v.play(), firstFrame]);
            v.pause();
            if (!v.videoWidth || !v.videoHeight) throw new Error('video has no output dimensions');
        });
        urls.push(src);
    }
    assert.notEqual(urls[0], urls[1]);
    await manage.getByRole('button', { name: '完成', exact: true }).click();
    return urls;
}

async function recoverArchive(manage, device, context, url) {
    const deviceUrl = device.url();
    const json = async () => (await context.request.get(url + '/recordings/data')).json();
    const reports = await json();
    const before = new Set(reports.segments.filter((row) => row.kind === 'archive').map((row) => row.id));
    await manage.getByRole('tab', { name: '录制设置' }).click();
    for (const label of ['留档 · 屏幕', '留档 · 摄像头']) assert.equal(await manage.getByLabel(label, { exact: true }).inputValue(), 'archiveHd');
    await manage.getByLabel('录制全程留档', { exact: true }).check();
    await manage.getByRole('button', { name: '保存录制设置' }).click();
    await manage.getByText('录制设置已保存', { exact: true }).waitFor();
    const probes = await until('both HD archive channels must upload separate probes', async () => {
        const { segments } = await json();
        const rows = streams.map((stream) => segments.find((row) => row.kind === 'archive' && row.stream === stream && !before.has(row.id)));
        return rows.every(Boolean) && rows;
    });
    for (const probe of probes) {
        assert.ok(['hevc', 'av1', 'h264'].includes(probe.quality?.codec));
        assert.ok(probe.quality.width > 0 && probe.quality.height > 0 && probe.quality.height <= 720);
        assert.equal(probe.quality.requestedHeight, 720);
        assert.equal(probe.quality.fps, 24);
        assert.equal(probe.quality.kbps, 1200);
        assert.ok(probe.endAt - probe.startAt < 4000, 'encoder verification should upload a short first segment');
    }
    await delay(14000);
    const network = await context.newCDPSession(device);
    const offline = (value) => network.send('Network.emulateNetworkConditions', { offline: value, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await network.send('Network.enable');
    await offline(true);
    try {
        await device.waitForFunction(() => !navigator.onLine);
        // Ending these synthetic device tracks must flush independently decodable archive tails.
        await device.locator('#screen-video, #webcam-video').evaluateAll((videos) => {
            for (const video of videos) {
                const track = video.srcObject.getVideoTracks()[0];
                track.stop();
                track.dispatchEvent(new Event('ended'));
            }
        });
        const stored = await until('both archives must persist while offline', () => device.evaluate(async (first) => {
            const { name } = (await indexedDB.databases()).find((db) => db.name?.startsWith('hydro-recording-v1:')) || {};
            if (!name) return null;
            const db = await new Promise((resolve) => { const r = indexedDB.open(name); r.onsuccess = () => resolve(r.result); });
            try {
                const rows = await new Promise((resolve) => { const r = db.transaction('segments').objectStore('segments').getAll(); r.onsuccess = () => resolve(r.result); });
                const found = first.map((probe) => rows.find((row) => row.kind === 'archive' && row.stream === probe.stream && row.startMs > probe.startAt && row.bytes > 0));
                return found.every(Boolean) && found;
            } finally { db.close(); }
        }, probes));
        device.once('dialog', (dialog) => dialog.accept());
        await device.goto('about:blank');
        await offline(false);
        await device.goto(deviceUrl);
        const uploaded = await until('reopened device did not drain its dual-channel archive', async () => {
            const { segments } = await json();
            const found = stored.map((saved) => segments.find((row) => row.kind === 'archive' && row.stream === saved.stream && row.startAt === saved.startMs));
            return found.every(Boolean) && found;
        });
        assert.ok(Math.min(...uploaded.map((row) => row.endAt)) - Math.max(...uploaded.map((row) => row.startAt)) > 12000, 'archives did not overlap for twelve seconds');
        for (const [index, row] of uploaded.entries()) {
            assert.equal(row.bytes, stored[index].bytes);
            assert.equal(row.quality.codec, probes[index].quality.codec);
            const reply = await context.request.get(new URL(row.url, url).href);
            const data = await reply.body();
            assert.equal(data.length, stored[index].bytes);
            // The fixture enables the synthetic webcam microphone, while screen sharing is silent.
            const hasAudio = row.mime === 'video/mp4' ? data.includes(Buffer.from('soun')) : data.includes(Buffer.from('A_OPUS')) || data.includes(Buffer.from('A_VORBIS'));
            assert.equal(hasAudio, row.stream === 'webcam', 'unexpected audio in ' + row.stream + ' ' + row.mime);
            console.log('Recovered archive', row.stream, row.quality.codec, row.quality.width + '×' + row.quality.height, row.bytes, (row.endAt - row.startAt) / 1000 + 's');
        }
        await manage.getByRole('tab', { name: '录像', exact: true }).click();
        // The longer segment contains the selected instant on both archive lanes.
        const later = uploaded[0].startAt > uploaded[1].startAt ? uploaded[0] : uploaded[1];
        const lane = manage.locator('.record-timeline > div').filter({ hasText: later.stream === 'screen' ? '屏幕' : '摄像头' });
        const segment = lane.locator('.record-segment').nth(1);
        await segment.focus();
        await segment.press('Enter');
        const urls = await playDialog(manage, context);
        for (const row of uploaded) assert.ok(urls.includes(new URL(row.url, url).href));
    } finally { await offline(false); await network.detach(); }
}

async function screenSurvivesWebcamFailure(context, url, mode, uid) {
    const device = await context.newPage();
    try {
        await device.addInitScript((fault) => {
            if (fault === 'missing') {
                navigator.mediaDevices.getUserMedia = async () => { throw new DOMException('Synthetic webcam unavailable', 'NotFoundError'); };
            } else {
                const NativeRecorder = window.MediaRecorder;
                window.MediaRecorder = class extends NativeRecorder {
                    constructor(stream, options) {
                        // Only the archive of the synthetic webcam has both audio and this target bitrate.
                        if (stream.getAudioTracks().length && options.videoBitsPerSecond === 1200000) throw new Error('Synthetic webcam encoder unavailable');
                        super(stream, options);
                    }
                };
            }
        }, mode);
        const capture = new URL(url.replace('/live/capture', '/live-capture/me'));
        capture.searchParams.set('as', String(uid));
        await device.goto(capture.href);
        if (mode === 'missing') await device.locator('#status').filter({ hasText: '没有找到摄像头' }).waitFor();
        else await device.locator('#record-status').filter({ hasText: '高清摄像头留档已停止' }).waitFor();
        const rows = await until('screen archive was lost after webcam failure', async () => {
            const data = await (await context.request.get(url + '/recordings/data')).json();
            const archives = data.segments.filter((s) => s.teamUid === uid && s.kind === 'archive');
            return archives.some((r) => r.stream === 'screen') && archives;
        });
        assert.ok(rows.every((row) => row.stream === 'screen' && ['hevc', 'av1', 'h264'].includes(row.quality?.codec)));
        const sample = await context.request.get(new URL(rows[0].url, url).href);
        assert.equal((await sample.body()).length, rows[0].bytes);
        console.log('Screen archive persisted with synthetic webcam fault', mode, rows[0].quality.codec);
    } finally { await device.close(); }
}


// Project Chromium regression with synthetic media. A device and manager use the shipped JS,
// real MediaRecorder / IndexedDB, multipart HTTP, reports, Range playback and cleanup.
export async function recordingWorkflow(manage, device, context, base, contest) {
    const url = base + contest + '/live/capture';
    await device.getByRole('button', { name: '设备自检' }).click();
    await device.locator('#record-status').filter({ hasText: '设备测试中' }).waitFor();
    await manage.getByRole('tab', { name: '录制设置' }).click();
    await manage.getByLabel('录制提交片段', { exact: true }).check();
    await manage.getByLabel('录制范围').selectOption('all');
    await manage.getByLabel('提交前 / 秒', { exact: true }).fill('2');
    await manage.getByLabel('通过后 / 秒', { exact: true }).fill('3');
    await manage.getByLabel('其他结果后 / 秒', { exact: true }).fill('3');
    await manage.getByRole('button', { name: '保存录制设置' }).click();
    await manage.getByText('录制设置已保存', { exact: true }).waitFor();
    await device.locator('#record-status').filter({ hasText: '录像中' }).waitFor({ timeout: 15000 });
    await manage.getByRole('tab', { name: '录像', exact: true }).click();
    await manage.getByLabel('状态', { exact: true }).selectOption('ready');
    const view = manage.getByRole('button', { name: '查看', exact: true }).first();
    await view.click();
    const [src] = await playDialog(manage, context);
    await manage.getByRole('tab', { name: '测试', exact: true }).click();
    let report;
    const deadline = Date.now() + 85000;
    while (!report && Date.now() < deadline) {
        const response = await context.request.get(url + '/tests', { headers: { Accept: 'application/json' } });
        const test = (await response.json()).tests.find((t) => t.kind === 'device' && t.endedAt && t.targets.length);
        if (test) {
            const metric = Object.values(test.devices)[0];
            report = { bytes: metric.bytes, uploads: metric.uploads, throughput: metric.throughputMbps, bitrates: metric.bitrates, archiveScreenCodec: metric.archiveScreenCodec, archiveWebcamCodec: metric.archiveWebcamCodec, failures: metric.failures };
        } else await new Promise((resolve) => setTimeout(resolve, 1000));
    }
    assert.ok(report, 'No self-test result. Device: ' + await device.locator('#record-status').innerText());
    assert.ok(report.bytes > 0 && report.uploads > 0 && report.throughput > 0, 'self-test must actually upload encoded media: ' + JSON.stringify(report));
    for (const key of ['clipScreen', 'clipWebcam', 'archiveScreen', 'archiveWebcam']) assert.ok(report.bitrates[key] > 0, key);
    for (const codec of [report.archiveScreenCodec, report.archiveWebcamCodec]) assert.ok(['hevc', 'av1', 'h264'].includes(codec));
    assert.equal(report.failures, 0, JSON.stringify(report));
    await manage.getByRole('button', { name: '刷新报告' }).click();
    await manage.getByText(/本次测试.*达标/).first().waitFor();
    await manage.getByRole('tab', { name: '录像', exact: true }).click();
    await manage.getByLabel('类型', { exact: true }).selectOption('archive');
    await manage.getByRole('button', { name: '预览删除范围' }).click();
    await manage.getByRole('dialog').getByText(/将永久删除 2 个文件/).waitFor();
    await manage.getByRole('dialog').getByRole('button', { name: '永久删除' }).click();
    await until('archive lanes were not cleared', async () => (await manage.locator('.record-segment').count()) === 0);
    assert.ok((await context.request.get(src)).ok(), 'scoped archive cleanup removed the unrelated clip');
    const clip = await until('judged preview submission did not upload independently playable segments', async () => {
        const data = await (await context.request.get(url + '/recordings/data')).json();
        return data.clips.find((c) => c.rid !== 'fixture' && ['ready', 'partial'].includes(c.state) && streams.every((stream) => c.streams[stream]?.segments.length));
    });
    await manage.getByRole('button', { name: '刷新', exact: true }).click();
    await manage.locator('button[data-rid="' + clip.rid + '"]').click();
    const urls = await playDialog(manage, context);
    for (const stream of streams) assert.ok(urls.some((value) => clip.streams[stream].segments.some((id) => value.endsWith('/' + id))), 'unexpected ' + stream + ' clip');
    console.log('Uploaded judged clip', clip.state, clip.streams.screen.segments.length, clip.streams.webcam.segments.length);
    await recoverArchive(manage, device, context, url);
    await screenSurvivesWebcamFailure(context, url, 'missing', 2);
    await screenSurvivesWebcamFailure(context, url, 'encoder', 3);
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
