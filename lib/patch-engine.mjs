/** Extend only the pinned engine's public buildRank entry. Fail closed on
 * upstream changes instead of silently falling back to incorrect awards.
 */
export function patchBoardEngine(source) {
    const entry = /\bbuildRank\(\)\s*\{/g;
    if ([...source.matchAll(entry)].length !== 1 || source.includes('hydroBuildRank')) {
        throw new Error('无法扩展 XCPCIO 的奖项计算，请检查上游构建产物');
    }
    return 'import { applyAwardEligibility as __hydroApplyAwardEligibility } from "../award-policy.mjs";\n'
        + source.replace(entry, 'buildRank(){return __hydroApplyAwardEligibility(this.hydroBuildRank())}hydroBuildRank(){');
}

/**
 * XCPCIO 0.98 swaps in its own phone, compact and narrow layouts by window width (useMediaQuery).
 * The plugin lays the desktop table out for every width itself (client/board-ui.js, enhanced.css),
 * as with earlier releases, so these switches keep the desktop components. A width query this list
 * does not know fails the build instead of changing the board unnoticed.
 */
const layoutQueries = new Map([
    ['(max-width: 1023.98px)', 'not all'],
    ['(max-width: 1279.98px)', 'not all'],
    ['(max-width: 359.98px)', 'not all'],
    ['(min-width: 1024px)', 'all'],
]);

export function patchBoardLayouts(source) {
    let count = 0;
    const patched = source.replace(/([`"'])(\((?:max|min)-width:\s*[\d.]+px\))\1/g, (literal, quote, query) => {
        const replacement = layoutQueries.get(query);
        if (!replacement) throw new Error(`XCPCIO 新增了按宽度切换的布局 ${query}，请检查上游构建产物`);
        count++;
        return `${quote}${replacement}${quote}`;
    });
    return { source: patched, count };
}

export function patchBoardSharing(source) {
    // Keep the original share menu. XCPCIO 0.98 adds an image export that can send image URLs to public proxies.
    const desktopItem = /\b(\w+)\(`li`,null,\[\w+\(`div`,\{[^{}]+\},\[\w+\[\d+\]\|\|=\1\(`div`,\{"i-material-symbols-image":``,"text-base":``\},null,-1\),\1\(`span`,null,\w+\(\w+\(\w+\)\(`utility\.export_image`\)\),1\)\]\)\]\),/g;
    const mobileItem = /\b(\w+)\(`button`,\{[^{}]+\},\[\w+\[\d+\]\|\|=\1\(`div`,\{"i-material-symbols-image":``,class:`[^`]+`\},null,-1\),\1\(`span`,null,\w+\(\w+\(\w+\)\(`utility\.export_image`\)\),1\)\]\),/g;
    // Remove the proxy fetch functions and retain the direct image fetch in the fallback list.
    const imageSources = /(let (\w+)=async\(\)=>\{let \w+=await fetch\(\w+,\{mode:`cors`\}\)[^{}]+\}),\w+=async\(\)=>\{(?=if\(!\w+\)throw Error\(`Image proxy requires an absolute URL`\);)[\s\S]*?,(\w+)=\w+\?\[\w+,\w+,\w+,\2\]:\[\2,\.\.\.\w+\?\[\w+,\w+,\w+\]:\[\]\],(\w+);/g;
    for (const pattern of [desktopItem, mobileItem, imageSources]) {
        if ([...source.matchAll(pattern)].length !== 1) throw new Error('无法适配 XCPCIO 的榜单分享，请检查上游构建产物');
    }
    return source.replace(desktopItem, '').replace(mobileItem, '').replace(imageSources, '$1,$3=[$2],$4;');
}
