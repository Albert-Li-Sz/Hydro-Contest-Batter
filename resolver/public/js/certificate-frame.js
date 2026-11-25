// Original engraved frame. Coordinates are millimetres from the top left, shared by the editor and PDF.
const navy = '#243e53';
const brass = '#a17840';
const pale = '#bdc9c7';
const rounded = (n) => Math.round(n * 100) / 100;

export function logoBox(width, slot) {
    const w = width > 250 ? 42 : 31;
    return { x: slot === 0 ? 20 : width - 20 - w, y: 17, width: w, height: 22 };
}

const distinctions = new Map([
    ...['金奖', '金牌'].map((name) => [name, ['Gold Medal', '#895d2d']]),
    ...['银奖', '银牌'].map((name) => [name, ['Silver Medal', '#526a78']]),
    ...['铜奖', '铜牌'].map((name) => [name, ['Bronze Medal', '#94553b']]),
    ['一等奖', ['First Prize']], ['二等奖', ['Second Prize']], ['三等奖', ['Third Prize']], ['冠军', ['Champion']],
]);
export const awardEnglish = (award) => distinctions.get(award)?.[0] || '';
export const fieldInk = (field, award) => (field.medalColor && distinctions.get(award)?.[1]) || field.color;

export function certificateFrame(width, height) {
    const paths = [];
    const add = (stroke, weight, commands, fill) => paths.push({ stroke, weight, commands, fill });
    const rect = (x, y, w, h) => [['M', x, y], ['L', x + w, y], ['L', x + w, y + h], ['L', x, y + h], ['Z']];
    const line = (x1, y1, x2, y2) => [['M', x1, y1], ['L', x2, y2]];
    add(null, 0, rect(0, 0, width, height), '#fffdf7');
    add(navy, 0.65, rect(6.5, 6.5, width - 13, height - 13));
    add(brass, 0.22, rect(7.7, 7.7, width - 15.4, height - 15.4));
    add(navy, 0.28, rect(11, 11, width - 22, height - 22));
    // Interlaced waves in the narrow perimeter band. Whole periods meet cleanly at all four ends.
    const engraving = [];
    for (const vertical of [false, true]) {
        const long = vertical ? height : width;
        const short = vertical ? width : height;
        const length = long - 33;
        const count = Math.round(length / 8);
        for (const far of [false, true]) {
            for (const direction of [-1, 1]) {
                for (let i = 0; i <= count * 8; i++) {
                    const along = rounded(16.5 + length * i / (count * 8));
                    let across = 9.3 + direction * Math.sin(i * Math.PI / 4) * 0.95;
                    across = rounded(far ? short - across : across);
                    engraving.push([i ? 'L' : 'M', ...(vertical ? [across, along] : [along, across])]);
                }
            }
        }
    }
    add(pale, 0.16, engraving);
    // Mirrored fan corners and a small brass lozenge terminate the frame.
    for (const right of [false, true]) for (const bottom of [false, true]) {
        const point = (x, y) => [right ? width - x : x, bottom ? height - y : y];
        const corner = [];
        for (const reach of [4, 7, 10]) {
            corner.push(['M', ...point(11, 11 + reach)], ['C', ...point(12, 13), ...point(13, 12), ...point(11 + reach, 11)]);
        }
        add(navy, 0.22, corner);
        add(null, 0, [['M', ...point(9.4, 7.8)], ['L', ...point(11, 9.4)], ['L', ...point(9.4, 11)], ['L', ...point(7.8, 9.4)], ['Z']], brass);
    }
    const landscape = width > height;
    const headerRule = landscape ? 54 : 62;
    const mid = width / 2;
    add(brass, 0.25, [...line(25, headerRule, mid - 4, headerRule), ...line(mid + 4, headerRule, width - 25, headerRule)]);
    add(null, 0, [['M', mid - 2.5, headerRule], ['L', mid, headerRule - 1.1], ['L', mid + 2.5, headerRule], ['L', mid, headerRule + 1.1], ['Z']], brass);
    // An open guilloché cartouche frames the distinction; the centre stays clear for type.
    const cx = landscape ? 219 : width / 2;
    const cy = landscape ? 99 : 189;
    const rosette = [];
    for (let layer = 0; layer < 7; layer++) {
        for (let i = 0; i <= 240; i++) {
            const angle = 2 * Math.PI * i / 240;
            const radius = 22 + 2.8 * Math.cos(12 * angle + layer * Math.PI / 5) + layer * 0.28;
            rosette.push([i ? 'L' : 'M', rounded(cx + 1.48 * radius * Math.cos(angle)), rounded(cy + .52 * radius * Math.sin(angle))]);
        }
    }
    add('#e5ddcc', 0.13, rosette);
    if (landscape) add(pale, 0.25, line(171, 66, 171, 127));
    add(pale, 0.25, line(25, landscape ? 165 : 248, width - 25, landscape ? 165 : 248));
    return paths;
}
