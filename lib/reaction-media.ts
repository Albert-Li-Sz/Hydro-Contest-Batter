import { Readable } from 'node:stream';
import type { Handler } from 'hydrooj';
import { ReactionError } from './reactions';
import { readRange } from './recording';

/** Stream authorized media through Hydro so changing access also takes effect on subsequent Range requests. */
export async function proxyReactionMedia(
    handler: Pick<Handler, 'request' | 'response'>,
    bytes: number,
    signed: () => Promise<string>,
    name?: string,
    mime = 'video/mp4',
) {
    handler.response.addHeader('Cache-Control', 'private, no-store');
    handler.response.addHeader('Accept-Ranges', 'bytes');
    handler.response.addHeader('X-Content-Type-Options', 'nosniff');
    let range;
    try {
        range = readRange(handler.request.headers.range, bytes);
    } catch {
        handler.response.status = 416;
        handler.response.addHeader('Content-Range', `bytes */${bytes}`);
        handler.response.body = '';
        return;
    }
    const response = await fetch(await signed(), {
        redirect: 'error',
        headers: range ? { Range: `bytes=${range.start}-${range.end}` } : {},
    });
    const expectedRange = range ? `bytes ${range.start}-${range.end}/${bytes}` : null;
    if (!response.body || response.status !== (range ? 206 : 200) || (range && response.headers.get('content-range') !== expectedRange)) {
        await response.body?.cancel();
        throw new ReactionError('成品存储读取失败', response.status === 404 ? 404 : 502);
    }
    handler.response.status = response.status;
    if (expectedRange) handler.response.addHeader('Content-Range', expectedRange);
    handler.response.addHeader('Content-Length', String(range ? range.end - range.start + 1 : bytes));
    handler.response.type = mime;
    if (name) handler.response.disposition = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
    handler.response.body = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
}
