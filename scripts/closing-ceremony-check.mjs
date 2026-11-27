import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { actionIndicesFor, awardStops, teamJump } from '../resolver/public/js/playback-model.js';

const contest = '/contest/demo';
const timeout = { timeout: 12000 };
const runtime = (page, id) => page.locator('#' + id).evaluate(el => JSON.parse(el.textContent));
const program = (page, type) => page.locator('body[data-program="' + type + '"]').waitFor(timeout);
const pairCode = async page => {
    await page.waitForFunction(() => /^[A-Z2-9]{3}-[A-Z2-9]{3}$/.test(document.querySelector('#screen-code')?.textContent), null, timeout);
    return page.locator('#screen-code').innerText();
};

async function resolver(context, base, image) {
    const page = await context.newPage();
    await page.addInitScript(() => {
        const draw = CanvasRenderingContext2D.prototype.drawImage;
        CanvasRenderingContext2D.prototype.drawImage = function (source, ...args) {
            if (this.canvas.id === 'screen' && source.currentSrc?.includes('/resolver/photos/')) window.paintedTeamPhoto = source.currentSrc;
            return draw.call(this, source, ...args);
        };
    });
    await page.goto(base + contest + '/resolver');
    const files = Array.from({ length: 8 }, (_, i) => ({ ...image, name: 'team' + (i + 1) + '.png' }));
    await page.locator('#photo-files').setInputFiles([...files, { ...image, name: 'unknown.png' }]);
    await page.getByText('已上传 8 / 9 张照片').waitFor();
    assert.match(await page.locator('#photo-unmatched').innerText(), /unknown.png/);
    assert.equal(await page.locator('#photo-teams img').count(), 8);
    // Batch uploads are cut to 4:3 on their own; a single photo is framed in the dialog first.
    assert.ok(await page.locator('#photo-teams img').first().evaluate(img => img.decode().then(() => Math.abs(img.naturalWidth / img.naturalHeight - 4 / 3) < 0.01)));
    const oldPhoto = await page.locator('#photo-teams img').first().getAttribute('src');
    const firstRow = page.locator('#photo-teams .resolver-session').first();
    const frame = async () => { await page.locator('#photo-crop[open]').waitFor(); await page.locator('#photo-crop').getByRole('button', { name: '上传' }).click(); };
    await firstRow.locator('input[type=file]').setInputFiles(image); await frame();
    await page.waitForFunction(old => document.querySelector('#photo-teams img').getAttribute('src') !== old, oldPhoto);
    assert.equal((await context.request.get(base + oldPhoto)).status(), 404);
    await firstRow.getByText('删除照片').click();
    await firstRow.locator('img').waitFor({ state: 'detached' });
    await firstRow.locator('input[type=file]').setInputFiles(image); await frame();
    await firstRow.locator('img').waitFor();
    await page.locator('[name=freezeMode]').selectOption('custom');
    await page.locator('[name=freezeMinutes]').fill('250');
    await page.locator('[name=autoplay]').uncheck();
    await page.locator('#start-btn').click();
    await page.waitForFunction(() => window.ICPCResolver?.game);
    const game = await page.evaluate(() => window.ICPCResolver.game);
    const actions = actionIndicesFor(game.steps);
    // The bronze zone begins before the cursor first reaches the zone's lowest row.
    const bronze = new Set(game.contest.awards.filter(a => /bronze/.test(a.id)).flatMap(a => a.teamIds));
    const lowest = Math.max(...game.steps.filter(s => s.type === 'selectTeam' && s.selectType !== 'NORMAL' && Number.isInteger(s.row) && bronze.has(s.teamIds[0])).map(s => s.row));
    const stop = awardStops(game)[0];
    const position = actions.indexOf(stop);
    assert.ok(position > 0);
    const entering = game.steps[actions[position + 1]];
    assert.equal(entering.row, lowest);
    const early = game.steps.slice(0, stop + 1).map((s, i) => ({ i, type: s.type, selectType: s.selectType, row: s.row, team: s.teamIds?.[0] })).filter(s => s.type === 'selectTeam' && Number.isInteger(s.row) && s.row <= lowest);
    assert.deepEqual(early, [], JSON.stringify({ stop, lowest, entering, stops: awardStops(game) }));
    const at = i => page.waitForFunction(index => window.ICPCResolver.index === index, i, timeout);
    await page.keyboard.press('j'); await page.keyboard.press('j'); await at(stop);
    await page.keyboard.press('ArrowLeft');
    await page.getByText('再按一次撤回上一步', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.ICPCResolver.index), stop);
    await page.keyboard.press('ArrowLeft'); await at(actions[position - 1]);
    await page.locator('#btn-award').click(); await at(stop);
    // G / I: ten teams on and back, each confirmed by a second press.
    const ahead = teamJump(game, actions, position, 10);
    await page.keyboard.press('g');
    await page.getByText('再按一次前进 10 队', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.ICPCResolver.index), stop);
    await page.keyboard.press('g'); await page.keyboard.press('j'); await at(ahead);
    await page.keyboard.press('i'); await page.keyboard.press('i');
    await at(teamJump(game, actions, actions.indexOf(ahead), -10));
    await page.locator('#btn-award').click(); await at(stop);
    await page.locator('#btn-prev').click(); await at(actions[position - 1]);
    const award = actions.find(i => i > stop && game.steps[i].type === 'presentation' && game.steps[i].screen === 'teamAward');
    assert.ok(award);
    for (const i of actions.slice(position).filter(i => i <= award)) {
        await page.locator('#btn-next').click(); await at(i);
    }
    await page.waitForFunction(() => window.paintedTeamPhoto, null, timeout);
    const photo = await page.evaluate(() => window.paintedTeamPhoto);
    assert.ok((await context.request.get(photo)).ok());
    return { url: photo, page };
}

async function slides(context, browser, base, folder, image) {
    const snap = await context.request.post(base + contest + '/results', { form: { snapshotName: '闭幕式定稿' }, maxRedirects: 0 });
    const source = new URL(snap.headers().location, base).searchParams.get('before');
    assert.ok(source);
    const page = await context.newPage();
    await page.goto(base + contest + '/ceremony?source=' + source);
    await page.locator('#ceremony-strip .ce-thumb').first().waitFor();
    assert.equal(await page.locator('[name=source]').inputValue(), source);
    assert.equal(await page.locator('#ceremony-stage .cs-cover h1').count(), 1);
    await page.getByLabel('海蓝').check();
    await page.getByLabel('队员', { exact: true }).check();
    await page.locator('#ceremony-background').setInputFiles(image);
    await page.locator('#ceremony-stage .ceremony-slide[data-background]').waitFor();
    await page.getByRole('button', { name: '保存设置' }).click();
    await page.getByText('设置已保存').waitFor();
    await page.reload();
    await page.locator('#ceremony-stage .ceremony-slide[data-theme=blue][data-background]').waitFor();
    assert.ok(await page.getByLabel('队员', { exact: true }).isChecked());
    // Keys reach the slides only while the stage has focus or is full screen.
    await page.locator('h1.section__title').click();
    await page.keyboard.press('b'); assert.equal(await page.locator('#ceremony-stage[data-black]').count(), 0);
    await page.locator('#ceremony-play').click();
    assert.ok(await page.evaluate(() => !!document.fullscreenElement));
    const count = page.locator('#ceremony-count');
    await page.keyboard.press('PageDown'); assert.match(await count.innerText(), /^2 \/ /);
    await page.keyboard.press('b'); assert.ok(await page.locator('#ceremony-stage[data-black]').count());
    await page.keyboard.press('b'); await page.keyboard.press('End');
    const last = (await count.innerText()).split(' / '); assert.equal(last[0], last[1]);
    await page.keyboard.press('Home'); assert.match(await count.innerText(), /^1 \/ /);
    await page.keyboard.press('f');
    const ready = page.waitForEvent('download');
    await page.locator('#ceremony-export').click();
    const local = path.join(folder, '颁奖.html'); await (await ready).saveAs(local);
    const offline = await browser.newContext({ offline: true });
    try {
        const playback = await offline.newPage();
        const external = [];
        playback.on('request', request => { if (/^https?:/.test(request.url())) external.push(request.url()); });
        await playback.goto(pathToFileURL(local).href);
        const text = () => playback.locator('main .ceremony-slide').innerText();
        const first = await text();
        assert.match(await playback.locator('.ceremony-slide').evaluate(el => el.style.backgroundImage), /data:image/);
        await playback.keyboard.press('PageDown');
        assert.notEqual(await text(), first);
        await playback.waitForFunction(() => document.querySelector('.cs-plate strong')?.textContent);
        await playback.waitForFunction(() => [...document.images].some(img => img.src.startsWith('data:image/') && img.naturalWidth > 0));
        await playback.keyboard.press('Home'); assert.equal(await text(), first);
        assert.deepEqual(external, []);
    } finally { await offline.close(); }
    await page.close();
}

async function audience(context, base, save) {
    const url = base + contest + '/scoreboard/xcpcio-plus';
    const page = await context.newPage();
    for (const showIdentity of [true, false]) {
        await save({ showIdentity });
        await page.goto(url + '?view=manager&running=1#group=official');
        await page.getByRole('link', { name: '观众视角' }).click();
        await page.getByRole('link', { name: '返回管理视角' }).waitFor();
        assert.equal(await page.locator('.xp-page-actions a,.xp-page-actions button').count(), 1);
        assert.equal(await page.locator('.xp-no-submissions').count(), 1);
        const src = (await runtime(page, 'xcpcio-runtime')).dataSource;
        assert.match(src, /view=audience/);
        const json = await (await context.request.get(new URL(src, base).href)).json();
        const publicData = await (await context.request.get(base + contest + '/xcpcio-public?json=true&running=1')).json();
        assert.deepEqual(json, publicData);
        assert.equal(json.teams.some(team => team.organization === '南京晓庄学院'), showIdentity);
    }
    await save({ publicAccess: false });
    await page.goto(url + '?view=audience&running=1');
    await page.getByRole('link', { name: '返回管理视角' }).click();
    await page.getByRole('link', { name: '观众视角' }).waitFor();
    await page.close();
}

async function devices(context, browser, base, photo) {
    const admin = await context.newPage();
    await admin.goto(base + contest + '/screens');
    const oldFixed = new URL((await runtime(admin, 'screens-runtime')).linkBase + '/scoreboard/data', base).href;
    const booth = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const second = await browser.newContext();
    try {
        const display = await booth.newPage(), spare = await second.newPage();
        await display.goto(base + '/xcpcio-screen');
        await admin.locator('#screen-connect').click();
        const connect = async (code, newScreen) => {
            const dialog = admin.locator('#device-dialog');
            await dialog.getByLabel('配对码').fill(code);
            if (newScreen) {
                await dialog.getByLabel('名称').fill('闭幕式投影');
                await dialog.getByLabel('初始画面').selectOption('team-intro');
            }
            await dialog.getByRole('button', { name: '确认连接' }).click();
            await dialog.waitFor({ state: 'hidden' });
        };
        await connect(await pairCode(display), true); await program(display, 'team-intro');
        const row = admin.locator('.device-row').filter({ has: admin.locator('input.device-name') }).last();
        await row.getByText('在线', { exact: true }).waitFor(timeout);
        // The row shows what the screen shows, and the remote's keys come back with the screen's receipt.
        await row.locator('.device-thumb iframe[sandbox=""]').waitFor(timeout);
        await row.getByRole('button', { name: '遥控', exact: true }).click();
        await row.getByRole('button', { name: '→', exact: true }).click();
        await row.locator('.device-receipt').filter({ hasText: /^→ 已执行 · 第 \d+ \/ \d+ 页$/ }).waitFor(timeout);
        await admin.keyboard.press('f');
        await row.locator('.device-receipt').filter({ hasText: '全屏 失败：需在大屏上点击一次' }).waitFor(timeout);
        await row.getByRole('button', { name: '遥控', exact: true }).click();
        const endpoint = base + contest + '/screens/devices';
        const id = await row.getAttribute('data-device');
        const issue = async () => {
            const response = await context.request.post(endpoint, { data: { payload: JSON.stringify({ id, action: 'link' }) } });
            return (await response.json()).link;
        };
        const firstLink = await issue(), newLink = await issue();
        assert.equal((await second.request.get(base + firstLink, { maxRedirects: 0 })).status(), 404);
        await spare.goto(base + newLink); await program(spare, 'team-intro');
        await display.mouse.move(85, 50);
        await display.locator('#screen-full').click();
        await row.locator('select').first().selectOption('problem-list');
        await program(display, 'problem-list');
        assert.ok(await display.evaluate(() => !!document.fullscreenElement));
        await row.getByRole('button', { name: '+', exact: true }).click();
        await display.waitForFunction(() => document.documentElement.style.getPropertyValue('--screen-scale') === '1.1', null, timeout);
        await row.getByRole('button', { name: '识别', exact: true }).click();
        await display.locator('#screen-identify:not([hidden])').waitFor(timeout);
        assert.equal(await display.locator('#screen-identify').innerText(), '闭幕式投影');
        const reload = display.waitForEvent('framenavigated', { predicate: frame => frame === display.mainFrame(), ...timeout });
        await row.getByRole('button', { name: '刷新', exact: true }).click(); await reload;
        await program(display, 'problem-list');
        await second.clearCookies(); await spare.reload();
        const fresh = await pairCode(spare);
        await row.getByRole('button', { name: '重新配对' }).click(); await connect(fresh, false);
        await program(spare, 'problem-list'); await program(display, 'pair');
        assert.equal((await booth.request.get(base + newLink, { maxRedirects: 0 })).status(), 404);
        admin.once('dialog', dialog => dialog.accept());
        await row.getByRole('button', { name: '删除', exact: true }).click();
        await program(spare, 'pair');
        assert.ok((await context.request.get(oldFixed)).ok());
        await admin.locator('#screen-connect').click(); await connect(await pairCode(display), true);
        await program(display, 'team-intro');
        const revoke = await context.request.post(base + '/manage/xcpcio-users', { data: { operation: 'revoke_links',
            payload: JSON.stringify({ contest: 'system/6740a0000000000000000001' }) } });
        const result = await revoke.json();
        assert.ok(result.links.some(r => r.id === 'screen-devices' && r.count === 1 && !r.error));
        await program(display, 'pair');
        assert.equal((await context.request.get(photo.url)).status(), 404);
        await photo.page.waitForFunction(url => window.ICPCResolver.view._images.get(new URL(url).pathname)?.failed, photo.url, timeout);
        assert.equal((await context.request.get(oldFixed)).status(), 404);
        await admin.reload();
        const newFixed = new URL((await runtime(admin, 'screens-runtime')).linkBase + '/scoreboard/data', base).href;
        assert.ok((await context.request.get(newFixed)).ok());
    } finally { await booth.close(); await second.close(); await admin.close(); }
}

export async function closingCeremony(browser, base, folder) {
    const context = await browser.newContext();
    const settings = { manualBoards: [], participationBoards: true, schoolBoards: true, publicAccess: true, showIdentity: true, firstSolve: true, medals: { gold: 1, silver: 1, bronze: 2 }, podiumEnabled: true };
    const save = async patch => {
        const response = await context.request.post(base + contest + '/xcpcio-settings', { form: { config: JSON.stringify({ ...settings, ...patch }) } });
        assert.ok(response.ok(), await response.text());
    };
    try {
        await save({});
        const image = { name: 'photo.png', mimeType: 'image/png', buffer: await readFile(new URL('../resolver/public/assets/img/tools-logo.png', import.meta.url)) };
        const photo = await resolver(context, base, image);
        await audience(context, base, save); await save({});
        await slides(context, browser, base, folder, image);
        await devices(context, browser, base, photo);
        console.log('Closing ceremony: award photo paint, offline playback, audience projection, device pairing and revocation passed');
    } finally { await context.close(); }
}
