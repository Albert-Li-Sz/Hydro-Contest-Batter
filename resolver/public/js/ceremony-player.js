// Self-contained by design: the offline HTML embeds this same function.
export function ceremonyPlayer(stage, deck, config, onPage = () => {}) {
    let index = 0;
    function node(tag, text) {
        const element = document.createElement(tag);
        element.textContent = text;
        return element;
    }
    function render() {
        const page = deck.slides[index];
        const slide = node('article', '');
        slide.className = 'ceremony-slide';
        slide.dataset.theme = config.theme;
        if (config.background) {
            slide.dataset.background = '';
            slide.style.backgroundImage = 'url(' + JSON.stringify(config.background) + ')';
            slide.style.color = config.ink;
        }
        // Vertical CSS padding percentages resolve against width, so use absolute insets on the content.
        const body = node('div', '');
        Object.assign(body.style, { position: 'absolute', inset: config.header + '% 0 ' + config.footer + '%', display: 'flex', flexDirection: 'column' });
        slide.append(body);
        if (page) {
            const header = node('header', '');
            header.append(node('span', config.showTitle ? deck.title : ''), node('span', page.board));
            const grid = node('div', '');
            grid.className = 'ceremony-winners';
            grid.style.setProperty('--columns', page.columns);
            const rows = Math.ceil(page.teams.length / page.columns);
            const size = Math.min(4.8, 8 / Math.sqrt(page.columns + 1), (44 - (config.header + config.footer) * .42) / (rows * (config.showMembers ? 2.5 : 1.95)));
            grid.style.fontSize = size + 'cqw';
            for (const team of page.teams) {
                const entry = node('div', ''); entry.className = 'ceremony-winner';
                if (team.logo) { const img = new Image(); img.src = config.embeddedLogos?.[team.logo] || team.logo; img.alt = ''; entry.append(img); }
                const lines = node('div', ''); lines.append(node('strong', team.name));
                if (team.school) lines.append(node('small', team.school));
                if (team.members.length) lines.append(node('small', team.members.join('、')));
                entry.append(lines); grid.append(entry);
            }
            body.append(header, node('h2', page.award), grid, node('footer', page.parts > 1 ? page.part + ' / ' + page.parts : ''));
        } else body.append(node('h2', '所选榜单暂无获奖队伍'));
        stage.replaceChildren(slide);
        const grid = slide.querySelector('.ceremony-winners');
        if (grid) {
            let size = parseFloat(grid.style.fontSize);
            while (size > 1 && grid.scrollHeight > grid.clientHeight + 1) { size -= .15; grid.style.fontSize = size + 'cqw'; }
        }
        onPage(index, deck.slides.length);
    }
    function go(to) { index = Math.max(0, Math.min(deck.slides.length - 1, to)); render(); }
    async function full() {
        if (document.fullscreenElement) await document.exitFullscreen();
        else { stage.focus(); await stage.requestFullscreen(); }
    }
    function key(event) {
        if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey ||
            event.target.closest?.('input, select, textarea, button, a, [contenteditable=true]')) return;
        switch (event.key.toLowerCase()) {
            case 'arrowright': case ' ': case 'pagedown': go(index + 1); break;
            case 'arrowleft': case 'pageup': go(index - 1); break;
            case 'home': go(0); break;
            case 'end': go(deck.slides.length - 1); break;
            case 'f': full().catch(() => {}); break;
            case 'b': stage.toggleAttribute('data-black'); break;
            default: return;
        }
        event.preventDefault();
    }
    document.addEventListener('keydown', key);
    render();
    return { full, prev: () => go(index - 1), next: () => go(index + 1),
        update(data, appearance) { deck = data; config = appearance; go(index); } };
}
