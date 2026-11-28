import { normalizeIp, validIp } from './onsite';

/**
 * 命令行交题 (`submit`, submit-client/): what the server side keeps independent of Hydro, so the
 * routes (lib/submit-routes.ts) and the local preview share it.
 */

export class SubmitError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}

export const SUBMIT_CLIENT_PREFIX = 'hydro-submit-';
export const submitPlatforms: Record<string, string> = {
    'windows-amd64.exe': 'Windows（x64）', 'windows-arm64.exe': 'Windows（ARM64）', 'darwin-arm64': 'macOS（Apple 芯片）',
    'darwin-amd64': 'macOS（Intel）', 'linux-amd64': 'Linux（x64）', 'linux-arm64': 'Linux（ARM64）',
};

/** Hydro's problem labels (@hydrooj/utils getAlphabeticId): A…Z, AA…AZ, BA…ZZ, then onwards. */
export function alphabeticId(index: number): string {
    if (index < 0) return '?';
    const head = Math.floor(index / 26) - 1;
    return (head >= 0 ? alphabeticId(head) : '') + String.fromCharCode(65 + (index % 26));
}

/** The problem of a contest with the label as the contestant typed it (`b`, ` B `), or null. */
export function problemByLabel(pids: readonly number[], label: unknown): { pid: number; label: string } | null {
    const wanted = String(label ?? '').trim().toUpperCase();
    if (!/^[A-Z]+$/.test(wanted)) return null;
    const index = pids.findIndex((_pid, i) => alphabeticId(i) === wanted);
    return index < 0 ? null : { pid: pids[index], label: wanted };
}

export const labelOf = (pids: readonly number[], pid: number) => {
    const index = pids.indexOf(pid);
    return index < 0 ? '?' : alphabeticId(index);
};

export interface LangLike {
    display?: string;
    code_file?: string;
}

/** A language as the client sees it: key, name and the file extension of Hydro's code_file. */
export function describeLanguage(key: string, lang: LangLike | undefined) {
    const file = lang?.code_file || `foo.${key}`;
    const dot = file.lastIndexOf('.');
    return { key, display: lang?.display || key, ext: dot >= 0 ? file.slice(dot + 1).toLowerCase() : '' };
}

/** A file name for Hydro's print queue (Types.Title: 1–64 characters): the base name, without control characters. */
export function printTitle(filename: unknown) {
    const base = String(filename ?? '').replace(/\\/g, '/').split('/').pop() || '';
    const clean = base.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, '').trim();
    return (clean || 'code.txt').slice(0, 64).replace(/[\ud800-\udbff]$/u, '');
}

const objectId = /^[a-f\d]{24}$/i;
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});

export interface SubmitRequest { tid: string | null; problem: string; lang: string; code: string; filename: string }
export interface PrintRequest { tid: string | null; filename: string; code: string }

function tidOf(body: Record<string, unknown>) {
    if (body.tid === undefined || body.tid === null || body.tid === '') return null;
    if (typeof body.tid !== 'string' || !objectId.test(body.tid)) throw new SubmitError('比赛编号无效');
    return body.tid.toLowerCase();
}

export function parseSubmit(input: unknown, lengthLimit: number): SubmitRequest {
    const body = record(input);
    const problem = String(body.problem ?? '').trim().toUpperCase();
    if (!/^[A-Z]+$/.test(problem)) throw new SubmitError('请指定题号（如 A）');
    const lang = typeof body.lang === 'string' ? body.lang.trim() : '';
    // Hydro's Types.Name.
    if (!lang || lang.length > 255) throw new SubmitError('请指定语言');
    if (typeof body.code !== 'string') throw new SubmitError('缺少代码');
    const code = body.code.replace(/\r\n/g, '\n');
    if (!code.trim()) throw new SubmitError('代码为空');
    if (code.length > lengthLimit) throw new SubmitError(`代码超过 ${Math.floor(lengthLimit / 1024)} KB 的长度限制`, 413);
    return { tid: tidOf(body), problem, lang, code, filename: printTitle(body.filename) };
}

/** Hydro's postPrint takes Types.Title and Types.Content (trimmed, under 65536 characters). */
export const MAX_PRINT_CHARS = 65535;
export function parsePrint(input: unknown): PrintRequest {
    const body = record(input);
    if (typeof body.code !== 'string') throw new SubmitError('缺少要打印的内容');
    const code = body.code.trim();
    if (!code) throw new SubmitError('要打印的内容为空');
    if (code.length > MAX_PRINT_CHARS) throw new SubmitError('要打印的内容超过 64 K 字符的限制', 413);
    return { tid: tidOf(body), filename: printTitle(body.filename), code };
}

/** Hydro's judge statuses (@hydrooj/common STATUS), with a short code and a Chinese name. */
const statusNames: Record<number, [string, string]> = {
    0: ['WAIT', '等待评测'], 1: ['AC', '通过'], 2: ['WA', '答案错误'], 3: ['TLE', '超出时间限制'], 4: ['MLE', '超出内存限制'],
    5: ['OLE', '输出超限'], 6: ['RE', '运行时错误'], 7: ['CE', '编译错误'], 8: ['SE', '系统错误'], 9: ['CANCEL', '已取消'],
    10: ['UKE', '未知错误'], 11: ['HACKED', '被 Hack'], 20: ['JUDGING', '评测中'], 21: ['COMPILING', '编译中'], 22: ['FETCHED', '评测中'],
    30: ['IGN', '已忽略'], 31: ['FE', '格式错误'], 32: ['HACK_OK', 'Hack 成功'], 33: ['HACK_FAIL', 'Hack 失败'],
};
const pendingStatuses = new Set([0, 20, 21, 22]);

export function statusOf(code: number, visible: boolean) {
    if (!visible) return { code: 'HIDDEN', text: '已提交（结果暂不公开）', pending: false };
    const [short, text] = statusNames[code] || ['UKE', '未知状态'];
    return { code: short, text, pending: pendingStatuses.has(code) };
}

/**
 * The contest a request means: the one named, or else the only ongoing one of the contestant's.
 * `ongoing` contests are those that accept submissions now.
 */
export function pickContest<T extends { tid: string; title: string }>(ongoing: T[], tid: string | null, what = '提交'): T {
    if (tid) {
        const found = ongoing.find((contest) => contest.tid === tid);
        if (!found) throw new SubmitError('该比赛未在进行中，或本机账号没有参加', 403);
        return found;
    }
    if (!ongoing.length) throw new SubmitError(`本机账号没有正在进行、可以${what}的比赛`, 403);
    if (ongoing.length > 1) {
        throw new SubmitError(`本机账号同时参加了多场进行中的比赛，请用 --tid 指定：${ongoing.map((contest) => `${contest.tid}（${contest.title}）`).join('、')}`, 400);
    }
    return ongoing[0];
}

export function requireIpLogin(ip: string, loggedInIp: unknown, effectiveUid: number, boundUid: number | undefined,
    headers: { cookie?: unknown; authorization?: unknown }) {
    if (headers.cookie !== undefined || headers.authorization !== undefined || typeof loggedInIp !== 'string'
        || !validIp(ip) || normalizeIp(loggedInIp) !== normalizeIp(ip) || effectiveUid <= 0 || effectiveUid !== boundUid) {
        throw new SubmitError(notBoundMessage, 403);
    }
}

export const notBoundMessage = '本机未绑定比赛账号：请在比赛机房的选手机上使用，或联系工作人员绑定本机 IP';
