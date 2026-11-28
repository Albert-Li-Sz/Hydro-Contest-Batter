import assert from 'node:assert/strict';

/** Exercise the public browser source and staff controls in separate tabs of the preview. */
export async function liveOverlays(browser, base, contest) {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const errors = [];
    const control = base + contest + '/control';
    const setFirstSolve = value => context.request.post(control, {
        data: { operation: 'board', payload: JSON.stringify({ firstSolve: value }) },
    });
    const previous = (await (await context.request.get(control + '/data')).json()).board.firstSolve;
    try {
        const settings = await context.newPage();
        const director = await context.newPage();
        const output = await context.newPage();
        for (const page of [settings, director, output]) page.on('pageerror', error => errors.push(error.message));
        const runsSockets = new Set();
        output.on('websocket', socket => {
            if (!socket.url().endsWith('/runs')) return;
            runsSockets.add(socket);
            socket.on('close', () => runsSockets.delete(socket));
        });
        await settings.goto(base + contest + '/live');
        const link = await settings.locator('#overlay-link').inputValue();
        const url = new URL(link);
        url.searchParams.set('onlyWidgets', 'scoreboard');
        await output.goto(url.href);
        await settings.bringToFront();
        const row = settings.locator('#overlay-clients li').filter({ hasText: '组件 scoreboard' });
        await row.locator('[data-info]').filter({ hasText: '1920 × 1080' }).waitFor();
        const id = await row.getAttribute('data-id');
        const name = await row.locator('[data-name]').innerText();
        await row.getByRole('button', { name: '识别画面' }).click();
        const badge = output.locator('[data-hydro-identify]');
        await badge.waitFor();
        assert.equal(name, '画面 #' + await badge.innerText());
        await row.locator('[data-receipt]').filter({ hasText: '识别已确认' }).waitFor();
        const reloaded = output.waitForEvent('load');
        await row.getByRole('button', { name: '刷新画面' }).click();
        await reloaded;
        await row.locator('[data-receipt]').filter({ hasText: '刷新已确认' }).waitFor();
        assert.equal(await row.getAttribute('data-id'), id);
        assert.equal(await row.locator('[data-name]').innerText(), name);
        await output.setViewportSize({ width: 1600, height: 900 });
        await row.locator('[data-info]').filter({ hasText: '1600 × 900' }).waitFor();

        assert.ok((await setFirstSolve(true)).ok());
        await director.goto(base + contest + '/live/admin/scoreboard');
        const panel = director.locator('.ScoreboardSettings');
        const timeline = panel.getByRole('checkbox', { name: '每行提交时间轴' });
        assert.equal(await timeline.isChecked(), false);
        await panel.getByRole('button', { name: '显示', exact: true }).click();
        await timeline.check();
        await output.locator('.ScoreboardTimeline [data-result=first]').first().waitFor({ state: 'attached' });
        await output.locator('.ScoreboardTimeline [data-result=wrong]').first().waitFor({ state: 'attached' });
        await output.locator('.ScoreboardTimeline [data-result=accepted]').first().waitFor({ state: 'attached' });
        assert.ok(await output.locator('.ScoreboardTimeline [data-freeze]').count() > 1);
        assert.equal(runsSockets.size, 1, 'all visible rows share one runs subscription');
        await timeline.uncheck();
        await output.locator('.ScoreboardTimeline').first().waitFor({ state: 'detached' });
        await panel.getByRole('button', { name: '隐藏', exact: true }).click();

        await settings.bringToFront();
        await settings.getByRole('button', { name: '作废并重新生成链接' }).click();
        await settings.getByRole('dialog').getByRole('button', { name: '作废并重新生成' }).click();
        await settings.getByText('已生成新链接，旧链接已失效', { exact: true }).waitFor();
        await settings.getByText('暂无直播画面连接', { exact: true }).waitFor();
        assert.equal((await context.request.get(link)).status(), 404);
        assert.deepEqual(errors, []);
    } finally {
        try { await setFirstSolve(previous); } finally { await context.close(); }
    }
}
