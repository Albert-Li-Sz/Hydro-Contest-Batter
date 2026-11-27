import assert from 'node:assert/strict';

/** The venue operator's normal entry points, plus a guest browser on the simulated venue LAN. */
export async function venueOps(browser, base, contest) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: 'America/New_York' });
    const page = await context.newPage();
    const guest = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        await page.goto(base + '/manage/xcpcio-users#seats');
        const scope = page.getByLabel('范围');
        await scope.locator('option').nth(1).waitFor({ state: 'attached' });
        await scope.selectOption({ index: 1 });
        const summary = page.getByRole('button', { name: /^已录 IP/ });
        await summary.waitFor();
        const initial = await summary.textContent();
        await page.getByRole('button', { name: /条 IP 没对应队伍/ }).click();
        await page.locator('.seat-coverage').getByText('10.9.9.9').waitFor();
        await page.getByRole('button', { name: '批量导入' }).click();
        let dialog = page.getByRole('dialog');
        await dialog.getByLabel('导入类型').selectOption('seat');
        await dialog.getByRole('textbox').fill('player52\tZ-99');
        await dialog.getByRole('button', { name: '导入', exact: true }).click();
        await page.getByText('已导入 1 个座位，可从备份恢复').waitFor();
        await page.getByRole('button', { name: '快速补录 IP' }).click();
        dialog = page.getByRole('dialog');
        const fields = dialog.locator('.seat-quick-row');
        assert.ok((await fields.count()) > 1);
        const first = fields.first(), next = fields.nth(1);
        assert.match(await first.getByLabel('网段前缀').inputValue(), /^10\.\d+\.0\.$/);
        await first.getByLabel(/IP 末段/).fill('220');
        await first.getByLabel(/IP 末段/).press('Enter');
        assert.ok(await next.getByLabel(/IP 末段/).evaluate(node => document.activeElement === node));
        await dialog.getByRole('button', { name: '保存 IP' }).click();
        await page.getByText('已导入 1 条 IP，可从备份恢复').waitFor();
        await page.waitForFunction(text => ![...document.querySelectorAll('button')].some(button => button.textContent === text), initial);

        const secret = 'local-only-test,&" -';
        const sent = [];
        context.on('request', request => { if (request.postData()?.includes('local-only-test') || request.url().includes('local-only-test')) sent.push(request.url()); });
        // Capture the contents that Chrome would send to its native print dialog.
        await page.evaluate(() => {
            const append = document.body.append.bind(document.body);
            document.body.append = (...items) => {
                append(...items);
                for (const item of items) if (item instanceof HTMLIFrameElement && item.title === '密码条打印页') item.contentWindow.print = () => {
                    document.body.dataset.printedStrip = item.contentDocument.querySelector('article')?.textContent || '';
                    item.contentWindow.dispatchEvent(new Event('afterprint'));
                };
            };
        });
        await page.getByRole('button', { name: '打印密码条' }).click();
        dialog = page.getByRole('dialog');
        await dialog.locator('input[type=file]').setInputFiles({ name: 'slips.csv', mimeType: 'text/csv', buffer: Buffer.from('\uFEFFPaSsWoRd,AcCoUnT\r\n"local-only-test,&"" -",player52') });
        await dialog.getByRole('button', { name: '打印 A4 密码条' }).click();
        await page.waitForFunction(() => !!document.body.dataset.printedStrip);
        const strip = await page.locator('body').getAttribute('data-printed-strip');
        for (const value of [secret, 'player52', '选手 52', 'Z-99', '河海大学']) assert.ok(strip.includes(value), value);
        assert.deepEqual(sent, []);
        assert.equal(await page.locator('iframe[title="密码条打印页"]').count(), 0);

        await page.goto(base + contest + '/presence?phase=before');
        await page.getByText('收集机位 IP', { exact: true }).click();
        await page.getByLabel('开启 IP 收集').check();
        await page.getByLabel('允许网段').fill('127.0.0.1/32');
        await page.getByRole('button', { name: '保存收集设置' }).click();
        const link = page.getByRole('link', { name: '打开登记页' });
        await link.waitFor();
        const target = await link.getAttribute('href');
        const registration = await guest.newPage();
        registration.on('pageerror', error => errors.push(error.message));
        await registration.goto(base + target);
        await registration.getByRole('textbox', { name: '本队登录账号' }).fill('player52');
        await registration.getByRole('button', { name: '登记本机 IP' }).click();
        await registration.locator('#registered').getByText('选手 52').waitFor();
        await page.getByLabel('开启 IP 收集').uncheck();
        await page.getByRole('button', { name: '保存收集设置' }).click();
        await link.waitFor({ state: 'hidden' });
        assert.equal((await registration.reload()).status(), 403);
        await registration.getByText('本场 IP 收集已关闭').waitFor();

        await page.goto(base + contest + '/balloons');
        const start = page.getByRole('button', { name: '开启气球配送' });
        const pending = page.getByRole('button', { name: /待配送/, exact: false }).filter({ has: page.locator('strong') }).first();
        await start.or(pending).first().waitFor();
        if (await start.isVisible()) await start.click();
        await pending.click();
        const matrix = page.getByRole('table', { name: '队伍 × 题目' });
        assert.ok(await matrix.isVisible());
        assert.ok(await matrix.locator('td[data-state=pending]').first().evaluate(node => node === document.activeElement));
        await page.goto(base + contest + '/control');
        await page.locator('.control-status').getByText(/GMT\+8|UTC\+8/).first().waitFor();
        assert.deepEqual(errors, []);
    } finally { await guest.close(); await context.close(); }
}
