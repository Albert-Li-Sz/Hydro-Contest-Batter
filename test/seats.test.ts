import { describe, expect, it } from 'vitest';
import { ContestLinks } from '../lib/links';
import {
    backupFile, backupOf, BACKUP_FORMAT, buildSeatRows, clearPlan, duplicateSeats, normalizeBackup, normalizeClearOptions, normalizeIpList,
    normalizeSeatEdit, normalizeSeatQuery, parseSeatImport, seatCoverage, seatImportData, type SeatAccount, scopeLabel, selectSeatRows,
} from '../lib/manage/seats';
import { normalizeIp, seatText } from '../lib/onsite';

const user = (uid: number, seat: string, extra: Partial<SeatAccount> = {}): SeatAccount => ({ uid, kind: 'user', uname: `u${uid}`, name: `选手 ${uid}`, seat, ...extra });

describe('onsite-toolkit storage', () => {
    it('normalizes addresses the way its IP login does', () => {
        expect(normalizeIp(' ::ffff:10.0.0.5 ')).toBe('10.0.0.5');
        expect(normalizeIp('fe80::1')).toBe('fe80::1');
        expect(seatText(' A-1 ')).toBe('A-1');
        expect(seatText(12)).toBe('12');
        expect(seatText(null)).toBe('');
    });
});

describe('seat rows', () => {
    const accounts: SeatAccount[] = [
        user(10, 'A-10'), user(11, 'A-2'), user(12, 'B-1'), user(13, ''), user(14, 'B-1'),
        // Teammates on one seat, and their team, are no conflict.
        user(20, 'C-1', { group: -1, team: '星火' }), user(21, 'C-1', { group: -1, team: '星火' }),
        { uid: -1, kind: 'team', uname: 'team:20:x', name: '星火', seat: 'C-1' },
    ];
    const ipDocs = [{ _id: '10.0.0.11', uid: 11 }, { _id: '10.0.0.2', uid: 11 }, { _id: '10.0.0.10', uid: 10 }, { _id: '10.9.9.9', uid: 999 }];

    it('flags seats held by different accounts of one kind only', () => {
        expect([...duplicateSeats(accounts)]).toEqual(['user\nB-1']);
    });

    it('orders seats naturally, keeps rows without one last and lists orphaned addresses', () => {
        const rows = buildSeatRows(accounts, ipDocs, true);
        expect(rows.map((row) => row.seat || `#${row.uid}`)).toEqual(['A-2', 'A-10', 'B-1', 'B-1', 'C-1', 'C-1', 'C-1', '#13', '#999']);
        expect(rows.find((row) => row.uid === 11)!.ips).toEqual(['10.0.0.2', '10.0.0.11']);
        expect(rows.filter((row) => row.duplicate).map((row) => row.uid)).toEqual([12, 14]);
        expect(rows.at(-1)).toMatchObject({ uid: 999, missing: true, ips: ['10.9.9.9'] });
        // A contest's list has no orphans.
        expect(buildSeatRows(accounts, ipDocs, false).some((row) => row.missing)).toBe(false);
    });

    it('selects by room, filter and search, with counts for each filter', () => {
        const rows = buildSeatRows(accounts, ipDocs, true);
        const all = selectSeatRows(rows, normalizeSeatQuery({}));
        expect(all.counts).toEqual({ all: 9, duplicate: 2, noSeat: 1, noIp: 5, orphan: 1 });
        expect(all.zones).toEqual([{ zone: 'A', count: 2 }, { zone: 'B', count: 2 }, { zone: 'C', count: 3 }, { zone: '', count: 1 }]);
        expect(selectSeatRows(rows, { zone: 'B', filter: 'all' }).rows.map((row) => row.uid)).toEqual([12, 14]);
        expect(selectSeatRows(rows, { zone: '-', filter: 'all' }).rows.map((row) => row.uid)).toEqual([13]);
        expect(selectSeatRows(rows, { filter: 'duplicate' }).rows).toHaveLength(2);
        expect(selectSeatRows(rows, { q: '10.0.0.2' }).rows.map((row) => row.uid)).toEqual([11]);
        expect(selectSeatRows(rows, { zone: 'A', filter: 'noIp' }).counts.all).toBe(2);
        expect(normalizeSeatQuery({ filter: 'bogus', q: '  x ' })).toEqual({ zone: '', filter: 'all', q: 'x' });
    });
});

describe('seat edits', () => {
    it('checks the seat and addresses', () => {
        expect(normalizeSeatEdit({ uid: 5, seat: ' A-1 ', ips: '10.0.0.1, ::ffff:10.0.0.2\n10.0.0.1' })).toEqual({ uid: 5, kind: 'user', seat: 'A-1', ips: ['10.0.0.1', '10.0.0.2'] });
        // A team's virtual user cannot sign in, so it gets no IP login.
        expect(normalizeSeatEdit({ uid: -3, seat: 'C-1', ips: ['10.0.0.1'] })).toEqual({ uid: -3, kind: 'team', seat: 'C-1', ips: [] });
        expect(() => normalizeIpList('10.0.0.300')).toThrow('格式无效');
        expect(() => normalizeSeatEdit({ uid: 0 })).toThrow('账号编号无效');
        expect(() => normalizeSeatEdit({ uid: 5, seat: 'x'.repeat(65) })).toThrow('64');
    });
});

describe('backup, cleanup and restore', () => {
    const rows = buildSeatRows([user(10, 'A-1'), user(11, ''), user(1, 'Z-1', { keepSessions: true }), user(12, 'A-2', { keepSessions: true }), <SeatAccount>
        { uid: -1, kind: 'team', uname: 't', name: 'T', seat: 'C-1' }], [{ _id: '10.0.0.1', uid: 10 }, { _id: '10.0.0.3', uid: 11 }, { _id: '10.9.9.9', uid: 77 }], true);

    it('backs up what the rows hold and reads it back', () => {
        const data = backupOf(rows);
        expect(data.seats).toEqual([{ uid: 10, kind: 'user', seat: 'A-1' }, { uid: 12, kind: 'user', seat: 'A-2' }, { uid: -1, kind: 'team', seat: 'C-1' }, { uid: 1, kind: 'user', seat: 'Z-1' }]);
        expect(data.ips).toHaveLength(3);
        const file = JSON.parse(JSON.stringify(backupFile(data, { createdAt: new Date(0), label: '全站' })));
        expect(file.format).toBe(BACKUP_FORMAT);
        expect(normalizeBackup(file)).toEqual(data);
        expect(() => normalizeBackup({ format: 'other', seats: [], ips: [] })).toThrow('不是座位');
        expect(() => normalizeBackup({ seats: [{ uid: 1, seat: '' }], ips: [] })).toThrow('座位记录无效');
        expect(() => normalizeBackup({ seats: [], ips: [{ uid: 1, ip: 'nope' }] })).toThrow('IP 登录记录无效');
    });

    it('clears only what was chosen and keeps protected sessions', () => {
        expect(() => normalizeClearOptions({})).toThrow('请选择');
        const plan = clearPlan(rows, { seats: true, ips: true, sessions: true }, 12);
        expect(plan.userSeats.sort()).toEqual([1, 10, 12]);
        expect(plan.teamSeats).toEqual([-1]);
        expect(plan.ips.sort()).toEqual(['10.0.0.1', '10.0.0.3', '10.9.9.9']);
        // Not the built-in account, the operator, or a missing one.
        expect(plan.sessions.sort()).toEqual([10, 11]);
        expect(clearPlan(rows, { seats: false, ips: true, sessions: false }, 0)).toMatchObject({ userSeats: [], teamSeats: [], sessions: [] });
    });

    it('names a selection', () => {
        expect(scopeLabel({ contest: { domainId: 'system', tid: 'x', title: '校赛' }, zone: 'A', filter: 'duplicate', q: '' })).toBe('校赛 · 考场 A · 重复座位');
        expect(scopeLabel({ zone: '-', q: 'p1' })).toBe('全站 · 无考场前缀 · “p1”');
    });
});

describe('contest links', () => {
    it('reports and revokes every registered kind, one failure apart', async () => {
        const links = new ContestLinks();
        let token = 'old';
        links.add({ id: 'screens', label: '大屏', status: async () => ({ count: 1, issuedAt: null }), revoke: async () => { token = 'new'; return 1; } });
        links.add({ id: 'capture', label: '画面采集设备', status: async () => { throw new Error('down'); }, revoke: async () => { throw new Error('down'); } });
        const tdoc = { domainId: 'system', docId: 'x' };
        expect(await links.status(tdoc)).toEqual([
            { id: 'screens', label: '大屏', count: 1, issuedAt: null },
            { id: 'capture', label: '画面采集设备', count: 0, issuedAt: null },
        ]);
        const result = await links.revoke(tdoc);
        expect(token).toBe('new');
        expect(result).toEqual([
            { id: 'screens', label: '大屏', count: 1, error: null },
            { id: 'capture', label: '画面采集设备', count: 0, error: 'down' },
        ]);
        expect(await links.revoke(tdoc, ['capture'])).toHaveLength(1);
    });
});

describe('venue spreadsheet and team coverage', () => {
    it('validates an entire tab-separated batch, rejects ambiguous assignments and enforces the selected roster', () => {
        const items = parseSeatImport('ip', '\uFEFFteam01\t::ffff:10.0.0.1\r\nteam02\t10.0.0.2');
        expect(seatImportData('ip', items, [10, 11], new Set([10, 11])).ips).toEqual([{ ip: '10.0.0.1', uid: 10 }, { ip: '10.0.0.2', uid: 11 }]);
        expect(() => parseSeatImport('ip', 'x\t10.0.0.1\ny\tbad')).toThrow('第 2 行');
        expect(() => seatImportData('ip', [items[0], items[0]], [10, 11])).toThrow('多个账号');
        expect(() => seatImportData('ip', items, [-10, 11])).toThrow('虚拟队伍');
        expect(() => seatImportData('ip', items, [10, 11], new Set([10]))).toThrow('范围');
        expect(seatImportData('seat', parseSeatImport('seat', '1001\tA-01'), [-10])).toEqual({ seats: [{ uid: -10, kind: 'team', seat: 'A-01' }], ips: [] });
        const empty = { seats: [], ips: [], emptySeats: [10], freeIps: ['10.0.0.1'] };
        expect(normalizeBackup(backupFile(empty, { createdAt: new Date(), label: '导入前' }))).toEqual(empty);
    });
    it('counts each official entry once and keeps unassigned IP records distinct', () => {
        const rows = buildSeatRows([user(-10, 'A-1', { kind: 'team', name: '星火' }), user(11, 'A-1', { group: -10, school: '大学' }), user(12, '', { group: -10 }), user(20, '')],
            [{ _id: '10.0.0.2', uid: 12 }], false);
        const result = seatCoverage(rows, [{ ip: '10.0.0.3', uid: 500 }]);
        expect(result.bound).toBe(1); expect(result.teams).toHaveLength(2);
        expect(result.teams[0]).toMatchObject({ name: '星火', school: '大学', seat: 'A-1', ips: ['10.0.0.2'], accounts: ['u11', 'u12'] });
        expect(result.unmatched).toHaveLength(1);
    });
});
