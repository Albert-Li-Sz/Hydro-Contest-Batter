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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const contest = '/contest/demo';
const screen = `${contest}/screen/preview0000000000000000000000000000000000000000`;
const themed = [
    `${contest}/scoreboard/xcpcio-plus`, `${contest}/xcpcio-settings`, `${contest}/resolver`, `${contest}/screens`,
    `${contest}/live`, `${contest}/live/capture`, `${contest}/monitor`, `${contest}/overview`,
    '/manage/xcpcio-users', '/manage/xcpcio-judges', '/manage/xcpcio-rejudge', '/manage/xcpcio-printers',
];
const plain = [`${contest}/live-capture/me?as=1`, `${contest}/problems?as=1`,
    ...['controls', 'capture', 'scoreboard', 'ticker', 'teamSpotlight', 'contestInfo'].map((page) => `${contest}/live/admin/${page}`), `${contest}/live/admin`];
const screens = ['scoreboard', 'leaders', 'tiles', 'first-solves', 'queue', 'clock', 'countdown', 'message', 'resolver', 'problem-stats',
    'rank-trend', 'outcomes', 'groups', 'logo-wall', 'team-intro', 'problem-colors', 'floor', 'balloons', 'announce', 'judges', 'poster',
    'clarifications', 'problem-list'].map((type) => `${screen}/${type}`);
const ignoredConsole = /favicon|404 \(Not Found\)|NotAllowedError|Permission denied|Could not start video/;

const failures = [];
const fail = (where, message) => failures.push(`${where}: ${message}`);

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
            const page = await open(context, base, theme === 'dark' ? `${url}${url.includes('?') ? '&' : '?'}theme=dark` : url, where);
            await page.waitForTimeout(1500);
            await checkLayout(page, where, options);
        } catch (error) { fail(where, error.message.split('\n')[0]); } finally { await context.close(); }
    };
    for (const url of themed) for (const [width, height] of [[375, 812], [1440, 900]]) for (const theme of ['light', 'dark']) await visit(url, width, height, theme);
    for (const url of plain) for (const [width, height] of [[375, 812], [1440, 900]]) await visit(url, width, height, 'light');
    for (const url of screens) await visit(url, 1920, 1080, 'light', { tall: true });
}

async function interactions(browser, base) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, permissions: ['camera', 'microphone'] });
    const check = (where, ok, message) => { if (!ok) fail(where, message); };
    try {
        // 画面采集: enable, add devices by seat and one in another zone, filter by seat prefix.
        let where = 'capture';
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
        await users.getByLabel('搜索').fill('player1');
        await users.waitForTimeout(1200);
        const found = await users.locator('tbody tr').count();
        check(where, found > 0 && found < all, `search shows ${found} of ${all}`);
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
        // The announce screen turns pages from the first frame on.
        where = 'announce';
        for (let i = 0; i < 4; i++) {
            const page = await open(context, base, `${screen}/announce`, where);
            await page.waitForTimeout(2000);
            await page.close();
        }
    } catch (error) { fail('interactions', error.message.split('\n')[0]); } finally { await context.close(); }
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
    if (process.env.UI_SMOKE !== 'interactions') await sweep(browser, base);
    await interactions(browser, base);
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
console.log(`UI smoke test passed: ${themed.length * 4 + plain.length * 2 + screens.length} page views and the main interactions`);
