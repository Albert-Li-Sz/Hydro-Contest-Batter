import { hashToken, newPrintToken, tokenMatches } from './print';
import { ReactionError } from './reactions';

export function workerName(value: unknown) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > 80) throw new ReactionError('请填写 1 至 80 字的媒体机名称');
    return value.trim();
}

export function workerApiPath(contestReactionsPath: string, id: string) {
    return `${contestReactionsPath}-api/workers/${id}`;
}

/** Prefer the public browser origin for reverse-proxied Hydro. Only use an origin for this site. */
export function workerOrigin(browserOrigin: unknown, configuredUrl: unknown, host: string, protocol: string) {
    function parse(value: unknown) {
        if (typeof value !== 'string') return null;
        try {
            const url = new URL(value);
            return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url : null;
        } catch {
            return null;
        }
    }
    const configured = parse(configuredUrl);
    const supplied = parse(browserOrigin);
    if (supplied && supplied.origin === browserOrigin && (supplied.host === host || supplied.origin === configured?.origin))
        return supplied.origin;
    const origin = configured?.origin || parse(`${protocol}://${host}`)?.origin;
    if (!origin) throw new ReactionError('无法确定 Hydro 对外地址');
    return origin;
}

export function issueWorkerCode(origin: string, base: string, id: string) {
    const token = newPrintToken();
    const body = { v: 1, url: origin + workerApiPath(base, id), id, token };
    return { code: 'hydro-reactions:' + Buffer.from(JSON.stringify(body)).toString('base64url'), tokenHash: hashToken(token) };
}

export function workerAuthorized(authorization: unknown, hash: string) {
    if (typeof authorization !== 'string') return false;
    const token = /^Bearer ([A-Za-z0-9_-]{32})$/i.exec(authorization)?.[1];
    return !!token && tokenMatches(token, hash);
}
