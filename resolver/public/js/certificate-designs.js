// Each preset uses the organizer's actual fields, including their bilingual names and verification number.
export const designLabels = { engraved: '典雅雕花', icpc: 'ICPC 风格', ccpc: 'CCPC 风格', gplt: '天梯赛风格', lanqiao: '蓝桥杯风格' };

export function styledTemplate(base, design, kind) {
    const template = structuredClone(base);
    if (design === 'engraved' || !Object.hasOwn(designLabels, design)) return template;
    template.frame = design;
    const wide = base.orientation === 'landscape';
    const w = wide ? 297 : 210;
    const mid = w / 2;
    const award = kind === 'award';
    const fields = new Map(template.fields.map((f) => [f.id, f]));
    // Record measurements in paper millimetres. Letter sizes remain in printer points.
    const put = (id, x, y, size, width, align = 'center', color) => {
        const f = fields.get(id);
        if (f) Object.assign(f, { x, y, size, width, align }, color && { color });
    };
    const roster = (x, ys, sizes, width, align, ink) => {
        const ids = ['name', 'name-en', 'school', 'school-en', 'members', 'members-en', 'coach', 'coach-en'];
        ids.forEach((id, i) => put(id, x, ys[i], sizes[i], width, align, ink));
        if (award) put('team', x, ys[4], sizes[4], width, align, ink);
    };
    const distinction = (x, y, size, width, color) => put(award ? 'award' : 'team', x, y, size, width, 'center', color);
    const footer = (color) => {
        const y = wide ? 185 : 265;
        put('qr', 34, y, 21, 21);
        put('serial-label', 49, y - 3.5, 8, 65, 'left', color);
        put('number', 49, y + 3, 11, 65, 'left', color);
        put('issuer', w - 22, y - 2, 13, wide ? 121 : 81, 'right', color);
        put('date', w - 22, y + 6, 10, wide ? 121 : 81, 'right', color);
    };
    if (design === 'icpc') {
        template.font = 'sans';
        const ink = '#173c61'; const soft = '#245b8b';
        const center = wide ? 190 : mid;
        put('title-en', mid, wide ? 26 : 32, wide ? 34 : 22, w - (wide ? 138 : 106), 'center', '#0752ac');
        put('title', mid, wide ? 40 : 46, 17, w - 90, 'center', soft);
        put('recipient-label', center, wide ? 57 : 72, 10, wide ? 136 : 151, 'center', soft);
        roster(center, wide ? [71, 81, 92, 100, 110, 116, 124, 130] : [87, 99, 116, 127, 140, 148, 159, 167],
            [26, 15, 17, 13, 12, 10, 12, 10], wide ? 154 : 157, 'center', ink);
        fields.delete('distinction-label');
        distinction(wide ? 56 : mid, wide ? 106 : 187, 34, wide ? 74 : 157, '#0752ac');
        put('distinction-en', wide ? 56 : mid, wide ? 120 : 201, 16, wide ? 74 : 157, 'center', soft);
        put('contest', mid, wide ? 150 : 222, 19, w - 52, 'center', ink);
        put('contest-en', mid, wide ? 160 : 234, 13, w - 52, 'center', soft);
        footer(ink);
    } else if (design === 'ccpc') {
        const ink = '#412a2e'; const red = '#b82139';
        put('title', mid, wide ? 28 : 34, 32, w - 116, 'center', red);
        put('title-en', mid, wide ? 41 : 48, 20, w - 110, 'center', red);
        put('recipient-label', 30, wide ? 58 : 69, 11, w - 60, 'left', ink);
        roster(35, wide ? [70, 79, 89, 97, 105, 111, 118, 124] : [83, 94, 106, 116, 128, 136, 147, 155],
            [23, 14, 16, 12, 13, 10, 12, 10], w - 70, 'left', ink);
        fields.delete('distinction-label');
        distinction(mid, wide ? 138 : 183, 31, w - 64, red);
        put('distinction-en', mid, wide ? 148 : 198, 16, w - 64, 'center', red);
        put('contest', 30, wide ? 159 : 220, 15, w - 60, 'left', ink);
        put('contest-en', 30, wide ? 166 : 231, 11, w - 60, 'left', ink);
        footer(ink);
    } else if (design === 'gplt') {
        const blue = '#075f9e'; const gold = '#a45b02';
        put('title', mid, wide ? 27 : 31, 33, w - 115, 'center', gold);
        put('title-en', mid, wide ? 39 : 46, 13, w - 104, 'center', blue);
        put('contest', mid, wide ? 55 : 67, 17, w - 63, 'center', '#ffffff');
        put('contest-en', mid, wide ? 67 : 81, 10, w - 55, 'center', blue);
        fields.delete('recipient-label');
        roster(mid, wide ? [83, 93, 104, 112, 121, 127, 135, 141] : [101, 114, 130, 141, 154, 163, 175, 184],
            [25, 14, 16, 12, 13, 10, 12, 10], w - 65, 'center', '#1c3445');
        fields.delete('distinction-label');
        distinction(mid, wide ? 155 : 210, 32, w - 70, '#095b8f');
        put('distinction-en', mid, wide ? 166 : 226, 14, w - 70, 'center', blue);
        footer(blue);
    } else {
        const ink = '#23384b'; const blue = '#075f9c'; const red = '#c52739';
        put('contest', mid, wide ? 27 : 34, 22, w - (wide ? 136 : 108), 'center', blue);
        put('contest-en', mid, wide ? 39 : 47, 11, w - 105, 'center', blue);
        put('title', mid, wide ? 58 : 69, 35, w - 62, 'center', red);
        put('title-en', mid, wide ? 70 : 83, 14, w - 62, 'center', blue);
        fields.delete('recipient-label');
        const xs = wide ? 39 : 32;
        roster(xs, wide ? [88, 98, 109, 117, 128, 135, 144, 151] : [104, 116, 132, 143, 157, 166, 178, 187],
            [24, 14, 17, 12, 13, 10, 12, 10], wide ? 131 : 148, 'left', ink);
        const x = wide ? 213 : mid;
        put('distinction-label', x, wide ? 96 : 203, 10, wide ? 78 : 143, 'center', blue);
        distinction(x, wide ? 115 : 220, 33, wide ? 80 : 150, red);
        put('distinction-en', x, wide ? 132 : 234, 15, wide ? 78 : 143, 'center', blue);
        footer(ink);
    }
    if (design !== 'ccpc') {
        for (const f of fields.values()) if (f.medalColor) delete f.medalColor;
    }
    template.fields = [...fields.values()];
    return template;
}

// The same original vector artwork is painted by the SVG editor and the PDF writer.
export function presetFrame(w, h, design) {
    const wide = w > h; const mid = w / 2;
    const paths = [];
    const stroke = (color, weight, commands) => paths.push({ stroke: color, weight, commands });
    const fill = (color, commands) => paths.push({ stroke: null, weight: 0, fill: color, commands });
    const poly = (...points) => points.map(([x, y], i) => [i ? 'L' : 'M', x, y]);
    const rect = (x, y, width, height) => [...poly([x,y],[x+width,y],[x+width,y+height],[x,y+height]), ['Z']];
    const line = (x1, y1, x2, y2) => poly([x1,y1],[x2,y2]);
    const loop = (cx, cy, r, sides = 48, petals = 0) => {
        const pts = Array.from({ length: sides }, (_, i) => {
            const a = i * 2 * Math.PI / sides;
            const radius = r * (1 + .12 * Math.cos(petals * a) * Number(petals > 0));
            return [cx + radius * Math.cos(a), cy + radius * Math.sin(a)].map((n) => Math.round(n * 100) / 100);
        });
        return [...poly(...pts), ['Z']];
    };
    if (design === 'icpc') {
        fill('#ffffff', rect(0, 0, w, h));
        const colors = ['#095cc5', '#ffc02a', '#e3423f'];
        fill(colors[0], rect(0, 0, w, 4));
        fill(colors[1], rect(w * .73, 0, w * .17, 4));
        fill(colors[2], rect(w * .90, 0, w * .10, 4));
        colors.forEach((c, i) => fill(c, rect(20 + i * 8, wide ? 48 : 56, 6.6, 1.2)));
        stroke('#6ea7d3', .5, line(46, wide ? 48.6 : 56.6, w - 20, wide ? 48.6 : 56.6));
        if (wide) {
            stroke('#acd0ee', .4, line(99, 60, 99, 133));
            fill(colors[0], [...poly([50,82],[55,83],[53,96],[50,93],[46,94]),['Z']]);
            fill(colors[2], [...poly([56,82],[61,81],[65,94],[61,93],[58,96]),['Z']]);
            fill('#fff0b9', loop(56,79,11.7,12));
            stroke('#ca7c06', .8, loop(56,79,11.7,12));
            stroke('#dc9a16', .4, loop(56,79,9.6));
            const points = Array.from({ length: 10 }, (_, i) => {
                const a = (2*i-5)*Math.PI/10, r = i%2 ? 2.9 : 6.6;
                return [56 + r*Math.cos(a),79 + r*Math.sin(a)].map(roundedPoint => Math.round(roundedPoint*100)/100);
            });
            fill('#cf8100', [...poly(...points), ['Z']]);
        }
        stroke('#5796c6', .45, line(20, wide ? 171 : 246, w - 20, wide ? 171 : 246));
    } else if (design === 'ccpc') {
        fill('#fff4df', rect(0,0,w,h));
        [5, 6.8, 8.6].forEach((d, i) => stroke(i === 1 ? '#e2a023' : '#b52b44', i === 0 ? 1.2 : .5, rect(d,d,w-2*d,h-2*d)));
        for (const x of [12, w-12]) for (const y of [12, h-12]) {
            [4.2, 5.8, 7].forEach((r, i) => stroke(i === 1 ? '#c77e0f' : '#c44c53', .35, loop(x,y,r,64,8)));
        }
        if (wide) for (const r of [14,16,18,20]) stroke('#efdbc3', .27, loop(w-55,92,r,160,8));
        const y = wide ? 50 : 59;
        stroke('#d59633', .48, [...line(32,y,mid-4,y), ...line(mid+4,y,w-32,y)]);
        fill('#bc2541', [...poly([mid-2,y],[mid,y-1],[mid+2,y],[mid,y+1]),['Z']]);
        stroke('#d5a55e', .42, line(25, wide ? 172 : 247, w-25, wide ? 172 : 247));
    } else if (design === 'gplt') {
        fill('#ffffff', rect(0,0,w,h));
        stroke('#1386c6', 2.15, rect(6,6,w-12,h-12));
        for (const x of [4,w-4]) for (const y of [4,h-4]) {
            const dx = x === 4 ? 1 : -1; const dy = y === 4 ? 1 : -1;
            stroke('#ee9d1d', 2.55, poly([x+dx*20,y],[x,y],[x,y+dy*20]));
        }
        const by = wide ? 55 : 67;
        fill('#086aae', [...poly([25,by-5.7],[w-21,by-5.7],[w-25,by+5.7],[21,by+5.7]), ['Z']]);
        fill('#f4ad29', [...poly([w-22,by-5.7],[w-19,by-5.7],[w-23,by+5.7],[w-26,by+5.7]), ['Z']]);
        for (const [cx,cy,outer] of [[w-38, h*.62, 17], [w-59,h*.70,11]]) {
            for (let r = 3; r <= outer; r += 2) stroke('#c4e4f5', .32, loop(cx,cy,r,6));
        }
        stroke('#75b4d6', .4, line(23, wide ? 174 : 246, w-23, wide ? 174 : 246));
    } else {
        fill('#fffefe', rect(0,0,w,h));
        for (const d of [5, 8.6, 10]) stroke('#0875ba', d === 5 ? 1.05 : .43, rect(d,d,w-2*d,h-2*d));
        for (const v of [false,true]) for (const far of [false,true]) {
            const length = (v ? h : w) - 24; const count = Math.round(length / 5.2);
            const pts = [];
            for (let i = 0; i < count; i++) {
                const t = 12 + length * (i + .5) / count;
                const p = (a,b) => v ? [far ? w-b : b, a] : [a,far ? h-b : b];
                pts.push(...poly(p(t-2,6.8),p(t,5.6),p(t+2,6.8),p(t,8),p(t-2,6.8)));
            }
            stroke('#218bc4', .33, pts);
        }
        stroke('#73aed0', .42, line(27,wide?163:246,w-27,wide?163:246));
    }
    return paths;
}
