import type { Context, ContestStatusDoc, Handler as HydroHandler, Tdoc } from 'hydrooj';
import type { ContestPrintHandler } from 'hydrooj/src/handler/contest';
import type { ProblemSubmitHandler } from 'hydrooj/src/handler/problem';
import { createCcsSourceLoader } from './ccs/source';
import { heldProblems, type JuryState } from './jury';
import { workerOrigin } from './reactions-connection';
import { IP_LOGIN, type IpLoginDoc, normalizeIp } from './onsite';
import { alphabeticId, describeLanguage, labelOf, parsePrint, parseSubmit, pickContest, problemByLabel, requireIpLogin, statusOf, SubmitError } from './submit';
import { submitDownload, submitDownloads } from './submit-download';

interface Entry { title: string; tid: string; tdoc: Tdoc; status: ContestStatusDoc }
const downloadPath = (tdoc: Tdoc) => `/d/${encodeURIComponent(tdoc.domainId)}/contest/${tdoc.docId}/submit-client`;

export function applySubmitApi(host: typeof import('hydrooj'), ctx: Context, loadJury: (tdoc: Tdoc) => Promise<JuryState | null>) {
    const { ContestModel, DocumentModel, Handler, NotFoundError, ObjectId, PERM, PRIV, ProblemModel, RecordModel, SettingModel, SystemModel, UserModel } = host;
    async function participantContests(handler: HydroHandler): Promise<Entry[]> {
        const domain = handler.domain._id, uid = handler.user._id, now = new Date();
        const contests = await ContestModel.getMulti(domain, { beginAt: { $lte: now }, endAt: { $gt: now }, rule: { $ne: 'homework' } }).toArray();
        const statuses = await ContestModel.getMultiStatus(domain, { docId: { $in: contests.map(c => c.docId) }, $or: [{ uid }, { members: uid }] }).toArray();
        const groups = contests.some(c => c.assign?.length) ? (await UserModel.listGroup(domain, uid)).map(g => g.name) : [];
        const entries: Entry[] = [];
        for (const tdoc of contests) {
            if (!ContestModel.RULES[tdoc.rule] || ContestModel.RULES[tdoc.rule].hidden) continue;
            if (tdoc.assign?.length && !handler.user.own(tdoc) && !handler.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)
                && !tdoc.assign.some(group => groups.includes(group))) continue;
            const enrolled = statuses.filter(s => String(s.docId) === String(tdoc.docId));
            const status = (tdoc.allowTeam && enrolled.find(s => s.members?.includes(uid))) || enrolled.find(s => s.uid === uid);
            if (status?.attend && (!status.startAt || status.startAt <= now) && ContestModel.isOngoing(tdoc, status)) {
                entries.push({ title: tdoc.title, tid: String(tdoc.docId), tdoc, status });
            }
        }
        return entries;
    }

    const bindings = ctx.db.collection(IP_LOGIN as never);
    const { problemLanguages } = createCcsSourceLoader(host);
    let submission: ProblemSubmitHandler, printing: ContestPrintHandler;
    ctx.withHandlerClass('ProblemSubmit', cls => { submission = cls.prototype as ProblemSubmitHandler; });
    ctx.withHandlerClass('ContestPrint', cls => { printing = cls.prototype as ContestPrintHandler; });

    class SubmitApiHandler extends Handler {
        noCheckPermView = true;

        async prepare() {
            this.response.addHeader('Cache-Control', 'no-store');
            this.response.type = 'application/json';
            const ip = normalizeIp(this.request.ip);
            const binding = await bindings.findOne<IpLoginDoc>({ _id: ip } as never, { projection: { uid: 1 } });
            requireIpLogin(ip, this.session.ipLoggedIn, this.user._id, binding?.uid, this.request.headers);
            if (this.request.headers.origin && this.request.headers.origin !== this.context.origin) throw new SubmitError('跨站请求被拒绝', 403);
            if (!this.user.hasPriv(PRIV.PRIV_VIEW_ALL_DOMAIN)) this.checkPerm(PERM.PERM_VIEW);
            this.checkPerm(PERM.PERM_VIEW_CONTEST);
            this.checkPriv(PRIV.PRIV_USER_PROFILE);
        }

        async get() {
            const entries = await participantContests(this);
            const domain = this.domain._id;
            const { action } = this.request.params;
            if (action === 'info') {
                const contests = await Promise.all(entries.map(async ({ title, tid, tdoc }) => ({
                    title, tid, canPrint: !!tdoc.allowPrint,
                    problems: await Promise.all(tdoc.pids.map(async (pid, index) => {
                        const pdoc = await ProblemModel.get(domain, pid);
                        const keys = pdoc ? await problemLanguages(tdoc, pdoc) : [];
                        return { label: alphabeticId(index), languages: keys.map(key => describeLanguage(key, SettingModel.langs[key])) };
                    })),
                })));
                this.response.body = { account: { uid: this.user._id, name: this.user.uname }, contests };
                return;
            }
            if (action !== 'status') throw new SubmitError('没有这个读操作', 404);
            const { tdoc, status } = pickContest(entries, this.request.query.tid || null, '查看');
            if (!ContestModel.canShowSelfRecord.call(this, tdoc) || !ContestModel.canShowScoreboard.call(this, tdoc)) {
                this.response.body = { hidden: true, records: [] };
                return;
            }
            const members = tdoc.allowTeam && status.members?.includes(this.user._id) ? status.members : [this.user._id];
            const [holds, records] = await Promise.all([
                loadJury(tdoc).then(jury => heldProblems(jury, tdoc.beginAt.getTime())),
                RecordModel.getMulti(domain, { contest: tdoc.docId, pid: { $in: tdoc.pids }, uid: { $in: members } },
                    { projection: { _id: 1, pid: 1, status: 1, lang: 1 } }).sort({ _id: -1 }).limit(10).toArray(),
            ]);
            this.response.body = { records: records.map(r => ({ rid: String(r._id), problem: labelOf(tdoc.pids, r.pid), lang: r.lang,
                ...statusOf(r.status, r._id.getTimestamp().getTime() < (holds.get(r.pid) ?? Infinity)) })) };
        }

        async post() {
            if (String(this.request.headers['content-type'] || '').split(';')[0].trim().toLowerCase() !== 'application/json'
                || Object.keys(this.request.files || {}).length) throw new SubmitError('请提交 JSON 请求', 415);
            // Native handlers own judging, contest status updates, rate limits and the print queue.
            // Invoke only the requested native methods; no web form operations are exposed by this route.
            const { action } = this.request.params;
            const domain = this.domain._id;
            const entries = await participantContests(this);
            if (action === 'submit') {
                this.checkPerm(PERM.PERM_SUBMIT_PROBLEM);
                const input = parseSubmit(this.request.body, SystemModel.get('limit.codelength') || 128 * 1024);
                const { tdoc, status } = pickContest(entries, input.tid);
                const problem = problemByLabel(tdoc.pids, input.problem);
                if (!problem) throw new SubmitError('该比赛没有这个题号');
                if (!submission) throw new SubmitError('Hydro 提交服务尚未就绪', 503);
                if (!status.startAt) {
                    // Starting from the CLI is equivalent to opening the contest problems page.
                    // Never upsert a status or move a teammate's existing start time.
                    await DocumentModel.collStatus.updateOne({ domainId: domain, docType: DocumentModel.TYPE_CONTEST,
                        docId: tdoc.docId, uid: status.uid, attend: 1, startAt: null }, { $set: { startAt: new Date() } });
                }
                const handler = this as unknown as ProblemSubmitHandler;
                await submission.__prepare.call(handler, domain, tdoc.docId);
                await submission._prepare.call(handler, domain, problem.pid, tdoc.docId);
                await submission.prepare.call(handler, domain, tdoc.docId);
                await submission.post.call(handler, domain, input.lang, input.code, false, [], tdoc.docId);
                const rid = this.response.body?.rid;
                this.response.body = { submitted: true, problem: problem.label, rid: rid ? String(rid) : null };
            } else if (action === 'print') {
                const input = parsePrint(this.request.body);
                const { tdoc } = pickContest(entries, input.tid, '打印');
                if (!printing) throw new SubmitError('Hydro 打印服务尚未就绪', 503);
                const handler = this as unknown as ContestPrintHandler;
                await printing.__prepare.call(handler, domain, tdoc.docId);
                await printing.prepare.call(handler, { domainId: domain }, tdoc.docId);
                await printing.postPrint.call(handler, domain, tdoc.docId, input.filename, input.code);
                this.response.body = { queued: true, filename: input.filename };
            } else throw new SubmitError('没有这个写操作', 404);
            delete this.response.redirect;
            delete this.response.template;
        }

        async onerror(error: any) {
            delete this.response.redirect;
            delete this.response.template;
            const status = error instanceof SubmitError ? error.status : Number(error?.code);
            this.response.status = status >= 400 && status < 600 ? status : 500;
            if (this.response.status === 500) console.error('[submit]', error);
            this.response.type = 'application/json';
            this.response.body = { error: { message: this.response.status === 500 ? '服务器错误' : error.msg?.() || error.message } };
        }
    }

    class SubmitDownloadHandler extends Handler {
        async get() {
            const { tid, platform } = this.request.params;
            if (!ObjectId.isValid(tid)) throw new NotFoundError();
            const tdoc = await ContestModel.get(this.domain._id, new ObjectId(tid));
            if (!tdoc || tdoc.rule === 'homework' || !ContestModel.RULES[tdoc.rule] || ContestModel.RULES[tdoc.rule].hidden) throw new NotFoundError();
            if (tdoc.assign?.length && !this.user.own(tdoc) && !this.user.hasPerm(PERM.PERM_VIEW_HIDDEN_CONTEST)) {
                const groups = await UserModel.listGroup(this.domain._id, this.user._id);
                if (!groups.some(group => tdoc.assign?.includes(group.name))) throw new NotFoundError();
            }
            // Downloads contain the public address only. Team authentication is checked by each command.
            if (platform) {
                try {
                    const domainPath = `/d/${encodeURIComponent(this.domain._id)}`;
                    let refererOrigin = this.context.origin;
                    try { if (this.request.headers.referer) refererOrigin = new URL(this.request.headers.referer).origin; } catch { /* use request origin */ }
                    const origin = workerOrigin(refererOrigin, SystemModel.get('server.url'), this.request.host, this.context.protocol);
                    this.response.body = await submitDownload(platform, origin + domainPath);
                    this.response.type = 'application/zip';
                    this.response.disposition = `attachment; filename="submit-${platform.replace(/\.exe$/, '')}.zip"`;
                } catch (error) {
                    if (!(error instanceof SubmitError)) throw error;
                    this.response.status = error.status;
                    this.response.body = error.message;
                }
                return;
            }
            this.response.template = 'xcpcio_submit_client.html';
            this.response.body = { tdoc, downloads: submitDownloads(downloadPath(tdoc)) };
        }
    }

    ctx.Route('xcpcio_submit_api', '/xcpcio-submit/:action', SubmitApiHandler);
    ctx.Route('contest_xcpcio_submit_client', '/contest/:tid/submit-client', SubmitDownloadHandler, PERM.PERM_VIEW_CONTEST);
    ctx.Route('contest_xcpcio_submit_download', '/contest/:tid/submit-client/:platform', SubmitDownloadHandler, PERM.PERM_VIEW_CONTEST);
    ctx.on('handler/after/ContestProblemList', (h: HydroHandler) => {
        const tdoc: Tdoc | undefined = h.response.body?.tdoc;
        if (tdoc && tdoc.rule !== 'homework') h.UiContext.xcpcioSubmitClient = downloadPath(tdoc);
    });
}
