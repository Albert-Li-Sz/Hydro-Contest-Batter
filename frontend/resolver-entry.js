const entryIds = ['xcpcio-resolver-entry', 'xcpcio-screens-entry', 'xcpcio-live-entry', 'xcpcio-capture-entry', 'xcpcio-monitor-entry', 'xcpcio-overview-entry', 'xcpcio-awards-entry', 'xcpcio-balloons-entry', 'xcpcio-presence-entry'];
const resultsEntryId = 'xcpcio-results-entry';
const entries = (url, { live = true, capture = false } = {}) => [
    // One place for the boards and every award the board, the resolver, the screens and the broadcast use.
    [entryIds[6], url.replace(/\/resolver$/, '/xcpcio-settings'), 'icon-award', '榜单与奖项'],
    [resultsEntryId, url.replace(/\/resolver$/, '/results'), 'icon-download', '成绩与导出'],
    [entryIds[0], url, 'icon-statistics', '滚榜'],
    [entryIds[1], url.replace(/\/resolver$/, '/screens'), 'icon-preview', '大屏'],
    // Which teams are owed which balloons, by room and problem; receipt tickets for the runners.
    [entryIds[7], url.replace(/\/resolver$/, '/balloons'), 'icon-balloon', '气球配送'],
    ...live ? [[entryIds[2], url.replace(/\/resolver$/, '/live'), 'icon-play', '直播']] : [],
    // 画面采集: contestants' screens and webcams (with the live module and its plugin setting).
    ...live && capture ? [[entryIds[3], url.replace(/\/resolver$/, '/live/capture'), 'icon-security', '画面采集']] : [],
    // Which contestant computers are on, and which look wrong (check-in before the start).
    [entryIds[8], url.replace(/\/resolver$/, '/presence'), 'icon-user--multiple', '机位监控'],
    [entryIds[4], url.replace(/\/resolver$/, '/monitor'), 'icon-stopwatch', '评测监控'],
    [entryIds[5], url.replace(/\/resolver$/, '/overview'), 'icon-pie-chart', '赛况总览'],
];
const removeEntries = () => { for (const id of [...entryIds, resultsEntryId]) document.getElementById(id)?.remove(); };

/** Add the entries after CCS, including when CCS finishes loading later. */
export function installResolverEntry(url, options = {}) {
    let stopped = false;
    let scheduled = false;
    const update = () => {
        scheduled = false;
        if (stopped) return;
        const currentContest = /\/contest\/([a-f\d]{24})(?:\/|$)/i.exec(location.pathname)?.[1];
        const targetContest = /\/contest\/([a-f\d]{24})\/resolver$/i.exec(url)?.[1];
        const currentDomain = /^\/d\/([^/]+)\//.exec(location.pathname)?.[1];
        const targetDomain = /^\/d\/([^/]+)\//.exec(url)?.[1];
        if (!currentContest || currentContest !== targetContest || (currentDomain && currentDomain !== targetDomain)) {
            removeEntries();
            return;
        }
        const ccs = document.querySelector('#contest-reset');
        const management = document.querySelector(`a[href$="/contest/${currentContest}/management"]`);
        const anchor = (ccs || management)?.closest('li');
        if (!anchor) return;
        // 榜单与奖项, 滚榜, 大屏, 气球配送, 直播, 机位监控, 评测监控 and 赛况总览 (same permission), right after CCS / management.
        let previous = anchor;
        for (const [id, href, iconName, label] of entries(url, options)) {
            let entry = document.getElementById(id);
            if (!entry) {
                entry = document.createElement('li');
                entry.id = id;
                entry.className = 'menu__item';
                const link = document.createElement('a');
                link.className = 'menu__link';
                link.href = href;
                link.setAttribute('data-no-instant', '');
                const icon = document.createElement('span');
                icon.className = `icon ${iconName}`;
                link.append(icon, document.createTextNode(` ${label}`));
                entry.append(link);
            }
            if (previous.nextElementSibling !== entry) previous.after(entry);
            previous = entry;
        }
    };
    const observer = new MutationObserver(() => {
        if (!scheduled) {
            scheduled = true;
            queueMicrotask(update);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    update();
    return () => {
        stopped = true;
        observer.disconnect();
        removeEntries();
    };
}
