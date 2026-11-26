// Text on a balloon or problem colour, the same everywhere: the balloon page, the overview, the screens and the
// XCPCIO board (lib/patch-engine.mjs patchBoardInk uses this rule too). Of dark and light text, the one with the
// higher WCAG 2 contrast against the background, so each preset colour keeps one ink on every page.

const channel = (value) => {
    const c = value / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

/** WCAG relative luminance of `#rrggbb` or `#rgb`, or null for anything else. */
export function luminance(hex) {
    const short = /^#([\da-f])([\da-f])([\da-f])$/i.exec(hex || '');
    const match = short ? [, ...short.slice(1).map((digit) => digit + digit)] : /^#([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex || '');
    if (!match) return null;
    const [r, g, b] = match.slice(1).map((part) => channel(parseInt(part, 16)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio of two `#rrggbb` colours (1 to 21). */
export function contrast(a, b) {
    const [x, y] = [luminance(a) ?? 0, luminance(b) ?? 0].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

/** `dark` or `light` text on `background`, whichever reads better; `dark` when the colour is unknown. */
export function inkOn(background, dark = '#000000', light = '#ffffff') {
    if (luminance(background) === null) return dark;
    return contrast(background, dark) >= contrast(background, light) ? dark : light;
}
