/**
 * 气球配送: one balloon per team and problem, from the team's first accepted submission in the
 * contest. The plugin tracks them itself instead of using Hydro's balloon records, which Hydro stops
 * creating at the freeze and only creates when the contest has balloon colours. Staff see what to
 * deliver by room (seat prefix) and problem; with 小票机 a ticket is printed for every new balloon,
 * on the receipt printer the contest's plan assigns. Pure; lib/balloon-routes.ts stores and serves.
 */
import { serverTakes } from './print';

export class BalloonError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}

/** Hydro's STATUS_ACCEPTED (model/builtin.ts). */
export const STATUS_ACCEPTED = 1;

// ---------------------------------------------------------------- Settings

export interface BalloonColor {
    /** As read aloud and printed on a ticket: 红、浅蓝、金. */
    name: string;
    /** `#rrggbb`, for the screens. */
    hex: string;
}

export interface TicketPrinterRef {
    /** Print server id. */
    server: string;
    printer: string;
}

/** Tickets of matching balloons go to these receipt printers; the first matching rule decides. */
export interface TicketRule {
    id: string;
    name: string;
    /** Seat prefixes (`A`, `B-1`); empty matches every seat. */
    zones: string[];
    /** Hydro problem ids; empty matches every problem. */
    problems: number[];
    printers: TicketPrinterRef[];
}

export interface BalloonSettings {
    enabled: boolean;
    /** continue: balloons for accepts after the freeze go out at once; hold: they wait until the board is unlocked. */
    afterFreeze: 'continue' | 'hold';
    /** By Hydro problem id. */
    colors: Record<string, BalloonColor>;
    tickets: {
        enabled: boolean;
        rules: TicketRule[];
        /** The ticket lists every problem the team has a balloon for (DOMjudge's "team has"). */
        solvedList: boolean;
        members: boolean;
    };
}

export const defaultBalloonSettings = (): BalloonSettings => ({
    enabled: false, afterFreeze: 'continue', colors: {},
    tickets: { enabled: false, rules: [], solvedList: true, members: false },
});

/** Names the colour picker offers; the nearest one names a colour Hydro set without a Chinese name. */
export const colorPresets: [string, string][] = [
    ['红', '#e53935'], ['橙', '#fb8c00'], ['黄', '#fdd835'], ['绿', '#43a047'], ['浅绿', '#9ccc65'], ['青', '#00acc1'],
    ['蓝', '#1e88e5'], ['浅蓝', '#81d4fa'], ['紫', '#8e24aa'], ['粉', '#f48fb1'], ['白', '#ffffff'], ['黑', '#212121'],
    ['灰', '#9e9e9e'], ['棕', '#6d4c41'], ['金', '#d4af37'], ['银', '#c0c0c0'],
];

const hexOf = (value: unknown) => {
    const match = typeof value === 'string' ? /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim()) : null;
    if (!match) return null;
    const hex = match[1].toLowerCase();
    return `#${hex.length === 3 ? hex.replace(/./g, '$&$&') : hex}`;
};

/** A Chinese name for a colour, by hue, saturation and lightness (what people call it, not the nearest swatch). */
export function nearestColorName(hex: string) {
    const [r, g, b] = [1, 3, 5].map((index) => parseInt(hex.slice(index, index + 2), 16) / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const lightness = (max + min) / 2;
    const chroma = max - min;
    const saturation = chroma === 0 ? 0 : chroma / (1 - Math.abs(2 * lightness - 1));
    if (lightness > 0.93) return '白';
    if (lightness < 0.18) return '黑';
    if (saturation < 0.15 || chroma < 0.08) return lightness > 0.7 ? '银' : '灰';
    let hue = max === r ? ((g - b) / chroma) % 6 : max === g ? (b - r) / chroma + 2 : (r - g) / chroma + 4;
    hue = (hue * 60 + 360) % 360;
    const reddish = hue < 45 || hue >= 330;
    if (reddish && (lightness < 0.3 || (lightness < 0.45 && saturation < 0.45))) return '棕';
    if ((hue >= 330 || hue < 15) && lightness > 0.72) return '粉';
    if (hue < 15 || hue >= 345) return '红';
    if (hue < 40) return '橙';
    if (hue < 56 && saturation < 0.75) return '金';
    if (hue < 68) return '黄';
    if (hue < 160) return lightness > 0.58 ? '浅绿' : '绿';
    if (hue < 195) return '青';
    if (hue < 255) return lightness > 0.68 ? '浅蓝' : '蓝';
    if (hue < 290) return '紫';
    return lightness > 0.6 ? '粉' : '紫';
}

/** A problem's colour as Hydro stores it (`{ color, name }`, or a bare string in older data). */
export function hydroColor(entry: unknown): BalloonColor | null {
    const raw = typeof entry === 'string' ? entry : (entry as { color?: unknown } | null | undefined)?.color;
    const hex = hexOf(raw);
    if (!hex) return null;
    const name = typeof entry === 'object' && entry ? String((entry as { name?: unknown }).name ?? '').trim() : '';
    // Hydro's colour names are often English (`red`); a Chinese one is kept.
    return { hex, name: /[一-鿿]/.test(name) ? name.slice(0, 12) : nearestColorName(hex) };
}

const list = (value: unknown) => (Array.isArray(value) ? value : typeof value === 'string' ? value.split(/[\s,，;；]+/) : []);

export function normalizeBalloonSettings(input: unknown, pids: number[], base = defaultBalloonSettings()): BalloonSettings {
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, any>;
    const settings: BalloonSettings = structuredClone(base);
    if (typeof raw.enabled === 'boolean') settings.enabled = raw.enabled;
    if (raw.afterFreeze !== undefined) {
        if (raw.afterFreeze !== 'continue' && raw.afterFreeze !== 'hold') throw new BalloonError('封榜后的发放方式无效');
        settings.afterFreeze = raw.afterFreeze;
    }
    const known = new Set(pids.map(String));
    if (raw.colors !== undefined) {
        if (!raw.colors || typeof raw.colors !== 'object' || Array.isArray(raw.colors)) throw new BalloonError('气球颜色格式无效');
        const colors: Record<string, BalloonColor> = {};
        for (const [pid, value] of Object.entries(raw.colors as Record<string, any>)) {
            if (!known.has(pid)) continue; // a problem removed from the contest
            const hex = hexOf(value?.hex);
            const name = String(value?.name ?? '').trim();
            // Both left empty: the problem has no colour of its own here.
            if (!hex && !name && !String(value?.hex ?? '').trim()) continue;
            if (!hex) throw new BalloonError(`第 ${pids.indexOf(Number(pid)) + 1} 题的颜色值无效`);
            if (name.length > 12) throw new BalloonError('颜色名称不能超过 12 个字符');
            colors[pid] = { hex, name: name || nearestColorName(hex) };
        }
        settings.colors = colors;
    }
    const tickets = raw.tickets && typeof raw.tickets === 'object' ? raw.tickets : null;
    if (tickets) {
        for (const key of ['enabled', 'solvedList', 'members'] as const) if (typeof tickets[key] === 'boolean') settings.tickets[key] = tickets[key];
        if (tickets.rules !== undefined) {
            if (!Array.isArray(tickets.rules) || tickets.rules.length > 30) throw new BalloonError('分配规则最多 30 条');
            const ids = new Set<string>();
            settings.tickets.rules = tickets.rules.map((rule: any, index: number): TicketRule => {
                const id = typeof rule?.id === 'string' && /^[\w-]{1,32}$/.test(rule.id) && !ids.has(rule.id) ? rule.id : `rule-${index + 1}`;
                ids.add(id);
                const name = String(rule?.name ?? '').trim() || `规则 ${index + 1}`;
                if (name.length > 40) throw new BalloonError('规则名称不能超过 40 个字符');
                const zones = [...new Set(list(rule?.zones).map((zone) => String(zone).trim()).filter(Boolean))];
                if (zones.length > 50 || zones.some((zone) => zone.length > 16)) throw new BalloonError(`规则“${name}”的考场前缀过多或过长`);
                const problems = [...new Set(list(rule?.problems).map(Number).filter((pid) => known.has(String(pid))))];
                const printers = (Array.isArray(rule?.printers) ? rule.printers : []).map((ref: any) => ({
                    server: String(ref?.server ?? ''), printer: String(ref?.printer ?? '').slice(0, 200),
                })).filter((ref: TicketPrinterRef) => /^[a-f\d]{24}$/i.test(ref.server) && ref.printer);
                if (printers.length > 20) throw new BalloonError(`规则“${name}”最多选择 20 台小票机`);
                if (!printers.length) throw new BalloonError(`规则“${name}”还没有选择小票机`);
                return { id, name, zones, problems, printers };
            });
        }
    }
    return settings;
}

/** The colour of each problem: the one set here, else Hydro's balloon colour, else none. */
export function problemColors(settings: BalloonSettings, pids: number[], hydro: Record<string, unknown> | undefined) {
    return pids.map((pid) => settings.colors[String(pid)] ?? hydroColor(hydro?.[pid]) ?? null);
}

// ---------------------------------------------------------------- Seats

/** The room of a seat as the screens group it: `A-01` and `A12` are in A, a bare number has none. */
export function zoneOf(seat: string) {
    const trimmed = seat.trim();
    return trimmed ? trimmed.replace(/[\s_-]*\d+$/, '') : '';
}

export const seatMatches = (seat: string, prefixes: string[]) => {
    const value = seat.trim().toLowerCase();
    return !!value && prefixes.some((prefix) => value.startsWith(prefix.toLowerCase()));
};

// ---------------------------------------------------------------- Balloons from journals

export interface JournalEntry {
    uid: number;
    journal?: { rid: unknown; pid: number; status: number }[] | null;
}

export interface DueBalloon {
    key: string;
    uid: number;
    pid: number;
    rid: string;
    submittedAt: number;
}

/** Seconds since the epoch are the first 4 bytes of an ObjectId. */
export const ridTime = (rid: unknown) => parseInt(String(rid).slice(0, 8), 16) * 1000;

export const balloonKey = (contest: string, uid: number, pid: number) => `${contest}/${uid}/${pid}`;

/**
 * The balloons a contest owes: every team's first accepted submission per problem made during the
 * contest (Hydro's ACM rule times submissions from the contest start, also in personal windows).
 * The journal is the current state after rejudges; a record appearing twice counts once.
 */
export function dueBalloons(contest: string, tdoc: { pids: number[]; beginAt: Date; endAt: Date }, entries: JournalEntry[]): DueBalloon[] {
    const begin = tdoc.beginAt.getTime();
    const end = tdoc.endAt.getTime();
    const pids = new Set(tdoc.pids);
    const due: DueBalloon[] = [];
    for (const entry of entries) {
        const records = [...new Map((entry.journal || []).map((record) => [String(record.rid), record])).values()]
            .map((record) => ({ ...record, rid: String(record.rid), time: ridTime(record.rid) }))
            .filter((record) => pids.has(record.pid) && record.time >= begin && record.time < end && /^[a-f\d]{24}$/i.test(record.rid))
            .sort((a, b) => a.time - b.time || a.rid.localeCompare(b.rid));
        const seen = new Set<number>();
        for (const record of records) {
            if (record.status !== STATUS_ACCEPTED || seen.has(record.pid)) continue;
            seen.add(record.pid);
            due.push({ key: balloonKey(contest, entry.uid, record.pid), uid: entry.uid, pid: record.pid, rid: record.rid, submittedAt: record.time });
        }
    }
    return due.sort((a, b) => a.submittedAt - b.submittedAt || a.rid.localeCompare(b.rid));
}

export type TicketStatus = 'none' | 'pending' | 'printing' | 'printed' | 'failed';

export interface TicketState {
    status: TicketStatus;
    server?: string;
    printer?: string;
    claimedAt?: number;
    printedAt?: number;
    attempts: number;
    error?: string;
    /** Times it came out of a printer. */
    prints: number;
}

export interface StoredBalloon {
    id: string;
    key: string;
    uid: number;
    pid: number;
    rid: string;
    submittedAt: number;
    /** 1, 2, 3 … per contest, in the order balloons appeared: what staff call out. */
    seq: number;
    /** revoked: a rejudge took the accept away. */
    state: 'active' | 'revoked';
    /** An accept after the freeze while the contest holds those balloons until the board is unlocked. */
    held: boolean;
    delivered: { at: number; by: string } | null;
    ticket: TicketState;
}

export interface ReconcileContext {
    now: number;
    lockAt: number | null;
    /** The board is frozen now (Hydro ContestModel.isLocked). */
    locked: boolean;
    hold: boolean;
    tickets: boolean;
    /** Keys Hydro's own balloon page marked as sent. */
    hydroSent: Set<string>;
}

export type NewBalloon = Omit<StoredBalloon, 'id' | 'seq'>;

/** What must change so the stored balloons match the contest: new ones, revoked and restored ones. */
export function reconcile(existing: StoredBalloon[], due: DueBalloon[], context: ReconcileContext) {
    const held = (submittedAt: number) => context.hold && context.lockAt !== null && submittedAt > context.lockAt && context.locked;
    const byKey = new Map(existing.map((balloon) => [balloon.key, balloon]));
    const dueKeys = new Set(due.map((balloon) => balloon.key));
    const inserts: NewBalloon[] = [];
    const updates: { id: string; set: Partial<StoredBalloon> }[] = [];
    for (const balloon of due) {
        const stored = byKey.get(balloon.key);
        const sent = context.hydroSent.has(balloon.key);
        if (!stored) {
            inserts.push({
                key: balloon.key, uid: balloon.uid, pid: balloon.pid, rid: balloon.rid, submittedAt: balloon.submittedAt,
                state: 'active', held: held(balloon.submittedAt),
                delivered: sent ? { at: context.now, by: 'Hydro 气球页' } : null,
                ticket: { status: context.tickets && !sent ? 'pending' : 'none', attempts: 0, prints: 0 },
            });
            continue;
        }
        const set: Partial<StoredBalloon> = {};
        if (stored.rid !== balloon.rid || stored.submittedAt !== balloon.submittedAt) Object.assign(set, { rid: balloon.rid, submittedAt: balloon.submittedAt });
        if (stored.state === 'revoked') {
            set.state = 'active';
            if (stored.ticket.status === 'none' && context.tickets && !stored.delivered) set.ticket = { ...stored.ticket, status: 'pending', attempts: 0 };
        }
        const isHeld = held(balloon.submittedAt);
        if (stored.held !== isHeld) set.held = isHeld;
        if (sent && !stored.delivered) {
            set.delivered = { at: context.now, by: 'Hydro 气球页' };
            if (stored.ticket.status === 'pending') set.ticket = { ...(set.ticket || stored.ticket), status: 'none' };
        }
        if (Object.keys(set).length) updates.push({ id: stored.id, set });
    }
    for (const stored of existing) {
        if (stored.state !== 'active' || dueKeys.has(stored.key)) continue;
        // A rejudge took the accept away: no ticket for it; a delivered one is shown for staff to fetch back.
        updates.push({ id: stored.id, set: { state: 'revoked', ...(stored.ticket.status === 'pending' ? { ticket: { ...stored.ticket, status: 'none' } } : {}) } });
    }
    return { inserts, updates };
}

/** The first accepted balloon of each problem among eligible teams (equal seconds share it). */
export function firstBalloons(balloons: Pick<StoredBalloon, 'uid' | 'pid' | 'submittedAt' | 'state' | 'key'>[], eligible: (uid: number) => boolean) {
    const earliest = new Map<number, number>();
    for (const balloon of balloons) {
        if (balloon.state !== 'active' || !eligible(balloon.uid)) continue;
        const second = Math.floor(balloon.submittedAt / 1000);
        if (!earliest.has(balloon.pid) || second < earliest.get(balloon.pid)!) earliest.set(balloon.pid, second);
    }
    return new Set(balloons.filter((balloon) => balloon.state === 'active' && eligible(balloon.uid)
        && Math.floor(balloon.submittedAt / 1000) === earliest.get(balloon.pid)).map((balloon) => balloon.key));
}

/** A ticket waits for a printer: an active balloon, not held, not yet delivered. */
export const ticketReady = (balloon: Pick<StoredBalloon, 'state' | 'held' | 'delivered' | 'ticket'>) =>
    balloon.state === 'active' && !balloon.held && !balloon.delivered && balloon.ticket.status === 'pending';

// ---------------------------------------------------------------- Receipt printers and routing

export interface ReceiptConfig {
    /** Paper width in millimetres. */
    width: 58 | 80;
    /** escpos: the printer's own commands (most thermal printers); driver: drawn through the system's driver. */
    mode: 'escpos' | 'driver';
    cut: boolean;
}

export const defaultReceiptConfig = (): ReceiptConfig => ({ width: 80, mode: 'escpos', cut: true });

export interface ReceiptPrinter extends TicketPrinterRef {
    serverName: string;
    /** Print server binding, for routing without a plan. */
    contests: string[];
    seatPrefixes: string[];
    /** Online, enabled here, working, on a client that prints receipts. */
    usable: boolean;
    config: ReceiptConfig;
}

const fnv = (text: string) => {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index++) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193) >>> 0;
    }
    return hash;
};

/**
 * The receipt printers a ticket may go to: the printers of the first rule that matches its seat and
 * problem (a rule whose printers are all down keeps its tickets waiting), else, with no matching
 * rule, the receipt printers of the print servers that take the seat for this contest (as for
 * printouts, lib/print.ts serverTakes).
 */
export function ticketTargets(balloon: { pid: number }, seat: string, contest: string, rules: TicketRule[], printers: ReceiptPrinter[]) {
    const usable = printers.filter((printer) => printer.usable);
    const rule = rules.find((candidate) => (!candidate.zones.length || seatMatches(seat, candidate.zones))
        && (!candidate.problems.length || candidate.problems.includes(balloon.pid)));
    if (rule) {
        return { rule: rule.name, printers: usable.filter((printer) => rule.printers.some((ref) => ref.server === printer.server && ref.printer === printer.printer)) };
    }
    const servers = [...new Map(usable.map((printer) => [printer.server, { id: printer.server, contests: printer.contests, seatPrefixes: printer.seatPrefixes }])).values()];
    const taking = new Set(servers.filter((server) => serverTakes(server, { contest, seat }, servers)).map((server) => server.id));
    return { rule: null, printers: usable.filter((printer) => taking.has(printer.server)) };
}

/** One of the targets, the same for a ticket every time (until the targets change), spread evenly. */
export function pickTarget(id: string, targets: ReceiptPrinter[]) {
    if (!targets.length) return null;
    const sorted = [...targets].sort((a, b) => a.server.localeCompare(b.server) || a.printer.localeCompare(b.printer));
    return sorted[fnv(id) % sorted.length];
}

// ---------------------------------------------------------------- Ticket content

export interface ReceiptLine {
    text: string;
    /** s small, m normal, l large (double), xl huge (triple). */
    size: 's' | 'm' | 'l' | 'xl';
    bold?: boolean;
    align?: 'left' | 'center';
    /** White on black (ESC/POS) or boxed (driver). */
    invert?: boolean;
    /** A separator line instead of text. */
    rule?: boolean;
}

export interface TicketInput {
    contest: string;
    seq: number;
    seat: string;
    label: string;
    problemTitle: string;
    color: BalloonColor | null;
    first: boolean;
    team: string;
    school: string;
    members: string[];
    unofficial: boolean;
    submittedAt: number;
    beginAt: number;
    /** Labels of the problems the team has balloons for, this one included. */
    solved: string[];
    printedAt: number;
    /** The how-manyth time this ticket is printed (1 the first). */
    copy: number;
}

const clock = (ms: number) => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    return `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
};
const wallTime = (ms: number) => new Date(ms).toLocaleTimeString('zh-CN', { hour12: false, timeZone: process.env.TZ || 'Asia/Shanghai' });

export function ticketLines(input: TicketInput, options: { solvedList: boolean; members: boolean }): ReceiptLine[] {
    const lines: (ReceiptLine | null)[] = [
        { text: input.contest, size: 's', align: 'center' },
        { text: `气球 #${input.seq}${input.copy > 1 ? `（补打 ${input.copy - 1}）` : ''}`, size: 'm', bold: true, align: 'center' },
        { text: '', size: 'm', rule: true },
        { text: input.seat ? `座位 ${input.seat}` : '座位未导入', size: 'xl', bold: true, align: 'center' },
        { text: `${input.label} 题 · ${input.color?.name || '未设颜色'}`, size: 'xl', bold: true, align: 'center' },
        input.first ? { text: '★ 本题一血 ★', size: 'l', bold: true, align: 'center', invert: true } : null,
        { text: '', size: 'm', rule: true },
        { text: `${input.team}${input.unofficial ? '（打星）' : ''}`, size: 'l', bold: true },
        input.school ? { text: input.school, size: 'm' } : null,
        options.members && input.members.length ? { text: `队员：${input.members.join('、')}`, size: 's' } : null,
        input.problemTitle ? { text: `题目：${input.label}. ${input.problemTitle}`, size: 's' } : null,
        { text: `通过：比赛时间 ${clock(input.submittedAt - input.beginAt)}（${wallTime(input.submittedAt)}）`, size: 's' },
        options.solvedList && input.solved.length ? { text: `该队已通过：${input.solved.join(' ')}`, size: 's' } : null,
        { text: '', size: 'm', rule: true },
        { text: `打印 ${wallTime(input.printedAt)} · 送达后请在气球页面标记`, size: 's', align: 'center' },
    ];
    return lines.filter((line): line is ReceiptLine => !!line);
}

export function testTicketLines(serverName: string, printer: string, config: ReceiptConfig): ReceiptLine[] {
    return [
        { text: 'Hydro 气球小票 · 测试', size: 'm', bold: true, align: 'center' },
        { text: '', size: 'm', rule: true },
        { text: '座位 A-01', size: 'xl', bold: true, align: 'center' },
        { text: 'B 题 · 红', size: 'xl', bold: true, align: 'center' },
        { text: '★ 本题一血 ★', size: 'l', bold: true, align: 'center', invert: true },
        { text: '', size: 'm', rule: true },
        { text: '测试队伍 Test Team', size: 'l', bold: true },
        { text: `打印服务器：${serverName}`, size: 's' },
        { text: `小票机：${printer}`, size: 's' },
        { text: `${config.width} mm · ${config.mode === 'escpos' ? 'ESC/POS 指令' : '系统驱动'}${config.cut ? ' · 自动切纸' : ''}`, size: 's' },
        { text: '中文、English、0123456789 应清晰完整', size: 's', align: 'center' },
    ];
}
