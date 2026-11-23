import { isIP } from 'node:net';

/**
 * What @hydrooj/onsite-toolkit keeps, read and written the same way here:
 * - the seat on the account document (`user.seat`, set by its onsiteImport; Hydro 5.1 teams may
 *   carry one on their virtual user, `vuser.seat`);
 * - IP login in the global `iplogin` collection, `{ _id: ip, uid }`, one account per address. Its
 *   `handler/init` hook signs requests from that address in as the account. Each hit refreshes
 *   its process-local 60-second cache, so active clients can keep stale entries alive.
 */
export const IP_LOGIN = 'iplogin';

export interface IpLoginDoc {
    _id: string;
    uid: number;
}

/** onsite-toolkit's normalizeIp: IPv4-mapped IPv6 addresses become plain IPv4. */
export function normalizeIp(ip: string) {
    const trimmed = String(ip).trim();
    return trimmed.startsWith('::ffff:') ? trimmed.slice(7) : trimmed;
}

export const validIp = (ip: string) => isIP(ip) !== 0;

/** A seat as onsite-toolkit stores it (a string, sometimes a number), or '' for none. */
export function seatText(value: unknown) {
    return typeof value === 'string' ? value.trim() : typeof value === 'number' && Number.isFinite(value) ? String(value) : '';
}

/** Mongo filter for documents with a seat. */
export const hasSeat = { seat: { $exists: true, $nin: ['', null] } } as const;
