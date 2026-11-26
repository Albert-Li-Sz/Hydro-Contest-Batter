/**
 * A minimal STUN server (RFC 5389 Binding only) for 画面采集. A browser that captures only the
 * screen has no camera permission, so Chrome hides its local addresses behind random `.local`
 * names that other computers often cannot resolve; asking a STUN server on the venue network
 * gives each side its real address instead. Hydro answers these itself, so no separate server
 * is needed. Responses are 32 bytes (IPv4) or 44 bytes (IPv6) for a 20-byte header, so inbound
 * requests are rate-limited per source IP and globally to prevent UDP flood/amplification abuse.
 */
import dgram from 'node:dgram';
import net from 'node:net';

const MAGIC_COOKIE = 0x2112a442;
const BINDING_REQUEST = 0x0001;
const BINDING_SUCCESS = 0x0101;
const XOR_MAPPED_ADDRESS = 0x0020;

const RATE_WINDOW_MS = 1000;
const MAX_PER_IP_PER_SEC = 60;
const MAX_GLOBAL_PER_SEC = 1000;
const MAX_TRACKED_IPS = 4096;

/** The Binding success response for a request from `address:port`, or null when invalid. */
export function stunResponse(request: Buffer, address: string, port: number): Buffer | null {
    if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
    if (request.length < 20 || request.length > 1500) return null;
    if ((request[0] & 0xc0) !== 0) return null;
    if (request.readUInt16BE(0) !== BINDING_REQUEST || request.readUInt32BE(4) !== MAGIC_COOKIE) return null;
    if (request.readUInt16BE(2) + 20 !== request.length) return null;
    const transaction = request.subarray(8, 20);
    const mapped = address.startsWith('::ffff:') && net.isIPv4(address.slice(7)) ? address.slice(7) : address;
    let value: Buffer;
    if (net.isIPv4(mapped)) {
        value = Buffer.alloc(8);
        value[1] = 0x01;
        const octets = mapped.split('.').map(Number);
        value.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 2);
        value.writeUInt32BE((((octets[0] << 24) | (octets[1] << 16) | (octets[2] << 8) | octets[3]) ^ MAGIC_COOKIE) >>> 0, 4);
    } else if (net.isIPv6(mapped)) {
        value = Buffer.alloc(20);
        value[1] = 0x02;
        value.writeUInt16BE(port ^ (MAGIC_COOKIE >>> 16), 2);
        const key = Buffer.concat([Buffer.from([0x21, 0x12, 0xa4, 0x42]), transaction]);
        const bytes = ipv6Bytes(mapped);
        for (let i = 0; i < 16; i++) value[4 + i] = bytes[i] ^ key[i];
    } else return null;
    const response = Buffer.alloc(20 + 4 + value.length);
    response.writeUInt16BE(BINDING_SUCCESS, 0);
    response.writeUInt16BE(4 + value.length, 2);
    response.writeUInt32BE(MAGIC_COOKIE, 4);
    transaction.copy(response, 8);
    response.writeUInt16BE(XOR_MAPPED_ADDRESS, 20);
    response.writeUInt16BE(value.length, 22);
    value.copy(response, 24);
    return response;
}

function ipv6Bytes(address: string) {
    let text = address.split('%')[0];
    // An embedded IPv4 tail (64:ff9b::1.2.3.4) as its two groups.
    const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
    if (v4) {
        const [a, b, c, d] = v4[1].split('.').map(Number);
        text = `${text.slice(0, -v4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
    }
    const [head, tail] = text.split('::');
    const first = head ? head.split(':') : [];
    const last = tail === undefined ? [] : tail ? tail.split(':') : [];
    const groups = tail === undefined ? first : [...first, ...Array(8 - first.length - last.length).fill('0'), ...last];
    const bytes = Buffer.alloc(16);
    groups.slice(0, 8).forEach((group, index) => bytes.writeUInt16BE(parseInt(group || '0', 16) & 0xffff, index * 2));
    return bytes;
}

/**
 * Answers STUN on `port` over IPv4 and IPv6 for as long as the returned stop function is not
 * called. With several Hydro processes only one needs to hold the port; the others fail to bind
 * and stay quiet.
 */
export function startStunServer(port: number, log: (message: string) => void = () => {}) {
    const sockets: { socket: dgram.Socket; closed: boolean; bound: boolean }[] = [];
    let windowStart = Date.now();
    let globalCount = 0;
    const ipCounts = new Map<string, number>();

    const allowRequest = (address: string) => {
        const now = Date.now();
        if (now - windowStart >= RATE_WINDOW_MS) {
            windowStart = now;
            globalCount = 0;
            ipCounts.clear();
        }
        if (globalCount >= MAX_GLOBAL_PER_SEC) return false;
        const count = ipCounts.get(address) ?? 0;
        if (count >= MAX_PER_IP_PER_SEC) return false;
        if (count === 0 && ipCounts.size >= MAX_TRACKED_IPS) return false;
        globalCount++;
        ipCounts.set(address, count + 1);
        return true;
    };

    const closeEntry = (entry: { socket: dgram.Socket; closed: boolean }) => {
        if (entry.closed) return;
        entry.closed = true;
        try { entry.socket.close(); } catch { /* already closed */ }
    };

    for (const type of ['udp4', 'udp6'] as const) {
        const socket = dgram.createSocket({ type, reuseAddr: false, ...type === 'udp6' ? { ipv6Only: true } : {} });
        const entry = { socket, closed: false, bound: false };
        socket.on('listening', () => { entry.bound = true; });
        socket.on('message', (message, remote) => {
            if (entry.closed || !Number.isInteger(remote.port) || remote.port <= 0 || remote.port > 65535) return;
            if (!allowRequest(remote.address)) return;
            const response = stunResponse(message, remote.address, remote.port);
            if (!response) return;
            try {
                // Always attach a callback so transient send failures (ENETUNREACH, ENOBUFS, etc.)
                // never emit an unhandled socket error or shut down the STUN listener.
                socket.send(response, remote.port, remote.address, () => {});
            } catch {
                // Ignore synchronous socket validation/state errors from malformed peers.
            }
        });
        socket.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code !== 'EADDRINUSE' && error.code !== 'EAFNOSUPPORT' && error.code !== 'EADDRNOTAVAIL') log(`STUN ${type}: ${error.message}`);
            // Only close on bind/startup failure; a bound socket keeps serving past transient errors.
            if (!entry.bound) closeEntry(entry);
        });
        try {
            socket.bind(port, type === 'udp4' ? '0.0.0.0' : '::');
            socket.unref();
        } catch (error) {
            log(`STUN ${type}: ${error instanceof Error ? error.message : String(error)}`);
            closeEntry(entry);
        }
        sockets.push(entry);
    }
    return () => { for (const entry of sockets) closeEntry(entry); };
}
