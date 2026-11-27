import { randomBytes } from 'node:crypto';
import { ContestModel, type Context, Handler, NotFoundError, ObjectId, param, PERM, PRIV, type Tdoc, Types, UserModel } from 'hydrooj';
import { bindCollectedIp, collectDeadline, collectionAddress, collectOpen, collectSettings, type CollectSettings } from './ip-collect';
import type { ContestLinks } from './links';
import { ManageError } from './manage/users';
import { IP_LOGIN, normalizeIp } from './onsite';
import { formatClock, zoneLabel } from './time-zone';

declare module 'hydrooj' {
    interface Collections {
        'xcpcio.ipcollect': CollectSettings & { _id: string };
    }
}

const keyOf = (tdoc: Tdoc) => `${tdoc.domainId}/${tdoc.docId}`;
const urlOf = (tdoc: Tdoc) => `/d/${encodeURIComponent(tdoc.domainId)}/contest/${tdoc.docId}/ip-collect`;

export function applyIpCollection(ctx: Context, links: ContestLinks<Tdoc>, codeBase: string) {
    const settings = ctx.db.collection('xcpcio.ipcollect');
    const bindings = ctx.db.collection(IP_LOGIN as never);
    const get = (tdoc: Tdoc) => settings.findOne({ _id: keyOf(tdoc) });
    const summary = async (tdoc: Tdoc) => {
        const value = await get(tdoc);
        const deadline = collectDeadline(tdoc.beginAt);
        return { enabled: collectOpen(value, tdoc.beginAt), networks: value?.networks || [], deadline, url: urlOf(tdoc),
            deadlineText: `${formatClock(deadline)}（${zoneLabel(deadline)}）` };
    };
    const save = async (tdoc: Tdoc, enabled: boolean, networks: unknown) => {
        const value = collectSettings(enabled, networks, tdoc.beginAt);
        await settings.updateOne({ _id: keyOf(tdoc) }, { $set: value }, { upsert: true });
        return summary(tdoc);
    };
    links.add({ id: 'ip-collect', label: '机位 IP 收集', status: async tdoc => {
        const value = await get(tdoc);
        return { count: collectOpen(value, tdoc.beginAt) ? 1 : 0, issuedAt: value?.changedAt ?? null, url: urlOf(tdoc) };
    }, revoke: async tdoc => { await settings.updateOne({ _id: keyOf(tdoc) }, { $set: { enabled: false } }); return 0; } });
    ctx.on('contest/del', (domainId, tid) => settings.deleteOne({ _id: `${domainId}/${tid}` }));
    ctx.on('domain/delete', (domainId) => settings.deleteMany({ _id: new RegExp(`^${domainId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`) }));

    class CollectHandler extends Handler {
        noCheckPermView = true;
        notUsage = true;
        tdoc!: Tdoc;
        ip!: string;

        @param('tid', Types.ObjectId)
        async prepare(domainId: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'private, no-store');
            this.response.addHeader('Referrer-Policy', 'no-referrer');
            this.response.addHeader('X-Frame-Options', 'DENY');
            const tdoc = await ContestModel.get(domainId, tid);
            if (!tdoc || tdoc.rule !== 'acm') throw new NotFoundError('比赛不存在');
            this.tdoc = tdoc;
            this.ip = collectionAddress(await get(tdoc), tdoc.beginAt, this.request.ip);
        }

        async get() {
            const nonce = randomBytes(24).toString('hex');
            this.context.cookies.set('xcpcio_collect', nonce, { signed: false, httpOnly: true, sameSite: 'strict', secure: this.context.secure,
                path: this.context.originalPath || this.request.path, maxAge: Math.max(1, collectDeadline(this.tdoc.beginAt) - Date.now()) });
            this.response.template = 'xcpcio_ip_collect.html';
            this.response.body = { title: this.tdoc.title, codeBase, ip: this.ip, nonce };
        }

        @param('account', Types.String)
        @param('nonce', Types.String)
        async post(domainId: string, account: string, nonce: string) {
            await this.limitRate('xcpcio_ip_collect', 60, 8, normalizeIp(this.request.ip));
            if (!/^[a-f0-9]{48}$/.test(nonce) || nonce !== this.context.cookies.get('xcpcio_collect', { signed: false })) throw new ManageError('请重新打开登记页', 403);
            if (!account.trim() || account.length > 128) throw new ManageError('请输入本队登录账号');
            const user = await UserModel.getByUname(domainId, account);
            if (!user || user._id <= 1 || !user.hasPriv(PRIV.PRIV_USER_PROFILE) || user.hasPriv(PRIV.PRIV_EDIT_SYSTEM, PRIV.PRIV_JUDGE)
                || user.hasPerm(PERM.PERM_EDIT_CONTEST) || user.own(this.tdoc)) throw new ManageError('该账号不是本场可登记的参赛账号');
            const entry = await ContestModel.getMultiStatus(domainId, { docId: this.tdoc.docId, attend: { $gte: 1 }, $or: [{ uid: user._id }, { members: user._id }] }).next();
            if (!entry) throw new ManageError('该账号不是本场可登记的参赛账号');
            const name = entry.displayName || (entry.uid < 0 ? (await UserModel.getById(domainId, entry.uid))?.displayName : user.displayName) || user.uname;
            // The allowed range or schedule may change while resolving an account.
            collectionAddress(await get(this.tdoc), this.tdoc.beginAt, this.request.ip);
            await bindCollectedIp(bindings as never, keyOf(this.tdoc), this.ip, user._id);
            this.response.body = { name, account: user.uname, ip: this.ip };
        }

        async onerror(error: Parameters<Handler['onerror']>[0] | ManageError) {
            if (!(error instanceof ManageError)) return super.onerror(error);
            this.response.status = error.status;
            if (this.request.method === 'get') {
                this.response.template = 'xcpcio_ip_collect.html';
                this.response.body = { codeBase, title: this.tdoc?.title, closed: error.message };
            } else this.response.body = { error: error.message };
        }
    }
    ctx.Route('contest_xcpcio_ip_collect', '/contest/:tid/ip-collect', CollectHandler);
    return { summary, save };
}
