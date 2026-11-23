/**
 * Print servers: PCs running the print client, which take Hydro's print requests (participants send
 * them from the contest's 打印 page) and print them on their printers. Settings, seats,
 * connection codes and which PC takes which request. Pure; lib/print-routes.ts applies them.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

export class PrintError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}

/** Hydro's print queue (model/contest.ts PrintTaskStatus). */
export const printStatuses = ['pending', 'printing', 'printed', 'failed'] as const;
export type PrintStatus = typeof printStatuses[number];

export const headerFields = [
    ['team', '队伍名'], ['seat', '座位号'], ['school', '学校'], ['members', '队员'], ['account', '账号'],
    ['problem', '文件名'], ['language', '语言'], ['time', '时间'], ['id', '编号'],
] as const;
export type HeaderField = typeof headerFields[number][0];

export interface PrintSettings {
    /** Black-and-white syntax styling: keywords bold, comments italic, strings grey. */
    highlight: boolean;
    lineNumbers: boolean;
    /** Code size in points. */
    fontSize: number;
    header: HeaderField[];
}

export const defaultPrintSettings = (): PrintSettings => ({
    highlight: true, lineNumbers: true, fontSize: 10,
    header: ['team', 'seat', 'school', 'members', 'problem', 'language', 'time', 'id'],
});

export function normalizePrintSettings(input: unknown, base = defaultPrintSettings()): PrintSettings {
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const known = new Set<string>(headerFields.map(([key]) => key));
    const settings: PrintSettings = { ...base };
    for (const key of ['highlight', 'lineNumbers'] as const) if (typeof raw[key] === 'boolean') settings[key] = raw[key] as boolean;
    if (raw.fontSize !== undefined) {
        const size = Number(raw.fontSize);
        if (!Number.isFinite(size) || size < 7 || size > 16) throw new PrintError('字号需在 7 至 16 磅之间');
        settings.fontSize = Math.round(size * 2) / 2;
    }
    if (Array.isArray(raw.header)) settings.header = [...new Set(raw.header.map(String).filter((key) => known.has(key)))] as HeaderField[];
    return settings;
}

/**
 * Seats come from Hydro's onsite-toolkit, which stores each team account's seat in the `seat`
 * field of the account (its quick import's `seat` column). A Hydro 5.1 team without a seat of
 * its own sits where its first seated member does.
 */
export function seatOf(seats: Map<number, string>, uid: number, members: number[] = []) {
    const own = seats.get(uid)?.trim();
    if (own) return own;
    for (const member of members) {
        const seat = seats.get(member)?.trim();
        if (seat) return seat;
    }
    return '';
}

/** The highlighting language from a Hydro language key (`cc.cc17o2`, `py.py3`, `java`). */
export function languageOf(lang: string) {
    const key = lang.toLowerCase();
    if (/^(cc|cpp|c\+\+|g\+\+)/.test(key)) return 'cpp';
    if (/^c(\.|$|11|99)/.test(key)) return 'c';
    if (/^(py|pypy)/.test(key)) return 'python';
    if (/^java/.test(key)) return 'java';
    if (/^(kt|kotlin)/.test(key)) return 'kotlin';
    if (/^go/.test(key)) return 'go';
    if (/^(rs|rust)/.test(key)) return 'rust';
    if (/^(js|node|ts)/.test(key)) return 'javascript';
    if (/^cs/.test(key)) return 'csharp';
    if (/^(pas|fpc)/.test(key)) return 'pascal';
    return 'plain';
}

/** A print request's language from its file name. */
export function languageOfFile(name: string) {
    const extension = /\.([a-z0-9+]+)$/i.exec(name.trim())?.[1]?.toLowerCase();
    const byExtension: Record<string, string> = {
        cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp', h: 'cpp', c: 'c', py: 'python', java: 'java', kt: 'kotlin',
        go: 'go', rs: 'rust', js: 'javascript', ts: 'javascript', cs: 'csharp', pas: 'pascal',
    };
    return (extension && byExtension[extension]) || 'plain';
}

export const lineCount = (text: string) => (text ? text.replace(/\n$/, '').split('\n').length : 0);

/** Hydro's code size limit is 128 KiB; a printout larger than this is refused rather than wasting paper. */
export const MAX_PRINT_BYTES = 256 * 1024;

// ---------------------------------------------------------------- Print servers

/** A print request goes back to the queue after a failed attempt, and fails for good after this many. */
export const MAX_ATTEMPTS = 3;
/** A print server that has not reported for this long is offline; its claimed requests return to the queue. */
export const ONLINE_MS = 30_000;
export const CLAIM_TIMEOUT_MS = 5 * 60_000;

export interface PrintServerInput {
    name: string;
    note: string;
    enabled: boolean;
    /** `domainId/contestId` of the contests it prints for; empty means every contest. */
    contests: string[];
    /** Seat prefixes it serves (`A`, `B-1`); empty means seats no other print server claims. */
    seatPrefixes: string[];
}

export function normalizeServerInput(input: unknown, base?: PrintServerInput): PrintServerInput {
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const server: PrintServerInput = base ? { ...base } : { name: '', note: '', enabled: true, contests: [], seatPrefixes: [] };
    if (raw.name !== undefined) {
        const name = String(raw.name).trim();
        if (!name || name.length > 40) throw new PrintError('打印服务器名称需为 1 至 40 个字符');
        server.name = name;
    }
    if (!server.name) throw new PrintError('请填写打印服务器名称');
    if (raw.note !== undefined) server.note = String(raw.note).trim().slice(0, 200);
    if (typeof raw.enabled === 'boolean') server.enabled = raw.enabled;
    if (raw.contests !== undefined) {
        if (!Array.isArray(raw.contests)) throw new PrintError('绑定的比赛格式无效');
        const contests = [...new Set(raw.contests.map(String))];
        if (contests.some((key) => !/^[^/\s]{1,64}\/[a-f\d]{24}$/i.test(key))) throw new PrintError('绑定的比赛无效');
        server.contests = contests;
    }
    if (raw.seatPrefixes !== undefined) {
        const list = Array.isArray(raw.seatPrefixes) ? raw.seatPrefixes : String(raw.seatPrefixes).split(/[\s,，;；]+/);
        const prefixes = [...new Set(list.map((prefix) => String(prefix).trim()).filter(Boolean))];
        if (prefixes.some((prefix) => prefix.length > 16)) throw new PrintError('座位前缀不能超过 16 个字符');
        server.seatPrefixes = prefixes;
    }
    return server;
}

export interface PrinterPreference {
    /** Administrators can take a printer out of rotation. */
    enabled: boolean;
    /** Share of the PC's printouts, 1 to 10. */
    weight: number;
    /** document: prints code; receipt (小票机): prints only balloon tickets (lib/balloons.ts). */
    kind: 'document' | 'receipt';
    receipt: { width: 58 | 80; mode: 'escpos' | 'driver'; cut: boolean };
}

export function normalizePrinterPreference(input: unknown): PrinterPreference {
    const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const weight = raw.weight === undefined ? 1 : Number(raw.weight);
    if (!Number.isSafeInteger(weight) || weight < 1 || weight > 10) throw new PrintError('打印机权重需为 1 至 10 的整数');
    if (raw.kind !== undefined && raw.kind !== 'document' && raw.kind !== 'receipt') throw new PrintError('打印机类型无效');
    const receipt = (raw.receipt && typeof raw.receipt === 'object' ? raw.receipt : {}) as Record<string, unknown>;
    const width = receipt.width === undefined ? 80 : Number(receipt.width);
    if (width !== 58 && width !== 80) throw new PrintError('小票纸宽只能是 58 或 80 毫米');
    if (receipt.mode !== undefined && receipt.mode !== 'escpos' && receipt.mode !== 'driver') throw new PrintError('小票输出方式无效');
    return {
        enabled: raw.enabled !== false, weight, kind: raw.kind === 'receipt' ? 'receipt' : 'document',
        receipt: { width, mode: receipt.mode === 'driver' ? 'driver' : 'escpos', cut: receipt.cut !== false },
    };
}

/** A saved preference from before printer types: a printer for printouts. */
export const preferenceOf = (saved: Partial<PrinterPreference> | undefined, fallback: () => PrinterPreference): PrinterPreference =>
    (saved ? normalizePrinterPreference(saved) : fallback());

/** A new secret for a print server; only its hash is stored. */
export const newPrintToken = () => randomBytes(24).toString('base64url');
export const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');
export function tokenMatches(token: string, hash: string) {
    const given = Buffer.from(hashToken(token), 'hex');
    const stored = Buffer.from(hash, 'hex');
    return given.length === stored.length && timingSafeEqual(given, stored);
}

const CODE_PREFIX = 'hydro-print:';

/** The connection code the print client is given: the Hydro address, the print server id and its secret. */
export function connectionCode(url: string, id: string, token: string) {
    return CODE_PREFIX + Buffer.from(JSON.stringify({ v: 1, url: url.replace(/\/+$/, ''), id, token })).toString('base64url');
}

export function parseConnectionCode(code: string) {
    const text = code.trim();
    if (!text.startsWith(CODE_PREFIX)) throw new PrintError('连接信息格式无效');
    try {
        const value = JSON.parse(Buffer.from(text.slice(CODE_PREFIX.length), 'base64url').toString('utf8'));
        if (typeof value.url !== 'string' || typeof value.id !== 'string' || typeof value.token !== 'string') throw new Error('fields');
        return value as { v: number; url: string; id: string; token: string };
    } catch { throw new PrintError('连接信息格式无效'); }
}

/**
 * Whether a print server takes a request: its contest is bound (or none are), and the team's seat
 * starts with one of the server's prefixes. A server without prefixes takes the seats no other
 * active server claims. When every active server for the contest has prefixes, a request whose
 * seat none of them claims (no seat imported, or a seat outside every range) goes to any of them,
 * so every request has somewhere to go.
 */
export function serverTakes(
    server: Pick<PrintServerInput, 'contests' | 'seatPrefixes'> & { id: string },
    request: { contest: string; seat: string },
    others: (Pick<PrintServerInput, 'contests' | 'seatPrefixes'> & { id: string })[],
) {
    type Candidate = Pick<PrintServerInput, 'contests' | 'seatPrefixes'>;
    const serves = (candidate: Candidate) => !candidate.contests.length || candidate.contests.includes(request.contest);
    if (!serves(server)) return false;
    const seat = request.seat.toLowerCase();
    const claims = (candidate: Candidate) => !!seat && serves(candidate)
        && candidate.seatPrefixes.some((prefix) => seat.startsWith(prefix.toLowerCase()));
    const rest = others.filter((other) => other.id !== server.id);
    if (!server.seatPrefixes.length) return !rest.some(claims);
    if (claims(server)) return true;
    // An orphan: nobody's range covers it and no catch-all server is there to take it.
    return !rest.some((other) => claims(other) || (serves(other) && !other.seatPrefixes.length));
}
