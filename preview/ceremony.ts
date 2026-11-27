import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Environment } from 'nunjucks';
import type { BoardData } from '../lib/board';
import { ceremonyConfig, ceremonyDefaults, ceremonySlides, ceremonyThemes } from '../lib/ceremony-slides';
import { ceremonyKey, ceremonyPptx, parseCeremonyLayout, pptxType } from '../lib/ceremony-pptx';
import { resolverCodeBase } from '../lib/resolver-data';
import { decodePoster } from '../lib/screens-data';
import { toScriptJson, type BoardSettings } from '../lib/settings';
import type { createResultsPreview } from './results';

export function createCeremonyPreview(env: Environment, version: string, logos: Record<string, string>, results: ReturnType<typeof createResultsPreview>) {
    const base = '/contest/demo/ceremony';
    let saved = ceremonyDefaults;
    let background: ReturnType<typeof decodePoster> | null = null;
    let backgroundAt = 0;
    return async (req: IncomingMessage, res: ServerResponse, url: URL, data: BoardData, settings: BoardSettings) => {
        if (![base, base + '/background', base + '/pptx'].includes(url.pathname)) return false;
        res.setHeader('Cache-Control', 'no-store');
        const json = (v: unknown) => res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(v));
        if (req.method === 'POST') {
            const chunks: Buffer[] = [];
            let bytes = 0;
            for await (const chunk of req) {
                bytes += chunk.length;
                if (bytes > 9 * 1024 ** 2) throw new Error('文件过大');
                chunks.push(chunk);
            }
            const buffer = Buffer.concat(chunks);
            const type = req.headers['content-type'] || '';
            if (url.pathname.endsWith('/background')) {
                const image = type.startsWith('multipart/') ? (await new Response(new Uint8Array(buffer), { headers: { 'Content-Type': type } }).formData()).get('image')
                    : JSON.parse(buffer.toString()).image;
                background = image ? decodePoster(String(image), 6 * 1024 ** 2) : null;
                backgroundAt = Date.now(); json({ at: background ? backgroundAt : null });
            } else {
                const body = JSON.parse(buffer.toString());
                const config = ceremonyConfig(JSON.parse(body.config));
                const source = await results.readSource(data, settings, config.source);
                if (!source) throw new Error('快照不存在');
                const deck = ceremonySlides(source, config, logos);
                if (url.pathname.endsWith('/pptx')) {
                    const layout = parseCeremonyLayout(body.layout, deck, background ? backgroundAt : 0);
                    const bg = background?.mime === 'image/webp' && body.fallback ? decodePoster(body.fallback, 6 * 1024 ** 2) : background;
                    const file = await ceremonyPptx(deck, config, layout, bg || undefined);
                    res.writeHead(200, { 'Content-Type': pptxType, 'Content-Disposition': 'attachment; filename="awards.pptx"' }).end(file);
                } else {
                    if (body.save) saved = config;
                    json({ ...deck, key: ceremonyKey(deck) });
                }
            }
        } else if (url.pathname.endsWith('/pptx')) { res.writeHead(405, { Allow: 'POST' }).end();
        } else if (url.pathname.endsWith('/background')) {
            if (!background) res.writeHead(404).end();
            else res.writeHead(200, { 'Content-Type': background.mime }).end(background.data);
        } else {
            const sources = await results.sources();
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(env.render('xcpcio_ceremony.html', {
                tdoc: { title: data.contest.contest_name }, codeBase: resolverCodeBase(version), runtimeJson: toScriptJson({
                    base, config: { ...saved, source: url.searchParams.get('source') || saved.source }, themes: ceremonyThemes, sources,
                    background: background ? base + '/background?v=' + backgroundAt : '',
                }),
            }));
        }
        return true;
    };
}
