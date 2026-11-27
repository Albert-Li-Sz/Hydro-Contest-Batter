import assert from 'node:assert/strict';

/** Drive the enhanced board's real XCPCIO table so projection, ranks and medals are checked together. */
export async function boardFilterCheck(browser, base) {
    const context = await browser.newContext();
    try {
        const page = await context.newPage();
        await page.goto(base + '/contest/demo/scoreboard/xcpcio-plus?fixture=team');
        const rows = page.getByRole('table').locator('tbody .xp-team-row');
        const matches = rows.filter({ hasText: '破晓队' });
        await matches.waitFor();
        const all = await rows.count();
        const originalRank = await matches.getByRole('cell').first().getAttribute('aria-label');
        assert.match(originalRank, /第 3 名/);
        const panel = page.locator('#xp-board-filter');
        await panel.locator('summary').click();
        const field = panel.getByRole('combobox', { name: '匹配字段' });
        const pattern = panel.getByRole('textbox', { name: '正则表达式' });
        const apply = panel.getByRole('button', { name: '应用筛选' });
        await field.selectOption('members');
        await pattern.fill('^许青$');
        await panel.getByRole('button', { name: '添加规则' }).click();
        await field.nth(1).selectOption('seat');
        await pattern.nth(1).fill('^A-02$');
        await panel.getByLabel('规则组合').selectOption('all');
        await apply.click();
        await page.waitForFunction(() => document.querySelector('tbody .xp-team-row')?.innerText.includes('破晓队'));
        assert.equal(await rows.count(), all);
        assert.equal(await matches.getByRole('cell').first().getAttribute('aria-label'), originalRank);
        await panel.getByLabel('匹配队伍').selectOption('only');
        await apply.click();
        await rows.filter({ hasText: '星火队' }).waitFor({ state: 'hidden' });
        assert.equal(await rows.count(), 1);
        assert.match(await rows.first().innerText(), /破晓队/);
        await panel.getByLabel('规则组合').selectOption('any');
        await apply.click();
        await rows.filter({ hasText: '长风队' }).waitFor();
        assert.equal(await rows.count(), 2);
        await page.reload();
        await matches.waitFor();
        assert.equal(await rows.count(), 2);
        await panel.locator('summary').click();
        await panel.getByText('导出文本', { exact: true }).click();
        const transfer = panel.getByRole('textbox', { name: '筛选规则文本' });
        const saved = JSON.parse(await transfer.inputValue());
        assert.deepEqual(saved.rules.map(rule => rule.field), ['members', 'seat']);
        await transfer.fill(JSON.stringify({ ...saved, rules: [{ field: 'school', pattern: '[' }] }));
        await panel.getByText('导入文本', { exact: true }).click();
        await panel.getByText('第 1 条正则表达式无效').waitFor();
        assert.equal(await rows.count(), 2);
        await transfer.fill(JSON.stringify({ match: 'all', action: 'only', rules: [
            { field: 'coaches', pattern: '吴' }, { field: 'school', pattern: '晓庄' }, { field: 'name', pattern: '^破晓队$' },
        ] }));
        await panel.getByText('导入文本', { exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll('tbody .xp-team-row').length === 1);
        assert.equal(await matches.getByRole('cell').first().getAttribute('aria-label'), originalRank);
        await panel.getByText('清除筛选', { exact: true }).click();
        await rows.filter({ hasText: '星火队' }).waitFor();
        assert.equal(await rows.count(), all);
    } finally {
        await context.close();
    }
}
