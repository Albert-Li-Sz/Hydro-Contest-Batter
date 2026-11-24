import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
    ContestModel, Context, DocumentModel, getAlphabeticId, Handler, MessageModel, NotFoundError, ObjectId,
    param, PERM, ProblemModel, Tdoc, Types, UserModel,
} from 'hydrooj';
import {
    clarificationAnnouncements, clarificationClaimMs, ClarificationDeskError, deskSettings, deskView, firstDeskReply,
    freezeNotice, isDeskWrite, readDeskSettings, readDeskSubject, readDeskText,
    type DeskActor, type DeskClaim, type DeskSettings,
} from './clarification-desk';
import type { ContestLinks } from './links';
import { seatOf } from './print';
import { resolverCodeBase } from './resolver-data';
import { toScriptJson } from './settings';
import { describeTeam, isTeamEntry, loadSeats, memberIds, type TeamEntry } from './teams';

interface SettingsDoc {
    _id: string;
    domainId: string;
    tid: ObjectId;
    settings: DeskSettings;
    checkAt: Date | null;
    checkedFreeze?: number;
    reminder?: { lock: number; id: ObjectId };
}
interface LinkDoc {
    _id: ObjectId;
    contest: string;
    label: string;
    pid: number;
    token: string;
    tokenAt: Date;
}
interface ClaimDoc extends DeskClaim {
    _id: string;
    contest: string;
    expiresAt: Date;
}
declare module 'hydrooj' {
    interface Collections {
        'xcpcio.clarification.settings': SettingsDoc;
        'xcpcio.clarification.links': LinkDoc;
        'xcpcio.clarification.claims': ClaimDoc;
    }
}

type Question = NonNullable<Awaited<ReturnType<typeof ContestModel.getClarification>>>;
const keyOf = (tdoc: Tdoc) => `${tdoc.domainId}/${tdoc.docId}`;
const baseOf = (tdoc: Tdoc) => `/d/${encodeURIComponent(tdoc.domainId)}/contest/${tdoc.docId}`;
const token = () => randomBytes(24).toString('hex');
const duplicate = (error: unknown) => (error as { code?: number } | null)?.code === 11000;
const isManager = (handler: Handler, tdoc: Tdoc) => !!handler.user._id
    && (handler.user.own(tdoc) || handler.user.hasPerm(PERM.PERM_EDIT_CONTEST));

function readId(value: unknown) {
    if (typeof value !== 'string' || !/^[a-f\d]{24}$/i.test(value)) throw new ClarificationDeskError('编号无效');
    return new ObjectId(value);
}

function nextFreezeCheck(tdoc: Tdoc, minutes: number, checked: number | undefined, now = Date.now()) {
    const lock = tdoc.lockAt?.getTime() ?? 0;
    const start = tdoc.beginAt.getTime();
    if (!minutes || tdoc.unlocked || lock <= Math.max(start, now) || lock >= tdoc.endAt.getTime() || checked === lock) return null;
    return new Date(Math.max(start, lock - minutes * 60_000));
}

export function applyClarificationDesk(ctx: Context, dependencies: {
    links: ContestLinks<Tdoc>;
    liveTicker?: (tdoc: Tdoc, content: string) => Promise<unknown>;
}) {
    const codeBase = resolverCodeBase(JSON.parse(readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version);
    const settings = ctx.db.collection('xcpcio.clarification.settings');
    const links = ctx.db.collection('xcpcio.clarification.links');
    const claims = ctx.db.collection('xcpcio.clarification.claims');
    const native = ctx.db.collection('document');

    ctx.on('app/started', async () => {
        await Promise.all([
            settings.createIndex({ checkAt: 1 }),
            links.createIndex({ contest: 1, token: 1 }),
            claims.createIndex({ contest: 1, until: 1 }),
            claims.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
        ]);
    });

    dependencies.links.add({
        id: 'clarification-desk', label: '答疑员',
        async status(tdoc) {
            const contest = keyOf(tdoc);
            const docs = await links.find({ contest, pid: { $in: tdoc.pids } }, { projection: { tokenAt: 1 } }).sort({ tokenAt: -1 }).toArray();
            return { count: docs.length, issuedAt: docs[0]?.tokenAt ?? null };
        },
        async revoke(tdoc) {
            const contest = keyOf(tdoc);
            const docs = await links.find({ contest, pid: { $in: tdoc.pids } }, { projection: { _id: 1 } }).toArray();
            const updated = await Promise.all(docs.map(({ _id }) => links.updateOne({ _id, contest }, { $set: { token: token(), tokenAt: new Date() } })));
            return updated.reduce((count, result) => count + result.matchedCount, 0);
        },
    });

    async function announce(tdoc: Tdoc, content: string, subject: number, ip: string, id?: ObjectId) {
        const { domainId, docId } = tdoc;
        try {
            if (id) {
                // Same native clarification shape, with a stable ID for any process retrying this reminder.
                await DocumentModel.add(domainId, content, 0, DocumentModel.TYPE_CONTEST_CLARIFICATION,
                    id, DocumentModel.TYPE_CONTEST, docId, { ip, subject, _id: id });
            } else await ContestModel.addClarification(domainId, docId, 0, content, ip, subject);
        } catch (error) {
            if (id && duplicate(error)) return {};
            throw error;
        }
        try {
            const subscribed = await ContestModel.getMultiStatus(domainId, { docId, subscribe: 1 }).project({ uid: 1 }).toArray();
            await MessageModel.send(1, [...new Set(subscribed.map(({ uid }) => uid))], JSON.stringify({
                message: 'Broadcast message from contest {0}:\n{1}', params: [tdoc.title, content], url: `${baseOf(tdoc)}/problems`,
            }), (ContestModel.isOngoing(tdoc) ? MessageModel.FLAG_ALERT : MessageModel.FLAG_UNREAD) | MessageModel.FLAG_I18N);
            return {};
        } catch {
            return { warning: '公告已发布，Hydro 站内通知发送失败。' };
        }
    }

    async function automaticNotices() {
        const now = Date.now();
        const due = await settings.find({ checkAt: { $type: 'date', $lte: new Date(now) } }).sort({ checkAt: 1 }).limit(50).toArray();
        for (const doc of due) {
            try {
                const tdoc = await ContestModel.get(doc.domainId, doc.tid);
                if (!tdoc) {
                    await settings.deleteOne({ _id: doc._id, checkAt: doc.checkAt });
                    continue;
                }
                const minutes = doc.settings.freezeMinutes;
                const lock = freezeNotice(tdoc.beginAt.getTime(), tdoc.lockAt?.getTime() ?? 0, tdoc.endAt.getTime(), minutes, now, !!tdoc.unlocked);
                const filter = { _id: doc._id, checkAt: doc.checkAt, 'settings.freezeMinutes': minutes, checkedFreeze: doc.checkedFreeze ?? { $exists: false } };
                if (lock === null || doc.checkedFreeze === lock) {
                    await settings.updateOne(filter, { $set: { checkAt: nextFreezeCheck(tdoc, minutes, doc.checkedFreeze, now) } });
                    continue;
                }
                // Keep one native document ID even if PM2 workers race or the lead time changes.
                // The ID survives a restart between publication and updating this schedule.
                const reminder = doc.reminder?.lock === lock ? doc.reminder : (await settings.findOneAndUpdate(
                    { ...filter, 'reminder.lock': { $ne: lock } },
                    { $set: { reminder: { lock, id: new ObjectId() } } }, { returnDocument: 'after' },
                ))?.reminder;
                if (!reminder) continue;
                // Contestants read Beijing time, as on the results page (lib/results-page.ts).
                const time = new Intl.DateTimeFormat('zh-CN', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(lock);
                await announce(tdoc, `封榜提醒：本场比赛将于 ${time} 封榜（约 ${Math.ceil((lock - now) / 60_000)} 分钟后）。封榜期间仍可正常提交。`, 0, '', reminder.id);
                await settings.updateOne(filter, { $set: { checkAt: null, checkedFreeze: lock } });
            } catch { /* A temporarily unavailable contest or database is retried in the next run. */ }
        }
    }
    const timer = setInterval(() => { void automaticNotices().catch(() => undefined); }, 10_000);
    timer.unref?.();
    ctx.effect(() => () => clearInterval(timer));
    ctx.on('contest/edit', async (tdoc) => {
        const doc = await settings.findOne({ _id: keyOf(tdoc) });
        if (doc) await settings.updateOne({ _id: doc._id, 'settings.freezeMinutes': doc.settings.freezeMinutes }, {
            $set: { checkAt: nextFreezeCheck(tdoc, doc.settings.freezeMinutes, doc.checkedFreeze) },
        });
    });
    ctx.on('contest/del', async (domainId, tid) => {
        const contest = `${domainId}/${tid}`;
        await Promise.all([settings.deleteOne({ _id: contest }), links.deleteMany({ contest }), claims.deleteMany({ contest })]);
    });

    const deskData = new Map<string, { until: number; promise: ReturnType<typeof readDesk> }>();
    async function readDesk(tdoc: Tdoc) {
        const docs = await ContestModel.getMultiClarification(tdoc.domainId, tdoc.docId);
        const owners = [...new Set(docs.map((doc) => doc.owner).filter(Boolean))];
        const [entries, pdict] = await Promise.all([
            owners.length ? ContestModel.getMultiStatus(tdoc.domainId, { docId: tdoc.docId, $or: [{ uid: { $in: owners } }, { members: { $in: owners } }] })
                .project<TeamEntry>({ uid: 1, members: 1, displayName: 1 }).toArray() : [],
            ProblemModel.getList(tdoc.domainId, tdoc.pids, true, false, ['docId', 'title'], true),
        ]);
        const uids = [...new Set([...owners, ...entries.map(({ uid }: TeamEntry) => uid), ...memberIds(tdoc, entries)])];
        const [people, seats] = uids.length ? await Promise.all([UserModel.getList(tdoc.domainId, uids), loadSeats(ctx.db, uids)])
            : [{}, new Map<number, string>()] as const;
        const teamOfUser = new Map<number, TeamEntry>();
        for (const entry of entries) {
            teamOfUser.set(entry.uid, entry);
            if (isTeamEntry(entry)) for (const uid of entry.members) teamOfUser.set(uid, entry);
        }
        const identities = new Map(owners.map((uid) => {
            const team = teamOfUser.get(uid) || { uid };
            return [uid, {
                name: describeTeam(team, people, false)?.name ?? `账号 #${uid}`,
                seat: seatOf(seats, team.uid, isTeamEntry(team) ? team.members : []),
            }] as const;
        }));
        const subjects = [{ pid: 0, label: '通用' }, { pid: -1, label: '技术问题' }, ...tdoc.pids.map((pid, index) => ({
            pid, label: [getAlphabeticId(index), pdict[pid]?.title].filter(Boolean).join(' · '),
        }))];
        return { docs, identities, subjects };
    }

    function source(tdoc: Tdoc) {
        const now = Date.now();
        const name = keyOf(tdoc);
        const cached = deskData.get(name);
        if (cached && cached.until > now) return cached.promise;
        for (const [key, item] of deskData) if (item.until <= now) deskData.delete(key);
        const promise = readDesk(tdoc);
        deskData.set(name, { until: now + 3000, promise });
        promise.catch(() => { if (deskData.get(name)?.promise === promise) deskData.delete(name); });
        return promise;
    }

    async function view(tdoc: Tdoc, actor: DeskActor) {
        const contest = keyOf(tdoc);
        const now = Date.now();
        const [{ docs, identities, subjects }, currentClaims, config, assignments] = await Promise.all([
            source(tdoc), claims.find({ contest, until: { $gt: now } }).toArray(), settings.findOne({ _id: contest }),
            actor.pid === null ? links.find({ contest }).sort({ tokenAt: -1 }).toArray() : [],
        ]);
        const summary = deskView(docs, subjects, identities, new Map(currentClaims.map((claim) => [claim._id.split('/').pop()!, claim])), actor, now);
        return {
            ...summary, now, viewer: actor.label,
            ...actor.pid === null ? {
                settings: deskSettings(config?.settings),
                freeze: { at: tdoc.lockAt?.getTime() ?? null, sent: config?.checkedFreeze === tdoc.lockAt?.getTime() && !!tdoc.lockAt },
                endAt: tdoc.endAt.getTime(),
                links: assignments.map((assignment) => ({
                    id: String(assignment._id), label: assignment.label, pid: assignment.pid,
                    url: tdoc.pids.includes(assignment.pid) ? `${baseOf(tdoc)}/clarification-desk/jury/${assignment.token}` : null,
                })),
            } : { replies: deskSettings(config?.settings).replies },
        };
    }

    async function getQuestion(tdoc: Tdoc, actor: DeskActor, id: ObjectId): Promise<Question> {
        const question = await ContestModel.getClarification(tdoc.domainId, id);
        if (!question || !question.owner || String(question.parentId) !== String(tdoc.docId)
            || (actor.pid !== null && question.subject !== actor.pid)) throw new ClarificationDeskError('找不到这条提问', 404);
        if (firstDeskReply(question)) throw new ClarificationDeskError('这条提问已回复', 409);
        return question;
    }

    async function claim(tdoc: Tdoc, actor: DeskActor, id: ObjectId) {
        const contest = keyOf(tdoc);
        const now = Date.now();
        const until = now + clarificationClaimMs;
        try {
            await claims.updateOne({ _id: `${contest}/${id}`, $or: [{ until: { $lte: now } }, { actor: actor.id }] }, {
                $set: { contest, actor: actor.id, name: actor.label, at: now, until, expiresAt: new Date(until) },
            }, { upsert: true });
        } catch (error) {
            if (duplicate(error)) throw new ClarificationDeskError('这条提问正由其他裁判处理', 409);
            throw error;
        }
    }

    async function action(handler: Handler, tdoc: Tdoc, actor: DeskActor, payload: Record<string, unknown>) {
        const contest = keyOf(tdoc);
        const manager = actor.pid === null;
        const requestIp = handler.request.ip;
        const operation = payload.action;
        const live = manager && payload.live === true;
        if (live && !dependencies.liveTicker) throw new ClarificationDeskError('本站未启用直播');
        const pushLive = async (text: string) => {
            if (!live) return '';
            try {
                await dependencies.liveTicker!(tdoc, text);
                return '';
            } catch {
                return '公告已发布，直播滚动条推送失败。';
            }
        };
        if (operation === 'claim' || operation === 'release' || operation === 'reply') {
            const id = readId(payload.id);
            const question = await getQuestion(tdoc, actor, id);
            if (operation === 'release') {
                await claims.deleteOne({ _id: `${contest}/${id}`, ...manager ? {} : { actor: actor.id } });
                return {};
            }
            if (operation === 'claim') {
                await claim(tdoc, actor, id);
                return {};
            }
            const text = readDeskText(payload.text, '私下回复');
            const publicText = payload.public === true ? readDeskText(payload.publicText, '公开公告内容') : '';
            if (live && !publicText) throw new ClarificationDeskError('直播滚动条仅接收公开公告');
            await claim(tdoc, actor, id);
            const replyId = new ObjectId();
            // Same reply item as Hydro's addClarificationReply. A conditional push also rejects a
            // native reply recorded after our read and ensures two desk replies cannot both succeed.
            const updated = await native.updateOne({
                domainId: tdoc.domainId, docType: DocumentModel.TYPE_CONTEST_CLARIFICATION, parentType: DocumentModel.TYPE_CONTEST,
                parentId: tdoc.docId, docId: id, owner: question.owner, subject: question.subject,
                reply: { $not: { $elemMatch: { owner: { $ne: question.owner } } } },
            }, { $push: { reply: { _id: replyId, owner: 0, content: text, ip: requestIp } } as never });
            if (!updated.modifiedCount) throw new ClarificationDeskError('这条提问已回复或已移除', 409);
            deskData.delete(contest);
            const warnings: string[] = [];
            await MessageModel.send(1, question.owner, JSON.stringify({
                message: 'Contest {0} jury replied to your clarification, please go to contest page to view.',
                params: [tdoc.title], url: `${baseOf(tdoc)}/problems`,
            }), MessageModel.FLAG_I18N | MessageModel.FLAG_ALERT).catch(() => { warnings.push('回复已保存，Hydro 站内通知发送失败。'); });
            if (publicText) {
                try {
                    const published = await announce(tdoc, publicText, question.subject, requestIp, replyId);
                    if (published.warning) warnings.push(published.warning);
                    const tickerWarning = await pushLive(publicText);
                    if (tickerWarning) warnings.push(tickerWarning);
                    deskData.delete(contest);
                } catch {
                    warnings.push('私下回复已保存，全体公告发布失败。请联系比赛管理员重新发布。');
                }
            }
            return { warning: warnings.join(' ') };
        }
        if (!manager) throw new ClarificationDeskError('答疑员链接仅能处理所分配题目的提问', 403);
        if (operation === 'settings') {
            const saved = readDeskSettings(payload.settings);
            const existing = await settings.findOne({ _id: contest });
            await settings.updateOne({ _id: contest }, {
                $set: { domainId: tdoc.domainId, tid: tdoc.docId, settings: saved, checkAt: nextFreezeCheck(tdoc, saved.freezeMinutes, existing?.checkedFreeze) },
            }, { upsert: true });
            return {};
        }
        if (operation === 'link-create') {
            const pid = readDeskSubject(payload.pid, tdoc.pids);
            const label = readDeskText(payload.label, '答疑员名称', 60);
            if (await links.countDocuments({ contest }, { limit: 200 }) >= 200) throw new ClarificationDeskError('此比赛最多可生成 200 个答疑员链接');
            await links.insertOne({ _id: new ObjectId(), contest, pid, label, token: token(), tokenAt: new Date() });
            return {};
        }
        if (operation === 'link-rotate' || operation === 'link-remove') {
            const _id = readId(payload.id);
            const target = { _id, contest };
            const updated = operation === 'link-rotate'
                ? (await links.updateOne(target, { $set: { token: token(), tokenAt: new Date() } })).matchedCount
                : (await links.deleteOne(target)).deletedCount;
            if (!updated) throw new ClarificationDeskError('找不到这条答疑员链接', 404);
            if (operation === 'link-remove') await claims.deleteMany({ contest, actor: `link:${_id}` });
            return {};
        }
        if (operation === 'announce') {
            const subject = readDeskSubject(payload.subject, tdoc.pids, true);
            const text = readDeskText(payload.text, '公告');
            const published = await announce(tdoc, text, subject, requestIp);
            deskData.delete(contest);
            return { warning: [published.warning, await pushLive(text)].filter(Boolean).join(' ') };
        }
        throw new ClarificationDeskError('请求操作无效');
    }

    abstract class DeskBase extends Handler {
        tdoc!: Tdoc;
        actor!: DeskActor;
        base!: string;

        async load(tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            this.response.addHeader('Referrer-Policy', 'no-referrer');
            const tdoc = await ContestModel.get(this.domain._id, tid);
            if (!tdoc || tdoc.rule !== 'acm') throw new NotFoundError('Contest not found');
            this.tdoc = tdoc;
            this.base = `${baseOf(tdoc)}/clarification-desk`;
        }

        page() {
            const manager = this.actor.pid === null;
            this.response.template = 'xcpcio_clarification_desk.html';
            this.response.body = {
                tdoc: this.tdoc, codeBase, manager,
                runtimeJson: toScriptJson({
                    title: this.tdoc.title, manager, dataUrl: `${this.base}/data`, contestUrl: baseOf(this.tdoc),
                    nativeUrl: `${baseOf(this.tdoc)}/clarification`,
                    live: manager && !!dependencies.liveTicker, announcementTemplates: clarificationAnnouncements,
                }),
            };
        }

        async data() { this.response.body = await view(this.tdoc, this.actor); }

        @param('payload', Types.String)
        async post(_domainId: string, raw: string) {
            if (!this.request.path.endsWith('/data')) throw new ClarificationDeskError('请求地址无效', 404);
            // The delegate page suppresses Referer to keep the link secret. Browser writes still
            // have to come from the site's own fetch, even if Hydro was configured for CORS.
            if (!isDeskWrite(this.request.host, this.request.headers)) throw new ClarificationDeskError('请在答疑台页面提交操作', 403);
            if (raw.length > 12000) throw new ClarificationDeskError('请求内容过大');
            let payload: unknown;
            try { payload = JSON.parse(raw); } catch { throw new ClarificationDeskError('请求格式无效'); }
            if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new ClarificationDeskError('请求格式无效');
            this.response.body = { ok: true, ...await action(this, this.tdoc, this.actor, payload as Record<string, unknown>) };
        }

        async onerror(error: Parameters<Handler['onerror']>[0] | ClarificationDeskError) {
            if (error instanceof ClarificationDeskError) {
                this.response.status = error.status;
                this.response.body = { error: error.message };
                return;
            }
            return super.onerror(error);
        }
    }

    class ManagerPage extends DeskBase {
        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            await this.load(tid);
            if (!isManager(this, this.tdoc)) throw new ClarificationDeskError('请登录比赛管理账号', 403);
            this.actor = { id: `user:${this.user._id}`, label: this.user.displayName || this.user.uname, pid: null };
        }

        get() { this.page(); }
    }
    class ManagerData extends ManagerPage {
        async get() { await this.data(); }
    }
    class DelegatePage extends DeskBase {
        @param('tid', Types.ObjectId)
        @param('token', Types.String)
        async prepare(_domainId: string, tid: ObjectId, secret: string) {
            await this.load(tid);
            const link = /^[a-f\d]{48}$/.test(secret)
                ? await links.findOne({ contest: keyOf(this.tdoc), token: secret, pid: { $in: this.tdoc.pids } }) : null;
            if (!link) throw new NotFoundError('答疑员链接已失效');
            this.actor = { id: `link:${link._id}`, label: link.label, pid: link.pid };
            this.base += `/jury/${secret}`;
        }

        get() { this.page(); }
    }
    class DelegateData extends DelegatePage {
        async get() { await this.data(); }
    }

    ctx.Route('contest_xcpcio_clarification_desk', '/contest/:tid/clarification-desk', ManagerPage);
    ctx.Route('contest_xcpcio_clarification_desk_data', '/contest/:tid/clarification-desk/data', ManagerData);
    ctx.Route('contest_xcpcio_clarification_delegate', '/contest/:tid/clarification-desk/jury/:token', DelegatePage);
    ctx.Route('contest_xcpcio_clarification_delegate_data', '/contest/:tid/clarification-desk/jury/:token/data', DelegateData);
    ctx.i18n.load('zh', { contest_xcpcio_clarification_desk: '答疑与公告', contest_xcpcio_clarification_delegate: '答疑与公告' });
    return { automaticNotices };
}
