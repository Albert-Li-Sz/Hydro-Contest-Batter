import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from 'hydrooj';
import type { Environment } from 'nunjucks';
import { applySubmitApi } from '../lib/submit-api';
import { SubmitError } from '../lib/submit';
import { normalizeIp } from '../lib/onsite';
import { previewDatabase } from './resolver-memory-db';

export const submitPreviewTid = '68ea00000000000000000000';

/** Real submit HTTP handlers, with an isolated IP binding, judge inbox and print queue. */
export async function createSubmitPreview(env: Environment, title: string, boundIp = '127.0.0.1') {
    const { db } = previewDatabase();
    const table = (name: string) => db.collection(name as never) as any;
    const domain = 'system', tid = submitPreviewTid, uid = 101;
    const tdoc = { domainId: domain, docId: tid, title, rule: 'acm', beginAt: new Date(Date.now() - 3600000),
        endAt: new Date(Date.now() + 24 * 3600000), pids: [107, 203, 42], allowPrint: true, allowTeam: true };
    await table('iplogin').insertOne({ _id: normalizeIp(boundIp), uid });
    await table('document').insertOne({ ...tdoc, _id: tid });
    await table('status').insertOne({ _id: 'team', domainId: domain, docType: 30, docId: tid, uid: -120, attend: 1, members: [uid, 102], startAt: null });
    const langs: Record<string, { display: string; code_file: string }> = {
        'cc.cc17o2': { display: 'C++17', code_file: 'foo.cpp' }, py3: { display: 'Python 3', code_file: 'foo.py' },
    };
    class Id {
        constructor(private raw: string) {}
        static isValid(raw: string) { return /^[a-f0-9]{24}$/i.test(raw); }
        toString() { return this.raw; }
        getTimestamp() { return new Date(parseInt(this.raw.slice(0, 8), 16) * 1000); }
    }
    const id = () => Math.floor(Date.now() / 1000).toString(16) + randomBytes(8).toString('hex');
    class Handler {
        domain = { _id: domain };
        user: any;
        request: any;
        session: any;
        response: any;
        constructor(public context: any) { Object.assign(this, context); }
        checkPerm() { if (!this.user._id) throw new SubmitError('请登录', 403); }
        checkPriv() { this.checkPerm(); }
    }
    class NativeSubmission extends Handler {
        pid = 0;
        async __prepare(domainId: string, contestId: string) {
            const status = await table('status').findOne({ domainId, docId: contestId, members: this.user._id, attend: 1 });
            if (!status) throw new SubmitError('未参赛', 403);
        }
        async _prepare(_domain: string, pid: number) { this.pid = pid; }
        async prepare() {}
        async post(domainId: string, lang: string, code: string, _pretest: boolean, _input: string[], contest: string) {
            if (!langs[lang]) throw new SubmitError('题目不接受此语言');
            const rid = id();
            await table('record').insertOne({ _id: rid, domainId, contest, uid: this.user._id, pid: this.pid, lang, code, status: 0 });
            this.response.redirect = '/record/' + rid;
            this.response.body = { rid };
        }
    }
    class NativePrint extends NativeSubmission {
        async prepare() { if (!tdoc.allowPrint) throw new SubmitError('比赛未开放打印', 403); }
        async postPrint(domainId: string, docId: string, title: string, content: string) {
            await table('print').insertOne({ _id: id(), domainId, docId, uid: this.user._id, title, content });
        }
    }
    const host = {
        Handler, ObjectId: Id, NotFoundError: class extends SubmitError { constructor() { super('比赛不存在', 404); } },
        PERM: {}, PRIV: {}, SystemModel: { get: () => 128 * 1024 }, SettingModel: { langs },
        ContestModel: { RULES: { acm: {} }, getMulti: (domainId: string, query: any) => table('document').find({ domainId, ...query }),
            getMultiStatus: (domainId: string, query: any) => table('status').find({ domainId, ...query }),
            get: (domainId: string, docId: unknown) => table('document').findOne({ domainId, docId: String(docId) }),
            canShowSelfRecord: (c: { hideSelfRecord?: boolean }) => !c.hideSelfRecord, canShowScoreboard: () => true, isOngoing: (c: any, s: any) =>
                c.beginAt <= new Date() && new Date() < c.endAt && (!s.endAt || new Date() < s.endAt) },
        DomainModel: { get: async () => ({}) }, ProblemModel: { get: async () => ({ config: { type: 'default' } }) },
        DocumentModel: { TYPE_CONTEST: 30, collStatus: table('status') },
        RecordModel: { getMulti(domainId: string, query: any) {
            const cursor = table('record').find({ domainId, ...query });
            return { sort(order: any) { cursor.sort(order); return this; }, limit(count: number) { cursor.limit(count); return this; },
                async toArray() { return (await cursor.toArray()).map((r: any) => ({ ...r, _id: new Id(r._id) })); } };
        } },
    } as unknown as typeof import('hydrooj');
    const routes = new Map<string, any>();
    const ctx = { db, Route: (name: string, _path: string, cls: any) => routes.set(name, cls), on() {},
        withHandlerClass: (name: string, collect: (cls: any) => void) => collect(name === 'ContestPrint' ? NativePrint : NativeSubmission) } as unknown as Context;
    applySubmitApi(host, ctx, async () => null);
    return {
        db,
        async handle(request: IncomingMessage, response: ServerResponse, url: URL) {
            const api = /^\/d\/system\/xcpcio-submit\/([^/]+)$/.exec(url.pathname);
            const download = /^\/(?:d\/system\/)?contest\/(?:demo|68ea00000000000000000000)\/submit-client(?:\/([^/]+))?$/.exec(url.pathname);
            if (!api && !download) return false;
            const ip = normalizeIp(request.socket.remoteAddress || '');
            const mapping = await table('iplogin').findOne({ _id: ip });
            const user = { _id: mapping?.uid || 0, uname: 'team01', hasPriv: () => false, hasPerm: () => false, own: () => false };
            const headers: Record<string, string> = {};
            const res: any = { headers, addHeader(name: string, value: string) { headers[name] = value; } };
            const routeName = api ? 'xcpcio_submit_api' : download?.[1] ? 'contest_xcpcio_submit_download' : 'contest_xcpcio_submit_client';
            const Cls = routes.get(routeName);
            const input: any = { ip, host: request.headers.host, headers: request.headers, params: api ? { action: api[1] } : { tid, platform: download?.[1] },
                query: Object.fromEntries(url.searchParams), body: null };
            const h = new Cls({ request: input, user, session: { ipLoggedIn: mapping && ip }, response: res, protocol: 'http', origin: `http://${request.headers.host}` });
            try {
                const chunks: Buffer[] = [];
                let size = 0;
                for await (const chunk of request) {
                    size += chunk.length;
                    if (size > 2 * 1024 * 1024) throw new SubmitError('请求过大', 413);
                    chunks.push(Buffer.from(chunk));
                }
                if (size) {
                    try { input.body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new SubmitError('JSON 无效'); }
                }
                if (input.body?.operation) throw new SubmitError('没有这个操作', 405);
                if (h.prepare) await h.prepare();
                if (request.method === 'GET') await h.get();
                else if (api && request.method === 'POST') await h.post();
                else throw new SubmitError('不支持这个方法', 405);
            } catch (error) {
                if (h.onerror) await h.onerror(error);
                else { res.status = error instanceof SubmitError ? error.status : 500; res.body = String(error); }
            }
            if (res.disposition) headers['Content-Disposition'] = res.disposition;
            response.writeHead(res.status || 200, { ...headers, 'Content-Type': res.template ? 'text/html; charset=utf-8' : res.type || 'application/json' });
            response.end(res.template ? env.render(res.template, res.body) : Buffer.isBuffer(res.body) || typeof res.body === 'string' ? res.body : JSON.stringify(res.body));
            return true;
        },
    };
}
