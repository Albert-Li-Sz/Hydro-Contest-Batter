// CCPCOJ 二代 theme for the resolver, laid out after the CCPCOJ-2 classic card stage: a white
// table with bilingual headings, a rank badge coloured by medal zone over solved and penalty,
// a round school mark, "school | team" names and problem chips in fixed columns (attempts in a
// darker square, the minute after). Awards open a full-screen sheet: a blue 4:3 photo stage on
// the left and the team's details on the right. Drawn with this plugin's own code; logical
// pixels, 1080 high and L.width wide.
import { HEIGHT, box, cropImage, hash, star, stroke, teamName, text, unit } from './draw.js';

export const colors = {
    ink: '#1f2937', soft: '#374151', muted: '#6b7280', line: '#e5e7eb', head: '#f3f5f8', page: '#ffffff',
    accent: '#2563eb', judging: '#eaf2ff', recent: '#f5f9ff',
};
const zones = {
    gold: { fill: '#f6c445', ink: '#3b2f00' }, silver: { fill: '#cfd6de', ink: '#1f2937' },
    bronze: { fill: '#e0a872', ink: '#3a2108' }, none: { fill: '#eef1f4', ink: '#1f2937' },
};
const chips = {
    solved: { fill: '#1f7a4d', deep: '#125233', ink: '#ffffff' },
    first: { fill: '#2b5fae', deep: '#1c437f', ink: '#ffffff' },
    failed: { fill: '#c93a4a', deep: '#9c2735', ink: '#ffffff' },
    pending: { fill: '#e0b43a', deep: '#bf931f', ink: '#2b2100' },
    untried: { fill: '#e9ecef', deep: '#e9ecef', ink: '#6c757d' },
};
const plaques = {
    gold: { top: '#fdf0b8', bottom: '#f1d27a', edge: '#c9a43a', ink: '#6b4e00', en: 'Gold' },
    silver: { top: '#f4f6f8', bottom: '#d5dbe2', edge: '#9aa5b1', ink: '#374151', en: 'Silver' },
    bronze: { top: '#f8e2cf', bottom: '#e2ae80', edge: '#b67a45', ink: '#5a3210', en: 'Bronze' },
};
const kindOf = cell => cell?.status === 'solved' ? cell.firstToSolve ? 'first' : 'solved'
    : cell?.status === 'failed' || cell?.status === 'pending' ? cell.status : 'untried';

function vertical(ctx, y, h, top, bottom) {
    const g = ctx.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, top);
    g.addColorStop(1, bottom);
    return g;
}

function spaced(ctx, value, x, y, width, size, options = {}) {
    const has = 'letterSpacing' in ctx;
    if (has) ctx.letterSpacing = (options.spacing ?? size * .14) + 'px';
    text(ctx, value, x, y, width, size, { weight: 600, squeeze: .7, ...options });
    if (has) ctx.letterSpacing = '0px';
}

/** A round seal with the school's first characters, standing in for a missing logo. */
function seal(ctx, name, cx, cy, size) {
    const hue = hash(name) % 360, color = 'hsl(' + hue + ', 62%, 42%)';
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = size * .06;
    ctx.beginPath(); ctx.arc(cx, cy, size * .44, 0, Math.PI * 2); ctx.stroke();
    ctx.lineWidth = size * .02;
    ctx.setLineDash([size * .04, size * .03]);
    ctx.beginPath(); ctx.arc(cx, cy, size * .35, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    const short = Array.from(String(name || '队').replace(/大学|学院|学校|University|College/g, '')).slice(0, 2).join('') || '队';
    text(ctx, short, cx, cy + size * .02, size * .62, size * .26, { align: 'center', color, weight: 800, squeeze: .8 });
}

function hexagon(ctx, cx, cy, size, color) {
    ctx.save();
    ctx.fillStyle = color;
    ctx.beginPath();
    for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + i * Math.PI / 3;
        ctx.lineTo(cx + Math.cos(a) * size * .5, cy + Math.sin(a) * size * .5);
    }
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath(); ctx.arc(cx, cy, size * .2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
}

/** A flat medal: a ribbon over a disc with a star, for an award without a team photo. */
function medal(ctx, cx, cy, size, tier) {
    const tone = plaques[tier] || { top: '#e5e7eb', bottom: '#c9ced6', edge: '#9aa5b1' };
    ctx.save();
    for (const [side, color] of [[-1, '#e2e8f0'], [1, '#dc2626']]) {
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(cx + side * size * .05, cy - size * .02);
        ctx.lineTo(cx + side * size * .32, cy - size * .62);
        ctx.lineTo(cx + side * size * .12, cy - size * .62);
        ctx.lineTo(cx - side * size * .12, cy - size * .1);
        ctx.closePath();
        ctx.fill();
    }
    ctx.fillStyle = vertical(ctx, cy - size * .3, size * .6, tone.top, tone.bottom);
    ctx.beginPath(); ctx.arc(cx, cy + size * .12, size * .3, 0, Math.PI * 2); ctx.fill();
    ctx.lineWidth = size * .025;
    ctx.strokeStyle = tone.edge;
    ctx.beginPath(); ctx.arc(cx, cy + size * .12, size * .3, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(cx, cy + size * .12, size * .23, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
    star(ctx, cx, cy + size * .12, size * .3, tone.edge);
}

export function stageLayout(width, rowsPerScreen, teamCount, problemCount) {
    const span = Math.min(width, 2880);
    const left = (width - span) / 2 + 16, right = width - left;
    const count = Math.max(1, Math.min(teamCount, 20, Math.max(4, Number(rowsPerScreen) || 12)));
    const tableTop = 70;
    const pitch = Math.floor((HEIGHT - tableTop - 6) / count);
    // Proportions of a CCPCOJ-2 row, 114 units high.
    const u = pitch / 114;
    const contentX = left + 201 * u;
    const area = right - contentX - 8 * u;
    const column = Math.min(area / Math.max(1, problemCount), 170 * u);
    return { width, left, right, inner: right - left, count, tableTop, pitch, u,
        rankX: left + 15 * u, rankW: 102 * u, logoX: left + 123 * u, logoW: 72 * u, nameX: left + 206 * u,
        contentX, column };
}

function header(ctx, L, problems) {
    box(ctx, colors.head, L.left, 0, L.inner, L.tableTop, 0);
    box(ctx, colors.line, L.left, L.tableTop - 1, L.inner, 1);
    const top = 27, sub = 50, u = L.u;
    const label = (zh, en, cx, w) => {
        text(ctx, zh, cx, top, w, 21, { align: 'center' });
        text(ctx, en, cx, sub, w, 13, { align: 'center', color: colors.muted, weight: 500 });
    };
    label('排名', 'Rank', L.rankX + L.rankW / 2, L.rankW);
    label('标志', 'Logo', L.logoX + L.logoW / 2, L.logoW);
    problems.forEach((problem, p) => {
        text(ctx, problem.label, L.contentX + (p + .5) * L.column, 36, L.column - 4 * u, 22, { align: 'center', weight: 800 });
    });
}

function chip(ctx, cell, problem, x, y, w, h, u, { judging = false, pulse = 0, glow = 0 } = {}) {
    const kind = kindOf(cell), style = chips[kind], r = 3 * u;
    if (judging) {
        ctx.save();
        ctx.shadowColor = 'rgba(37,99,235,' + (.35 + .45 * pulse).toFixed(2) + ')';
        ctx.shadowBlur = 8 + 10 * pulse;
        box(ctx, style.fill, x, y, w, h, r);
        ctx.restore();
    } else box(ctx, style.fill, x, y, w, h, r);
    if (kind === 'untried') {
        text(ctx, problem?.label, x + w / 2, y + h / 2 + 1, w - 6 * u, 18 * u, { align: 'center', color: style.ink, weight: 700 });
    } else {
        const attempts = cell?.attempts || 1;
        const sq = Math.min(h * .9, w * .34);
        const deep = attempts > 1 || kind === 'pending';
        if (deep) box(ctx, style.deep, x + 2 * u, y + 2 * u, sq, h - 4 * u, 2 * u);
        text(ctx, attempts, x + 2 * u + sq / 2, y + h / 2 + 1, sq - 2 * u, 19 * u,
            { align: 'center', color: deep ? style.ink : 'rgba(255,255,255,0.72)', weight: 700, squeeze: .7 });
        if (kind === 'pending' && !deep) {
            text(ctx, attempts, x + 2 * u + sq / 2, y + h / 2 + 1, sq - 2 * u, 19 * u, { align: 'center', color: style.ink, squeeze: .7 });
        }
        const minute = cell?.time == null ? '?' : cell.time + "'";
        text(ctx, minute, x + w - 6 * u, y + h / 2 + 1, w - sq - 12 * u, 19 * u, { align: 'right', color: style.ink, weight: 800, squeeze: .7 });
    }
    if (kind === 'first') star(ctx, x + w - 2 * u, y + 1 * u, 13 * u, '#f5b301');
    if (glow > 0) box(ctx, 'rgba(255,255,255,' + (glow * .55).toFixed(3) + ')', x, y, w, h, r);
    if (judging) stroke(ctx, colors.accent, x - 2 * u, y - 2 * u, w + 4 * u, h + 4 * u, r + 2 * u, 2.5 * u);
}

export function board(ctx, L, data, teamOf, problems, logoOf, fx) {
    box(ctx, colors.page, 0, 0, L.width, HEIGHT);
    const u = L.u, rowH = L.pitch;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, L.tableTop, L.width, HEIGHT - L.tableTop);
    ctx.clip();
    for (const row of data.rows) {
        const team = teamOf.get(row.id), y = L.tableTop + row.position * rowH;
        box(ctx, row.judging ? colors.judging : row.recent ? colors.recent : colors.page, L.left, y, L.inner, rowH);
        box(ctx, colors.line, L.left, y + rowH - 1, L.inner, 1);
        if (row.judging) box(ctx, colors.accent, L.left, y + 4 * u, 4 * u, rowH - 8 * u, 2 * u);

        const zone = zones[row.medal] || zones.none;
        box(ctx, zone.fill, L.rankX, y + 6 * u, L.rankW, 58 * u, 4 * u);
        text(ctx, row.rank || '*', L.rankX + L.rankW / 2, y + 35 * u, L.rankW - 8 * u, 26 * u, { align: 'center', color: zone.ink, weight: 800 });
        const statY = y + 68 * u, statH = 36 * u, solvedW = 42 * u;
        box(ctx, '#ffffff', L.rankX, statY, solvedW, statH, 3 * u);
        stroke(ctx, colors.line, L.rankX, statY, solvedW, statH, 3 * u, Math.max(1, u));
        box(ctx, '#ffffff', L.rankX + solvedW + 4 * u, statY, L.rankW - solvedW - 4 * u, statH, 3 * u);
        stroke(ctx, colors.line, L.rankX + solvedW + 4 * u, statY, L.rankW - solvedW - 4 * u, statH, 3 * u, Math.max(1, u));
        text(ctx, row.score?.solved ?? 0, L.rankX + solvedW / 2, statY + statH / 2 + 1, solvedW - 4 * u, 24 * u, { align: 'center', weight: 800 });
        text(ctx, row.score?.time ?? 0, L.rankX + solvedW + 4 * u + (L.rankW - solvedW - 4 * u) / 2, statY + statH / 2 + 1,
            L.rankW - solvedW - 10 * u, 17 * u, { align: 'center', color: colors.soft, squeeze: .7 });

        const logoY = y + 8 * u, size = L.logoW;
        box(ctx, '#ffffff', L.logoX, logoY, size, size, 7 * u);
        stroke(ctx, colors.line, L.logoX, logoY, size, size, 7 * u, Math.max(1, u));
        if (!cropImage(ctx, logoOf(team), L.logoX + 4 * u, logoY + 4 * u, size - 8 * u, size - 8 * u, false, 5 * u)) {
            seal(ctx, team?.organizationName || teamName(team), L.logoX + size / 2, logoY + size / 2, size * .9);
        }

        const nameY = y + 32 * u, icon = 22 * u;
        if (team?.unrank) star(ctx, L.nameX + icon / 2, nameY, icon * 1.1, '#9ca3af');
        else hexagon(ctx, L.nameX + icon / 2, nameY, icon, '#3b6fd8');
        const school = data.showSchool && team?.organizationName;
        const startX = L.nameX + icon + 12 * u, room = L.right - startX - 10 * u;
        if (school) {
            ctx.font = '800 ' + 36 * u + 'px "Contest Noto Sans SC", sans-serif';
            const schoolW = Math.min(room * .55, ctx.measureText(school).width);
            text(ctx, school, startX, nameY + u, schoolW, 36 * u, { weight: 800 });
            const bar = startX + schoolW + 12 * u;
            box(ctx, colors.accent, bar, nameY - 19 * u, 3 * u, 38 * u, 1.5 * u);
            text(ctx, teamName(team), bar + 12 * u, nameY + u, L.right - bar - 22 * u, 28 * u, { color: colors.soft, weight: 600 });
        } else text(ctx, teamName(team), startX, nameY + u, room, 34 * u, { weight: 800 });

        const cells = row.cells || data.state.results[row.id] || [];
        const chipY = y + 70 * u, chipH = 34 * u;
        problems.forEach((problem, p) => {
            const judging = row.judging && data.problemIndex === p;
            chip(ctx, cells[p], problem, L.contentX + p * L.column + 3 * u, chipY, L.column - 6 * u, chipH, u,
                judging ? { judging: true, pulse: fx.pulse, glow: fx.glow } : {});
        });
    }
    ctx.restore();
    header(ctx, L, problems);
}

/** The dark curtain that opens the session; `leave` lifts it off the board. */
export function openingCard(ctx, L, summary, enter, leave = 0) {
    if (leave >= 1) return;
    ctx.save();
    ctx.translate(0, -HEIGHT * leave * leave);
    const g = ctx.createLinearGradient(0, 0, L.width * .4, HEIGHT);
    g.addColorStop(0, '#0b1220');
    g.addColorStop(1, '#16213a');
    box(ctx, g, 0, 0, L.width, HEIGHT);
    box(ctx, colors.accent, 0, HEIGHT - 6, L.width, 6);
    ctx.globalAlpha *= unit(enter);
    const cx = L.width / 2, span = Math.min(L.inner, 1600);
    spaced(ctx, '闭幕式滚榜  ·  RANK ROLL', cx, 300, span, 24, { align: 'center', color: '#93b4ff' });
    text(ctx, summary.title, cx, 400, span, 84, { align: 'center', color: '#ffffff', weight: 800, squeeze: .5 });
    const tiles = [['参赛队伍', 'TEAMS', summary.teams], ['院校', 'SCHOOLS', summary.schools], ['赛题', 'PROBLEMS', summary.problems]];
    if (summary.freezeMinutes) tiles.push(['封榜', 'FROZEN', summary.freezeMinutes + "'"]);
    const tileW = Math.min(300, span / tiles.length - 24), startX = cx - (tiles.length * (tileW + 24) - 24) / 2;
    tiles.forEach(([zh, en, value], i) => {
        const x = startX + i * (tileW + 24);
        box(ctx, 'rgba(255,255,255,0.06)', x, 520, tileW, 170, 12);
        stroke(ctx, 'rgba(147,180,255,0.25)', x, 520, tileW, 170, 12, 1.5);
        text(ctx, zh, x + 22, 556, tileW * .55, 22, { color: '#cbd5e1', weight: 600 });
        spaced(ctx, en, x + tileW - 22, 556, tileW * .45, 13, { align: 'right', color: '#7c8db5' });
        text(ctx, value, x + tileW / 2, 632, tileW - 30, 64, { align: 'center', color: '#ffffff', weight: 800 });
    });
    const lines = [['gold', '金奖'], ['silver', '银奖'], ['bronze', '铜奖']].filter(([tier]) => summary.medals?.[tier]);
    const lineW = 240, lx = cx - (lines.length * (lineW + 20) - 20) / 2;
    lines.forEach(([tier, zh], i) => {
        const tone = plaques[tier], x = lx + i * (lineW + 20);
        box(ctx, vertical(ctx, 740, 70, tone.top, tone.bottom), x, 740, lineW, 70, 8);
        text(ctx, zh + ' ' + summary.medals[tier] + ' 队', x + lineW / 2, 776, lineW - 24, 30, { align: 'center', color: tone.ink, weight: 800 });
    });
    ctx.restore();
}

/** The blue photo stage shared by the full-screen sheets. Returns the framed area. */
function stage(ctx, x, y, w, h, title, caption) {
    const g = ctx.createLinearGradient(x, y, x + w, y + h);
    g.addColorStop(0, '#0f2a5c');
    g.addColorStop(.55, '#1d4fb8');
    g.addColorStop(1, '#2f6bea');
    box(ctx, g, x, y, w, h);
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    for (const [cx, cy, r] of [[x + w * .1, y + h * .18, h * .34], [x + w * .86, y + h * .82, h * .4]]) {
        ctx.fillStyle = 'rgba(255,255,255,0.07)';
        ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
    const frame = { x: x + w * .045, y: y + h * .07, w: w * .91, h: h * .86 };
    box(ctx, 'rgba(255,255,255,0.04)', frame.x, frame.y, frame.w, frame.h, 22);
    stroke(ctx, 'rgba(255,255,255,0.28)', frame.x, frame.y, frame.w, frame.h, 22, 2);
    const plaque = { x: frame.x + frame.w * .07, y: frame.y + frame.h * .07, w: frame.w * .86, h: 140 };
    return { frame, plaque, draw() {
        box(ctx, 'rgba(15,35,80,0.55)', plaque.x, plaque.y, plaque.w, plaque.h, 18);
        stroke(ctx, 'rgba(255,255,255,0.35)', plaque.x, plaque.y, plaque.w, plaque.h, 18, 2);
        text(ctx, title, plaque.x + plaque.w / 2, plaque.y + 54, plaque.w - 60, 44, { align: 'center', color: '#ffffff', weight: 800, squeeze: .55 });
        spaced(ctx, caption, plaque.x + plaque.w / 2, plaque.y + 104, plaque.w - 60, 19, { align: 'center', color: '#bcd0ff' });
    } };
}

function field(ctx, x, y, w, zh, en, value, size) {
    text(ctx, zh, x, y, w * .5, 17, { color: colors.soft, weight: 700 });
    spaced(ctx, en, x + w, y, w * .5, 12, { align: 'right', color: colors.muted });
    text(ctx, value, x + w / 2, y + 46, w, size, { align: 'center', weight: 800, squeeze: .55 });
    box(ctx, colors.line, x, y + 84, w, 1);
    return y + 104;
}

/** The award sheet: a 4:3 photo stage on the left and the team's details on the right. */
export function awardCard(ctx, L, info, enter, photo, logo, summary) {
    const show = unit(enter);
    ctx.save();
    ctx.globalAlpha *= show;
    const panelW = Math.max(420, Math.min(560, L.width * .24));
    const stageW = L.width - panelW;
    const sheet = stage(ctx, 0, 0, stageW, HEIGHT, summary.title, 'TEAM PHOTO');
    const { frame } = sheet;
    if (!cropImage(ctx, photo, frame.x, frame.y, frame.w, frame.h, true, 22)) {
        medal(ctx, frame.x + frame.w / 2, frame.y + frame.h * .6, Math.min(frame.h * .62, frame.w * .5), info.medal);
        box(ctx, 'rgba(255,255,255,0.35)', frame.x + frame.w * .07, frame.y + frame.h * .93, frame.w * .86, 4, 2);
    }
    sheet.draw();
    const x = stageW + 24, w = panelW - 48;
    ctx.translate((1 - show) * 40, 0);
    box(ctx, '#ffffff', stageW, 0, panelW, HEIGHT);
    if (logo) {
        ctx.save();
        ctx.globalAlpha *= .12;
        cropImage(ctx, logo, stageW + panelW - 230, 30, 200, 200, false);
        ctx.restore();
    }
    let y = 58;
    y = field(ctx, x, y, w, '院校/组织', 'SCHOOL / ORGANIZATION', info.team?.organizationName || '—', 40);
    y = field(ctx, x, y, w, '队名', 'TEAM', teamName(info.team), 34);
    text(ctx, '奖项', x, y, w * .5, 17, { color: colors.soft, weight: 700 });
    spaced(ctx, 'AWARDS', x + w, y, w * .5, 12, { align: 'right', color: colors.muted });
    y += 24;
    const lead = plaques[info.medal];
    if (info.title) {
        const tone = lead || { top: '#eef4ff', bottom: '#dbe7ff', edge: '#93b4ff', ink: '#1e3a8a', en: '' };
        box(ctx, vertical(ctx, y, 96, tone.top, tone.bottom), x, y, w, 96, 6);
        stroke(ctx, tone.edge, x, y, w, 96, 6, 2);
        stroke(ctx, tone.edge, x + 6, y + 6, w - 12, 84, 4, 1);
        text(ctx, info.title + (tone.en ? '  ' + tone.en : ''), x + w / 2, y + 49, w - 40, 40, { align: 'center', color: tone.ink, weight: 800, squeeze: .55 });
        y += 112;
    }
    for (const citation of info.others.slice(0, 4)) {
        box(ctx, '#eef4ff', x, y, w, 54, 6);
        stroke(ctx, '#c7d7fe', x, y, w, 54, 6, 1.5);
        text(ctx, citation, x + w / 2, y + 28, w - 30, 24, { align: 'center', color: '#1e3a8a', weight: 700, squeeze: .55 });
        y += 64;
    }
    const stats = [['全场排名', 'OVERALL RANK', info.rank], ['解题数', 'SOLVED', info.solved], ['首答', 'FIRST SOLVE', info.firsts || '—']];
    const boxH = stats.length * 62, top = HEIGHT - 30 - boxH;
    box(ctx, '#ffffff', x, top, w, boxH, 8);
    stroke(ctx, colors.line, x, top, w, boxH, 8, 1.5);
    stats.forEach(([zh, en, value], i) => {
        const ry = top + i * 62;
        if (i) box(ctx, colors.line, x, ry, w, 1);
        text(ctx, zh, x + 16, ry + 24, w * .5, 18, { weight: 700 });
        spaced(ctx, en, x + 16, ry + 45, w * .55, 11, { color: colors.muted });
        text(ctx, value, x + w - 16, ry + 32, w * .42, 36, { align: 'right', weight: 800, squeeze: .6 });
    });
    ctx.restore();
}

/** An award shared by many teams: the blue stage with a card per team. */
export function teamListCard(ctx, L, heading, entries, enter, page) {
    ctx.save();
    ctx.globalAlpha *= unit(enter);
    const sheet = stage(ctx, 0, 0, L.width, HEIGHT, heading, 'AWARD WINNERS');
    sheet.draw();
    const { frame, plaque } = sheet;
    const perPage = 12, columns = 3;
    const pages = Math.max(1, Math.ceil(entries.length / perPage));
    const shown = entries.slice(page % pages * perPage, (page % pages + 1) * perPage);
    const gridX = plaque.x, gridW = plaque.w, top = plaque.y + plaque.h + 40;
    const cardW = (gridW - (columns - 1) * 20) / columns, cardH = Math.min(120, (frame.y + frame.h - 40 - top) / 4 - 16);
    shown.forEach((entry, i) => {
        const x = gridX + (i % columns) * (cardW + 20), y = top + Math.floor(i / columns) * (cardH + 16);
        box(ctx, 'rgba(255,255,255,0.94)', x, y, cardW, cardH, 12);
        box(ctx, colors.accent, x, y + 16, 5, cardH - 32, 2.5);
        text(ctx, entry.title, x + 26, y + cardH * .38, cardW - 46, 32, { weight: 800 });
        text(ctx, entry.detail, x + 26, y + cardH * .72, cardW - 46, 21, { color: colors.muted, weight: 600 });
    });
    if (pages > 1) text(ctx, (page % pages + 1) + ' / ' + pages, frame.x + frame.w - 30, frame.y + frame.h - 30, 200, 22, { align: 'right', color: '#dbe7ff' });
    ctx.restore();
}

/** The close: runner-up, champion and third place on the blue stage. */
export function podiumCard(ctx, L, winners, teamOf, logoOf, cycle, enter, progress, summary) {
    ctx.save();
    ctx.globalAlpha *= unit(enter);
    const sheet = stage(ctx, 0, 0, L.width, HEIGHT, summary.title, '亚军 · 冠军 · 季军');
    sheet.draw();
    const { frame, plaque } = sheet;
    if (!winners.some(Boolean)) {
        text(ctx, '暂无领奖队伍', L.width / 2, HEIGHT / 2 + 60, L.inner, 48, { align: 'center', color: '#dbe7ff' });
        ctx.restore();
        return;
    }
    const names = ['冠军', '亚军', '季军'], tiers = ['gold', 'silver', 'bronze'];
    const slot = plaque.w / 3, base = frame.y + frame.h - 30;
    [1, 0, 2].forEach((rank, column) => {
        const winner = winners[rank];
        if (!winner?.teamIds.length) return;
        const show = unit(progress[rank]);
        const cx = plaque.x + slot * column + slot / 2;
        const plinth = [220, 160, 120][rank] * show, tone = plaques[tiers[rank]];
        ctx.save();
        ctx.globalAlpha *= show;
        box(ctx, vertical(ctx, base - plinth, plinth, tone.top, tone.bottom), cx - slot * .4, base - plinth, slot * .8, plinth, 10);
        text(ctx, rank + 1, cx, base - plinth / 2, slot * .4, Math.min(110, plinth * .62), { align: 'center', color: tone.ink, weight: 900 });
        const cardH = 300, cardY = base - plinth - cardH - 18;
        box(ctx, '#ffffff', cx - slot * .42, cardY, slot * .84, cardH, 14);
        const id = winner.teamIds[cycle % winner.teamIds.length], team = teamOf.get(id);
        const mark = 96;
        if (!cropImage(ctx, logoOf(team), cx - mark / 2, cardY + 22, mark, mark, false)) seal(ctx, team?.organizationName || id, cx, cardY + 22 + mark / 2, mark);
        text(ctx, winner.name || names[rank], cx, cardY + 160, slot * .76, rank === 0 ? 46 : 38, { align: 'center', color: tone.edge, weight: 800 });
        text(ctx, teamName(team), cx, cardY + 214, slot * .76, 32, { align: 'center', weight: 800 });
        text(ctx, team?.organizationName, cx, cardY + 258, slot * .76, 22, { align: 'center', color: colors.muted, weight: 600 });
        if (winner.teamIds.length > 1) text(ctx, (cycle % winner.teamIds.length + 1) + ' / ' + winner.teamIds.length, cx, cardY - 22, slot * .76, 20, { align: 'center', color: '#dbe7ff' });
        ctx.restore();
    });
    ctx.restore();
}
