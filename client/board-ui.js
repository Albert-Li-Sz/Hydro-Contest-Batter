// Accessibility and layout adapter for the pinned XCPCIO 0.98.0 components (desktop layout at every width).
// Ranking and submissions remain owned by the upstream Vue application.
const app = document.getElementById('app');
if (app) {
    let awardRules;
    let specialText;
    // The contest's own medal names; before they arrive, the defaults of lib/settings.ts.
    const citationOf = (tier) => awardRules?.[`${tier}Citation`] || { gold: '金奖', silver: '银奖', bronze: '铜奖' }[tier];
    window.addEventListener('hydro-xcpcio-awards', (event) => {
        awardRules = event.detail.rules;
        const podium = document.getElementById('xp-podium');
        if (podium) {
            podium.hidden = !event.detail.podium.length;
            podium.textContent = event.detail.podium.map((trophy) => `${trophy.name} ${trophy.teams.join('、')}`).join(' · ');
        }
        for (const tier of ['gold', 'silver', 'bronze']) {
            const dot = document.querySelector(`#xp-legend .xp-${tier}`);
            if (dot?.nextSibling) dot.nextSibling.textContent = citationOf(tier);
        }
        const first = document.querySelector('#xp-legend .xp-first');
        if (first) first.parentElement.hidden = !awardRules?.firstSolve;
        const special = document.getElementById('xp-special');
        const awards = event.detail.special || [];
        const text = JSON.stringify(awards);
        if (special && text !== specialText) {
            specialText = text;
            special.hidden = !awards.length;
            special.replaceChildren(...awards.map((award) => {
                const item = document.createElement('span');
                const name = document.createElement('strong');
                name.textContent = award.name;
                item.append(name, ` ${award.teams}`);
                return item;
            }));
        }
    });
    // Below this width identity and score share one column (see enhanced.css).
    const mobile = matchMedia('(max-width: 1023px)');
    let scheduled = false;
    let overlays;
    let statisticsId = 0;
    const modalFocus = new Map();
    const hideSubmissions = !!app.closest('.xp-no-submissions');
    const isSubmissions = (element) => ['提交', 'Submissions'].includes(element.textContent.trim());
    // School logos are bundled next to this script (scripts/fetch-logos.mjs); nothing is loaded from other hosts.
    const logoBase = new URL('./logos/', import.meta.url);
    let logoNames = null;
    const schoolKey = (name) => String(name).normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase();
    // The logo is a faint watermark behind the school (desktop) or the name (narrow screens);
    // participants without a school get the ICPC mark. Rows are recycled while scrolling, so
    // every pass sets or clears it for whatever school the row shows now.
    function setLogo(row, name) {
        const id = name === '未填写学校' ? 'icpc' : logoNames?.[schoolKey(name)];
        const src = id ? new URL(`${id}.webp`, logoBase).href : '';
        if (row.dataset.xpLogo === src) return;
        row.dataset.xpLogo = src;
        row.classList.toggle('xp-has-logo', !!src);
        if (src) row.style.setProperty('--xp-logo', `url("${src}")`); else row.style.removeProperty('--xp-logo');
    }
    // The name/school column is as wide as its longest name or school, so no blank gap sits
    // between it and the score columns. Widths are measured once from the board data and
    // then only grow (rows are virtualised; a shrinking column would jump while scrolling).
    const measure = document.createElement('canvas').getContext('2d');
    let widestText = 0;
    // Each name and school is measured once: decorate runs on every change while scrolling.
    const measured = new Set();
    // Team contests (Hydro 5.1): team name -> member names, from the board data.
    let teamMembers = null;
    function noteTexts(entries) {
        if (!measure) return false;
        let family = null;
        let widest = widestText;
        for (const { name, school, star } of entries) {
            const key = `${name}\n${school}\n${star}`;
            if (measured.has(key)) continue;
            measured.add(key);
            family ||= getComputedStyle(app).fontFamily || 'sans-serif';
            measure.font = `700 15px ${family}`;
            widest = Math.max(widest, measure.measureText(name || '').width + (star && !school ? 18 : 0));
            if (school) { measure.font = `400 12px ${family}`; widest = Math.max(widest, measure.measureText(school).width + (star ? 16 : 0)); }
        }
        if (widest <= widestText) return false;
        widestText = widest; return true;
    }
    const statusClass = (text) => {
        if (/^(accepted|correct|ac|通过)$/i.test(text)) return 'xp-st-ok';
        if (/pending|frozen|judging|waiting|compiling|running|queue|评测|封榜/i.test(text)) return 'xp-st-wait';
        if (/compil|skipped|cancel|ignored|编译|取消|忽略/i.test(text)) return 'xp-st-neutral';
        return 'xp-st-bad';
    };
    // The upstream app replaces the document title; keep the host site's.
    const hostTitle = document.title;
    const titleElement = document.querySelector('title');
    if (titleElement) {
        new MutationObserver(() => { if (document.title !== hostTitle) document.title = hostTitle; })
            .observe(titleElement, { childList: true, characterData: true, subtree: true });
    }
    const observer = new MutationObserver(() => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(decorate);
    });
    const observe = () => observer.observe(app, { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ['class'] });
    function decorate() {
        scheduled = false;
        observer.disconnect();
        try {
            const contestTitle = app.querySelector('div.title');
            const meta = contestTitle?.nextElementSibling;
            meta?.classList.add('xp-board-meta');
            for (const [selector, name] of [['[i-material-symbols-info-outline]', '比赛信息'], ['[i-material-symbols-share]', '分享榜单']]) {
                const control = app.querySelector(`.xp-board-meta ${selector}, .xp-board-tools ${selector}`);
                if (control && !control.closest('.xp-icon-button')) {
                    const button = document.createElement('button');
                    button.type = 'button'; button.className = 'xp-icon-button';
                    button.setAttribute('aria-label', name); button.title = name;
                    button.addEventListener('click', (event) => { if (event.target === button) control.click(); });
                    control.before(button); button.append(control);
                    control.setAttribute('aria-hidden', 'true');
                }
            }
            for (const timeline of app.querySelectorAll('.float-left + .flex-1')) {
                if (timeline.parentElement?.querySelector('sup')) {
                    const row = timeline.parentElement;
                    const clock = row.parentElement;
                    row.classList.add('xp-timeline'); clock.classList.add('xp-contest-clock');
                    if (!row.querySelector('.xp-time-toggle')) {
                        const toggle = document.createElement('button');
                        toggle.type = 'button'; toggle.className = 'xp-time-toggle';
                        toggle.textContent = '比赛时间'; toggle.setAttribute('aria-expanded', 'false');
                        toggle.addEventListener('click', () => {
                            const open = clock.classList.toggle('xp-time-expanded');
                            toggle.setAttribute('aria-expanded', String(open));
                            toggle.textContent = open ? '收起时间' : '比赛时间';
                        });
                        row.append(toggle);
                    }
                }
            }
            // Upstream labels the elapsed contest time as the current time.
            for (const item of app.querySelectorAll('.xp-contest-clock .float-left')) {
                const text = item.firstChild;
                if (text?.nodeType === Node.TEXT_NODE && text.nodeValue.includes('当前时间')) text.nodeValue = text.nodeValue.replace('当前时间', '已用时间');
            }
            const states = { PENDING: '未开始', RUNNING: '进行中', FROZEN: '封榜中', FINISHED: '已结束', PAUSED: '已暂停' };
            for (const dot of app.querySelectorAll('.xp-timeline .label')) {
                const label = dot.nextElementSibling;
                if (label && states[label.textContent.trim()]) label.textContent = states[label.textContent.trim()];
            }
            for (const placeholder of app.querySelectorAll('.ui.selection.dropdown > .text.default')) {
                if (placeholder.textContent.trim() === 'Group') placeholder.textContent = '筛选组别';
            }
            const menuLists = [...app.querySelectorAll('.second-level-menu-item')]
                .map((item) => item.parentElement).filter((value, index, all) => all.indexOf(value) === index);
            for (const list of menuLists) {
                list.classList.add('xp-menu-items');
                list.setAttribute('role', 'group');
                for (const item of list.querySelectorAll('.second-level-menu-item')) {
                    item.setAttribute('role', 'button'); item.tabIndex = 0;
                    item.setAttribute('aria-pressed', String(item.classList.contains('second-level-menu-item-current')));
                }
            }
            if (hideSubmissions) {
                for (const item of menuLists[1]?.querySelectorAll('.second-level-menu-item') || []) {
                    if (!isSubmissions(item)) continue;
                    item.hidden = true;
                    // Opened through a shared link: go back to the ranking.
                    if (item.classList.contains('second-level-menu-item-current')) menuLists[1].querySelector('.second-level-menu-item:not([hidden])')?.click();
                }
            }
            const groupList = menuLists[0];
            if (groupList) {
                const groupMenu = groupList.parentElement;
                groupMenu.classList.add('xp-group-menu');
                groupList.setAttribute('aria-label', '选择分榜');
                const navigation = groupMenu.parentElement?.parentElement;
                navigation?.classList.add('xp-navigation');
                if (menuLists[1]) {
                    menuLists[1].setAttribute('aria-label', '榜单功能');
                    menuLists[1].parentElement.classList.add('xp-view-menu');
                }
                let label = groupMenu.parentElement.querySelector('.xp-mobile-group');
                if (!label) {
                    label = document.createElement('label'); label.className = 'xp-mobile-group';
                    label.textContent = '选择分榜';
                    const select = document.createElement('select'); select.className = 'select';
                    select.setAttribute('aria-label', '选择分榜');
                    select.addEventListener('change', () => {
                        groupList.querySelectorAll('.second-level-menu-item')[Number(select.value)]?.click();
                    });
                    label.append(select); groupMenu.after(label);
                }
                // Info and share sit beside the board switcher, so the header is a single control row.
                const tools = app.querySelector('.xp-board-tools') || meta?.querySelector(':scope > [flex]');
                if (tools && tools.parentElement !== groupMenu.parentElement) {
                    tools.classList.add('xp-board-tools'); groupMenu.parentElement.append(tools);
                }
                meta?.classList.toggle('xp-meta-empty', meta.childElementCount === 0);
                const select = label.querySelector('select');
                const items = [...groupList.querySelectorAll('.second-level-menu-item')];
                if (select.options.length !== items.length || items.some((item, index) => select.options[index]?.text !== item.textContent.trim())) {
                    select.replaceChildren(...items.map((item, index) => new Option(item.textContent.trim(), String(index))));
                }
                const selected = items.findIndex((item) => item.classList.contains('second-level-menu-item-current'));
                if (selected >= 0) select.value = String(selected);
            }
            for (const [modal, previous] of modalFocus) {
                if (!modal.isConnected) { modalFocus.delete(modal); if (previous?.isConnected) previous.focus({ preventScroll: true }); }
            }
            for (const modal of app.querySelectorAll('[z-1997]')) {
                // Team/org dialogs are rendered inside table cells upstream.
                // Move their existing root (with Vue's handlers intact) outside
                // hidden/sticky cells so neither clipping nor stacking hides it.
                if (!overlays) { overlays = document.createElement('div'); overlays.className = 'xp-overlays'; app.append(overlays); }
                if (modal.parentElement !== overlays) overlays.append(modal);
                modal.classList.add('xp-modal'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
                const title = modal.querySelector('h3');
                if (title?.textContent.trim()) modal.setAttribute('aria-label', title.textContent.trim());
                const legendLabels = { Gold: citationOf('gold'), Silver: citationOf('silver'), Bronze: citationOf('bronze'), Honorable: '优胜',
                    'First to solve problem': '首次通过', 'Solved problem': '通过', 'Attempted problem': '未通过',
                    'Pending judgement/Frozen': '待评测 / 封榜', 队名: teamMembers ? '队伍' : '选手', 组织: '学校', 组别: '所属榜单' };
                for (const cell of modal.querySelectorAll('td')) {
                    const label = legendLabels[cell.textContent.trim()];
                    if (label && cell.childElementCount === 0) cell.textContent = label;
                }
                for (const menu of modal.querySelectorAll('[role="group"]')) {
                    menu.classList.add('xp-modal-menu');
                    if (hideSubmissions) for (const button of menu.querySelectorAll('button')) if (isSubmissions(button)) button.hidden = true;
                }
                for (const button of modal.querySelectorAll('button')) {
                    if (button.hasAttribute('ml-auto')) { button.setAttribute('aria-label', '关闭弹窗'); continue; }
                    if (button.closest('.xp-modal-menu')) continue;
                    button.classList.add('button');
                    if (button.type === 'submit') button.classList.add('primary');
                }
                for (const input of modal.querySelectorAll('input:not([type="checkbox"])')) input.classList.add('textbox');
                for (const input of modal.querySelectorAll('input.sr-only[type="checkbox"]')) {
                    input.parentElement.classList.add('checkbox', 'xp-toggle');
                    const label = input.parentElement.textContent.trim() || input.parentElement.previousElementSibling?.textContent.trim();
                    if (label) input.setAttribute('aria-label', label);
                }
                if (!modalFocus.has(modal)) {
                    modalFocus.set(modal, document.activeElement); modal.tabIndex = -1; modal.focus({ preventScroll: true });
                }
            }
            for (const table of app.querySelectorAll('table')) {
                const scroll = table.parentElement;
                scroll.classList.add('xp-table-scroll');
                // Only the board itself is a named, focusable scroll region; dialog tables are plain content.
                if (!table.closest('.xp-modal')) {
                    scroll.tabIndex = 0; scroll.setAttribute('role', 'region'); scroll.setAttribute('aria-label', '榜单表格，可横向滚动');
                }
                const host = scroll.parentElement;
                host?.classList.add('xp-table-host'); host?.parentElement?.classList.add('xp-table-host');
                if (!table.classList.contains('standings')) {
                    table.classList.add('xp-data-table');
                    // Submission lists: colour the result so accepted, rejected and pending stand apart.
                    const column = [...(table.tHead?.rows[0]?.cells || [])].findIndex((cell) => /^(status|状态|结果)$/i.test(cell.textContent.trim()));
                    if (column >= 0) {
                        for (const row of table.tBodies[0]?.rows || []) {
                            const cell = row.cells[column];
                            if (!cell) continue;
                            const wanted = statusClass(cell.textContent.trim());
                            if (!cell.classList.contains(wanted)) {
                                cell.classList.remove('xp-st-ok', 'xp-st-wait', 'xp-st-neutral', 'xp-st-bad');
                                cell.classList.add('xp-status', wanted);
                            }
                        }
                    }
                    continue;
                }
                const headers = [...(table.tHead?.rows[0]?.cells || [])];
                if (!headers.length) { table.classList.add('xp-legend-table'); continue; }
                table.id ||= `xp-standings-${++statisticsId}`;
                let tools = scroll.nextElementSibling;
                if (!tools?.classList.contains('xp-table-tools')) {
                    tools = document.createElement('div'); tools.className = 'xp-table-tools';
                    const button = document.createElement('button'); button.type = 'button';
                    button.className = 'xp-statistics-toggle'; button.setAttribute('aria-controls', table.id);
                    button.setAttribute('aria-expanded', 'false');
                    const label = document.createElement('span'); label.textContent = '展开题目统计';
                    const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
                    icon.setAttribute('viewBox', '0 0 16 16'); icon.setAttribute('aria-hidden', 'true');
                    const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
                    path.setAttribute('d', 'm4 6 4 4 4-4'); icon.append(path);
                    button.append(label, icon); tools.append(button); scroll.after(tools);
                    button.addEventListener('click', () => {
                        const open = table.classList.toggle('xp-statistics-open');
                        button.setAttribute('aria-expanded', String(open));
                        label.textContent = open ? '收起题目统计' : '展开题目统计';
                    });
                }
                const hasSchool = /^(Organization|School|学校|组织|单位)$/i.test(headers[1]?.textContent.trim());
                const names = ['rank', ...(hasSchool ? ['school'] : []), 'team', 'solved', 'penalty'];
                const who = teamMembers ? '队伍' : '选手';
                const translations = ['名次', ...(hasSchool ? ['学校'] : []), hasSchool ? `${who} / 学校` : who, '过题', '罚时'];
                headers.slice(0, names.length).forEach((header, index) => {
                    header.classList.add(`xp-col-${names[index]}`);
                    if (header.childElementCount === 0) header.textContent = translations[index];
                });
                for (const [column, header] of headers.slice(names.length, -2).entries()) {
                    header.classList.add('xp-col-problem');
                    // CCPC 新榜单模式: from `hiddenFrom` on, a column is a position in each row, not a problem.
                    header.classList.toggle('xp-problem-hidden', awardRules?.hiddenFrom !== undefined && column >= awardRules.hiddenFrom);
                    // Headers carry the contest's Hydro balloon colour inline. The server sends
                    // #e2e8f0 for problems that have none; those stay plain like the other headers.
                    const fill = header.style.backgroundColor;
                    header.classList.toggle('xp-problem-plain', !fill || fill.replace(/\s/g, '') === 'rgb(226,232,240)');
                }
                const statistics = { Submitted: '提交', Attempted: '尝试', Accepted: '通过', Dirt: '失误率', SE: '难度', 'First Solved': '最早通过', 'Last Solved': '最后通过' };
                const tips = ['失误率：已通过题目上的错误提交占这些题目全部提交的比例。', '平均难度：一道题被 M 名选手中的 N 名通过时难度为 (M−N)/M，取所过题目的平均值。'];
                headers.slice(-2).forEach((header, index) => {
                    // Upstream tooltips are static English text; replace them once.
                    const tip = header.querySelector('[role="tooltip"]');
                    if (tip && tip.dataset.xpTip !== '1') { tip.textContent = tips[index]; tip.dataset.xpTip = '1'; }
                });
                for (const header of headers.slice(-2)) {
                    const walker = document.createTreeWalker(header, NodeFilter.SHOW_TEXT);
                    while (walker.nextNode()) {
                        const node = walker.currentNode; const translated = statistics[node.textContent.trim()];
                        if (translated) node.textContent = translated;
                    }
                }
                table.style.setProperty('--xp-problems', String(Math.max(0, headers.length - names.length - 2)));
                table.classList.toggle('xp-no-school', !hasSchool);
                noteTexts([...(table.tBodies[0]?.rows || [])].filter((row) => row.querySelector('td.stnd.relative')).map((row) => ({
                    name: row.querySelector('.xp-col-team [line-clamp-2]')?.textContent.trim(),
                    school: hasSchool ? row.cells[1]?.textContent.trim() : '',
                    star: !!row.querySelector('[class~="i-line-md:star-alt-filled"]'),
                })));
                const content = `${Math.ceil(Math.min(280, Math.max(96, widestText + 6)))}px`;
                if (widestText && table.style.getPropertyValue('--xp-team-content') !== content) table.style.setProperty('--xp-team-content', content);
                for (const row of table.tBodies[0]?.rows || []) {
                    const cells = [...row.cells];
                    if (row.querySelector('td.stnd.relative')) {
                        row.classList.add('xp-team-row');
                        names.forEach((name, index) => cells[index]?.classList.add(`xp-col-${name}`));
                        const rank = cells[0];
                        const medal = ['gold', 'silver', 'bronze'].find((name) => rank.classList.contains(name));
                        const citation = medal && citationOf(medal);
                        rank.setAttribute('aria-label', `${citation ? `${citation}，` : ''}第 ${rank.textContent.trim()} 名`);
                        rank.title = citation || '';
                        const team = cells[names.indexOf('team')];
                        const schoolAction = hasSchool ? cells[1]?.querySelector('[cursor-pointer]') : null;
                        const schoolName = schoolAction?.textContent.trim() || '';
                        const teamName = team?.querySelector('[line-clamp-2]')?.textContent.trim() || '';
                        const members = teamMembers?.get(teamName);
                        team?.querySelector('[cursor-pointer]')?.setAttribute('title', members ? `${teamName}\n队员：${members.join('、')}` : teamName);
                        const star = team?.querySelector('[class~="i-line-md:star-alt-filled"]');
                        if (star) { star.title = '打星选手'; star.setAttribute('aria-label', '打星选手'); }
                        let school = team?.querySelector('.xp-mobile-school');
                        if (hasSchool && team && !school) {
                            school = document.createElement('button'); school.type = 'button'; school.className = 'xp-mobile-school';
                            school.addEventListener('click', () => row.cells[1]?.querySelector('[cursor-pointer]')?.click()); team.append(school);
                        }
                        // Name on the first line, school on the second; unofficial (打星) participants get
                        // a star after the school instead of after the name.
                        const unofficial = !!star;
                        if (unofficial) {
                            if (rank.textContent.trim() !== '*') rank.textContent = '*';
                            rank.setAttribute('aria-label', '打星选手');
                        }
                        const label = `${schoolName}${unofficial ? ' ★' : ''}`;
                        if (school && school.dataset.xpName !== label) {
                            school.dataset.xpName = label;
                            school.replaceChildren(document.createTextNode(schoolName));
                            if (unofficial) {
                                const mark = document.createElement('span'); mark.className = 'xp-star'; mark.textContent = '★';
                                mark.title = '打星选手'; school.append(mark);
                            }
                            school.title = unofficial ? `${schoolName}（打星）` : schoolName;
                            school.setAttribute('aria-label', `查看学校：${schoolName}${unofficial ? '，打星选手' : ''}`);
                        }
                        setLogo(row, hasSchool ? schoolName : '');
                        let result = team?.querySelector('.xp-mobile-result');
                        if (team && !result) {
                            result = document.createElement('div'); result.className = 'xp-mobile-result';
                            result.append(document.createElement('strong'), document.createElement('span'));
                            team.append(result);
                        }
                        if (result) {
                            const solved = cells[names.indexOf('solved')].textContent.trim();
                            const penalty = cells[names.indexOf('penalty')].textContent.trim();
                            result.firstElementChild.textContent = `${solved} 题`;
                            result.lastElementChild.textContent = `${penalty} 罚时`;
                        }
                        for (const cell of row.querySelectorAll('td[aria-label^="首次通过"]:not(.first-solve)')) cell.removeAttribute('aria-label');
                        for (const cell of row.querySelectorAll('td.first-solve')) {
                            cell.setAttribute('aria-label', `首次通过，${cell.textContent.trim().replace(/\s+/g, ' ')}`);
                        }
                    } else {
                        // Keep problem statistics aligned when identity and
                        // score columns are combined on small screens.
                        const span = row.querySelector('[colspan]');
                        if (span) {
                            span.dataset.xpColspan ||= span.getAttribute('colspan');
                            span.colSpan = Number(span.dataset.xpColspan) - (mobile.matches ? (hasSchool ? 3 : 2) : 0);
                        }
                        const label = cells[1]?.querySelector('b');
                        if (label && statistics[label.textContent.trim()]) label.textContent = statistics[label.textContent.trim()];
                    }
                }
            }
        } finally { observe(); }
    }
    app.addEventListener('keydown', (event) => {
        const modal = overlays?.lastElementChild;
        if (event.key === 'Tab' && modal) {
            const focusable = [...modal.querySelectorAll('button, a[href], input, select, textarea, [tabindex="0"]')]
                .filter((element) => !element.disabled && element.getClientRects().length);
            const target = event.shiftKey ? focusable.at(-1) : focusable[0];
            if (target && (event.target === modal || (event.shiftKey ? event.target === focusable[0] : event.target === focusable.at(-1)))) {
                event.preventDefault(); target.focus();
            }
        }
        if (!['Enter', ' '].includes(event.key)) return;
        const item = event.target.closest('.second-level-menu-item');
        if (item && event.target === item) { event.preventDefault(); item.click(); }
    });
    mobile.addEventListener('change', decorate);
    decorate();
    // Size the name column from every participant, not only the rows rendered so far.
    if (typeof window.DATA_SOURCE === 'string') {
        fetch(window.DATA_SOURCE.split('#')[0], { headers: { Accept: 'application/json' } }).then((response) => (response.ok ? response.json() : null))
            .then((board) => {
                const withMembers = Array.isArray(board?.teams) ? board.teams.filter((team) => Array.isArray(team.members) && team.members.length) : [];
                if (withMembers.length) {
                    teamMembers = new Map(withMembers.map((team) => [String(team.name ?? ''), team.members.map(String)]));
                    decorate();
                }
                if (Array.isArray(board?.teams) && noteTexts(board.teams.map((team) => ({
                    name: String(team.name ?? ''), school: board.contest?.options?.enable_organization === false ? '' : String(team.organization ?? ''),
                    star: Array.isArray(team.group) && team.group.includes('unofficial'),
                })))) decorate();
            }).catch(() => {});
    }
    fetch(new URL('index.json', logoBase)).then((response) => (response.ok ? response.json() : null))
        .then((index) => { if (index?.names) { logoNames = index.names; decorate(); } }).catch(() => {});
}
