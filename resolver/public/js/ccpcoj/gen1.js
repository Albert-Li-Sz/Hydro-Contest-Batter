// CCPCOJ 一代 theme for the resolver, laid out after the original CCPCOJ rank roll: a light,
// dense board where every row carries its school mark, the "school：team" line, a strip of
// problem chips (attempts, label, last minute), solved count and penalty, with dialogs for awards.
// Drawn with this plugin's own code; logical pixels, 1080 high and L.width wide.
import { HEIGHT, balloon, box, cropImage, identicon, path, rosette, star, stroke, teamName, text, unit } from './draw.js';

export const colors = {
    ink: '#212529', muted: '#6c757d', page: '#ffffff', odd: '#f8f9fa', even: '#dee2e6',
    judging: '#3dd5f3', recent: '#cff4fc',
    solved: '#198754', first: '#0f5132', failed: '#dc3545', pending: '#ffc107', untried: '#adb5bd',
};
const medalFill = { gold: '#ffd700', silver: '#c0c0c0', bronze: '#a52a2a' };
const medalEdge = { gold: '#daa520', silver: '#808080', bronze: '#b8860b' };
const medalTone = { gold: '#ffd700', silver: '#c0c0c0', bronze: '#b8860b' };

export function stageLayout(width, rowsPerScreen) {
    // Extra-wide LED walls keep the board within a readable central span.
    const span = Math.min(width, 2880);
    const left = (width - span) / 2 + 12, right = width - left;
    const inner = right - left;
    // Row height follows the rows per screen even when fewer teams take part.
    const count = Math.min(20, Math.max(4, Number(rowsPerScreen) || 12));
    const tableTop = 46;
    const pitch = Math.floor((HEIGHT - tableTop - 8) / count);
    // CCPCOJ proportions: a 60-unit line inside a 70-unit row, 75 units apart.
    const u = pitch / 75;
    const line = 60 * u, gap = 5 * u;
    const rank = line, logo = line, solved = line, time = line * 3;
    const team = inner - rank - logo - solved - time - gap * 4 - 10 * u;
    const rankX = left + 5 * u;
    return { width, left, right, inner, count, tableTop, pitch, u, line, gap, rank, logo, team, solved, time,
        rankX, logoX: rankX + rank + gap, teamX: rankX + rank + logo + gap * 2,
        solvedX: right - 5 * u - time - gap - solved, timeX: right - 5 * u - time };
}

export function header(ctx, L) {
    const y = 26, size = 17;
    text(ctx, '排名', L.rankX + L.rank / 2, y, L.rank, size, { align: 'center' });
    text(ctx, '图标', L.logoX + L.logo / 2, y, L.logo, size, { align: 'center' });
    text(ctx, '队伍', L.teamX + L.team / 2, y, L.team, size, { align: 'center' });
    text(ctx, '题数', L.solvedX + L.solved / 2, y, L.solved, size, { align: 'center' });
    text(ctx, '罚时', L.timeX + L.time / 2, y, L.time, size, { align: 'center' });
}

const chipStyles = {
    solved: { fill: colors.solved, ink: '#ffffff' },
    first: { fill: colors.first, ink: '#ffffff' },
    failed: { fill: colors.failed, ink: '#ffffff' },
    pending: { fill: colors.pending, ink: colors.ink },
    untried: { fill: colors.untried, ink: colors.ink },
};
export const chipKind = cell => cell?.status === 'solved' ? cell.firstToSolve ? 'first' : 'solved'
    : cell?.status === 'failed' || cell?.status === 'pending' ? cell.status : 'untried';

/** One problem chip: attempts on the left, the label in the middle, the last minute on the right. */
function chip(ctx, cell, problem, x, y, w, h, u, { judging = false, solid = false, glow = 0 } = {}) {
    const kind = chipKind(cell), style = chipStyles[kind], r = 4 * u;
    if (kind === 'first') {
        ctx.save();
        ctx.shadowColor = 'rgba(128,128,128,0.9)';
        ctx.shadowBlur = 5 * u;
        box(ctx, style.fill, x, y, w, h, r);
        ctx.restore();
        stroke(ctx, '#ffffff', x + 1.5 * u, y + 1.5 * u, w - 3 * u, h - 3 * u, r, Math.max(1, u));
    } else box(ctx, style.fill, x, y, w, h, r);
    if (glow > 0) box(ctx, 'rgba(255,255,255,' + (glow * .55).toFixed(3) + ')', x, y, w, h, r);
    if (judging) {
        ctx.save();
        ctx.shadowColor = 'rgba(255,255,255,0.9)';
        ctx.shadowOffsetX = ctx.shadowOffsetY = 2 * u;
        stroke(ctx, '#000000', x, y, w, h, r, 2 * u, solid ? null : [6 * u, 4 * u]);
        ctx.restore();
    }
    const size = 14.4 * u, cy = y + h / 2 + .5;
    const mid = 20 * u, side = Math.max(0, (w - mid - 10 * u) / 2);
    const attempts = kind === 'untried' ? '' : cell?.attempts || 1;
    const minute = kind === 'untried' || cell?.time == null ? '' : cell.time;
    const start = x + 5 * u;
    text(ctx, attempts, start + side * .8, cy, side * .8, size, { align: 'right', color: style.ink, squeeze: 1 });
    text(ctx, problem?.label || '', start + side * .8 + mid / 2, cy, mid + 6 * u, size, { align: 'center', color: style.ink, squeeze: .8 });
    text(ctx, minute, start + side * .8 + mid, cy, side * 1.2, size, { color: style.ink, squeeze: 1 });
}

/**
 * The board. `data.rows` carries each visible row's position (in rows from the window top),
 * shown rank, score and cells; `fx` the judging chip's border and glow.
 */
export function board(ctx, L, data, teamOf, problems, logoOf, fx) {
    box(ctx, colors.page, 0, 0, L.width, HEIGHT);
    header(ctx, L);
    const { u, line } = L, itemH = 70 * u;
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, L.tableTop - 4, L.width, HEIGHT - L.tableTop + 4);
    ctx.clip();
    for (const row of data.rows) {
        const team = teamOf.get(row.id);
        const y = L.tableTop + row.position * L.pitch;
        const fill = row.judging ? colors.judging : row.recent ? colors.recent : row.index % 2 ? colors.even : colors.odd;
        ctx.save();
        ctx.shadowColor = 'rgba(0,0,0,0.2)';
        ctx.shadowBlur = 3 * u;
        ctx.shadowOffsetY = u;
        box(ctx, fill, L.left, y, L.inner, itemH, 4 * u);
        ctx.restore();
        if (row.judging) stroke(ctx, 'blue', L.left, y, L.inner, itemH, 4 * u, Math.max(1, u), [5 * u, 3 * u]);
        const top = y + 5 * u, center = top + line / 2;

        if (row.medal) rosette(ctx, L.rankX + L.rank / 2, center, line, medalFill[row.medal], medalEdge[row.medal], .4);
        text(ctx, row.rank || '*', L.rankX + L.rank / 2, center + u, L.rank, 24 * u, { align: 'center' });

        box(ctx, '#ffffff', L.logoX, top, L.logo, line, 4 * u);
        if (!cropImage(ctx, logoOf(team), L.logoX, top, L.logo, line, false, 4 * u)) {
            identicon(ctx, team?.organizationName || team?.name || row.id, L.logoX, top, line);
        }

        const icon = 18 * u, nameY = top + 15 * u;
        if (team?.unrank) star(ctx, L.teamX + icon / 2, nameY, icon, '#0d6efd');
        else balloon(ctx, L.teamX + icon / 2, nameY, icon, colors.solved);
        const school = data.showSchool && team?.organizationName;
        const label = school ? school + '：' + teamName(team) : teamName(team);
        text(ctx, label, L.teamX + icon + 6 * u, nameY + u, L.team - icon - 6 * u, 24 * u);

        const cells = row.cells || data.state.results[row.id] || [];
        const n = Math.max(1, problems.length);
        const chipGap = 5 * u, chipW = (L.team - chipGap * n) / n, chipY = top + 35 * u, chipH = 25 * u;
        problems.forEach((problem, p) => {
            const judging = row.judging && data.problemIndex === p;
            chip(ctx, cells[p], problem, L.teamX + chipGap + p * (chipW + chipGap), chipY, chipW, chipH, u,
                judging ? { judging: true, solid: fx.solid, glow: fx.glow } : {});
        });

        text(ctx, row.score?.solved ?? 0, L.solvedX + L.solved / 2, center + u, L.solved, 24 * u, { align: 'center' });
        text(ctx, row.score?.time ?? 0, L.timeX + L.time / 2, center + u, L.time, 24 * u, { align: 'center', squeeze: 1 });
    }
    ctx.restore();
}

/**
 * A dialog over the dimmed board: a white panel that slides down as it fades in, a title bar,
 * and a body the caller fills. Returns the body rectangle.
 */
function dialog(ctx, L, title, enter, { width = 1680, height = 900 } = {}) {
    const show = unit(enter);
    ctx.save();
    ctx.globalAlpha *= show;
    box(ctx, 'rgba(0,0,0,0.5)', 0, 0, L.width, HEIGHT);
    ctx.restore();
    const w = Math.min(width, L.width - 80), h = Math.min(height, HEIGHT - 80);
    const x = (L.width - w) / 2, y = (HEIGHT - h) / 2 - 50 * (1 - show);
    ctx.globalAlpha *= show;
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,0.3)';
    ctx.shadowBlur = 24;
    box(ctx, '#ffffff', x, y, w, h, 8);
    ctx.restore();
    text(ctx, title, x + 24, y + 36, w - 48, 26, { weight: 600 });
    box(ctx, '#dee2e6', x, y + 72, w, 1);
    return { x: x + 24, y: y + 92, w: w - 48, h: h - 112 };
}

/** The award dialog: the team photo on the left, the award and the team's details on the right. */
export function awardCard(ctx, L, info, enter, photo, logo) {
    ctx.save();
    const body = dialog(ctx, L, '获奖信息', enter, { height: 880 });
    const infoW = Math.min(560, body.w * .36);
    const photoW = body.w - infoW - 16, photoH = Math.min(body.h, photoW * 2 / 3);
    box(ctx, '#f1f3f5', body.x, body.y, photoW, photoH, 4);
    if (!cropImage(ctx, photo, body.x, body.y, photoW, photoH, true, 4)) {
        rosette(ctx, body.x + photoW / 2, body.y + photoH / 2, Math.min(photoW, photoH) * .7,
            medalFill[info.medal] || '#a2a9b6', medalEdge[info.medal] || '#8a919d', .45);
    }
    stroke(ctx, '#000000', body.x, body.y, photoW, photoH, 4, 2, [8, 5]);
    const x = body.x + photoW + 16;
    let y = body.y + 70;
    ctx.save();
    ctx.shadowColor = 'rgba(128,128,128,0.9)';
    ctx.shadowOffsetX = ctx.shadowOffsetY = 4;
    ctx.shadowBlur = 4;
    text(ctx, info.title, x, y, infoW, info.medal ? 128 : 88,
        { color: info.medal ? medalTone[info.medal] : colors.ink, weight: 800, squeeze: .5 });
    ctx.restore();
    y += 100;
    if (logo) {
        box(ctx, '#ffffff', x, y, 128, 128, 4);
        cropImage(ctx, logo, x, y, 128, 128, false, 4);
        y += 166;
    } else y += 36;
    for (const [label, value] of info.rows) {
        if (value == null || value === '') continue;
        text(ctx, label + '：', x, y, 100, 32);
        text(ctx, value, x + 100, y, infoW - 100, 32, { squeeze: .5 });
        y += 52;
    }
    ctx.restore();
}

/** A list of teams in a dialog, for an award shared by many teams. */
export function teamListCard(ctx, L, heading, entries, enter, page) {
    ctx.save();
    const body = dialog(ctx, L, '获奖名单', enter);
    text(ctx, heading, body.x, body.y + 40, body.w, 56, { weight: 800 });
    const columns = 2, perPage = 12;
    const pages = Math.max(1, Math.ceil(entries.length / perPage));
    const shown = entries.slice(page % pages * perPage, (page % pages + 1) * perPage);
    const perColumn = Math.max(1, Math.ceil(shown.length / columns));
    const colW = (body.w - 16) / columns, rowH = Math.min(100, (body.h - 110) / (perPage / columns));
    shown.forEach((entry, i) => {
        const col = Math.floor(i / perColumn), x = body.x + col * (colW + 16), y = body.y + 100 + (i % perColumn) * rowH;
        box(ctx, i % 2 ? colors.even : colors.odd, x, y, colW, rowH - 10, 4);
        text(ctx, entry.title, x + 18, y + (rowH - 10) * .36, colW - 36, 30);
        text(ctx, entry.detail, x + 18, y + (rowH - 10) * .74, colW - 36, 20, { color: colors.muted, weight: 600 });
    });
    if (pages > 1) text(ctx, (page % pages + 1) + ' / ' + pages, body.x + body.w, body.y + body.h - 10, 200, 22, { align: 'right', color: colors.muted });
    ctx.restore();
}

/** The opening dialog over the frozen board. */
export function openingCard(ctx, L, summary, enter) {
    ctx.save();
    const body = dialog(ctx, L, '滚榜', enter, { width: 1280, height: 480 });
    text(ctx, summary.title, body.x + body.w / 2, body.y + 120, body.w, 72, { align: 'center', weight: 800, squeeze: .5 });
    text(ctx, summary.teams + ' 支队伍 · ' + summary.problems + ' 道题目', body.x + body.w / 2, body.y + 236, body.w, 34, { align: 'center', color: colors.muted });
    ctx.restore();
}

/** The podium at the close: champion in the middle, runner-up left and third place right. */
export function podiumCard(ctx, L, winners, teamOf, logoOf, cycle, enter, progress) {
    ctx.save();
    const body = dialog(ctx, L, '领奖台', enter, { height: 860 });
    if (!winners.some(Boolean)) {
        text(ctx, '暂无领奖队伍', body.x + body.w / 2, body.y + body.h / 2, body.w, 48, { align: 'center', color: colors.muted });
        ctx.restore();
        return;
    }
    const tones = [medalTone.gold, medalTone.silver, medalTone.bronze];
    const names = ['冠军', '亚军', '季军'];
    const slot = body.w / 3;
    [1, 0, 2].forEach((rank, column) => {
        const winner = winners[rank];
        if (!winner?.teamIds.length) return;
        const show = unit(progress[rank]);
        const cx = body.x + slot * column + slot / 2;
        const top = body.y + 30 + [0, 50, 90][rank] + (1 - show) * 30;
        ctx.save();
        ctx.globalAlpha *= show;
        const id = winner.teamIds[cycle % winner.teamIds.length], team = teamOf.get(id);
        const badge = 140;
        box(ctx, '#ffffff', cx - badge / 2, top, badge, badge, 6);
        if (!cropImage(ctx, logoOf(team), cx - badge / 2, top, badge, badge, false, 6)) identicon(ctx, team?.organizationName || id, cx - badge / 2, top, badge);
        stroke(ctx, '#dee2e6', cx - badge / 2, top, badge, badge, 6, 2);
        ctx.save();
        ctx.shadowColor = 'rgba(128,128,128,0.9)';
        ctx.shadowOffsetX = ctx.shadowOffsetY = 3;
        ctx.shadowBlur = 3;
        text(ctx, winner.name || names[rank], cx, top + badge + 66, slot - 40, rank === 0 ? 80 : 64, { align: 'center', color: tones[rank], weight: 800 });
        ctx.restore();
        text(ctx, teamName(team), cx, top + badge + 142, slot - 40, 40, { align: 'center' });
        text(ctx, team?.organizationName, cx, top + badge + 190, slot - 40, 26, { align: 'center', color: colors.muted, weight: 600 });
        if (winner.teamIds.length > 1) {
            text(ctx, (cycle % winner.teamIds.length + 1) + ' / ' + winner.teamIds.length, cx, top + badge + 230, slot - 40, 22, { align: 'center', color: colors.muted });
        }
        const base = body.y + body.h, plinth = [200, 150, 110][rank] * show;
        box(ctx, rank === 0 ? colors.solved : colors.even, cx - slot * .36, base - plinth, slot * .72, plinth, 6);
        text(ctx, rank + 1, cx, base - plinth / 2, slot * .5, Math.min(100, plinth * .6), { align: 'center', color: rank === 0 ? '#ffffff' : colors.ink, weight: 900 });
        ctx.restore();
    });
    ctx.restore();
}
