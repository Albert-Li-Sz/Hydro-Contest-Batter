import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Environment } from 'nunjucks';
import { collectDeadline, collectionAddress, collectOpen, collectSettings, type CollectSettings } from '../lib/ip-collect';
import type { ContestLinks } from '../lib/links';
import { ManageError } from '../lib/manage/users';
import { formatClock, zoneLabel } from '../lib/time-zone';

export function previewCollection(env: Environment, codeBase: string, title: string, collect: (ip: string, name: string) => Promise<unknown>, links: ContestLinks) {
    const before = new Date(Date.now() + 25 * 60_000);
    const running = new Date(Date.now() - 2 * 3600_000);
    let settings: CollectSettings | null = null;
    const attempts = new Map<string, { from: number; count: number }>();
    const base = '/contest/demo';
    const summary = (pre: boolean) => {
        const begin = pre ? before : running, deadline = collectDeadline(begin);
        return { enabled: collectOpen(settings, begin), networks: settings?.networks || [], deadline,
            deadlineText: `${formatClock(deadline)}（${zoneLabel(deadline)}）`, url: base + '/ip-collect' + (pre ? '?phase=before' : '') };
    };
    links.add({ id: 'ip-collect', label: '机位 IP 收集', status: async () => ({ count: collectOpen(settings, before) ? 1 : 0, issuedAt: settings?.changedAt || null, url: summary(true).url }),
        revoke: async () => { if (settings) settings.enabled = false; return 0; } });
    async function handle(req: IncomingMessage, res: ServerResponse, url: URL) {
        const manager = url.pathname === base + '/presence' && req.method === 'POST';
        if (!manager && url.pathname !== base + '/ip-collect') return false;
        const pre = url.searchParams.get('phase') === 'before', begin = pre ? before : running;
        const headers = { 'Cache-Control': 'private, no-store', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' };
        const json = (value: unknown, status = 200) => res.writeHead(status, { ...headers, 'Content-Type': 'application/json' }).end(JSON.stringify(value));
        try {
            let raw = '';
            if (req.method === 'POST') for await (const chunk of req) { raw += chunk; if (raw.length > 8192) throw new ManageError('请求过大'); }
            const body = raw ? JSON.parse(raw) : {};
            if (manager) { settings = collectSettings(body.enabled === true, body.networks, begin); json(summary(pre)); return true; }
            const ip = collectionAddress(settings, begin, req.socket.remoteAddress || '');
            if (req.method === 'GET') {
                const nonce = randomBytes(24).toString('hex');
                res.writeHead(200, { ...headers, 'Content-Type': 'text/html; charset=utf-8', 'Set-Cookie': `xcpcio_collect=${nonce}; HttpOnly; SameSite=Strict; Path=${base}/ip-collect` })
                    .end(env.render('xcpcio_ip_collect.html', { title, codeBase, ip, nonce }));
            } else if (req.method === 'POST') {
                const recent = attempts.get(ip), current = recent && Date.now() - recent.from < 60_000 ? recent : { from: Date.now(), count: 0 };
                current.count++; attempts.set(ip, current);
                if (current.count > 8) throw new ManageError('尝试过于频繁，请稍后重试', 429);
                const cookie = /(?:^|;\s*)xcpcio_collect=([a-f0-9]{48})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
                if (!cookie || cookie !== body.nonce) throw new ManageError('请重新打开登记页', 403);
                json(await collect(ip, String(body.account || '').trim()));
            } else throw new ManageError('请求方法无效', 405);
        } catch (error) {
            const status = error instanceof ManageError ? error.status : 400;
            const message = error instanceof Error ? error.message : '请求无效';
            if (req.method === 'GET') res.writeHead(status, { ...headers, 'Content-Type': 'text/html; charset=utf-8' }).end(env.render('xcpcio_ip_collect.html', { title, codeBase, closed: message }));
            else json({ error: message }, status);
        }
        return true;
    }
    return { handle, summary };
}
