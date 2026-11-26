import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from 'hydrooj';
import type { Environment } from 'nunjucks';
import { kindNames, placeholders } from '../lib/certificates/model';
import { CertificateError, certificateService, type CertificateFile } from '../lib/certificates/service';
import { resolverCodeBase } from '../lib/resolver-data';
import { toScriptJson } from '../lib/settings';

/** 证书 in the preview: the same service as Hydro, on the preview's in-memory store, as the demo admin (uid 1). */
export function createCertificatesPreview(env: Environment, version: string, db: Context['db'], dependencies: {
    snapshot: (label: string) => Promise<string>;
    showIdentity: () => boolean;
    title: () => string;
}) {
    const scope = { domainId: 'preview', contestId: 'demo' };
    const base = '/contest/demo/certificates';
    // The demo teams are the accounts of the same id; team 1 is the preview's signed-in user.
    const service = certificateService(db, {
        snapshot: (_scope, label) => dependencies.snapshot(label),
        accounts: async () => new Map(Array.from({ length: 20 }, (_, index) => [String(index + 1), [index + 1]])),
        showIdentity: async () => dependencies.showIdentity(),
    });
    const request = (incoming: IncomingMessage) => ({ scope, title: dependencies.title(), uid: 1, site: `http://${incoming.headers.host || '127.0.0.1:18900'}/` });
    const send = (response: ServerResponse, file: CertificateFile) => response.writeHead(200, {
        'Content-Type': file.type, 'Cache-Control': 'no-store',
        'Content-Disposition': `${file.inline ? 'inline' : 'attachment'}; filename="certificate"; filename*=UTF-8''${encodeURIComponent(file.name)}`,
    }).end(file.data);
    const json = (response: ServerResponse, body: unknown, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));

    async function handle(incoming: IncomingMessage, response: ServerResponse, url: URL) {
        const verify = /^\/d\/preview\/certificate\/([^/]+)$/.exec(url.pathname);
        if (!url.pathname.startsWith(base) && !verify) return false;
        try {
            if (verify) {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
                    .end(env.render('xcpcio_certificate_verify.html', { codeBase: resolverCodeBase(version), ...await service.verify('preview', decodeURIComponent(verify[1])) }));
                return true;
            }
            if (incoming.method === 'POST' && url.pathname === base) {
                let body = '';
                for await (const chunk of incoming) { body += chunk; if (body.length > 10_000_000) throw new CertificateError('请求过大'); }
                const { operation, payload } = JSON.parse(body) as { operation: string; payload?: string };
                json(response, await service.operate(request(incoming), operation, JSON.parse(payload || '{}')));
                return true;
            }
            if (url.pathname === base) {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(env.render('xcpcio_certificates.html', {
                    tdoc: { title: dependencies.title() }, codeBase: resolverCodeBase(version),
                    runtimeJson: toScriptJson({ base, dataUrl: `${base}/data`, fileUrl: `${base}/file`, assetUrl: `${base}/asset`, resultsUrl: '/contest/demo/results',
                        verifyBase: '/d/preview/certificate/', mineUrl: `${base}/mine`, placeholders, kindNames }),
                }));
                return true;
            }
            if (url.pathname === `${base}/data`) { json(response, await service.data(request(incoming))); return true; }
            const file = /^\/file\/([a-z]+)$/.exec(url.pathname.slice(base.length));
            if (file) {
                const query = Object.fromEntries(['code', 'school', 'kind', 'template'].map((key) => [key, url.searchParams.get(key) || '']));
                send(response, await service.file(request(incoming), file[1], query));
                return true;
            }
            const asset = /^\/asset\/([a-f0-9]{24})$/.exec(url.pathname.slice(base.length));
            if (asset) {
                const image = await service.asset(scope, asset[1], url.searchParams.get('part') || '');
                response.writeHead(200, { 'Content-Type': image.type }).end(image.data);
                return true;
            }
            if (url.pathname === `${base}/mine`) {
                const result = await service.mine(request(incoming), url.searchParams.get('code') || '');
                if (result.file) { send(response, result.file); return true; }
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(env.render('xcpcio_certificate_mine.html', {
                    tdoc: { title: dependencies.title() }, codeBase: resolverCodeBase(version), base: `${base}/mine`, certificates: result.list,
                }));
                return true;
            }
            response.writeHead(404).end('Not found');
        } catch (error) {
            if (!(error instanceof CertificateError)) throw error;
            json(response, { error: { message: error.message } }, error.status);
        }
        return true;
    }

    return { handle };
}
