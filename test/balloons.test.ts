import { describe, expect, it } from 'vitest';
import {
    balloonKey, dueBalloons, firstBalloons, hydroColor, nearestColorName, normalizeBalloonSettings, pickTarget, problemColors, reconcile,
    STATUS_ACCEPTED, ticketLines, ticketReady, ticketTargets, zoneOf, type ReceiptPrinter, type StoredBalloon,
} from '../lib/balloons';
import { encodeGbk, escposTicket, receiptJob, wrapColumns } from '../lib/escpos';
import { formatClock, setTimeZone, zoneLabel } from '../lib/time-zone';
import { normalizePrinterPreference } from '../lib/print';

const begin = new Date('2026-11-23T01:00:00Z');
const end = new Date(begin.getTime() + 5 * 3600_000);
const lock = new Date(begin.getTime() + 4 * 3600_000);
const contest = 'system/6740a0000000000000000001';
/** An ObjectId whose timestamp is `minutes` into the contest. */
const rid = (minutes: number, n = 0) => `${Math.floor((begin.getTime() + minutes * 60_000) / 1000).toString(16)}${String(n).padStart(16, '0')}`;
const WA = 2;
const tdoc = { pids: [1001, 1002, 1003], beginAt: begin, endAt: end };

function stored(due: ReturnType<typeof dueBalloons>, extra: Partial<StoredBalloon> = {}): StoredBalloon[] {
    return due.map((balloon, index) => ({
        ...balloon, id: `id-${index}`, seq: index + 1, state: 'active', held: false, delivered: null,
        ticket: { status: 'pending', attempts: 0, prints: 0 }, ...extra,
    }));
}

describe('balloons from journals', () => {
    it('owes one balloon per team and problem, from the first accept in the contest', () => {
        const due = dueBalloons(contest, tdoc, [
            { uid: 1, journal: [
                { rid: rid(10), pid: 1001, status: WA }, { rid: rid(20), pid: 1001, status: STATUS_ACCEPTED },
                { rid: rid(30), pid: 1001, status: STATUS_ACCEPTED }, { rid: rid(25), pid: 1002, status: STATUS_ACCEPTED },
                // Before the start, after the end, a problem not in the contest: none.
                { rid: rid(-5), pid: 1003, status: STATUS_ACCEPTED }, { rid: rid(301), pid: 1003, status: STATUS_ACCEPTED },
                { rid: rid(40), pid: 9999, status: STATUS_ACCEPTED },
            ] },
            // The same record twice (a rejudge rewrites the journal entry) counts once.
            { uid: 2, journal: [{ rid: rid(15, 1), pid: 1001, status: STATUS_ACCEPTED }, { rid: rid(15, 1), pid: 1001, status: STATUS_ACCEPTED }] },
            { uid: 3, journal: null },
        ]);
        expect(due.map((balloon) => [balloon.uid, balloon.pid, balloon.rid])).toEqual([[2, 1001, rid(15, 1)], [1, 1001, rid(20)], [1, 1002, rid(25)]]);
        expect(due[0].key).toBe(balloonKey(contest, 2, 1001));
    });

    it('adds new balloons, revokes those a rejudge took away and restores them', () => {
        const first = dueBalloons(contest, tdoc, [{ uid: 1, journal: [{ rid: rid(20), pid: 1001, status: STATUS_ACCEPTED }] }]);
        const context = { now: Date.now(), lockAt: lock.getTime(), locked: false, hold: false, tickets: true, hydroSent: new Set<string>() };
        const added = reconcile([], first, context);
        expect(added.inserts).toHaveLength(1);
        expect(added.inserts[0]).toMatchObject({ state: 'active', held: false, delivered: null, ticket: { status: 'pending' } });
        expect(reconcile([], first, { ...context, tickets: false }).inserts[0].ticket.status).toBe('none');
        const existing = stored(first);
        // Rejudged to WA: revoked, and its waiting ticket is not printed.
        const revoked = reconcile(existing, [], context);
        expect(revoked.updates).toEqual([{ id: 'id-0', set: { state: 'revoked', ticket: { status: 'none', attempts: 0, prints: 0 } } }]);
        const back = reconcile([{ ...existing[0], state: 'revoked', ticket: { status: 'none', attempts: 0, prints: 0 } }], first, context);
        expect(back.updates[0].set).toMatchObject({ state: 'active', ticket: { status: 'pending' } });
        // An earlier accept found by a rejudge moves the balloon's time; nothing else changes.
        const earlier = dueBalloons(contest, tdoc, [{ uid: 1, journal: [{ rid: rid(12), pid: 1001, status: STATUS_ACCEPTED }] }]);
        expect(reconcile(existing, earlier, context).updates).toEqual([{ id: 'id-0', set: { rid: rid(12), submittedAt: earlier[0].submittedAt } }]);
        expect(reconcile(existing, first, context)).toEqual({ inserts: [], updates: [] });
    });

    it('holds accepts after the freeze while the board is frozen, when the contest says so', () => {
        const due = dueBalloons(contest, tdoc, [{ uid: 1, journal: [{ rid: rid(250), pid: 1001, status: STATUS_ACCEPTED }, { rid: rid(100), pid: 1002, status: STATUS_ACCEPTED }] }]);
        const context = { now: Date.now(), lockAt: lock.getTime(), locked: true, hold: true, tickets: true, hydroSent: new Set<string>() };
        const { inserts } = reconcile([], due, context);
        expect(inserts.map((balloon) => [balloon.pid, balloon.held])).toEqual([[1002, false], [1001, true]]);
        expect(reconcile([], due, { ...context, hold: false }).inserts.every((balloon) => !balloon.held)).toBe(true);
        // Unlocked: released, and the ticket that waited prints.
        const held = stored(due).map((balloon) => ({ ...balloon, held: balloon.pid === 1001 }));
        expect(reconcile(held, due, { ...context, locked: false }).updates).toEqual([{ id: held[1].id, set: { held: false } }]);
        expect(ticketReady(held[1])).toBe(false);
        expect(ticketReady({ ...held[1], held: false })).toBe(true);
    });

    it('takes deliveries marked on Hydro’s own balloon page', () => {
        const due = dueBalloons(contest, tdoc, [{ uid: 1, journal: [{ rid: rid(20), pid: 1001, status: STATUS_ACCEPTED }] }]);
        const context = { now: 5, lockAt: null, locked: false, hold: false, tickets: true, hydroSent: new Set([balloonKey(contest, 1, 1001)]) };
        expect(reconcile([], due, context).inserts[0]).toMatchObject({ delivered: { at: 5, by: 'Hydro 气球页' }, ticket: { status: 'none' } });
        expect(reconcile(stored(due), due, context).updates[0].set).toMatchObject({ delivered: { at: 5 }, ticket: { status: 'none' } });
    });

    it('marks the first balloon of each problem among eligible teams, ties included', () => {
        const balloons = [
            { key: 'a', uid: 1, pid: 1, submittedAt: 60_500, state: 'active' as const },
            { key: 'b', uid: 2, pid: 1, submittedAt: 60_900, state: 'active' as const },
            { key: 'c', uid: 3, pid: 1, submittedAt: 30_000, state: 'active' as const },
            { key: 'd', uid: 4, pid: 1, submittedAt: 10_000, state: 'revoked' as const },
        ];
        // Team 3 is starred and not eligible: teams 1 and 2 accepted in the same second.
        expect([...firstBalloons(balloons, (uid) => uid !== 3)].sort()).toEqual(['a', 'b']);
        expect([...firstBalloons(balloons, () => true)]).toEqual(['c']);
    });
});

describe('balloon settings', () => {
    it('keeps colours of the contest’s problems and checks the plan', () => {
        const settings = normalizeBalloonSettings({
            enabled: true, afterFreeze: 'hold',
            colors: { 1001: { hex: '#F00', name: '大红' }, 1002: { hex: '#0000ff', name: '' }, 4242: { hex: '#000000', name: '黑' } },
            tickets: { enabled: true, rules: [{ name: 'A 区', zones: 'A, B', problems: [1001, 7], printers: [{ server: '6742b0000000000000000001', printer: 'XP-80' }] }] },
        }, tdoc.pids);
        expect(settings.colors).toEqual({ 1001: { hex: '#ff0000', name: '大红' }, 1002: { hex: '#0000ff', name: '蓝' } });
        expect(settings.tickets.rules[0]).toMatchObject({ name: 'A 区', zones: ['A', 'B'], problems: [1001] });
        expect(() => normalizeBalloonSettings({ tickets: { rules: [{ name: 'x', printers: [] }] } }, tdoc.pids)).toThrow('还没有选择小票机');
        expect(() => normalizeBalloonSettings({ afterFreeze: 'later' }, tdoc.pids)).toThrow();
        expect(() => normalizeBalloonSettings({ colors: { 1001: { hex: 'red' } } }, tdoc.pids)).toThrow('颜色值无效');
    });

    it('names Hydro’s colours in Chinese and prefers the ones set here', () => {
        expect(hydroColor({ color: '#e53935', name: 'red' })).toEqual({ hex: '#e53935', name: '红' });
        expect(hydroColor({ color: '#00f', name: '宝蓝' })).toEqual({ hex: '#0000ff', name: '宝蓝' });
        // The manager's English name wins over the hue: brown is not called red, gold not yellow.
        expect(hydroColor({ color: '#a52a2a', name: 'Brown' })?.name).toBe('棕');
        expect(hydroColor({ color: '#ffd700', name: 'gold' })?.name).toBe('金');
        expect(hydroColor({ color: '#87ceeb', name: 'Sky Blue' })?.name).toBe('天蓝');
        expect(hydroColor({ color: '#ff8800', name: 'Team Orange' })?.name).toBe('Team Orange');
        expect(hydroColor({ color: '#a52a2a', name: '' })?.name).toBe(nearestColorName('#a52a2a'));
        expect(hydroColor('nope')).toBeNull();
        expect(nearestColorName('#fffffe')).toBe('白');
        const settings = normalizeBalloonSettings({ colors: { 1002: { hex: '#ffd700', name: '金' } } }, tdoc.pids);
        expect(problemColors(settings, tdoc.pids, { 1001: { color: '#43a047' } })).toEqual([{ hex: '#43a047', name: '绿' }, { hex: '#ffd700', name: '金' }, null]);
    });

    it('stores a printer’s type and receipt paper', () => {
        expect(normalizePrinterPreference({ enabled: true, weight: 2 })).toEqual({ enabled: true, weight: 2, kind: 'document', receipt: { width: 80, mode: 'escpos', cut: true } });
        expect(normalizePrinterPreference({ kind: 'receipt', receipt: { width: 58, mode: 'driver', cut: false } }))
            .toMatchObject({ kind: 'receipt', receipt: { width: 58, mode: 'driver', cut: false } });
        expect(() => normalizePrinterPreference({ kind: 'receipt', receipt: { width: 76 } })).toThrow('58 或 80');
    });
});

describe('ticket routing', () => {
    const printer = (server: string, name: string, seatPrefixes: string[], usable = true): ReceiptPrinter => ({
        server, serverName: server, printer: name, contests: [], seatPrefixes, usable, config: { width: 80, mode: 'escpos', cut: true },
    });
    const north = printer('6742b0000000000000000001', 'North', ['A']);
    const south = printer('6742b0000000000000000002', 'South', ['B']);
    const spare = printer('6742b0000000000000000003', 'Spare', []);

    it('without a plan follows the print servers’ seat ranges', () => {
        expect(ticketTargets({ pid: 1 }, 'A-01', contest, [], [north, south, spare]).printers).toEqual([north]);
        expect(ticketTargets({ pid: 1 }, 'B-12', contest, [], [north, south, spare]).printers).toEqual([south]);
        // Seats no range claims go to the server without a range; with none, to any.
        expect(ticketTargets({ pid: 1 }, 'C-03', contest, [], [north, south, spare]).printers).toEqual([spare]);
        expect(ticketTargets({ pid: 1 }, '', contest, [], [north, south]).printers).toEqual([north, south]);
        // A printer that is down takes nothing; its seats fall to the catch-all server.
        expect(ticketTargets({ pid: 1 }, 'A-01', contest, [], [{ ...north, usable: false }, spare]).printers).toEqual([spare]);
    });

    it('uses the first rule matching the seat and the problem', () => {
        const rules = [
            { id: 'r1', name: 'B 区气球', zones: ['B'], problems: [7], printers: [{ server: north.server, printer: 'North' }] },
            { id: 'r2', name: 'B 区', zones: ['b'], problems: [], printers: [{ server: south.server, printer: 'South' }, { server: spare.server, printer: 'Spare' }] },
        ];
        expect(ticketTargets({ pid: 7 }, 'B-01', contest, rules, [north, south, spare])).toEqual({ rule: 'B 区气球', printers: [north] });
        expect(ticketTargets({ pid: 8 }, 'B-01', contest, rules, [north, south, spare])).toEqual({ rule: 'B 区', printers: [south, spare] });
        // A rule whose printers are all down keeps its tickets waiting.
        expect(ticketTargets({ pid: 7 }, 'B-01', contest, rules, [{ ...north, usable: false }, south])).toEqual({ rule: 'B 区气球', printers: [] });
        expect(ticketTargets({ pid: 7 }, 'A-01', contest, rules, [north, south]).rule).toBeNull();
    });

    it('spreads tickets over a rule’s printers, the same printer for a ticket every time', () => {
        const picks = Array.from({ length: 200 }, (_, index) => pickTarget(`ticket-${index}`, [south, spare])!.printer);
        expect(new Set(picks)).toEqual(new Set(['South', 'Spare']));
        expect(picks.filter((name) => name === 'South').length).toBeGreaterThan(60);
        expect(pickTarget('ticket-1', [spare, south])).toEqual(pickTarget('ticket-1', [south, spare]));
        expect(pickTarget('x', [])).toBeNull();
        expect(zoneOf('A-012')).toBe('A');
        expect(zoneOf('305 12')).toBe('305');
        expect(zoneOf('12')).toBe('');
    });
});

describe('tickets', () => {
    const input = {
        contest: '2026 校赛', seq: 12, seat: 'A-12', label: 'C', problemTitle: '括号序列', color: { hex: '#81d4fa', name: '浅蓝' }, first: true,
        team: '星火队', school: '南京晓庄学院', members: ['林澈', '周宁'], unofficial: false,
        submittedAt: begin.getTime() + 83 * 60_000 + 5000, beginAt: begin.getTime(), solved: ['A', 'C'], printedAt: Date.now(), copy: 1,
    };

    it('reads seat, problem and colour large, then the team', () => {
        const lines = ticketLines(input, { solvedList: true, members: true });
        const texts = lines.map((line) => line.text);
        expect(lines.find((line) => line.text === '座位 A-12')).toMatchObject({ size: 'xl', bold: true, align: 'center' });
        expect(texts).toContain('C 题 · 浅蓝');
        expect(lines.find((line) => line.text.includes('一血'))).toMatchObject({ invert: true });
        expect(texts).toContain('该队已通过：A C');
        expect(texts).toContain('队员：林澈、周宁');
        expect(texts.some((text) => text.includes('比赛时间 1:23:05'))).toBe(true);
        const plain = ticketLines({ ...input, first: false, seat: '', copy: 2 }, { solvedList: false, members: false }).map((line) => line.text);
        expect(plain).toContain('座位未导入');
        expect(plain).toContain('气球 #12（补打 1）');
        expect(plain.some((text) => text.includes('一血') || text.includes('已通过') || text.includes('队员'))).toBe(false);
    });

    it('encodes ESC/POS in GBK with sizes, inversion and a cut', () => {
        expect(encodeGbk('气球A')).toEqual([0xc6, 0xf8, 0xc7, 0xf2, 0x41]);
        expect(encodeGbk('😀')).toEqual([0x3f]);
        expect(wrapColumns('座位A-12座位', 6)).toEqual(['座位A-', '12座位']);
        const lines = ticketLines(input, { solvedList: true, members: false });
        const bytes = [...escposTicket(lines, { width: 80, cut: true })];
        const has = (sequence: number[]) => bytes.some((_, index) => sequence.every((value, offset) => bytes[index + offset] === value));
        expect(bytes.slice(0, 4)).toEqual([0x1b, 0x40, 0x1c, 0x26]);
        expect(has([0x1d, 0x21, 0x22])).toBe(true); // triple size for the seat
        expect(has([0x1d, 0x42, 1])).toBe(true); // white on black for 一血
        expect(has(encodeGbk('座位 A-12'))).toBe(true);
        expect(bytes.slice(-4)).toEqual([0x1d, 0x56, 66, 0]);
        expect([...escposTicket(lines, { width: 58, cut: false })].slice(-4)).not.toEqual([0x1d, 0x56, 66, 0]);
        // A 58 mm rule is 32 columns.
        expect(has([...Array(32).fill(0x2d), 0x0a])).toBe(true);
    });

    it('sends the bytes only to ESC/POS printers', () => {
        const lines = ticketLines(input, { solvedList: true, members: false });
        const raw = receiptJob('balloon-1', '气球 #12', 'XP-80', lines, { width: 80, mode: 'escpos', cut: true });
        expect(raw).toMatchObject({ kind: 'receipt', printer: 'XP-80', receipt: { width: 80, mode: 'escpos' } });
        expect(Buffer.from(raw.receipt.raw!, 'base64').subarray(0, 2)).toEqual(Buffer.from([0x1b, 0x40]));
        expect(receiptJob('balloon-1', '气球 #12', 'Driver', lines, { width: 58, mode: 'driver', cut: true }).receipt.raw).toBeUndefined();
    });
});

it('uses venue time for receipt walls and observes DST in labelled notices', () => {
    const when = new Date('2026-11-23T01:00:00Z');
    try {
        expect(setTimeZone('America/New_York')).toBe(true);
        expect(formatClock(when)).toBe('20:00');
        expect(zoneLabel(when)).toBe('UTC-5');
        expect(zoneLabel('2026-07-01T01:00:00Z')).toBe('UTC-4');
        const lines = ticketLines({ contest: '校赛', seq: 1, seat: 'A-1', label: 'A', problemTitle: '', color: null, first: false, team: 'T', school: '', members: [],
            unofficial: false, submittedAt: +when, beginAt: +when - 1000, solved: [], printedAt: +when, copy: 1 }, { solvedList: false, members: false });
        expect(lines.some(line => line.text.includes('0:00:01（20:00:00）'))).toBe(true);
        expect(setTimeZone('bad/unknown')).toBe(false);
        expect(zoneLabel(when)).toBe('UTC+8');
    } finally { setTimeZone(undefined); }
});
