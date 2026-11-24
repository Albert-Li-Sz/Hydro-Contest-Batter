/**
 * 机位监控: which contestant computers are on, and what looks wrong with them. Contest pages of a
 * participant report every few seconds (frontend/presence.js); these pure functions keep the
 * per-team record and turn the records into the seat map and alerts of the monitor page.
 */
import { zoneOf } from './balloons';

export const BEAT_MS = 20_000;
/** No report for this long: the computer may be off. */
export const WEAK_MS = 45_000;
export const OFFLINE_MS = 120_000;
/** Addresses used within this window count as in use at once. */
export const IP_WINDOW_MS = 10 * 60_000;
const IPS_KEPT = 8;
/** Reports this close together with nothing new are not written again. */
const REWRITE_MS = 10_000;

export interface PresenceDoc {
    /** `${contestKey}/${team uid}` */
    _id: string;
    contest: string;
    uid: number;
    /** The account that reported last (a member, in a team contest). */
    member: number;
    firstSeen: Date;
    lastSeen: Date;
    ip: string;
    ips: { ip: string; first: Date; last: Date }[];
    ua: string;
}

export interface Beat {
    contest: string;
    uid: number;
    member: number;
    ip: string;
    ua: string;
}

const time = (value: Date | string | number) => new Date(value).getTime();

/** The record after a report, or null when it would change nothing worth a write. */
export function applyBeat(prev: PresenceDoc | null, beat: Beat, now: Date): PresenceDoc | null {
    if (prev && prev.ip === beat.ip && prev.member === beat.member && now.getTime() - time(prev.lastSeen) < REWRITE_MS) return null;
    const ips = (prev?.ips || []).filter((entry) => entry.ip !== beat.ip);
    const same = prev?.ips.find((entry) => entry.ip === beat.ip);
    ips.push({ ip: beat.ip, first: same?.first || now, last: now });
    return {
        _id: `${beat.contest}/${beat.uid}`, contest: beat.contest, uid: beat.uid, member: beat.member,
        firstSeen: prev?.firstSeen || now, lastSeen: now, ip: beat.ip,
        ips: ips.sort((a, b) => time(a.last) - time(b.last)).slice(-IPS_KEPT),
        ua: beat.ua.slice(0, 400),
    };
}

export interface BrowserInfo { name: string; version: number; old: boolean }

/** The browser and whether it is too old for Hydro's pages (Chrome or Firefox before 90, Safari before 14). */
export function browserOf(ua: string): BrowserInfo {
    const match = (pattern: RegExp) => Number(pattern.exec(ua)?.[1] || 0);
    if (/MSIE |Trident\//.test(ua)) return { name: 'Internet Explorer', version: match(/(?:MSIE |rv:)(\d+)/), old: true };
    const browsers: [string, RegExp, number][] = [
        ['Edge', /Edg(?:e|A|iOS)?\/(\d+)/, 90], ['Opera', /OPR\/(\d+)/, 76], ['Firefox', /Firefox\/(\d+)/, 90],
        ['Chrome', /Chrom(?:e|ium)\/(\d+)/, 90], ['Safari', /Version\/(\d+)[.\d]* (?:Mobile\/\S+ )?Safari\//, 14],
    ];
    for (const [name, pattern, minimum] of browsers) {
        const version = match(pattern);
        if (version) return { name, version, old: version < minimum };
    }
    return { name: '', version: 0, old: false };
}

export type PresenceState = 'online' | 'weak' | 'offline' | 'never';
export const presenceStates: PresenceState[] = ['online', 'weak', 'offline', 'never'];

export function stateOf(doc: Pick<PresenceDoc, 'lastSeen'> | null, now: number): PresenceState {
    if (!doc) return 'never';
    const age = now - time(doc.lastSeen);
    if (age >= OFFLINE_MS) return 'offline';
    if (age >= WEAK_MS) return 'weak';
    return 'online';
}

export interface PresenceTeam {
    uid: number;
    name: string;
    seat: string;
    members: string[];
    /** IP login (onsite-toolkit) addresses of the team and its members. */
    mapped: string[];
    /** The capture device's connection, or null when the contest does not capture. */
    capture: 'recording' | 'connected' | 'disconnected' | null;
}

export type AlertKind = 'sharedIp' | 'ipMismatch' | 'offline' | 'never' | 'multiIp' | 'noCapture' | 'oldBrowser';
const severity: AlertKind[] = ['sharedIp', 'ipMismatch', 'offline', 'never', 'multiIp', 'noCapture', 'oldBrowser'];

export interface PresenceAlert {
    kind: AlertKind;
    uid: number;
    seat: string;
    name: string;
    text: string;
    since: number | null;
}

export type ContestPhase = 'before' | 'running' | 'ended';

export function phaseOf(times: { beginAt: Date | string; endAt: Date | string }, now: number): ContestPhase {
    return now < time(times.beginAt) ? 'before' : now < time(times.endAt) ? 'running' : 'ended';
}

const collator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

/** The monitor page's data: teams by room with their state, the counts, and the alerts. */
export function presenceSnapshot(teams: PresenceTeam[], docs: PresenceDoc[], times: { beginAt: Date | string; endAt: Date | string }, now: number) {
    const phase = phaseOf(times, now);
    const records = new Map(docs.map((doc) => [doc.uid, doc]));
    const rows = teams.map((team) => {
        const doc = records.get(team.uid) || null;
        const state = team.capture === 'recording' || team.capture === 'connected' ? 'online' : stateOf(doc, now);
        const recent = (doc?.ips || []).filter((entry) => now - time(entry.last) < IP_WINDOW_MS).map((entry) => entry.ip);
        return {
            ...team, zone: zoneOf(team.seat), state, doc,
            lastSeen: doc ? time(doc.lastSeen) : null, firstSeen: doc ? time(doc.firstSeen) : null,
            ip: doc?.ip || '', recent,
            browser: doc ? browserOf(doc.ua) : null,
            checkedIn: !!doc && time(doc.firstSeen) < time(times.beginAt),
        };
    });
    const alerts: PresenceAlert[] = [];
    const add = (row: typeof rows[number], kind: AlertKind, text: string, since: number | null) => alerts.push({ kind, uid: row.uid, seat: row.seat, name: row.name, text, since });
    // Computers in use now, by address: two teams on one address is a swapped or shared seat.
    const active = rows.filter((row) => row.state === 'online' || row.state === 'weak');
    const byIp = new Map<string, typeof rows>();
    for (const row of active) if (row.ip) byIp.set(row.ip, [...byIp.get(row.ip) || [], row]);
    for (const row of rows) {
        const live = active.includes(row);
        const others = live && row.ip ? byIp.get(row.ip)!.filter((other) => other !== row) : [];
        if (others.length) add(row, 'sharedIp', `与 ${others.map((other) => other.seat || other.name).join('、')} 同一 IP ${row.ip}`, null);
        if (live && row.ip && row.mapped.length && !row.mapped.includes(row.ip)) add(row, 'ipMismatch', `IP ${row.ip}，座位绑定 ${row.mapped.join('、')}`, null);
        if (phase === 'running' && row.state === 'offline') add(row, 'offline', '离线', row.lastSeen);
        if (phase === 'running' && row.state === 'never') add(row, 'never', '未登录', time(times.beginAt));
        if (row.recent.length > 1) add(row, 'multiIp', `10 分钟内 ${row.recent.length} 个 IP：${row.recent.join('、')}`, null);
        if (phase === 'running' && live && row.capture && row.capture !== 'recording') add(row, 'noCapture', row.capture === 'connected' ? '已连接未采集屏幕' : '画面采集未连接', null);
        if (row.browser?.old) add(row, 'oldBrowser', `${row.browser.name} ${row.browser.version}`, null);
    }
    alerts.sort((a, b) => severity.indexOf(a.kind) - severity.indexOf(b.kind) || collator.compare(a.seat || '~', b.seat || '~') || a.uid - b.uid);
    const flagged = new Map<number, AlertKind[]>();
    for (const alert of alerts) flagged.set(alert.uid, [...flagged.get(alert.uid) || [], alert.kind]);
    const zones = new Map<string, typeof rows>();
    for (const row of rows) zones.set(row.seat ? row.zone : '￿', [...zones.get(row.seat ? row.zone : '￿') || [], row]);
    const counts = Object.fromEntries(presenceStates.map((state) => [state, rows.filter((row) => row.state === state).length])) as Record<PresenceState, number>;
    return {
        phase, now, counts, total: rows.length, checkedIn: rows.filter((row) => row.checkedIn).length,
        capture: teams.some((team) => team.capture !== null),
        zones: [...zones].sort(([a], [b]) => collator.compare(a, b)).map(([zone, list]) => ({
            zone: zone === '￿' ? null : zone,
            teams: list.sort((a, b) => collator.compare(a.seat, b.seat) || collator.compare(a.name, b.name)).map(({ doc: _doc, ...row }) => ({ ...row, alerts: flagged.get(row.uid) || [] })),
        })),
        alerts,
    };
}

export type PresenceSnapshot = ReturnType<typeof presenceSnapshot>;
