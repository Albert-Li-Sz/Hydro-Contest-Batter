// Self-contained by design: the offline HTML embeds this same function, so everything it needs lives inside.
export function ceremonyPlayer(stage, deck, config, onPage = () => {}, options = {}) {
    let index = 0;
    let fits = new Map();
    let idleTimer = 0;
    const node = (tag, className, text) => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text !== undefined && text !== null) element.textContent = text;
        return element;
    };
    const date = (ms) => {
        const d = new Date(ms);
        return Number.isFinite(d.getTime()) ? `${d.getFullYear()} 年 ${d.getMonth() + 1} 月 ${d.getDate()} 日` : '';
    };
    // The three thirds of a band; a third the background needs stays empty and its content moves aside.
    function band(kind, zones, items, height) {
        const row = node('div', 'cs-band cs-' + kind);
        const cells = [0, 1, 2].map(() => node('div', 'cs-cell'));
        const free = [0, 1, 2].filter(i => !zones[i]);
        for (const { element, prefer } of items) {
            const at = prefer.find(i => free.includes(i) && !cells[i].childElementCount);
            if (element && at !== undefined) cells[at].append(element);
        }
        if (zones.some(Boolean)) row.style.height = (height * 0.5625).toFixed(3) + 'cqw';
        row.append(...cells);
        return row;
    }
    function ornament() {
        const rule = node('div', 'cs-rule');
        rule.append(node('span', 'cs-orn'), node('i', 'cs-gem'), node('span', 'cs-orn'));
        return rule;
    }
    function slideFor(i) {
        const page = deck.slides[i];
        const slide = node('article', 'ceremony-slide cs-theme');
        slide.dataset.theme = config.theme;
        if (config.background) {
            slide.dataset.background = '';
            slide.dataset.tone = config.ink === '#ffffff' ? 'dark' : 'light';
            slide.style.backgroundImage = 'url(' + JSON.stringify(config.background) + ')';
        }
        const backdrop = node('div', 'cs-backdrop');
        backdrop.append(node('i'));
        const frame = node('div', 'cs-frame');
        const headerZones = config.headerZones || [false, false, false], footerZones = config.footerZones || [false, false, false];
        if (headerZones.some(Boolean)) frame.style.paddingTop = '0';
        if (footerZones.some(Boolean)) frame.style.paddingBottom = '0';
        slide.append(backdrop, frame);
        const body = node('main', 'cs-body');
        const head = [], foot = [];
        if (!page) {
            body.classList.add('cs-cover');
            body.append(node('p', 'cs-empty', '所选榜单暂无获奖队伍'));
        } else if (page.kind === 'cover') {
            slide.dataset.kind = 'cover';
            body.classList.add('cs-cover');
            body.append(node('p', 'cs-kicker', 'AWARDS CEREMONY'), node('h1', '', deck.title), ornament(),
                node('p', 'cs-sub', '颁奖典礼'), node('p', 'cs-date', date(deck.date)));
        } else {
            slide.dataset.tier = page.tier;
            if (config.showTitle) head.push({ element: node('span', 'cs-title', deck.title), prefer: [0, 1, 2] });
            head.push({ element: node('span', 'cs-pill', page.board), prefer: [2, 1, 0] });
            if (page.parts > 1) foot.push({ element: node('span', 'cs-pill', page.part + ' / ' + page.parts), prefer: [2, 1, 0] });
            const plaque = node('div', 'cs-plaque');
            const plate = node('div', 'cs-plate');
            plate.append(node('strong', '', page.award));
            if (page.subtitle && page.subtitle.toLowerCase() !== page.award.trim().toLowerCase()) plate.append(node('em', '', page.subtitle));
            plaque.append(node('span', 'cs-orn'), plate, node('span', 'cs-orn'));
            const panel = node('div', 'cs-panel');
            const list = node('div', 'cs-list');
            for (const team of page.teams) {
                const entry = node('div', 'cs-entry');
                entry.append(node('span', 'cs-rank', team.rank ? String(team.rank) : '*'));
                if (team.logo) {
                    const logo = node('span', 'cs-logo'), img = new Image();
                    img.src = config.embeddedLogos?.[team.logo] || team.logo; img.alt = '';
                    logo.append(img); entry.append(logo);
                }
                const lines = node('div', 'cs-text');
                lines.append(node('b', '', team.name));
                if (team.school) lines.append(node('small', '', team.school));
                if (team.members.length) lines.append(node('small', '', team.members.join('、')));
                entry.append(lines); list.append(entry);
            }
            panel.append(list);
            body.append(plaque, panel);
        }
        frame.append(band('head', headerZones, head, config.header), body, band('foot', footerZones, foot, config.footer));
        return slide;
    }
    // Columns and type size, chosen by measuring the names: the most legible arrangement that fits.
    function measure(slide, page) {
        const list = slide.querySelector('.cs-list');
        if (!list || !list.clientHeight) return null;
        const texts = [...list.querySelectorAll('.cs-text > *')];
        const fitsAt = (size) => {
            list.style.fontSize = size + 'cqw';
            if (list.scrollHeight > list.clientHeight + 1) return false;
            return texts.every(text => text.scrollWidth <= text.clientWidth + 1);
        };
        const counts = page.columns ? [page.columns] : [1, 2, 3, 4].filter(n => n === 1 || n <= page.teams.length);
        let best = null;
        for (const cols of counts) {
            list.dataset.cols = String(cols);
            list.style.setProperty('--cols', String(cols));
            let lo = 0.7, hi = 4.2;
            if (!fitsAt(lo)) continue;
            for (let k = 0; k < 11; k++) {
                const mid = (lo + hi) / 2;
                if (fitsAt(mid)) lo = mid; else hi = mid;
            }
            if (!best || lo > best.size + 0.05) best = { cols, size: lo, wrap: false };
        }
        if (!best) return { cols: counts.at(-1), size: 0.7, wrap: true, compact: false };
        // A short list sits on a panel of its own size instead of a mostly empty one.
        list.dataset.cols = String(best.cols);
        list.style.setProperty('--cols', String(best.cols));
        fitsAt(best.size);
        const entries = list.querySelectorAll('.cs-entry');
        const used = entries.length ? entries[entries.length - 1].getBoundingClientRect().bottom - entries[0].getBoundingClientRect().top : 0;
        return { ...best, compact: used < list.clientHeight * 0.6 };
    }
    function apply(slide, fit) {
        const list = slide.querySelector('.cs-list');
        if (!list || !fit) return;
        list.dataset.cols = String(fit.cols);
        list.style.setProperty('--cols', String(fit.cols));
        list.style.fontSize = fit.size.toFixed(3) + 'cqw';
        list.classList.toggle('cs-wrap', fit.wrap);
        list.parentElement.classList.toggle('cs-compact', !!fit.compact);
    }
    // Measured once per page at a fixed size, so the stage, thumbnails and offline copy lay out alike.
    function fitFor(i) {
        const page = deck.slides[i];
        if (!page || page.kind !== 'award') return null;
        if (fits.has(i)) return fits.get(i);
        const host = node('div');
        Object.assign(host.style, { position: 'fixed', left: '-10000px', top: '0', width: '1280px', visibility: 'hidden', pointerEvents: 'none' });
        const slide = slideFor(i);
        host.append(slide);
        document.body.append(host);
        const fit = measure(slide, page);
        host.remove();
        if (fit) fits.set(i, fit);
        return fit;
    }
    function renderInto(container, i) {
        const slide = slideFor(i);
        apply(slide, fitFor(i));
        container.replaceChildren(slide);
        return slide;
    }
    function render() {
        renderInto(stage, index);
        onPage(index, deck.slides.length);
    }
    function go(to) { index = Math.max(0, Math.min(deck.slides.length - 1, to)); render(); }
    async function full() {
        if (document.fullscreenElement) await document.exitFullscreen();
        else { stage.focus(); await stage.requestFullscreen(); }
    }
    const active = () => document.fullscreenElement === stage || stage.contains(document.activeElement)
        || (options.offline && (document.activeElement === document.body || !document.activeElement));
    function key(event) {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || !active()) return;
        if (event.target !== stage && event.target.closest?.('input, select, textarea, button, a, [contenteditable=true]')) return;
        switch (event.key.toLowerCase()) {
            case 'arrowright': case 'arrowdown': case ' ': case 'pagedown': case 'enter': go(index + 1); break;
            case 'arrowleft': case 'arrowup': case 'pageup': case 'backspace': go(index - 1); break;
            case 'home': go(0); break;
            case 'end': go(deck.slides.length - 1); break;
            case 'f': full().catch(() => {}); break;
            case 'b': case '.': stage.toggleAttribute('data-black'); break;
            default: return;
        }
        event.preventDefault();
    }
    function wake() {
        stage.classList.remove('cs-idle');
        clearTimeout(idleTimer);
        if (document.fullscreenElement === stage || options.offline) idleTimer = setTimeout(() => stage.classList.add('cs-idle'), 2000);
    }
    if (!options.static) {
        document.addEventListener('keydown', key);
        stage.addEventListener('pointermove', wake);
        stage.addEventListener('click', () => { if (document.fullscreenElement === stage || options.offline) go(index + 1); });
        stage.addEventListener('contextmenu', (event) => {
            if (document.fullscreenElement !== stage && !options.offline) return;
            event.preventDefault(); go(index - 1);
        });
        document.addEventListener('fullscreenchange', wake);
    }
    render();
    return {
        full, go, renderInto, prev: () => go(index - 1), next: () => go(index + 1), get index() { return index; },
        update(data, appearance) { deck = data; config = appearance; fits = new Map(); go(index); },
    };
}
