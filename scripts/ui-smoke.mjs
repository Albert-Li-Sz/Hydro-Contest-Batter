// UI smoke test: starts its own preview server and drives the pages in the system Chrome.
// Every page is opened at phone and desktop widths in light and dark; script errors, failed
// requests, horizontal overflow and stray "null"/"[object …]" text fail the run. Then the main
// interactions are exercised: capture (seat filter, settings, a recording contestant and a
// preview), screens autosave, resolver freeze options, user search and the announce screen.
//
//   pnpm test:ui            CHROME_PATH=/path/to/chrome pnpm test:ui            UI_SMOKE=interactions pnpm test:ui
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { boardFilterCheck } from './board-filter-check.mjs';
import { recordingWorkflow, venueWorkflow } from './recording-workflow-check.mjs';
import { captureContinuity } from './capture-continuity-check.mjs';
import { closingCeremony } from './closing-ceremony-check.mjs';
import { venueOps } from './venue-ops-check.mjs';
import { resolverAudience } from './resolver-audience-check.mjs';
import { liveOverlays } from './live-overlays-check.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contest = '/contest/demo';
const screen = `${contest}/screen/preview0000000000000000000000000000000000000000`;
const themed = [
    `${contest}/scoreboard/xcpcio-plus`, `${contest}/scoreboard/xcpcio-plus?view=audience&running=1`, `${contest}/ceremony`, `${contest}/perspective`, `${contest}/xcpcio-settings`, `${contest}/resolver`, `${contest}/screens`,
    `${contest}/live`, `${contest}/live/capture`, `${contest}/monitor`, `${contest}/presence`, `${contest}/overview`, `${contest}/balloons`,
    '/manage/xcpcio-users', '/manage/xcpcio-users#seats', '/manage/xcpcio-judges', '/manage/xcpcio-rejudge', '/manage/xcpcio-printers',
    `${contest}/clarification-desk`, ...['recordings', 'settings', 'tests'].map((tab) => `${contest}/live/capture#${tab}`),
    `${contest}/reactions/manage`, `${contest}/reactions/manage/layouts`, `${contest}/reactions`,
    `${contest}/jury`, `${contest}/integrity`, `${contest}/certificates`, `${contest}/certificates/mine`,
    `${contest}/results`, `${contest}/control`, ...['access', 'venue', 'media', 'recording', 'work'].map(key => `${contest}/control#${key}`), `${contest}/rejudge-review`,
];
const plain = ['/xcpcio-screen', `${contest}/live-capture/me?as=1`, `${contest}/problems?as=1`, `${contest}/presence?phase=before`,
    ...['controls', 'capture', 'scoreboard', 'ticker', 'teamSpotlight', 'contestInfo'].map((page) => `${contest}/live/admin/${page}`), `${contest}/live/admin`];
const screens = ['scoreboard', 'leaders', 'tiles', 'first-solves', 'queue', 'clock', 'countdown', 'message', 'resolver', 'problem-stats',
    'rank-trend', 'outcomes', 'groups', 'logo-wall', 'team-intro', 'problem-colors', 'floor', 'balloons', 'announce', 'judges', 'poster',
    'clarifications', 'problem-list', 'reactions'].map((type) => `${screen}/${type}`);
const ignoredConsole = /favicon|404 \(Not Found\)|NotAllowedError|Permission denied|Could not start video/;

const failures = [];
const fail = (where, message) => failures.push(`${where}: ${message}`);

const check = (where, ok, message) => { if (!ok) fail(where, message); };

function freePort() {
    return new Promise((resolve, reject) => {
        const server = createServer();
        server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); });
        server.on('error', reject);
    });
}

async function startPreview(port, statePath) {
    const child = spawn(process.execPath, [path.join(root, 'node_modules/tsx/dist/cli.mjs'), 'scripts/preview.ts'], {
        cwd: root, env: { ...process.env, XCPCIO_PREVIEW_PORT: String(port), XCPCIO_PREVIEW_STATE: statePath }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    for (let i = 0; i < 120; i++) {
        if (child.exitCode !== null) throw new Error(`preview exited:\n${output}`);
        try { if ((await fetch(`http://127.0.0.1:${port}${contest}/live`)).ok) return child; } catch { /* not up yet */ }
        await new Promise((resolve) => setTimeout(resolve, 500));
    }
    child.kill();
    throw new Error(`preview did not start:\n${output}`);
}

/** A page whose errors are recorded against `where`. */
async function open(context, base, url, where) {
    const page = await context.newPage();
    page.on('pageerror', (error) => fail(where, `script error: ${error.message}`));
    page.on('console', (message) => { if (message.type() === 'error' && !ignoredConsole.test(message.text())) fail(where, `console: ${message.text().slice(0, 160)}`); });
    page.on('response', (response) => { if (response.status() >= 400 && !/favicon/.test(response.url())) fail(where, `HTTP ${response.status()} ${response.url().replace(base, '')}`); });
    await page.goto(base + url, { waitUntil: 'load', timeout: 30000 });
    return page;
}

async function checkLayout(page, where, { tall = false } = {}) {
    const result = await page.evaluate(() => {
        const width = document.documentElement.clientWidth;
        const text = document.body.innerText;
        return {
            scroll: document.documentElement.scrollWidth, width,
            scrollHeight: document.documentElement.scrollHeight, height: document.documentElement.clientHeight,
            stray: text.match(/.{0,24}(\bnull\b|\bundefined\b|\bNaN\b|\[object \w+\]).{0,24}/)?.[0] || '',
        };
    });
    if (result.scroll > result.width + 1) fail(where, `wider than the screen (${result.scroll} > ${result.width})`);
    if (tall && result.scrollHeight > result.height + 1) fail(where, `taller than the screen (${result.scrollHeight} > ${result.height})`);
    if (result.stray) fail(where, `stray text "${result.stray}"`);
}

async function sweep(browser, base) {
    const visit = async (url, width, height, theme, options) => {
        const where = `${url} @${width}${theme === 'dark' ? ' dark' : ''}`;
        const context = await browser.newContext({ viewport: { width, height } });
        try {
            const target = new URL(url, base);
            if (theme === 'dark') target.searchParams.set('theme', 'dark');
            const page = await open(context, base, target.pathname + target.search + target.hash, where);
            if (target.pathname.endsWith('/control')) {
                const key = target.hash || '#rules';
                await page.locator('#control-nav a[aria-current="page"][href="' + key + '"]').waitFor();
                check(where, await page.locator('html').evaluate(e => e.classList.contains('theme--dark')) === (theme === 'dark'), 'wrong theme');
            }
            await page.waitForTimeout(1500);
            await checkLayout(page, where, options);
        } catch (error) { fail(where, error.message.split('\n')[0]); } finally { await context.close(); }
    };
    for (const url of themed) for (const [width, height] of [[375, 812], [1440, 900]]) for (const theme of ['light', 'dark']) await visit(url, width, height, theme);
    for (const url of plain) for (const [width, height] of [[375, 812], [1440, 900]]) await visit(url, width, height, 'light');
    for (const url of screens) await visit(url, 1920, 1080, 'light', { tall: true });
}

async function broadcastStyles(browser, base) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    try {
        const controls = await open(context, base, contest + '/live/admin/controls', 'broadcast controls');
        const output = await open(context, base, contest + '/live/preview?noStatus', 'broadcast overlay');
        for (const name of ['评测队列', '首解快报', '奖牌线追踪', '单题战况']) {
            const group = controls.getByRole('heading', { name: '显示 ' + name, exact: true });
            await group.getByRole('button', { name: '显示', exact: true }).click();
        }
        await output.getByRole('heading', { name: /奖牌线追踪/ }).waitFor();
        await output.getByRole('heading', { name: /单题战况/ }).waitFor();
        const headerStyle = (node) => {
            const css = getComputedStyle(node);
            return [css.fontFamily, css.fontSize, css.fontWeight, css.lineHeight].join(' ');
        };
        const original = await output.getByRole('heading', { name: '评测队列', exact: true }).evaluate(headerStyle);
        const medal = await output.getByRole('heading', { name: /奖牌线追踪/ }).evaluate(headerStyle);
        if (original !== medal) fail('broadcast overlay', 'medal line and original queue use different heading styles');
        const boxes = await output.locator('section[aria-label]').evaluateAll((items) => items.map((node) => {
            const r = node.getBoundingClientRect();
            return { left: r.left, right: r.right, bottom: r.bottom, height: node.clientHeight, scroll: node.scrollHeight };
        }).sort((a, b) => a.left - b.left));
        if (boxes.length !== 2 || boxes[0].right > boxes[1].left || boxes.some((r) => r.bottom > 1080 || r.scroll > r.height + 1)) {
            fail('broadcast overlay', 'broadcast graphics overlap or clip at 1920×1080');
        }
        await controls.getByRole('button', { name: '隐藏 单题战况' }).last().click();
        const problem = controls.getByRole('combobox', { name: '题目' });
        await problem.click();
        await controls.getByRole('option', { name: 'B', exact: true }).click();
        await output.getByRole('heading', { name: '单题战况 · B' }).waitFor();
        const api = base + contest + '/live/api/admin/';
        const change = async (path, data = {}) => {
            const response = await context.request.post(api + path, { data });
            if (!response.ok()) throw Error(path + ' returned ' + response.status());
        };
        const teams = await (await context.request.get(api + 'teamView/teams')).json();
        await change('teamView/SINGLE/show_with_settings', { teamId: teams[0].id, mediaTypes: [], showTimeLine: true });
        await output.waitForFunction(() => {
            const team = document.querySelector('.TeamViewContainer')?.getBoundingClientRect();
            const card = document.querySelector('section[aria-label="单题战况"]')?.getBoundingClientRect();
            return team?.height > 0 && card && team.bottom <= card.top + 1;
        });
        await output.locator('.TeamTrendGraph path[data-trend-rank]').waitFor({ state: 'attached' });
        await change('teamView/SINGLE/show_with_settings', { teamId: teams[0].id, mediaTypes: [], bottomBar: 'card' });
        await output.locator('.TeamInfoBanner').waitFor();
        await change('splitScreen/TOP_LEFT/show_with_settings', { teamId: teams[1].id, mediaTypes: [], bottomBar: 'card', showTimeLine: true });
        await output.waitForFunction(() => document.querySelectorAll('.TeamInfoBanner, .TeamTimeLine').length === 0);
        await change('splitScreen/hide');
        await output.locator('.TeamInfoBanner').waitFor();
        await change('teamView/hide');
        await output.locator('.TeamViewContainer').first().waitFor({ state: 'detached' });
        await change('teamPVP/PVP_TOP/show_with_settings', { teamId: teams[0].id, mediaTypes: [], bottomBar: 'timeline', showTimeLine: true });
        await change('teamPVP/PVP_BOTTOM/show_with_settings', { teamId: teams[1].id, mediaTypes: [], bottomBar: 'card', showTimeLine: true });
        // Both PVP views must be on screen before their missing bottom bars mean anything.
        await output.waitForFunction(() => [...document.querySelectorAll('.TeamViewContainer')]
            .filter((node) => node.getBoundingClientRect().height > 0).length === 2);
        check('broadcast overlay', await output.locator('.TeamInfoBanner, .TeamTimeLine, .TeamTrendGraph').count() === 0, 'PVP should not render bottom bar');
        await change('teamPVP/hide');
        await controls.getByRole('heading', { name: '隐藏 单题战况', exact: true }).getByRole('button', { name: '隐藏', exact: true }).click();
        await output.getByRole('region', { name: '单题战况' }).waitFor({ state: 'hidden' });
        await change('statistics/show');
        const stats = await (await context.request.get(base + contest + '/live/api/overlay/statistics')).json();
        const code = Object.keys(stats.verdictCounts).find((key) => !['PENDING', 'FROZEN'].includes(key));
        if (!code) throw Error('expected judged submissions in the statistics fixture');
        await output.getByText(code + ' ' + stats.verdictCounts[code], { exact: true }).first().waitFor();
        await change('statistics/hide');
        await change('overview/show');
        const overview = await (await context.request.get(base + contest + '/live/api/overlay/overview')).json();
        const judged = overview.verdicts?.find((v) => v.count > 0 && v.code);
        if (!judged) throw Error('the public overview has no detailed verdict for the judged fixture');
        await output.getByText(judged.code, { exact: true }).and(output.locator('[title]')).first().waitFor();
        await change('overview/hide');
    } finally { await context.close(); }
}

// The settings and specialist workspaces share one contest and the same save endpoints.
async function configuration(context, base) {
    const where = 'control';
    const control = await open(context, base, `${contest}/control?phase=sealed`, where);
    const category = (label) => control.getByRole('navigation', { name: '比赛配置分类' }).getByRole('link', { name: label });
    await category('公开与访问').click();
    const help = control.getByRole('button', { name: '公开选手屏幕帮助' });
    await help.hover();
    await control.getByRole('tooltip').waitFor();
    await control.emulateMedia({ reducedMotion: 'reduce' });
    check(where, await control.getByRole('tooltip').evaluate(node => getComputedStyle(node).animationName) === 'none', 'help animates with reduced motion');
    check(where, await control.locator('#manage-root').evaluate(node => getComputedStyle(node).animationName) === 'none', 'category animates with reduced motion');
    await control.emulateMedia({ reducedMotion: null });
    await category('公开与访问').hover();
    await control.getByRole('tooltip').waitFor({ state: 'hidden' });
    await help.focus();
    await control.getByRole('tooltip').waitFor();
    await help.press('Escape');
    await control.getByRole('tooltip').waitFor({ state: 'hidden' });
    await category('现场服务').click();
    await control.getByRole('link', { name: '气球颜色与小票分单' }).click();
    await control.getByRole('button', { name: '从 Hydro 气球颜色导入' }).waitFor();
    check(where, (await control.getByRole('tab', { name: '设置' }).getAttribute('aria-selected')) === 'true', 'balloon settings tab not selected');
    await control.goBack();
    await category('录制与存储').click();
    const bandwidth = control.getByLabel('上行 / Mbps', { exact: true });
    const previous = await bandwidth.inputValue();
    await bandwidth.fill('80');
    await control.getByRole('button', { name: '保存录制设置' }).click();
    await control.getByText('录制设置已保存', { exact: true }).waitFor();
    const captureSettings = await context.newPage();
    await captureSettings.goto(base + contest + '/live/capture#settings');
    const persisted = captureSettings.getByLabel('上行 / Mbps', { exact: true });
    check(where, await persisted.inputValue() === '80', 'recording settings differ between configuration and capture');
    await captureSettings.close();
    await bandwidth.fill(previous);
    await control.getByRole('button', { name: '保存录制设置' }).click();
    await category('采集与播出').click();
    await control.getByRole('link', { name: '媒体机连接' }).click();
    await control.getByRole('button', { name: '创建连接', exact: true }).waitFor();
    await control.goBack();
    await category('赛制与奖项').click();
    await control.getByRole('radiogroup', { name: '赛制', exact: true }).getByRole('radio', { name: 'CCPC', exact: true }).click();
    await control.getByRole('button', { name: '改用', exact: true }).click();
    await control.getByRole('status').filter({ hasText: '已改用 CCPC 赛制' }).waitFor();
    check(where, await control.getByLabel('同分规则').inputValue() === 'ccpc', 'the 赛制 did not change the ranking rule');
    check(where, await control.getByLabel('封榜前隐藏题号').isChecked(), 'the CCPC board is off');
    await control.getByLabel('过题达到').fill('5');
    await control.getByLabel('过题达到').press('Tab');
    await control.getByRole('status').filter({ hasText: '已保存' }).waitFor();
    const hidden = await (await context.request.get(`${base}${contest}/xcpcio-public?json=true&running=1`)).json();
    check(where, JSON.stringify(hidden.contest.problem_id) === JSON.stringify(['A', 'C', '']) && hidden.hiddenFrom === 2, 'the board shows hidden labels');
    await control.getByRole('button', { name: '解除封榜' }).click();
    await control.getByRole('button', { name: '解除封榜', exact: true }).last().click();
    await control.getByRole('status').filter({ hasText: '已解除封榜' }).waitFor();
    await checkLayout(control, where);
}

async function interactions(browser, base) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] });
    let where = 'capture';
    try {
        // 画面采集: enable, add devices by seat and one in another zone, filter by seat prefix.
        const manage = await open(context, base, `${contest}/live/capture`, where);
        await manage.waitForTimeout(1000);
        if ((await manage.locator('.capture-switch button').innerText()) === '启用') await manage.locator('.capture-switch button').click();
        await manage.getByRole('button', { name: '按座位添加' }).click();
        await manage.waitForTimeout(800);
        await manage.getByRole('button', { name: '添加', exact: true }).click();
        await manage.locator('dialog[open] input').first().fill('Z9-01');
        await manage.locator('dialog[open] button[type=submit]').click();
        await manage.waitForTimeout(800);
        await manage.getByLabel('按座位前缀筛选').fill('z9');
        const seats = await manage.locator('tbody tr td:nth-child(2)').allInnerTexts();
        check(where, seats.length === 1 && seats[0].startsWith('Z9-01'), `seat prefix z9 shows ${JSON.stringify(seats)}`);
        await manage.locator('thead input[type=checkbox]').check();
        check(where, (await manage.getByRole('button', { name: /^删除/ }).innerText()) === '删除 1 台', 'select all does not stay within the filter');
        await manage.getByRole('button', { name: /^删除/ }).click();
        await manage.locator('dialog[open] button[type=submit]').click();
        await manage.waitForTimeout(800);
        await manage.getByLabel('按座位前缀筛选').fill('');
        check(where, (await manage.locator('tbody tr').count()) >= 2, 'deleting the filtered device removed others');
        // Settings save as they change.
        await manage.locator('summary', { hasText: '采集设置' }).click();
        const audio = manage.locator('label.checkbox', { hasText: '摄像头采集声音' }).locator('input');
        const before = await audio.isChecked();
        await audio.click();
        await manage.waitForTimeout(1200);
        await manage.reload();
        await manage.waitForTimeout(1000);
        await manage.locator('summary', { hasText: '采集设置' }).click();
        check(where, (await manage.locator('label.checkbox', { hasText: '摄像头采集声音' }).locator('input').isChecked()) !== before, 'capture setting did not save');
        // The director console's capture page is open before the contestant connects: the device
        // must appear there by push (its fallback poll is slower than the wait below).
        const director = await open(context, base, `${contest}/live/admin/capture`, 'director capture');
        await director.waitForTimeout(1500);
        // A contestant records; the manager previews it from the table.
        where = 'capture device';
        const device = await open(context, base, `${contest}/live-capture/me?as=1`, where);
        // The page starts capturing once Hydro sends the settings; press start if it waits for a click.
        const recording = device.locator('#recording');
        await recording.waitFor({ state: 'visible', timeout: 10000 }).catch(async () => {
            if (await device.locator('#start').isVisible() && await device.locator('#start').isEnabled()) await device.locator('#start').click();
            await recording.waitFor({ state: 'visible', timeout: 10000 }).catch(() => {});
        });
        check(where, await recording.isVisible(), `not recording (status: ${await device.locator('#status').innerText()})`);
        where = 'director capture';
        const onAir = await director.getByRole('button', { name: '上屏' }).first().waitFor({ timeout: 10000 }).then(() => true, () => false);
        check(where, onAir && await director.getByText('在线', { exact: true }).first().isVisible(), 'the new device did not appear without reloading');
        where = 'capture preview';
        await manage.bringToFront();
        const row = manage.locator('tbody tr', { has: manage.locator('.manage-tag--ok') }).first();
        // Pushed as well: well before the 20-second poll.
        await row.waitFor({ timeout: 10000 }).catch(() => {});
        check(where, (await row.count()) === 1, 'no online device in the table');
        if (await row.count()) {
            await row.getByRole('button', { name: '预览' }).click();
            const playing = await manage.waitForFunction(() => [...document.querySelectorAll('.capture-grid video')].some((video) => video.videoWidth > 0),
                null, { timeout: 20000 }).then(() => true, () => false);
            check(where, playing, 'preview shows no video');
        }
        const contestantPage = await open(context, base, contest + '/problems?as=1', 'contestant heartbeat');
        const captureState = async () => {
            const r = await context.request.get(base + contest + '/live/api/admin/capture');
            const info = await r.json();
            const seat = info.devices.find((d) => d.teamId === '1');
            return !seat?.online ? 'disconnected' : seat.streams.includes('screen') ? 'recording' : 'connected';
        };
        await recordingWorkflow(manage, device, context, base, contest);
        if (process.env.UI_SMOKE === 'recording') return;
        await captureContinuity(device, contestantPage, captureState);
        // Screens save themselves.
        where = 'screens';
        const screensPage = await open(context, base, `${contest}/screens#screen-message`, where);
        await screensPage.waitForTimeout(800);
        const text = `smoke ${Date.now()}`;
        await screensPage.locator('#screen-card-message textarea').fill(text);
        await screensPage.waitForTimeout(1800);
        await screensPage.reload();
        await screensPage.waitForTimeout(800);
        check(where, (await screensPage.locator('#screen-card-message textarea').inputValue()) === text, 'message text did not save');
        // Resolver: a custom freeze point previews; the minutes field follows the menu.
        where = 'resolver';
        const resolver = await open(context, base, `${contest}/resolver`, where);
        await resolver.waitForTimeout(1200);
        await resolver.selectOption('[name=freezeMode]', 'custom');
        await resolver.fill('[name=freezeMinutes]', '60');
        await resolver.waitForTimeout(3000);
        check(where, (await resolver.locator('#preview-status').innerText()) === '预览已更新', 'preview did not update');
        check(where, await resolver.locator('#start-btn').isEnabled(), 'start button stays disabled');
        check(where, await resolver.locator('#autoplay-fields').isHidden(), 'autoplay options shown without autoplay');
        // Users are searched as typed.
        where = 'users';
        const users = await open(context, base, '/manage/xcpcio-users', where);
        await users.waitForTimeout(1000);
        const all = await users.locator('tbody tr').count();
        await users.getByLabel('搜索', { exact: true }).fill('player1');
        await users.waitForTimeout(1200);
        const found = await users.locator('tbody tr').count();
        check(where, found > 0 && found < all, `search shows ${found} of ${all}`);
        // 座位与 IP: a contest's seats with its no-login links; the duplicate filter narrows the list.
        where = 'seats';
        const seatPage = await open(context, base, '/manage/xcpcio-users#seats', where);
        await seatPage.waitForTimeout(1000);
        check(where, (await seatPage.locator('.manage-seats tbody tr').count()) > 1, 'the site-wide seat list is empty');
        const scope = seatPage.getByLabel('范围');
        await scope.selectOption({ index: 1 });
        await seatPage.waitForTimeout(1000);
        const kinds = await seatPage.locator('.manage-links .manage-link').evaluateAll(items => items.map(el => el.firstChild.textContent));
        for (const label of ['大屏', '大屏设备', '滚榜队伍照片', '气球台', '直播 overlay', '画面采集设备']) {
            check(where, kinds.includes(label), 'missing link kind ' + label);
        }
        await seatPage.locator('.manage-filters button', { hasText: '重复座位' }).click();
        await seatPage.waitForTimeout(800);
        const duplicates = await seatPage.locator('.manage-seats tbody .seat-cell.is-duplicate').count();
        check(where, duplicates === await seatPage.locator('.manage-seats tbody tr').count() && duplicates > 1, `duplicate filter shows ${duplicates}`);
        await seatPage.getByRole('button', { name: '恢复' }).click();
        const listed = await seatPage.locator('dialog[open] .manage-backup').first().waitFor({ timeout: 3000 }).then(() => true, () => false);
        check(where, listed, 'the restore dialog lists no backups');
        await seatPage.keyboard.press('Escape');
        await checkLayout(seatPage, where);
        // 特别奖: a new award picks its rule; 指定队伍 swaps the board for a team picker.
        where = 'special awards';
        const awardBoard = await open(context, base, `${contest}/xcpcio-public`, where);
        check(where, await awardBoard.locator('#xp-special').isHidden(), 'an award is displayed before it has been configured');
        const settingsPage = await open(context, base, `${contest}/xcpcio-settings`, where);
        await settingsPage.waitForTimeout(800);
        await settingsPage.getByRole('button', { name: '＋ 添加特别奖' }).click();
        const special = settingsPage.locator('.xp-special-card').last();
        check(where, await special.getByLabel('榜单').isVisible(), 'a rank award shows no board');
        await special.getByLabel('获奖方式').selectOption('manual');
        check(where, await special.getByLabel('添加获奖队伍').isVisible() && await special.getByLabel('榜单').isHidden(), 'the team picker did not replace the board');
        await special.getByLabel('获奖方式').selectOption('lastAccept');
        await special.getByLabel('特别奖名称').fill('顽强拼搏奖');
        await settingsPage.getByRole('button', { name: '保存设置', exact: true }).click();
        await settingsPage.locator('#xp-saved').waitFor({ state: 'visible' });
        await checkLayout(settingsPage, where);
        await awardBoard.getByText('顽强拼搏奖', { exact: true }).waitFor({ state: 'visible', timeout: 15000 });
        check(where, (await awardBoard.locator('#xp-special').innerText()).includes('陈言'), 'the public board shows the wrong winner');
        const frozenAwardData = await context.request.get(`${base}${contest}/xcpcio-public?json=true&frozen=1`);
        check(where, !(await frozenAwardData.json()).contest.medal.all.hydroSpecialAwards, 'the frozen board published special awards');
        // 机位监控: the seat map, the alerts, and a computer's details.
        where = 'presence';
        const presence = await open(context, base, `${contest}/presence`, where);
        await presence.waitForTimeout(1200);
        check(where, (await presence.locator('.presence-seat').count()) > 10, 'the seat map is empty');
        check(where, (await presence.locator('.presence-alert').count()) > 0, 'no alerts listed');
        await presence.locator('.presence-alert button').first().click();
        check(where, await presence.locator('dialog.presence-dialog[open] dl').isVisible(), 'the details did not open');
        await presence.keyboard.press('Escape');
        // 成绩与导出: save an immutable baseline, compare outcomes, and export awards including 特别奖.
        where = 'contest results';
        const results = await open(context, base, `${contest}/results`, where);
        await results.getByLabel('快照名称').fill('冒烟快照');
        await results.getByRole('button', { name: '拍快照' }).click();
        await results.getByRole('status').filter({ hasText: '快照已保存' }).waitFor();
        check(where, await results.locator('#results-no-changes').isVisible(), 'new snapshot differs from the current standings');
        await results.getByLabel('对比基准').selectOption('demo-rejudge-snapshot');
        await results.getByRole('button', { name: '应用', exact: true }).click();
        await results.locator('#results-submissions').waitFor();
        check(where, (await results.locator('#results-submissions').innerText()).includes('WA → AC'), 'changed judgement is missing');
        check(where, (await results.locator('#results-comparison tbody tr').count()) > 0, 'changed rows are missing');
        const standingsLink = await results.getByRole('link', { name: '下载成绩 CSV' }).getAttribute('href');
        const standingsFile = await context.request.get(base + standingsLink);
        check(where, (await standingsFile.body()).subarray(0, 3).toString('hex') === 'efbbbf', 'standings CSV has no UTF-8 BOM');
        const awardsLink = await results.getByRole('link', { name: '下载获奖名单 CSV' }).getAttribute('href');
        const awardsFile = await context.request.get(base + awardsLink);
        check(where, (await awardsFile.text()).includes('"顽强拼搏奖",3,"陈言"'), 'awards CSV omits the special award winner');
        check(where, (await results.getByRole('link', { name: '下载全部代码' }).getAttribute('href')).endsWith('/code?all=true'), 'full native code export link is missing');
        await checkLayout(results, where);
        // Print management follows changes made elsewhere without reloading (its poll is 30 s).
        where = 'printers push';
        const printers = await open(context, base, '/manage/xcpcio-printers', where);
        await printers.waitForTimeout(1500);
        const other = await open(context, base, '/manage/xcpcio-printers', where);
        const name = `冒烟 ${Date.now() % 100000}`;
        await other.evaluate(async (serverName) => {
            await fetch('/manage/xcpcio-printers', {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ operation: 'create', payload: JSON.stringify({ name: serverName, origin: location.origin }) }),
            });
        }, name);
        const seen = await printers.getByText(name).first().waitFor({ timeout: 5000 }).then(() => true, () => false);
        check(where, seen, 'a print server added elsewhere did not appear');
        // 气球配送: enabling lists the balloons; one is delivered from its card; the settings render.
        where = 'balloons';
        const balloons = await open(context, base, `${contest}/balloons`, where);
        await balloons.waitForTimeout(1000);
        const intro = balloons.getByRole('button', { name: '开启气球配送' });
        if (await intro.count()) await intro.click();
        await balloons.waitForTimeout(1500);
        const cards = await balloons.locator('.balloon-card').count();
        check(where, cards > 0, 'no balloons after enabling');
        if (cards) {
            await balloons.locator('.balloon-card button.balloon-pill').first().click();
            await balloons.waitForTimeout(1200);
            check(where, (await balloons.locator('[role=status]').first().innerText()).includes('已标记送达'), 'delivering a balloon did not report');
        }
        await balloons.getByRole('radio', { name: '按时间' }).click();
        await balloons.waitForTimeout(400);
        check(where, (await balloons.locator('.balloon-table tbody tr').count()) > 0, 'the time view is empty');
        await balloons.getByRole('tab', { name: '设置' }).click();
        await balloons.waitForTimeout(500);
        check(where, (await balloons.locator('input[type=color]').count()) > 0, 'the colour settings did not render');
        await checkLayout(balloons, where);
        // The volunteers' link, on a phone.
        where = 'balloon desk';
        const phone = await browser.newContext({ viewport: { width: 375, height: 812 } });
        try {
            const desk = await open(phone, base, `${contest}/balloon-desk/desk00000000000000000000000000000000`, where);
            await desk.waitForTimeout(1500);
            check(where, (await desk.locator('.balloon-card').count()) > 0, 'the volunteer page lists no balloons');
            check(where, (await desk.getByRole('tab', { name: '设置' }).count()) === 0, 'volunteers see the settings');
            await checkLayout(desk, where);
        } finally { await phone.close(); }
        // 答疑台: claim a question through a scoped link, reply and verify what goes public.
        where = 'clarification desk';
        const deskPage = await open(context, base, `${contest}/clarification-desk`, where);
        await deskPage.locator('[data-question]').first().waitFor();
        check(where, await deskPage.locator('.desk-delayed').count() > 0, 'no delayed question was highlighted');
        await deskPage.getByRole('button', { name: '设置', exact: true }).click();
        await deskPage.getByLabel('负责题目').selectOption('101');
        await deskPage.locator('#desk-link-name').fill('A 题裁判');
        await deskPage.getByRole('button', { name: '生成答疑员链接' }).click();
        const juryLink = deskPage.getByRole('link', { name: '打开答疑员链接' });
        await juryLink.waitFor();
        const scopedPath = await juryLink.getAttribute('href');
        const juryPage = await open(context, base, scopedPath, 'scoped clarification desk');
        await juryPage.locator('[data-question]').waitFor();
        check(where, await juryPage.locator('[data-question]').count() === 1 && !await juryPage.getByText('星际旅行').isVisible(), 'delegated scope included other questions');
        await juryPage.locator('[data-question]').click();
        await juryPage.getByRole('button', { name: '标记处理中' }).click();
        await juryPage.getByRole('button', { name: '释放认领' }).waitFor();
        await deskPage.bringToFront();
        await deskPage.getByRole('button', { name: '待回复', exact: true }).click();
        await deskPage.getByRole('button', { name: /热身题.*林澈/ }).click();
        await deskPage.getByRole('button', { name: '解除认领' }).waitFor();
        check(where, !await deskPage.getByRole('button', { name: '发送回复', exact: true }).isEnabled(), 'another judge could reply to a claimed question');
        await juryPage.bringToFront();
        await juryPage.getByLabel('套用回复模板').selectOption('请仔细阅读题面');
        await juryPage.getByLabel('同时向全体发布公告').check();
        await juryPage.getByLabel('公开公告内容').fill('A 题的输入以题面描述为准。');
        await juryPage.getByRole('button', { name: '发送回复并公告' }).click();
        await juryPage.getByText('已发送回复并发布公告。').waitFor();
        await juryPage.getByRole('button', { name: '已回复', exact: true }).click();
        await juryPage.locator('[data-question]').click();
        check(where, await juryPage.locator('#desk-existing-text').innerText() === '请仔细阅读题面', 'template reply did not persist');
        await juryPage.close();
        await deskPage.getByRole('button', { name: '公告', exact: true }).click();
        await deskPage.getByText('A 题的输入以题面描述为准。', { exact: true }).waitFor();
        const screenData = await context.request.get(`${base}${screen}/clarifications/data`).then((response) => response.json());
        check(where, screenData.data?.some((row) => row.text === 'A 题的输入以题面描述为准。')
            && !screenData.data?.some((row) => row.text === '请仔细阅读题面'), 'screen did not honor public and private text');
        await deskPage.getByLabel('公告内容', { exact: true }).fill('现场通知：请保持安静。');
        await deskPage.locator('#desk-announcement-form').getByLabel('同时推送至直播滚动条（5 分钟）').check();
        await deskPage.getByRole('button', { name: '向全体发布' }).click();
        await deskPage.getByText('现场通知：请保持安静。', { exact: true }).waitFor();
        const tickerData = await context.request.get(`${base}${contest}/live/api/admin/tickerMessage`).then((response) => response.json());
        check(where, tickerData.some((row) => row.settings?.text === '现场通知：请保持安静。'), 'announcement was not sent to the ticker');
        await deskPage.getByRole('button', { name: '设置', exact: true }).click();
        await deskPage.getByRole('button', { name: '更换链接' }).click();
        await deskPage.getByText('已更换链接。').waitFor();
        const revoked = await context.request.get(`${base}${scopedPath}/data`);
        check(where, revoked.status() === 404, 'old clarification link still works after rotation');
        await checkLayout(deskPage, where);
        // The announce screen turns pages from the first frame on.
        where = 'announce';
        for (let i = 0; i < 4; i++) {
            const page = await open(context, base, `${screen}/announce`, where);
            await page.waitForTimeout(2000);
            await page.close();
        }
        // 重测复核: restore one rejudged submission; the sessions built before it are flagged.
        where = 'rejudge review';
        const review = await open(context, base, `${contest}/rejudge-review`, where);
        await review.getByLabel('选择提交 s-13').check();
        await review.getByRole('button', { name: '恢复原结果（1）' }).click();
        await review.getByRole('button', { name: '恢复', exact: true }).click();
        await review.getByRole('status').filter({ hasText: '已更新 1 条提交' }).waitFor();
        check(where, (await review.locator('tbody tr', { hasText: 's-13' }).innerText()).includes('已恢复原结果'), 'the restore did not show');
        check(where, (await review.getByText('基于旧结果').count()) === 2, 'sessions built before the restore are not flagged');
        await checkLayout(review, where);
        where = 'control';
        await configuration(context, base);
    } catch (error) { fail(where, error.stack || error.message); } finally { await context.close(); }
}

const statePath = path.join(await mkdtemp(path.join(tmpdir(), 'xcpcio-ui-')), 'preview-state.json');
const port = await freePort();
const preview = await startPreview(port, statePath);
const base = `http://127.0.0.1:${port}`;
let browser;
try {
    browser = await chromium.launch({
        ...process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' },
        headless: true,
        args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream', '--auto-select-desktop-capture-source=Entire screen'],
    });
    // UI_SMOKE=interactions skips the page sweep while working on an interaction.
    const mode = process.env.UI_SMOKE;
    if (!mode) await sweep(browser, base);
    if (!mode || mode === 'board') await boardFilterCheck(browser, base);
    if (mode === 'control') {
        const context = await browser.newContext();
        try { await configuration(context, base); } finally { await context.close(); }
    }
    if (!mode || mode === 'venue-ops') await venueOps(browser, base, contest);
    if (mode === 'venue') await venueWorkflow(browser, base, contest);
    if (!mode || mode === 'resolver') console.log('Resolver audience', JSON.stringify(await resolverAudience(browser, base)));
    if (!mode || mode === 'live') { await broadcastStyles(browser, base); await liveOverlays(browser, base, contest); }
    if (!mode || mode === 'interactions' || mode === 'recording') await interactions(browser, base);
    if (!mode || mode === 'ceremony') await closingCeremony(browser, base, path.dirname(statePath));
    if (process.env.BASELINE_PREVIEW) console.log('Resolver v1.18.0', JSON.stringify(await resolverAudience(browser, process.env.BASELINE_PREVIEW, true)));
} finally {
    await browser?.close();
    preview.kill();
    await rm(path.dirname(statePath), { recursive: true, force: true });
}
if (failures.length) {
    console.error([...new Set(failures)].map((line) => `✗ ${line}`).join('\n'));
    console.error(`\n${failures.length} UI check(s) failed`);
    process.exit(1);
}
console.log(process.env.UI_SMOKE === 'resolver' ? 'Resolver audience checks passed' : process.env.UI_SMOKE ? 'UI interactions passed' : `UI smoke test passed: ${themed.length * 4 + plain.length * 2 + screens.length} page views and the main interactions`);
