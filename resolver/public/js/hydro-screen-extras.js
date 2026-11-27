// Hydro's displays that use contest data without the ICPC Tools presentation format.
import { Color, ICPCColors } from './render/java-graphics.js';
import { FONT_FAMILY, initFonts } from './render/text.js';
import { inkOn } from './ink.js';

const titles = {
    'rank-trend': ['排名走势图', 'Ranking over time'],
    outcomes: ['评测结果分布', 'Judgement distribution'],
    groups: ['分组排行', 'Group standings'],
    'team-intro': ['队伍巡礼', 'Team introduction'],
    floor: ['赛场平面图', 'Contest floor'],
    balloons: ['气球配送图', 'Balloon delivery'],
    announce: ['通过播报', 'Accepted submissions'],
    judges: ['评测机状态', 'Judge status'],
    reactions: ['反应视频轮播', 'Reaction videos'],
    poster: ['图片海报', 'Posters'],
    clarifications: ['比赛公告', 'Contest announcements'],
    'problem-list': ['题目列表', 'Problems'],
};

const outcomes = {
    CORRECT: ['AC', '#00e600'], REJECTED: ['未通过', '#f00000'], WRONG_ANSWER: ['WA', '#f00000'],
    TIME_LIMIT_EXCEEDED: ['TLE', '#ffdf36'], MEMORY_LIMIT_EXCEEDED: ['MLE', '#df9f35'],
    OUTPUT_LIMIT_EXCEEDED: ['OLE', '#ca713a'], RUNTIME_ERROR: ['RE', '#e792d3'],
    COMPILATION_ERROR: ['CE', '#c3c3c3'], PRESENTATION_ERROR: ['PE', '#77c3d9'],
    JUDGEMENT_FAILED: ['SE', '#c43a24'], HACKED: ['HACKED', '#bd8cdd'],
    CANCELED: ['已取消', '#888888'], PENDING: ['待定', '#4272f5'],
};
const colors = [Color.RED, Color.GREEN, ICPCColors.BLUE, Color.CYAN, ICPCColors.YELLOW].map((color) => (
    `#${[color.r, color.g, color.b].map((channel) => channel.toString(16).padStart(2, '0')).join('')}`
));
const count = (rows, size) => Math.max(1, Math.ceil(rows.length / size));
const portrait = () => innerWidth / innerHeight < 1.2;
const time = (ms) => {
    const seconds = Math.floor(ms / 1000);
    return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};

function el(tag, className, ...children) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    node.append(...children.filter((value) => value != null));
    return node;
}

function badge(label, color, className = '') {
    const node = el('span', `screen-badge ${className}`, label);
    if (/^#[a-f\d]{6}$/i.test(color || '')) node.style.setProperty('--badge-color', color);
    return node;
}

function image(src, alt) {
    const node = el('img');
    node.src = src;
    node.alt = alt;
    return node;
}

function table(headers, rows) {
    return el('table', 'screen-table',
        el('thead', '', el('tr', '', ...headers.map((label) => el('th', '', label)))),
        el('tbody', '', ...rows.map((cells) => el('tr', '', ...cells.map((cell) => el('td', '', cell))))));
}


/**
 * Columns and rows that make `count` cells (about `ratio` wide per unit high) as large as they can be in
 * width x height. At least `minimum` cells are planned, so a zone with few seats keeps the usual cell size.
 */
export function fitGrid(count, width, height, ratio = 1.7, minimum = 12) {
    const planned = Math.max(1, count, minimum);
    let best = { cols: 1, rows: planned, size: 0 };
    for (let cols = 1; cols <= planned; cols++) {
        const rows = Math.ceil(planned / cols);
        const size = Math.min(width / cols / ratio, height / rows);
        if (size > best.size + 1e-9) best = { cols, rows, size };
    }
    // Rows past the seats stay empty below them instead of stretching the seats.
    return { cols: best.cols, rows: best.rows };
}

function seatPages(rows, size) {
    const zones = new Map();
    for (const row of [...rows].sort((a, b) => a.seat.localeCompare(b.seat, undefined, { numeric: true }))) {
        const zone = row.seat ? row.seat.replace(/[\s_-]*\d+$/, '') : null;
        if (!zones.has(zone)) zones.set(zone, []);
        zones.get(zone).push(row);
    }
    return [...zones].flatMap(([zone, seats]) => Array.from({ length: count(seats, size) }, (_, index) => ({
        zone, rows: seats.slice(index * size, (index + 1) * size),
    })));
}

export class HydroScreenExtras {
    constructor(root) {
        this.root = root;
        this.key = '';
        this.fontLocale = null;
    }

    show(state, elapsed, offset = 0) {
        const { type, item, data } = state;
        if (!item || !(type in titles)) { this.page = null; return false; }
        this.root.hidden = false;
        this.root.dataset.type = type;
        const interval = (item.interval || 10) * 1000;
        const tick = Math.floor(elapsed / interval);
        const portrait = innerWidth / innerHeight < 1.2;
        const rows = portrait ? 9 : 12;
        const pages = type === 'floor' || type === 'balloons' ? seatPages(data.seats, portrait ? 20 : 32) : null;
        const total = pages ? pages.length : ({
            groups: item.variant === 'group' ? data.length : count(data, rows),
            outcomes: count(data, rows),
            'team-intro': data.length, reactions: data.length, poster: data.length, clarifications: data.length, announce: data.length,
            'problem-list': count(data, rows), judges: count(data.machines || [], rows),
        })[type] || 1;
        const current = ((tick + offset) % Math.max(1, total) + Math.max(1, total)) % Math.max(1, total);
        this.page = { current, total };
        // Charts and the seat grids are laid out for the window, so they are redrawn when it changes size.
        const size = ['rank-trend', 'floor', 'balloons'].includes(type) ? `${innerWidth}x${innerHeight}` : portrait;
        const key = JSON.stringify([type, item, data, state.title, state.locale, current, size]);
        if (key === this.key && this.root.childElementCount) {
            if (type === 'clarifications') {
                const body = this.root.querySelector('.screen-body');
                const hold = Math.min(1000, interval * .15);
                const progress = Math.min(1, Math.max(0, (elapsed % interval - hold) / (interval - 2 * hold)));
                body.scrollTop = Math.max(0, body.scrollHeight - body.clientHeight) * progress;
            }
            return true;
        }
        this.key = key;
        if (state.locale !== this.fontLocale) {
            this.fontLocale = state.locale;
            void initFonts(state.locale).then(() => { this.key = ''; });
        }
        const lang = state.locale === 'en' ? 1 : 0;
        this.t = (zh, en) => lang ? en : zh;
        this.root.lang = state.locale;
        const body = el('div', 'screen-body');
        this.root.replaceChildren(el('header', 'screen-heading', el('h1', '', titles[type][lang])), body,
            el('footer', 'screen-page', total > 1 ? `${current + 1} / ${total}` : ''));
        const page = (list) => list.slice(current * rows, (current + 1) * rows);
        if (type === 'rank-trend' && data?.teams.length) this.rankTrend(body, data);
        else if (type === 'outcomes' && data.some((row) => Object.keys(row.counts).length)) this.distribution(body, page(data), data);
        else if (type === 'groups' && data.length) this.groups(body, item.variant === 'group' ? [data[current]] : page(data), item.variant);
        else if (type === 'team-intro' && data.length) this.team(body, data[current]);
        else if (type === 'floor' || type === 'balloons') this.venue(body, pages[current], data, type, item.variant);
        else if (type === 'announce' && data.length) this.announce(body, data[current]);
        else if (type === 'judges') this.judges(body, page(data.machines), data);
        else if (type === 'reactions' && data.length) {
            const clip = data[current];
            const video = document.createElement('video');
            video.autoplay = video.muted = video.playsInline = true;
            video.loop = total === 1;
            video.src = clip.url;
            video.style.cssText = 'width:100%;height:100%;object-fit:contain';
            video.setAttribute('aria-label', [clip.team, clip.problem].join(' · '));
            body.append(video);
        }
        else if (type === 'poster' && data.length) body.append(el('div', 'screen-poster', image(data[current], this.t('比赛海报', 'Contest poster'))));
        else if (type === 'clarifications' && data.length) this.clarification(body, data[current]);
        else if (type === 'problem-list' && data.length) this.problems(body, page(data));
        else body.append(el('p', 'screen-empty', ({
            poster: this.t('等待管理员上传图片', 'Waiting for posters'),
            groups: this.t('没有可展示的分组。如未配置分榜，可在管理页切换为按学校分组。', 'No groups to show. Choose schools if no boards are configured.'),
            clarifications: this.t('暂无比赛公告', 'No contest announcements'),
            announce: this.t('等待通过', 'Waiting for accepted submissions'),
            'team-intro': this.t('暂无参赛队伍', 'No teams'),
        })[type] || this.t('暂无数据', 'No data yet')));
        return true;
    }

    outcomeLabel(status) {
        if (status === 'PENDING') return this.t('待定', 'Pending');
        if (status === 'REJECTED') return this.t('未通过', 'Rejected');
        if (status === 'CANCELED') return this.t('已取消', 'Canceled');
        return outcomes[status]?.[0] || status;
    }

    rankTrend(body, data) {
        const chart = el('canvas', 'screen-chart');
        chart.setAttribute('role', 'img');
        chart.setAttribute('aria-label', this.t('领先队伍随比赛时间的排名变化', 'Ranking of the leaders over time'));
        const legend = el('ul', 'screen-legend', ...data.teams.map((team, index) => el('li', '', badge('●', colors[index]), team.name)));
        body.append(el('div', 'screen-rank-trend', chart, legend));
        const ratio = Math.min(2, devicePixelRatio || 1);
        const w = chart.clientWidth, h = chart.clientHeight;
        chart.width = Math.max(1, Math.round(w * ratio));
        chart.height = Math.max(1, Math.round(h * ratio));
        const ctx = chart.getContext('2d');
        const margin = Math.max(27, Math.min(w, h) * .085);
        const x = (ms) => margin + ms / data.times.at(-1) * (w - margin * 2);
        const y = (rank) => margin + (rank - 1) / Math.max(1, data.maxRank - 1) * (h - margin * 2);
        ctx.scale(ratio, ratio);
        ctx.font = `${Math.max(12, margin * .39)}px ${FONT_FAMILY}`;
        ctx.textBaseline = 'middle';
        const ticks = Math.min(5, data.maxRank);
        for (let index = 0; index < ticks; index++) {
            const rank = 1 + Math.round(index * (data.maxRank - 1) / Math.max(1, ticks - 1));
            ctx.strokeStyle = '#646464';
            ctx.beginPath(); ctx.moveTo(margin, y(rank)); ctx.lineTo(w - margin, y(rank)); ctx.stroke();
            ctx.fillStyle = '#fff'; ctx.textAlign = 'right';
            ctx.fillText(`#${rank}`, margin - 6, y(rank));
        }
        const labels = w < 520 ? 3 : 5;
        for (let i = 0; i < labels; i++) {
            const at = data.times.at(-1) * i / (labels - 1);
            ctx.textAlign = 'center'; ctx.fillStyle = '#fff';
            ctx.fillText(time(at), x(at), h - margin * .38);
        }
        for (const [index, team] of data.teams.entries()) {
            ctx.lineWidth = Math.max(2, margin * .065);
            ctx.lineJoin = 'round';
            ctx.strokeStyle = colors[index];
            ctx.beginPath();
            let drawing = false;
            team.ranks.forEach((rank, i) => {
                if (!rank) { drawing = false; return; }
                if (drawing) ctx.lineTo(x(data.times[i]), y(rank));
                else ctx.moveTo(x(data.times[i]), y(rank));
                drawing = true;
            });
            ctx.stroke();
            ctx.fillStyle = colors[index];
            ctx.beginPath(); ctx.arc(x(data.times.at(-1)), y(team.ranks.at(-1)), 4, 0, Math.PI * 2); ctx.fill();
        }
    }

    distribution(body, page, data) {
        const total = (row) => Object.values(row.counts).reduce((sum, value) => sum + value, 0);
        const max = Math.max(1, ...data.map(total));
        const keys = [...new Set(data.flatMap((row) => Object.keys(row.counts)))].sort((a, b) => (
            (a === 'CORRECT' ? -1 : a === 'PENDING' ? 1 : 0) - (b === 'CORRECT' ? -1 : b === 'PENDING' ? 1 : 0)
        ));
        body.append(el('div', 'screen-outcomes', ...page.map((row) => {
            const bar = el('div', 'screen-bar', ...keys.filter((key) => row.counts[key]).map((key) => {
                const segment = el('span');
                segment.style.width = `${row.counts[key] / max * 100}%`;
                segment.style.background = outcomes[key]?.[1] || '#b5bbc6';
                segment.title = `${this.outcomeLabel(key)} · ${row.counts[key]}`;
                return segment;
            }));
            return el('div', 'screen-bar-row', el('span', '', row.label), bar, el('strong', '', total(row)));
        })), el('ul', 'screen-legend', ...keys.map((key) => el('li', '', badge('●', outcomes[key]?.[1]), this.outcomeLabel(key)))));
    }

    groups(body, groups, variant) {
        const name = (team, detail) => el('div', 'screen-team-row', image(team.logo || '/hydro-resolver/assets/img/icpc-logo.png', ''),
            el('div', '', el('strong', '', team.name), detail ? el('div', 'screen-marks', ...team.cells.map((cell) => badge(
                cell.status === 'unattempted' ? cell.label : `${cell.attempts}${cell.status === 'solved' ? ` - ${cell.time}` : ''}`,
                '', `screen-cell ${cell.first ? 'first' : cell.status}`,
            ))) : null));
        if (variant === 'group') {
            const group = groups[0];
            body.append(el('h2', 'screen-subtitle', group.name), table(
                [this.t('名次', 'Rank'), this.t('队伍', 'Team'), this.t('通过', 'Solved'), this.t('罚时', 'Penalty')],
                group.rows.map((team) => [team.rank, name(team, true), team.solved, time(team.timeSeconds * 1000)])));
        } else {
            body.append(table([this.t('分组', 'Group'), this.t('领先队伍', 'Leader'), this.t('通过', 'Solved')],
                groups.map((group) => {
                    const leader = group.rows.find((team) => team.rank === 1);
                    return [group.name, leader ? name(leader, false) : '—', leader?.solved ?? '—'];
                })));
        }
    }

    team(body, team) {
        const logo = image(team.logo || '/hydro-resolver/assets/img/icpc-logo.png', team.organizationName);
        body.append(el('article', 'screen-hero', logo, el('h2', '', team.displayName),
            el('p', 'screen-muted', team.organizationName), team.members?.length ? el('p', '', team.members.join(' · ')) : null));
    }

    venue(body, page, data, type, variant) {
        const delivery = type === 'balloons';
        const pending = delivery ? data.seats.reduce((sum, row) => sum + row.balloons.length, 0) : 0;
        if (delivery) body.append(el('p', 'screen-subtitle', this.t(`待配送 ${pending} 个气球`, `${pending} balloons to deliver`)));
        if (!page) {
            body.append(el('p', 'screen-empty', this.t('暂无座位，请先在 onsite-toolkit 导入座位号', 'Import seats with onsite-toolkit to show the floor')));
            return;
        }
        const zone = page.zone === null ? this.t('未分配座位', 'Unassigned seats') : page.zone;
        if (zone) body.append(el('p', 'screen-zone', zone));
        const problems = new Map(data.problems.map((problem) => [problem.id, problem]));
        const grid = el('div', `screen-seat-grid fit${variant === 'problems' && !delivery ? ' cells' : ''}`, ...page.rows.map((row) => {
            const cell = el('article', `screen-seat${delivery && !row.balloons.length ? ' quiet' : ''}`,
                el('strong', '', row.seat || '—'), el('span', 'screen-seat-name', row.name));
            const marks = el('div', 'screen-marks');
            if (delivery) for (const id of row.balloons) {
                const problem = problems.get(id);
                if (!problem) continue;
                // A filled balloon in the problem's colour, readable from across the room.
                const balloon = badge(problem.label, problem.color, 'screen-balloon');
                balloon.style.color = inkOn(problem.color);
                marks.append(balloon);
            }
            else if (variant === 'problems') for (const [i, state] of row.cells.entries()) {
                const problem = data.problems[i];
                if (problem) marks.append(badge(problem.label, problem.color, `screen-cell ${state}`));
            }
            else {
                marks.append(el('span', '', this.t(`通过 ${row.solved} 题`, `${row.solved} solved`)));
                if (row.latest) marks.append(badge(this.outcomeLabel(row.latest), outcomes[row.latest]?.[1]));
            }
            cell.append(marks);
            return cell;
        }));
        body.append(grid);
        // The grid fills what the heading leaves; its cells grow with the screen (font size follows the cell).
        const { cols, rows } = fitGrid(page.rows.length, grid.clientWidth || innerWidth, grid.clientHeight || innerHeight * 0.75,
            delivery ? 1.5 : variant === 'problems' ? 2.2 : 1.7, portrait() ? 8 : 12);
        grid.style.setProperty('--cols', String(cols));
        grid.style.setProperty('--rows', String(rows));
        // Many problems or balloons need more lines than the cell's height allows: shrink the text of every
        // cell alike until the fullest one fits (nothing is clipped, all seats keep one size).
        const fits = () => [...grid.children].every((cell) => cell.scrollHeight <= cell.clientHeight + 1 && cell.scrollWidth <= cell.clientWidth + 1);
        for (let scale = 1, tries = 0; tries < 14 && !fits(); tries++) {
            scale *= 0.9;
            grid.style.setProperty('--seat-scale', scale.toFixed(3));
        }
    }

    announce(body, row) {
        body.append(el('article', 'screen-hero', row.problem ? badge(row.problem.label, row.problem.color, 'screen-large-badge') : null,
            el('h2', '', row.name), el('p', '', row.first ? this.t('一血 · 首次通过', 'First to solve') : this.t('通过', 'Accepted')),
            el('p', 'screen-muted', time(row.time))));
    }

    judges(body, machines, data) {
        const joined = data.machines.filter((row) => row.online).length;
        body.append(el('p', 'screen-subtitle', this.t(
            `在线 ${joined}/${data.machines.length} · 等待评测 ${data.queueLength} · 告警 ${data.alerts}`,
            `Online ${joined}/${data.machines.length} · Queue ${data.queueLength} · Alerts ${data.alerts}`)));
        if (!machines.length) { body.append(el('p', 'screen-empty', this.t('暂无评测机数据', 'No judge data'))); return; }
        const percentage = (n) => Number.isFinite(n) ? `${Math.round(n)}%` : '—';
        body.append(table([this.t('评测机', 'Judge'), this.t('状态', 'Status'), this.t('评测中 / 并发', 'Active / Slots'),
            this.t('近 5 分钟评测', 'Judged / 5 min'), this.t('近 15 分钟系统错误', 'Errors / 15 min'), 'CPU', this.t('内存', 'RAM'), this.t('温度', 'Temperature')],
        machines.map((row) => [row.builtin ? this.t(`内置 #${row.number}`, `Built-in #${row.number}`) : this.t(`评测机 #${row.number}`, `Judge #${row.number}`),
            row.online ? badge(row.active ? this.t('评测中', 'Busy') : this.t('在线', 'Online'), '#00e600') : badge(this.t('离线', 'Offline'), '#f00000'),
            `${row.active} / ${row.concurrency ?? '—'}`, row.judged5, row.systemErrors15, percentage(row.cpu), percentage(row.memory),
            Number.isFinite(row.temperature) ? `${Math.round(row.temperature)} °C` : '—'])));
    }

    clarification(body, row) {
        const info = new Date(row.at).toLocaleTimeString(this.root.lang, { hour: '2-digit', minute: '2-digit' });
        body.append(el('article', 'screen-announcement', el('p', 'screen-muted', [info, row.subject].filter(Boolean).join(' · ')),
            el('p', row.text.length > 300 ? 'long' : '', row.text)));
    }

    problems(body, rows) {
        body.append(table([this.t('题号', 'Problem'), this.t('标题', 'Title'), this.t('时间限制', 'Time limit'), this.t('内存限制', 'Memory limit')],
            rows.map((row) => [badge(row.label, row.color), row.title, row.timeMs == null ? '—' : `${row.timeMs / 1000} s`,
                row.memoryMb == null ? '—' : `${row.memoryMb} MiB`])));
    }
}
