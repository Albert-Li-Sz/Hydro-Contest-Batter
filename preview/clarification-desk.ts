import { randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Environment } from 'nunjucks';
import {
    activeDeskClaim, clarificationAnnouncements, clarificationClaimMs, ClarificationDeskError,
    deskSettings, deskView, firstDeskReply, isDeskWrite, readDeskSettings, readDeskSubject, readDeskText,
    type DeskActor, type DeskClaim, type DeskClarification,
} from '../lib/clarification-desk';
import { resolverCodeBase } from '../lib/resolver-data';
import { toScriptJson } from '../lib/settings';

const base = '/contest/demo';
const desk = `${base}/clarification-desk`;
const title = 'Hydro XCPCIO · 功能演示';
const pids = [101, 102, 103];
const subjects = [
    { pid: 0, label: '通用' }, { pid: -1, label: '技术问题' },
    { pid: 101, label: 'A · 热身题' }, { pid: 102, label: 'B · 星际旅行' }, { pid: 103, label: 'C · 排列组合' },
];
const identity = new Map([
    [1, { name: '林澈', seat: 'A-01' }], [2, { name: '陈言', seat: 'A-02' }], [3, { name: '周宁', seat: 'B-01' }],
]);
const judge: DeskActor = { id: 'preview:manager', label: '比赛管理员', pid: null };
function docId(at: number) {
    const id = randomBytes(12).toString('hex');
    return { toString: () => id, getTimestamp: () => new Date(at) };
}

export function createClarificationPreview(env: Environment, version: string, publishLive: (text: string) => unknown) {
    const started = Date.now();
    const codeBase = resolverCodeBase(version);
    const entries: DeskClarification[] = [
        { docId: docId(started - 2 * 60_000), owner: 0, subject: 0, content: '请各队核对座位号和队伍名。如有疑问，请通过比赛页面向裁判提问。' },
        { docId: docId(started - 3 * 60_000), owner: 2, subject: 102, content: '输入里的地点编号是否从 0 开始？' },
        { docId: docId(started - 6 * 60_000), owner: 1, subject: 101, content: '样例中的一行包含空格，需要逐字符读取吗？' },
        { docId: docId(started - 7 * 60_000), owner: 3, subject: -1, content: 'B-01 机位的字体显示异常，能否换一个浏览器？' },
        { docId: docId(started - 10 * 60_000), owner: 1, subject: 0, content: '比赛期间可以打印题面吗？',
            reply: [{ _id: docId(started - 9 * 60_000), owner: 0, content: '请仔细阅读竞赛规则。' }] },
    ];
    const claims = new Map<string, DeskClaim>();
    const links = new Map<string, { label: string; pid: number; token: string }>();
    let settings = deskSettings();
    const freezeAt = started + 90 * 60_000;
    const endAt = started + 120 * 60_000;
    const publish = (text: string, subject: number, live: boolean) => {
        entries.unshift({ docId: docId(Date.now()), owner: 0, subject, content: text });
        if (live) publishLive(text);
    };

    async function handle(request: IncomingMessage, response: ServerResponse, url: URL) {
        const route = /^\/contest\/demo\/clarification-desk(?:\/jury\/([a-f\d]{48}))?(\/data)?$/.exec(url.pathname);
        if (!route) return false;
        const json = (body: unknown, status = 200) => response.writeHead(status, {
            'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
        }).end(JSON.stringify(body));
        try {
            const secret = route[1];
            const assignment = secret && [...links].find(([, link]) => link.token === secret);
            if (secret && !assignment) throw new ClarificationDeskError('答疑员链接已失效', 404);
            const actor = assignment ? { id: assignment[0], label: assignment[1].label, pid: assignment[1].pid } : judge;
            const manager = actor.pid === null;
            const now = Date.now();
            if (!route[2] && request.method === 'GET') {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
                    .end(env.render('xcpcio_clarification_desk.html', {
                        codeBase, tdoc: { title }, manager, runtimeJson: toScriptJson({
                            title, manager, dataUrl: `${url.pathname}/data`, nativeUrl: `${base}/problems`,
                            contestUrl: `${base}/xcpcio-public`, live: manager, announcementTemplates: clarificationAnnouncements,
                        }),
                    }));
                return true;
            }
            if (route[2] && request.method === 'GET') {
                const snapshot = deskView(entries, subjects, identity, claims, actor, now);
                json({ ...snapshot, now, viewer: actor.label, ...manager ? { settings, freeze: { at: freezeAt, sent: false }, endAt,
                    links: [...links].map(([id, link]) => ({ id, label: link.label, pid: link.pid, url: `${desk}/jury/${link.token}` })) } : { replies: settings.replies } });
                return true;
            }
            if (!route[2] || request.method !== 'POST') throw new ClarificationDeskError('请求地址无效', 404);
            if (!isDeskWrite(request.headers.host || '', request.headers)) throw new ClarificationDeskError('请在答疑台页面提交操作', 403);
            let body = '';
            for await (const chunk of request) {
                body += chunk;
                if (body.length > 40000) throw new ClarificationDeskError('请求内容过大');
            }
            const payload = JSON.parse(new URLSearchParams(body).get('payload') || '{}');
            if (['claim', 'reply', 'release'].includes(payload.action)) {
                const item = entries.find((entry) => String(entry.docId) === payload.id && entry.owner
                    && (manager || actor.pid === entry.subject));
                if (!item) throw new ClarificationDeskError('找不到这条提问', 404);
                if (firstDeskReply(item)) throw new ClarificationDeskError('这条提问已回复', 409);
                const claim = activeDeskClaim(claims.get(payload.id), now);
                if (payload.action === 'release') {
                    if (manager || claim?.actor === actor.id) claims.delete(payload.id);
                } else {
                    if (claim && claim.actor !== actor.id) throw new ClarificationDeskError('这条提问正由其他裁判处理', 409);
                    if (payload.action === 'reply') {
                        const text = readDeskText(payload.text);
                        const publicText = payload.public === true ? readDeskText(payload.publicText, '公开公告内容') : '';
                        item.reply = [...item.reply ?? [], { _id: docId(now), owner: 0, content: text }];
                        claims.delete(payload.id);
                        if (publicText) publish(publicText, item.subject, manager && payload.live === true);
                    } else claims.set(payload.id, { actor: actor.id, name: actor.label, at: now, until: now + clarificationClaimMs });
                }
            } else if (!manager) throw new ClarificationDeskError('答疑员链接仅能处理所分配题目的提问', 403);
            else if (payload.action === 'announce') publish(readDeskText(payload.text, '公告'), readDeskSubject(payload.subject, pids, true), payload.live === true);
            else if (payload.action === 'settings') settings = readDeskSettings(payload.settings);
            else if (payload.action === 'link-create') {
                const label = readDeskText(payload.label, '答疑员名称', 60);
                const pid = readDeskSubject(payload.pid, pids);
                links.set(randomBytes(12).toString('hex'), { label, pid, token: randomBytes(24).toString('hex') });
            } else if (payload.action === 'link-rotate' || payload.action === 'link-remove') {
                const link = links.get(payload.id);
                if (!link) throw new ClarificationDeskError('找不到这条答疑员链接', 404);
                if (payload.action === 'link-rotate') link.token = randomBytes(24).toString('hex');
                else links.delete(payload.id);
            } else throw new ClarificationDeskError('请求操作无效');
            json({ ok: true });
        } catch (error) {
            json({ error: error instanceof Error ? error.message : '请求失败' }, error instanceof ClarificationDeskError ? error.status : 400);
        }
        return true;
    }

    return { handle, announcements: () => entries.filter((item) => item.owner === 0) };
}
