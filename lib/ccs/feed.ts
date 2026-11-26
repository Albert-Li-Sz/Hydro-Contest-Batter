import { PassThrough } from 'node:stream';
import type { AccessContext } from './access';
import { endpointProperties } from './access';
import type { CcsStore } from './store';
import type { View } from './model';
import { eventLine, feedToken, parseFeedToken, tokenPrefix } from './events';

export async function openFeed(options: {
    store: CcsStore; key: string; view: View; access: AccessContext; since?: unknown;
    authorized: () => Promise<boolean>; pollMs?: number; keepaliveMs?: number; recheckMs?: number;
}) {
    const { store, key, view, access } = options;
    const prefix = tokenPrefix(key, view, access.identity);
    const props = endpointProperties(access);
    let cursor = options.since === undefined ? 0 : parseFeedToken(options.since, prefix, await store.lastSeq(key, view));
    const stream = new PassThrough();
    let stopped = false;
    let wake: (() => void) | undefined;
    stream.once('close', () => { stopped = true; wake?.(); });
    const write = async (text: string) => {
        if (stopped) return;
        if (stream.write(text)) return;
        await new Promise<void>(resolve => {
            const done = () => { stream.off('drain', done); stream.off('close', done); resolve(); };
            stream.once('drain', done); stream.once('close', done);
        });
    };
    const pump = async () => {
        let lastWrite = Date.now();
        let checkedAt = 0;
        while (!stopped) {
            // Permissions and the contest switch are rechecked now and then, not on every poll.
            if (Date.now() - checkedAt >= (options.recheckMs ?? 15_000)) {
                if (!await options.authorized()) break;
                if (view.startsWith('team-')) await store.registerTeamView(key, view.slice(5)).catch(() => null);
                checkedAt = Date.now();
            }
            const events = await store.eventsAfter(key, view, cursor);
            for (const event of events) {
                if (stopped) break;
                cursor = event.seq;
                const line = eventLine(event, props, access.identity);
                if (!line) continue;
                await write(`${JSON.stringify({ ...line, token: feedToken(prefix, event.seq) })}\n`);
                lastWrite = Date.now();
                if (event.type === 'state' && (event.data as any)?.end_of_updates) { stopped = true; break; }
            }
            if (stopped) break;
            if (events.length === 500) continue;
            const [domainId, tid] = key.split('/');
            const doc = await store.contest(domainId, tid);
            if (doc.ended?.[view] && cursor >= await store.lastSeq(key, view) && cursor > 0) break;
            if (Date.now() - lastWrite >= (options.keepaliveMs ?? 60_000)) {
                await write('\n'); lastWrite = Date.now();
            }
            await new Promise<void>(resolve => {
                const timer = setTimeout(done, options.pollMs ?? 1000);
                timer.unref?.();
                function done() { clearTimeout(timer); wake = undefined; resolve(); }
                wake = done;
            });
        }
        stream.end();
    };
    // Start after the handler has handed the stream to the HTTP server.
    setImmediate(() => { pump().catch(error => { stream.destroy(error); }); });
    return stream;
}
