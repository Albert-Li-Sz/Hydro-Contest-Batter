// Use the same 1280 × 720 reference frame and measured column/font fit as the player.
function measurePage(player, host, page, index) {
    const slide = player.renderInto(host, index);
    const origin = slide.getBoundingClientRect();
    const scale = 1280 / origin.width;
    const slots = {};
    const take = (key, element) => {
        if (!element) return;
        const rect = element.getBoundingClientRect();
        const style = getComputedStyle(element);
        const round = n => Math.round(n * 100) / 100;
        // The HTML header truncates long event names inside the available third of the band.
        const clip = element.closest('.cs-cell')?.getBoundingClientRect() || origin;
        const left = Math.max(rect.left,clip.left), right = Math.min(rect.right,clip.right);
        slots[key] = [round((left - origin.left) * scale), round((rect.top - origin.top) * scale),
            round(Math.max(0,right-left) * scale), round(rect.height * scale), round(parseFloat(style.fontSize) * scale)];
    };
    const one = selector => slide.querySelector(selector);
    for (const [key, selector] of Object.entries({
        title: '.cs-title', board: '.cs-head .cs-pill', part: '.cs-foot .cs-pill', panel: '.cs-panel', plaque: '.cs-plate',
        award: '.cs-plate strong', subtitle: '.cs-plate em', cover: '.cs-cover h1', kicker: '.cs-kicker', rule: '.cs-rule',
        ceremony: '.cs-sub', date: '.cs-date',
    })) take(key, one(selector));
    slide.querySelectorAll('.cs-entry').forEach((entry, i) => {
        const details = entry.querySelectorAll('.cs-text small');
        take('rank' + i, entry.querySelector('.cs-rank'));
        take('logo' + i, entry.querySelector('.cs-logo img'));
        take('name' + i, entry.querySelector('.cs-text b'));
        if (page.teams[i].school) take('school' + i, details[0]);
        if (page.teams[i].members.length) take('members' + i, details[details.length - 1]);
    });
    const fit = player.fitFor(index);
    return { cols: fit?.cols || 1, size: fit?.size || 1, wrap: fit?.wrap || false, slots };
}

export async function exportPptx(base, config, deck, player, background, ink) {
    await document.fonts.ready;
    const host = document.createElement('div');
    Object.assign(host.style, { position: 'fixed', width: '1280px', left: '-10000px', top: '0', visibility: 'hidden', pointerEvents: 'none' });
    document.body.append(host);
    let layouts;
    try { layouts = deck.slides.map((page, i) => measurePage(player, host, page, i)); } finally { host.remove(); }
    const meta = { layouts, key: deck.key, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone, ink, backgroundAt: 0, backgroundAspect: 1 };
    let fallback;
    if (background) {
        const image = new Image();
        image.src = background;
        await image.decode();
        meta.backgroundAt = Number(new URL(background, location.href).searchParams.get('v'));
        meta.backgroundAspect = image.naturalWidth / image.naturalHeight;
        // Historic API uploads could be WebP. Office readers can all display JPEG.
        const res = await fetch(background);
        if (!res.ok) throw new Error('读取颁奖背景失败');
        if ((res.headers.get('Content-Type') || '').startsWith('image/webp')) {
            const { printableImage, imageData } = await import('./image-upload.js');
            fallback = await imageData(await printableImage(await res.blob(), 3840, 'image/jpeg', 6 * 1024 ** 2));
        }
    }
    const response = await fetch(base + '/pptx', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ config: JSON.stringify(config), layout: JSON.stringify(meta), fallback }) });
    if (!response.ok || !response.headers.get('Content-Type')?.includes('presentationml.presentation')) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error?.message || body.error || '导出失败，请重新加载颁奖页后再试');
    }
    const link = document.createElement('a');
    link.href = URL.createObjectURL(await response.blob());
    link.download = deck.title + '·颁奖.pptx';
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 30000);
}
