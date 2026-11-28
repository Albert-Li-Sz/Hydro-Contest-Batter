export const HEIGHT = 1080;
export const colors = {
    white: '#f4f6ff', soft: '#b2bcd3', dim: '#8491aa', blue: '#3764ff', paleBlue: '#a5bcff',
    line: '#30394a', empty: '#262d3c', pending: '#ffce65', failed: '#f997a0', first: '#8ce5f5',
};
const sans = '"Inter", "Contest Noto Sans SC", "PingFang SC", "Microsoft YaHei", "Noto Sans SC", system-ui, sans-serif';
const figures = '"Barlow", "Inter", "Helvetica Neue", Arial, sans-serif';
const places = ['冠军', '亚军', '季军'];

export function teamName(team) {
    const name = team?.name || team?.displayName || '—';
    const school = team?.organizationName;
    if (school) {
        for (const suffix of ['（' + school + '）', ' (' + school + ')']) {
            if (name.endsWith(suffix) && name.length > suffix.length) return name.slice(0, -suffix.length).trim();
        }
    }
    return name;
}

export function text(ctx, value, x, y, width, size, {
    color = colors.white, align = 'left', weight = 700, numeric = false,
} = {}) {
    if (value == null || width <= 0) return;
    const label = String(value);
    const family = numeric ? figures : sans;
    ctx.font = weight + ' ' + size + 'px ' + family;
    const natural = ctx.measureText(label).width;
    if (natural > width) {
        size = Math.max(Math.round(size * .74), Math.floor(size * width / natural));
        ctx.font = weight + ' ' + size + 'px ' + family;
    }
    let visible = label;
    if (ctx.measureText(label).width > width) {
        const chars = Array.from(label);
        let lo = 0, hi = chars.length;
        while (lo < hi) {
            const mid = Math.ceil((lo + hi) / 2);
            if (ctx.measureText(chars.slice(0, mid).join('') + '…').width <= width) lo = mid;
            else hi = mid - 1;
        }
        visible = chars.slice(0, lo).join('') + '…';
    }
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    ctx.fillText(visible, x, y);
}

export function clock(ms) {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60]
        .map(value => String(value).padStart(2, '0')).join(':');
}

function rect(ctx, color, x, y, w, h) {
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
}

function cropImage(ctx, img, x, y, w, h, cover) {
    if (!img?.naturalWidth || !img.naturalHeight) return false;
    const fit = cover ? Math.max : Math.min;
    const ratio = fit(w / img.naturalWidth, h / img.naturalHeight);
    const iw = img.naturalWidth * ratio, ih = img.naturalHeight * ratio;
    ctx.save();
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    ctx.drawImage(img, x + (w - iw) / 2, y + (h - ih) / 2, iw, ih);
    ctx.restore();
    return true;
}

export function stageLayout(width, rowsPerScreen, teamCount, problemCount) {
    // Keep essential text within the central area of extra-wide LED walls.
    const span = Math.min(width, 2520);
    const margin = Math.round(Math.max(38, span * .036));
    const left = (width - span) / 2 + margin, right = width - left;
    const inner = right - left;
    const gap = Math.max(28, Math.round(inner * .026));
    const side = Math.min(540, Math.round(inner * .284));
    const table = inner - side - gap;
    const rank = Math.round(Math.min(92, table * .102));
    const name = Math.round(Math.min(354, table * (problemCount > 10 ? .27 : .34)));
    const solved = Math.round(Math.min(106, table * .115));
    const time = Math.round(Math.min(128, table * .12));
    const problems = table - rank - name - solved - time;
    const slots = Math.min(problemCount, Math.max(1, Math.floor(problems / 27)));
    const count = Math.max(1, Math.min(teamCount, 13, Math.max(4, Number(rowsPerScreen) || 12)));
    return { width, left, right, inner, gap, side, table, divider: right - side - gap / 2,
        rank, name, solved, time, problems, slots, count, row: Math.min(86, Math.floor(746 / count)), tableTop: 214,
        focusX: right - side / 2, tile: Math.min(352, side * .84), openingX: left + inner * .773,
        podiumX: [left + inner * .5, left + inner * .185, left + inner * .815],
        podiumUnit: Math.min(1.12, inner / 1640) };
}

function header(ctx, layout, title, contest) {
    const { left, right, inner } = layout;
    const height = layout.width < 1350 ? 52 : 70;
    text(ctx, title, left, 87, inner * .45, height, { weight: 850 });
    text(ctx, contest, right, 91, inner * .50, 29, { align: 'right', color: colors.soft, weight: 620 });
    rect(ctx, colors.line, left, 144, inner, 2);
    rect(ctx, colors.blue, left, 144, Math.min(254, inner * .2), 5);
}

export function opening(ctx, L, contest, teams, problems) {
    const { left, inner } = L;
    const titleWidth = inner * .56;
    rect(ctx, colors.blue, left, 344, 71, 10);
    text(ctx, '赛后滚榜', left, 458, titleWidth, Math.min(149, inner * .086), { weight: 900 });
    text(ctx, contest, left, 597, titleWidth, Math.min(43, inner * .035), { weight: 650, color: colors.soft });
    rect(ctx, colors.line, left, 686, titleWidth * .88, 2);
    const split = Math.min(196, titleWidth * .47);
    text(ctx, '队伍', left, 746, split, 25, { color: colors.soft });
    text(ctx, teams, left, 822, split, 82, { numeric: true, weight: 850 });
    text(ctx, '题目', left + split, 746, split, 25, { color: colors.soft });
    text(ctx, problems, left + split, 822, split, 82, { numeric: true, weight: 850 });
}

export function replay(ctx, L, contest, time, duration, runs, end, teams, problems, team, photo, logo, latest) {
    header(ctx, L, '提交回放', contest);
    const x = L.left, w = L.table, y = 405;
    const ratio = time / duration;
    text(ctx, clock(time), x, 288, w, Math.min(143, w * .185), { numeric: true, weight: 850 });
    rect(ctx, colors.line, x, y, w, 5);
    rect(ctx, colors.blue, x, y, w * ratio, 5);
    for (let p = 0; p < 96; p++) {
        const sample = latest[p];
        if (sample && sample[0] <= time) rect(ctx, sample[3] ? colors.paleBlue : colors.failed, x + p * w / 96, y - 5, 4, 15);
    }
    rect(ctx, colors.white, x + w * ratio - 2, y - 17, 4, 39);
    text(ctx, '00:00:00', x, 466, w / 2, 23, { numeric: true, color: colors.soft });
    text(ctx, clock(duration), x + w, 466, w / 2, 23, { numeric: true, align: 'right', color: colors.soft });

    if (!end) text(ctx, runs.length ? '等待首条公开提交' : '暂无公开提交', x, 573, w, 35, { color: colors.soft });
    for (let n = 0; n < 5 && n < end; n++) {
        const run = runs[end - 1 - n], py = 524 + n * 93;
        rect(ctx, n === 0 ? '#162346' : '#111620', x, py, w, 80);
        if (!n) rect(ctx, colors.blue, x, py, 5, 80);
        const size = Math.min(34, w * .049);
        text(ctx, clock(run[0]), x + 22, py + 40, w * .25 - 30, size, { numeric: true, color: colors.soft });
        text(ctx, problems[run[2]]?.label || '—', x + w * .30, py + 40, w * .13, size, { numeric: true, align: 'center' });
        text(ctx, teamName(teams[run[1]]), x + w * .39, py + 40, w * .38, size);
        text(ctx, run[3] ? '通过' : '未通过', x + w - 24, py + 40, w * .20 - 20, size,
            { align: 'right', color: run[3] ? colors.paleBlue : colors.failed });
    }
    const sx = L.right - L.side, boxY = 291, boxH = Math.min(340, L.side * .72);
    rect(ctx, colors.line, L.divider, 205, 2, 764);
    text(ctx, '队伍巡礼', sx, 232, L.side, 36, { color: colors.soft });
    rect(ctx, '#131d34', sx, boxY, L.side, boxH);
    if (!cropImage(ctx, photo, sx, boxY, L.side, boxH, true)) {
        if (!cropImage(ctx, logo, sx + L.side * .25, boxY + boxH * .18, L.side * .5, boxH * .64, false)) {
            // An abstract score mark fills the space when no team media is available.
            const bar = L.side / 9;
            for (let i = 0; i < 3; i++) rect(ctx, colors.blue, L.focusX + (i - 1.5) * bar * 1.32,
                boxY + boxH * (.65 - .13 * i), bar, boxH * (.17 + .13 * i));
        }
    }
    rect(ctx, colors.blue, sx, boxY + boxH - 5, L.side, 5);
    text(ctx, teamName(team), sx, boxY + boxH + 88, L.side, Math.min(65, L.side * .19), { weight: 850 });
    text(ctx, team?.organizationName, sx, boxY + boxH + 160, L.side, 29, { color: colors.soft });
}

const cells = {
    solved: { fill: '#294ddc', ink: '#fff', symbol: '✓' },
    first: { fill: '#8ce5f5', ink: '#061830', symbol: '✓' },
    failed: { fill: '#633243', ink: '#ffc1c8', symbol: '×' },
    pending: { fill: '#deac45', ink: '#14100a', symbol: '?' },
    empty: { fill: colors.empty, ink: colors.soft, symbol: '–' },
};
const verdict = cell => cells[cell?.firstToSolve && cell.status === 'solved' ? 'first' : cell?.status] || cells.empty;

function legend(ctx, x, w, y, dense) {
    const labels = dense ? [['solved', '通过'], ['failed', '未通过'], ['pending', '待揭晓'], ['first', '首解']]
        : [['solved', '已通过'], ['failed', '未通过'], ['pending', '待揭晓'], ['first', '首解']];
    const step = Math.min(154, w / 4), size = Math.min(23, step * .145);
    labels.forEach(([key, label], i) => {
        const style = cells[key], left = x + step * i;
        rect(ctx, style.fill, left, y - 12, 23, 24);
        text(ctx, style.symbol, left + 11.5, y + 1, 22, 17, { color: style.ink, align: 'center' });
        text(ctx, label, left + 32, y, step - 35, size, { color: colors.soft });
    });
}

export function board(ctx, L, contest, data, teamOf, problemList) {
    header(ctx, L, '翻牌揭晓', contest);
    const px = L.left + L.rank + L.name + L.solved + L.time;
    const solvedX = L.left + L.rank + L.name + L.solved / 2;
    const timeX = solvedX + (L.solved + L.time) / 2;
    const rankX = L.left + L.rank / 2, nameX = L.left + L.rank + 10;
    const cellWidth = L.problems / Math.max(1, L.slots);
    const tiles = problemList.slice(data.problemStart, data.problemStart + L.slots);
    const columns = [['名次', rankX, L.rank], ['过题', solvedX, L.solved], ['罚时', timeX, L.time]];
    for (const [label, x, w] of columns) text(ctx, label, x, 184, w - 8, 23, { align: 'center', color: colors.soft });
    text(ctx, '队伍', nameX, 184, L.name - 20, 23, { color: colors.soft });
    tiles.forEach((problem, p) => text(ctx, problem.label, px + (p + .5) * cellWidth, 184, cellWidth - 5, 24,
        { numeric: true, align: 'center', color: colors.soft }));

    ctx.save();
    ctx.beginPath(); ctx.rect(L.left, L.tableTop, L.table, L.count * L.row); ctx.clip();
    for (const row of data.rows) {
        const { id, position, rank, selected, old } = row, team = teamOf.get(id);
        const y = L.tableTop + position * L.row;
        const current = data.state.standings.get(id);
        const score = old?.score || current;
        const visibleCells = old?.cells || data.state.results[id] || [];
        rect(ctx, selected ? '#182f7c' : row.index % 2 ? '#10141d' : '#181e29', L.left, y, L.table, L.row - 3);
        if (selected) rect(ctx, colors.blue, L.left, y, 7, L.row - 3);
        const fontSize = Math.min(38, L.row * .54);
        const center = y + (L.row - 2) / 2;
        text(ctx, rank || '★', rankX, center, L.rank - 10, fontSize,
            { numeric: true, align: 'center', color: rank ? colors.white : colors.soft });
        const school = L.row >= 67 && team?.displayName !== team?.name && team?.organizationName;
        text(ctx, teamName(team), nameX, center - (school ? 13 : 0), L.name - 16, fontSize, { weight: 770 });
        if (school) text(ctx, school, nameX, center + 22, L.name - 16, 20, { color: colors.soft, weight: 550 });
        text(ctx, score?.solved || 0, solvedX, center, L.solved - 12, fontSize, { numeric: true, align: 'center' });
        text(ctx, score?.time ?? '—', timeX, center, L.time - 12, fontSize,
            { numeric: true, align: 'center', color: colors.soft });
        tiles.forEach((_, p) => {
            const index = p + data.problemStart, style = verdict(visibleCells[index]);
            const w = Math.min(cellWidth - 6, 67), h = Math.min(L.row * .72, 58), x = px + (p + .5) * cellWidth;
            rect(ctx, style.fill, x - w / 2, center - h / 2, w, h);
            if (data.focus?.team?.id === id && data.focus.problemIndex === index) {
                ctx.strokeStyle = colors.white; ctx.lineWidth = 2;
                ctx.strokeRect(x - w / 2 - 2, center - h / 2 - 2, w + 4, h + 4);
            }
            text(ctx, style.symbol, x, center, w - 4, Math.min(32, w * .62, h * .62),
                { align: 'center', color: style.ink });
        });
    }
    ctx.restore();
    legend(ctx, L.left, L.table - 14, 1024, L.width < 1500);
    if (L.slots < problemList.length) {
        text(ctx, (data.problemStart + 1) + '–' + (data.problemStart + L.slots) + ' / ' + problemList.length + ' 题',
            L.left + L.table, 991, L.table, 21, { align: 'right', color: colors.soft });
    }
    rect(ctx, colors.line, L.divider, 167, 2, 805);
    const focus = data.focus;
    const band = L.side * .94;
    if (!focus.team) {
        text(ctx, '冻结榜单', L.focusX, 418, band, 60, { align: 'center', weight: 840 });
        text(ctx, data.state.order.length + ' 支队伍', L.focusX, 502, band, 32, { align: 'center', color: colors.soft });
        return;
    }
    text(ctx, teamName(focus.team), L.focusX, 256, band, Math.min(79, L.side * .19), { align: 'center', weight: 850 });
    text(ctx, focus.team.organizationName, L.focusX, 327, band, 29, { align: 'center', color: colors.soft });
    if (focus.problemIndex == null) {
        const score = data.state.standings.get(focus.team.id);
        text(ctx, score?.solved || 0, L.focusX, 544, band, 134, { numeric: true, align: 'center', weight: 850 });
        text(ctx, '已通过题目', L.focusX, 649, band, 30, { align: 'center', color: colors.soft });
        const pending = (data.state.results[focus.team.id] || []).filter(cell => cell.status === 'pending').length;
        if (pending) text(ctx, pending + ' 题待揭晓', L.focusX, 821, band, 37, { align: 'center', color: colors.paleBlue });
        return;
    }
    const result = focus.result;
    const label = result ? result.firstToSolve ? '首解通过' : result.status === 'solved' ? '通过' : '未通过' : '待揭晓';
    const fieldColor = result ? result.status === 'solved' ? colors.paleBlue : colors.failed : colors.white;
    text(ctx, label, L.focusX, 813, band, Math.min(62, L.side * .156), { align: 'center', color: fieldColor, weight: 850 });
    if (focus.rank && focus.rank.from > focus.rank.to) {
        text(ctx, '↑  ' + focus.rank.from + ' → ' + focus.rank.to + ' 名', L.focusX, 913, band, 41,
            { align: 'center', color: colors.paleBlue, weight: 800 });
    }
}

export function award(ctx, L, contest, state, teamOf, elapsed, photo, logo) {
    const awards = state.award?.awards || [];
    const list = state.screen === 'teamList';
    header(ctx, L, list ? '获奖名单' : '奖项揭晓', contest);
    if (list) {
        const prize = awards[0], all = prize?.teamIds || state.selected;
        const pageSize = L.width < 1350 ? 8 : 12;
        const pages = Math.max(1, Math.ceil(all.length / pageSize));
        const page = Math.floor(elapsed / 5200) % pages;
        text(ctx, prize?.citation || '获奖队伍', L.left, 253, L.inner, 68, { weight: 850 });
        const columnWidth = (L.inner - L.gap) / 2;
        all.slice(page * pageSize, (page + 1) * pageSize).forEach((id, i) => {
            const team = teamOf.get(id), column = Math.floor(i / (pageSize / 2));
            const x = L.left + column * (columnWidth + L.gap), y = 336 + i % (pageSize / 2) * 98;
            rect(ctx, i % 2 ? '#111621' : '#1a2231', x, y, columnWidth, 85);
            rect(ctx, colors.blue, x, y, 5, 85);
            text(ctx, teamName(team), x + 23, y + 30, columnWidth - 42, 35);
            text(ctx, team?.organizationName, x + 23, y + 63, columnWidth - 42, 23, { color: colors.soft });
        });
        if (pages > 1) text(ctx, (page + 1) + ' / ' + pages, L.right, 1004, 200, 24, { align: 'right', color: colors.soft });
        return;
    }
    const team = teamOf.get(state.award?.teamId || state.selected[0]);
    const w = L.inner * .54, sx = L.left + w + L.gap;
    text(ctx, teamName(team), L.left, 424, w, 111, { weight: 850 });
    text(ctx, team?.organizationName, L.left, 527, w, 37, { color: colors.soft });
    const pageSize = 6, pages = Math.max(1, Math.ceil(awards.length / pageSize));
    const page = Math.floor(elapsed / 5200) % pages;
    awards.slice(page * pageSize, (page + 1) * pageSize).forEach((item, i) => {
        rect(ctx, colors.blue, L.left, 607 + i * 61, 6, 37);
        text(ctx, item.citation, L.left + 21, 626 + i * 61, w - 21, 35, { color: colors.paleBlue });
    });
    if (pages > 1) text(ctx, (page + 1) + ' / ' + pages, L.left, 1004, 200, 24, { color: colors.soft });
    const mediaW = L.right - sx, mediaH = mediaW * .75;
    if (!cropImage(ctx, photo, sx, 338, mediaW, mediaH, true)) {
        cropImage(ctx, logo, sx + mediaW * .2, 338, mediaW * .6, mediaH, false);
    }
}

export function podium(ctx, L, contest, winners, teamOf, cycle, logoOf, entrance) {
    header(ctx, L, '领奖台', contest);
    if (!winners.some(Boolean)) {
        text(ctx, '暂无领奖队伍', L.width / 2, 529, L.inner, 62, { align: 'center', color: colors.soft });
        return;
    }
    winners.forEach((winner, rank) => {
        if (!winner?.teamIds.length) return;
        const id = winner.teamIds[cycle % winner.teamIds.length];
        const x = L.podiumX[rank], w = L.inner * .283, scale = L.podiumUnit;
        const nameY = 801 - podiumHeights[rank] * scale;
        const team = teamOf.get(id);
        ctx.save(); ctx.globalAlpha = entrance[rank];
        const identity = logoOf(team);
        const badge = Math.min(79, w * .22);
        cropImage(ctx, identity, x - badge / 2, nameY - 161, badge, badge, false);
        text(ctx, teamName(team), x, nameY - 38, w, rank === 0 ? 66 : 47, { align: 'center', weight: 850 });
        text(ctx, team?.organizationName, x, nameY + 8, w, 26, { align: 'center', color: colors.soft });
        text(ctx, (winner.name || places[rank]) + (winner.teamIds.length > 1 ? ' · ' + (cycle % winner.teamIds.length + 1) + '/' + winner.teamIds.length : ''),
            x, nameY + 45, w, 24, { align: 'center', color: colors.paleBlue });
        ctx.restore();
    });
}

export const podiumHeights = [330, 242, 186];
