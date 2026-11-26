/**
 * SSRF protection for outbound CCS webhook callbacks: reject non-HTTP(S) schemes, embedded
 * credentials, local/internal hostnames, and private/loopback/link-local/reserved IP addresses
 * (both literal and DNS-resolved).
 */
import dns from 'node:dns';
import net from 'node:net';
import { CcsError } from './types';

export type HostLookup = (hostname: string) => Promise<string[]>;

const defaultLookup: HostLookup = async (hostname) => {
    const records = await dns.promises.lookup(hostname, { all: true, verbatim: true });
    return records.map((record) => record.address);
};

const BLOCKED_HOSTS = new Set([
    'localhost',
    'localhost.localdomain',
    'metadata.google.internal',
    'metadata.goog',
    'instance-data',
]);

function ipv4Int(ip: string): number | null {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let value = 0;
    for (const part of parts) {
        if (!/^\d{1,3}$/.test(part)) return null;
        const n = Number(part);
        if (n < 0 || n > 255) return null;
        value = (value * 256) + n;
    }
    return value >>> 0;
}

function isBlockedIpv4(ip: string): boolean {
    const n = ipv4Int(ip);
    if (n === null) return true;
    const a = (n >>> 24) & 0xff;
    const b = (n >>> 16) & 0xff;
    const c = (n >>> 8) & 0xff;
    if (a === 0) return true; // 0.0.0.0/8 ("this" network)
    if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
    if (a === 127) return true; // 127.0.0.0/8 (loopback)
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local / cloud metadata)
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
    if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF protocol)
    if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
    if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
    if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
    if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
    if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + broadcast
    return false;
}

function expandIpv6(raw: string): number[] | null {
    const addr = raw.split('%')[0].toLowerCase();
    const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(addr);
    let text = addr;
    if (v4) {
        const n = ipv4Int(v4[1]);
        if (n === null) return null;
        text = `${addr.slice(0, -v4[1].length)}${((n >>> 16) & 0xffff).toString(16)}:${(n & 0xffff).toString(16)}`;
    }
    const halves = text.split('::');
    if (halves.length > 2) return null;
    const left = halves[0] ? halves[0].split(':') : [];
    const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
    const missing = halves.length === 2 ? 8 - (left.length + right.length) : 0;
    if (missing < 0 || (halves.length === 1 && left.length !== 8)) return null;
    const groups = [...left, ...Array(missing).fill('0'), ...right];
    if (groups.length !== 8) return null;
    const values: number[] = [];
    for (const group of groups) {
        if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
        values.push(parseInt(group, 16));
    }
    return values;
}

export function isBlockedIp(raw: string): boolean {
    const ip = raw.trim().replace(/^\[|\]$/g, '');
    if (net.isIPv4(ip)) return isBlockedIpv4(ip);
    if (!net.isIPv6(ip)) return true;
    const g = expandIpv6(ip);
    if (!g) return true;
    // :: (unspecified) and ::1 (loopback)
    if (g.slice(0, 7).every((x) => x === 0) && (g[7] === 0 || g[7] === 1)) return true;
    // ::ffff:0:0/96 (IPv4-mapped) and ::ffff:0:0:0/96 (IPv4-translated) and 64:ff9b::/96 (NAT64)
    if (g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && (g[5] === 0xffff || g[5] === 0)) {
        const mapped = `${g[6] >>> 8}.${g[6] & 0xff}.${g[7] >>> 8}.${g[7] & 0xff}`;
        return isBlockedIpv4(mapped);
    }
    if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0) {
        const mapped = `${g[6] >>> 8}.${g[6] & 0xff}.${g[7] >>> 8}.${g[7] & 0xff}`;
        return isBlockedIpv4(mapped);
    }
    // 2002::/16 (6to4 embeds IPv4 in g[1..2])
    if (g[0] === 0x2002) {
        const mapped = `${g[1] >>> 8}.${g[1] & 0xff}.${g[2] >>> 8}.${g[2] & 0xff}`;
        return isBlockedIpv4(mapped);
    }
    if ((g[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 Unique Local
    if ((g[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 Link-Local
    if ((g[0] & 0xffc0) === 0xfec0) return true; // fec0::/10 Site-Local (deprecated)
    if ((g[0] & 0xff00) === 0xff00) return true; // ff00::/8 Multicast
    if (g[0] === 0x0100 && g[1] === 0 && g[2] === 0 && g[3] === 0) return true; // 100::/64 Discard-Only
    if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 Documentation
    return false;
}

/** Static validation for a user-supplied webhook URL (used at registration and before delivery). */
export function validateWebhookUrl(raw: unknown): URL {
    if (typeof raw !== 'string') throw new CcsError(400, 'url 必须是有效的 http 或 https 地址');
    let parsed: URL;
    try { parsed = new URL(raw); } catch { throw new CcsError(400, 'url 必须是有效的 http 或 https 地址'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) {
        throw new CcsError(400, 'url 必须是没有用户信息或片段的 http 或 https 地址');
    }
    const host = parsed.hostname.toLowerCase().replace(/\.+$/, '');
    if (!host) throw new CcsError(400, 'url 主机名无效');
    if (BLOCKED_HOSTS.has(host) || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
        throw new CcsError(400, '禁止将本地或内网地址设为 webhook');
    }
    const bare = host.replace(/^\[|\]$/g, '');
    if (net.isIP(bare) && isBlockedIp(bare)) {
        throw new CcsError(400, '禁止将内网、回环或保留 IP 设为 webhook');
    }
    return parsed;
}

/** Fail-closed DNS + IP validation executed before sending outbound webhook HTTP requests. */
export async function assertSafeWebhookTarget(raw: string, lookup: HostLookup = defaultLookup): Promise<URL> {
    const parsed = validateWebhookUrl(raw);
    const bare = parsed.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(bare)) {
        if (isBlockedIp(bare)) throw new CcsError(400, '禁止向内网、回环或保留 IP 投递 webhook');
        return parsed;
    }
    let addresses: string[];
    try {
        addresses = await lookup(bare);
    } catch {
        throw new CcsError(400, `无法解析 webhook 主机 ${bare}`);
    }
    if (!addresses.length || addresses.some((address) => isBlockedIp(address))) {
        throw new CcsError(400, 'webhook 域名解析到了内网或保留地址，已拒绝投递');
    }
    return parsed;
}
