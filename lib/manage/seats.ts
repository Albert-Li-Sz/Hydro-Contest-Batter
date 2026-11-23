/**
 * Seats and IP login (onsite-toolkit, lib/onsite.ts) on the /manage user configuration page: the
 * list of one contest's participants or of the whole site, duplicate seats, backups, cleanup and
 * restore. Pure functions; lib/manage-routes.ts reads and writes Hydro's collections.
 */
import { zoneOf } from '../balloons';
import { normalizeIp, validIp } from '../onsite';
import { ManageError } from './users';

export const SEAT_LIMIT = 5000;
export const BACKUP_FORMAT = 'hydro-xcpcio-seats';
export const BACKUPS_KEPT = 50;
const MAX_IPS = 16;

export type SeatKind = 'user' | 'team';
export type SeatFilter = 'all' | 'duplicate' | 'noSeat' | 'noIp' | 'orphan';
export const seatFilters: SeatFilter[] = ['all', 'duplicate', 'noSeat', 'noIp', 'orphan'];

export interface SeatAccount {
    uid: number;
    kind: SeatKind;
    uname: string;
    /** Display name in the domain, or the team name. */
    name: string;
    seat: string;
    loginat?: Date | null;
    loginip?: string;
    /** The team a member plays for, in a team contest. */
    team?: string;
    /** The team's uid for its members: teammates may share a seat. */
    group?: number;
    /** Built-in and super administrator accounts keep their sessions. */
    keepSessions?: boolean;
}

export interface SeatRow extends SeatAccount {
    zone: string;
    ips: string[];
    duplicate: boolean;
    /** An IP login entry whose account no longer exists. */
    missing: boolean;
}

export interface SeatQuery {
    zone?: string;
    filter?: SeatFilter;
    q?: string;
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

/** Seats in reading order (A-2 before A-10); rows without one go last. */
export function compareSeatRows(a: SeatRow, b: SeatRow) {
    if (!a.seat !== !b.seat) return a.seat ? -1 : 1;
    return collator.compare(a.seat, b.seat) || Number(a.missing) - Number(b.missing) || a.uid - b.uid;
}

export const seatKey = (kind: SeatKind, seat: string) => `${kind}\n${seat}`;

/**
 * Seats held by more than one account of the same kind. A team and its members may share one, and
 * so may the members of one team.
 */
export function duplicateSeats(accounts: Pick<SeatAccount, 'uid' | 'kind' | 'seat' | 'group'>[]) {
    const holders = new Map<string, Set<number>>();
    for (const account of accounts) {
        if (!account.seat) continue;
        const key = seatKey(account.kind, account.seat);
        holders.set(key, (holders.get(key) || new Set()).add(account.group ?? account.uid));
    }
    return new Set([...holders].filter(([, groups]) => groups.size > 1).map(([key]) => key));
}

/**
 * One row per account, with its IP login entries; entries of accounts that are gone become rows of
 * their own when `orphans` is set (the site-wide list). Duplicates are found among these accounts.
 */
export function buildSeatRows(accounts: SeatAccount[], ipDocs: { _id: string; uid: number }[], orphans: boolean): SeatRow[] {
    const duplicates = duplicateSeats(accounts);
    const ips = new Map<number, string[]>();
    for (const doc of ipDocs) ips.set(doc.uid, [...ips.get(doc.uid) || [], doc._id]);
    const seen = new Set<number>();
    const rows: SeatRow[] = [];
    for (const account of accounts) {
        if (seen.has(account.uid)) continue;
        seen.add(account.uid);
        rows.push({
            ...account, zone: zoneOf(account.seat), ips: (ips.get(account.uid) || []).sort(collator.compare),
            duplicate: !!account.seat && duplicates.has(seatKey(account.kind, account.seat)), missing: false,
        });
    }
    if (orphans) {
        for (const [uid, list] of ips) {
            if (seen.has(uid)) continue;
            rows.push({ uid, kind: 'user', uname: '', name: '', seat: '', zone: '', ips: list.sort(collator.compare), duplicate: false, missing: true });
        }
    }
    return rows.sort(compareSeatRows);
}

const matches = (row: SeatRow, q: string) => {
    const needle = q.toLowerCase();
    return [row.seat, row.uname, row.name, row.team || '', String(row.uid), ...row.ips].some((value) => value.toLowerCase().includes(needle));
};

const inFilter = (row: SeatRow, filter: SeatFilter) => {
    if (filter === 'duplicate') return row.duplicate;
    if (filter === 'noSeat') return !row.missing && !row.seat;
    if (filter === 'noIp') return !row.missing && row.kind === 'user' && !row.ips.length;
    if (filter === 'orphan') return row.missing;
    return true;
};

export function normalizeSeatQuery(input: { zone?: unknown; filter?: unknown; q?: unknown }): Required<SeatQuery> {
    const filter = seatFilters.includes(input.filter as SeatFilter) ? input.filter as SeatFilter : 'all';
    return { zone: typeof input.zone === 'string' ? input.zone.slice(0, 64) : '', filter, q: typeof input.q === 'string' ? input.q.trim().slice(0, 64) : '' };
}

/**
 * The rows a query selects, with the counts behind each filter (within the room and search) and
 * the rooms of all rows. Listing, backup and cleanup all use the same selection.
 */
export function selectSeatRows(rows: SeatRow[], query: SeatQuery) {
    const zone = query.zone ?? '';
    const scoped = rows.filter((row) => (!zone || (zone === '-' ? !row.zone && !row.missing : row.zone === zone)) && (!query.q || matches(row, query.q)));
    const counts = Object.fromEntries(seatFilters.map((filter) => [filter, scoped.filter((row) => inFilter(row, filter)).length])) as Record<SeatFilter, number>;
    const zones = new Map<string, number>();
    for (const row of rows) if (!row.missing) zones.set(row.zone, (zones.get(row.zone) || 0) + 1);
    return {
        rows: scoped.filter((row) => inFilter(row, query.filter || 'all')),
        counts,
        zones: [...zones].sort(([a], [b]) => (!a !== !b ? (a ? -1 : 1) : collator.compare(a, b))).map(([name, count]) => ({ zone: name, count })),
    };
}

// ---------------------------------------------------------------- Editing one account

export function normalizeIpList(input: unknown) {
    const values = Array.isArray(input) ? input : typeof input === 'string' ? input.split(/[\s,，;；]+/) : [];
    const ips = [...new Set(values.map((value) => normalizeIp(String(value))).filter(Boolean))];
    const bad = ips.find((ip) => !validIp(ip));
    if (bad) throw new ManageError(`IP 地址 ${bad} 格式无效`);
    if (ips.length > MAX_IPS) throw new ManageError(`一个账号最多绑定 ${MAX_IPS} 个 IP`);
    return ips;
}

export function normalizeSeatEdit(input: unknown) {
    if (!input || typeof input !== 'object') throw new ManageError('无效的座位资料');
    const raw = input as Record<string, unknown>;
    const uid = Number(raw.uid);
    if (!Number.isSafeInteger(uid) || uid === 0) throw new ManageError('账号编号无效');
    const kind: SeatKind = uid < 0 ? 'team' : 'user';
    if (raw.seat !== undefined && typeof raw.seat !== 'string') throw new ManageError('座位格式无效');
    const seat = String(raw.seat ?? '').trim();
    if (seat.length > 64) throw new ManageError('座位不能超过 64 个字符');
    // onsite-toolkit signs an address in as a Hydro account; a team's virtual user cannot sign in.
    const ips = kind === 'team' ? [] : normalizeIpList(raw.ips ?? []);
    return { uid, kind, seat, ips };
}

// ---------------------------------------------------------------- Backup, cleanup, restore

export interface SeatBackupData {
    seats: { uid: number; kind: SeatKind; seat: string }[];
    ips: { ip: string; uid: number }[];
}

export function backupOf(rows: SeatRow[]): SeatBackupData {
    return {
        seats: rows.filter((row) => !row.missing && row.seat).map((row) => ({ uid: row.uid, kind: row.kind, seat: row.seat })),
        ips: rows.flatMap((row) => row.ips.map((ip) => ({ ip, uid: row.uid }))),
    };
}

/** The downloaded file, and what an uploaded one must look like. */
export function backupFile(data: SeatBackupData, meta: { createdAt: Date; label: string }) {
    return { format: BACKUP_FORMAT, version: 1, createdAt: meta.createdAt.toISOString(), label: meta.label, seats: data.seats, ips: data.ips };
}

export function normalizeBackup(input: unknown): SeatBackupData {
    if (!input || typeof input !== 'object') throw new ManageError('备份文件无效');
    const raw = input as Record<string, unknown>;
    if (raw.format !== undefined && raw.format !== BACKUP_FORMAT) throw new ManageError('不是座位与 IP 登录的备份文件');
    if (!Array.isArray(raw.seats) || !Array.isArray(raw.ips)) throw new ManageError('备份文件缺少座位或 IP 登录');
    if (raw.seats.length > SEAT_LIMIT || raw.ips.length > SEAT_LIMIT) throw new ManageError(`备份最多包含 ${SEAT_LIMIT} 条记录`);
    const seats = raw.seats.map((item) => {
        const uid = Number((item as { uid?: unknown })?.uid);
        const seat = (item as { seat?: unknown })?.seat;
        if (!Number.isSafeInteger(uid) || uid === 0 || typeof seat !== 'string' || !seat.trim() || seat.length > 64) throw new ManageError('备份中的座位记录无效');
        return { uid, kind: (uid < 0 ? 'team' : 'user') as SeatKind, seat: seat.trim() };
    });
    const ips = raw.ips.map((item) => {
        const uid = Number((item as { uid?: unknown })?.uid);
        const ip = normalizeIp(String((item as { ip?: unknown })?.ip ?? ''));
        if (!Number.isSafeInteger(uid) || uid <= 0 || !validIp(ip)) throw new ManageError('备份中的 IP 登录记录无效');
        return { ip, uid };
    });
    return { seats, ips };
}

export interface ClearOptions {
    seats: boolean;
    ips: boolean;
    /** Signs the accounts out everywhere: a session made by IP login outlives its entry. */
    sessions: boolean;
}

export function normalizeClearOptions(input: unknown): ClearOptions {
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const options = { seats: raw.seats === true, ips: raw.ips === true, sessions: raw.sessions === true };
    if (!options.seats && !options.ips && !options.sessions) throw new ManageError('请选择要清理的内容');
    return options;
}

/** What a cleanup changes for the selected rows. */
export function clearPlan(rows: SeatRow[], options: ClearOptions, operatorId: number) {
    const live = rows.filter((row) => !row.missing);
    return {
        userSeats: options.seats ? live.filter((row) => row.kind === 'user' && row.seat).map((row) => row.uid) : [],
        teamSeats: options.seats ? live.filter((row) => row.kind === 'team' && row.seat).map((row) => row.uid) : [],
        ips: options.ips ? rows.flatMap((row) => row.ips) : [],
        sessions: options.sessions ? live.filter((row) => row.kind === 'user' && row.uid > 1 && row.uid !== operatorId && !row.keepSessions).map((row) => row.uid) : [],
    };
}

export interface SeatBackupMeta {
    contest?: { domainId: string; tid: string; title: string } | null;
    zone?: string;
    filter?: SeatFilter;
    q?: string;
}

const filterLabels: Record<SeatFilter, string> = { all: '', duplicate: '重复座位', noSeat: '无座位', noIp: '无 IP', orphan: '失效映射' };

/** One line naming a selection: `2026 校赛 · 考场 A · 重复座位`. */
export function scopeLabel(meta: SeatBackupMeta) {
    return [meta.contest?.title || '全站', meta.zone === '-' ? '无考场前缀' : meta.zone ? `考场 ${meta.zone}` : '', filterLabels[meta.filter || 'all'], meta.q ? `“${meta.q}”` : '']
        .filter(Boolean).join(' · ');
}
