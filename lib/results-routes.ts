import { randomUUID } from 'node:crypto';
import {
    ContestModel, type Context, DocumentModel, ForbiddenError, getAlphabeticId, Handler, NotFoundError, ObjectId, param, PERM, PRIV,
    RecordModel, StorageService, type Tdoc, Types, UserModel, ValidationError,
} from 'hydrooj';
import type { BoardData } from './board';
import type { RejudgeItem, RejudgeJob } from './manage/rejudge';
import { resolverCodeBase } from './resolver-data';
import { resultsPage, optionDate, snapshotOption, type ResultOption } from './results-page';
import { ResultsStore, resultKey, type SnapshotReason } from './results-store';
import { awardsCsv, boardOptions, resultBoard, restoreRejudge, settled, standingsCsv, type ResultsData } from './results';
import { filterChanges, impactOf, lastChange, reviewChanges, staleSessions, verdictName, type ReviewChange, type ReviewFilter, type ReviewItem } from './rejudge-review';
import { toScriptJson } from './settings';
import { loadCoaches } from './teams';
import { VERDICT_CHANGED, verdictChange } from './verdict-event';
import type { BoardSettings } from './settings';
import pkg from '../package.json';

interface HistoryJob extends Omit<RejudgeJob, '_id'> { _id: ObjectId }
interface HistoryItem extends Omit<RejudgeItem, 'job' | 'rid'> {
    _id: ObjectId; job: ObjectId; rid: ObjectId;
    /** 重测复核: the jury restored the original result, or took that back. */
    restored?: { at: Date; by: number } | null;
    reapplied?: { at: Date; by: number } | null;
}
declare module 'hydrooj' {
    interface Collections {
        'xcpcio.manage.rejudge.jobs': HistoryJob;
        'xcpcio.manage.rejudge.items': HistoryItem;
    }
}

const RECOVERY_MS = 24 * 60 * 60 * 1000;
const INTERVAL_MS = 10_000;
type ContestRef = Pick<Tdoc, 'domainId' | 'docId'>;
type ContestEnd = ContestRef & Pick<Tdoc, 'endAt'>;
const scopeFor = (tdoc: ContestRef) => ({ domainId: tdoc.domainId, contestId: String(tdoc.docId) });
const baseFor = (tdoc: Tdoc) => `/d/${encodeURIComponent(tdoc.domainId)}/contest/${tdoc.docId}`;
const endKey = (tdoc: ContestEnd) => resultKey(scopeFor(tdoc), `end-${tdoc.endAt.getTime()}`);
const unlockKey = (tdoc: Tdoc) => resultKey(scopeFor(tdoc), `unlock-${tdoc.lockAt?.getTime() ?? 0}`);
const warning = (error: unknown) => console.warn('[xcpcio] 成绩快照保存失败', error);

/** What 重测复核 needs of the resolver (lib/resolver-routes.ts). */
export interface ResolverSessionsApi {
    ofContest: (tdoc: Tdoc) => Promise<{ id: string; ownerId: number; createdAt: Date; config: { boardId: string; rehearsal: boolean }; overview: { title: string } }[]>;
    rebuild: (tdoc: Tdoc, ids: string[], ownerId: number, privateInfo: boolean) => Promise<{ from: string; id: string; url: string }[]>;
}

export function applyResults(ctx: Context, dependencies: {
    loadData: (tdoc: Tdoc, realtime: boolean, identity: boolean, staffResults: boolean) => Promise<BoardData>;
    loadSettings: (tdoc: Tdoc) => Promise<BoardSettings>;
    statusOf: (status: number) => string;
    resolver?: ResolverSessionsApi;
}) {
    const store = new ResultsStore(ctx.db);
    const jobs = ctx.db.collection('xcpcio.manage.rejudge.jobs');
    const items = ctx.db.collection('xcpcio.manage.rejudge.items');
    const contests = ctx.db.collection('document');

    async function load(tdoc: Tdoc): Promise<ResultsData> {
        const [data, settings] = await Promise.all([dependencies.loadData(tdoc, true, true, true), dependencies.loadSettings(tdoc)]);
        if (data.contest.problem_quantity !== tdoc.pids.length) throw new Error('比赛题目数据不完整，无法读取成绩');
        const at = Date.now();
        return {
            data, settings, at, problemIds: [...tdoc.pids], beginAt: tdoc.beginAt.getTime(), endAt: tdoc.endAt.getTime(),
            lockAt: tdoc.lockAt?.getTime() ?? null, unlocked: !!tdoc.unlocked, coaches: await loadCoaches(ctx.db, data.teams.map((team) => Number(team.team_id))),
        };
    }

    async function capture(tdoc: Tdoc, id: string, reason: SnapshotReason,
        details: { label?: string; operator?: number; jobId?: string; eventAt?: Date } = {}) {
        await store.save(scopeFor(tdoc), { _id: id, reason, eventAt: new Date(), ...details }, () => load(tdoc));
    }
    // Automatic end snapshots are keyed by the scheduled end (extensions receive a new snapshot).
    const captureEnd = (tdoc: Tdoc) => capture(tdoc, endKey(tdoc), 'end', { eventAt: tdoc.endAt });

    let scanning = false;
    async function scanEnded() {
        if (scanning) return;
        scanning = true;
        try {
            const now = Date.now();
            const ended = await contests.find({
                docType: DocumentModel.TYPE_CONTEST, rule: 'acm',
                endAt: { $gt: new Date(now - RECOVERY_MS), $lte: new Date(now) },
            }).project<ContestEnd>({ docId: 1, domainId: 1, endAt: 1 }).toArray();
            const ids = ended.map(endKey);
            const saved = await store.existing(ids);
            for (const [index, candidate] of ended.entries()) {
                if (saved.has(ids[index])) continue;
                try {
                    const tdoc = await ContestModel.get(candidate.domainId, candidate.docId);
                    // Reload all contest fields, including those added by later Hydro versions.
                    // An edit may also have extended the contest while the scan was underway.
                    if (tdoc?.rule === 'acm' && tdoc.endAt.getTime() === candidate.endAt.getTime()) await captureEnd(tdoc);
                } catch (error) {
                    warning(error);
                }
            }
        } finally {
            scanning = false;
        }
    }

    ctx.on('app/started', async () => {
        await Promise.all([
            store.ensureIndexes(),
            items.createIndex({ domainId: 1, contest: 1, job: 1 }),
            contests.createIndex({ docType: 1, rule: 1, endAt: 1 }, { partialFilterExpression: { docType: DocumentModel.TYPE_CONTEST } }),
        ]).catch(warning);
        ctx.interval(() => { void scanEnded().catch(warning); }, INTERVAL_MS);
        await Promise.all([scanEnded(), store.pruneOrphans(new Date(Date.now() - RECOVERY_MS))]).catch(warning);
    });

    // Hydro's own and the CCS unlock both call ContestModel.unlockScoreboard → contest edit.
    // Observe a transition in this process. Save the previous end snapshot before the flag changes.
    const unlocking = new Map<string, number>();
    ctx.on('contest/before-edit', async (tdoc, patch) => {
        if (tdoc.rule !== 'acm' || !tdoc.lockAt || tdoc.unlocked || !patch.unlocked) return;
        const now = Date.now();
        for (const [key, at] of unlocking) if (now - at > 60_000) unlocking.delete(key);
        unlocking.set(unlockKey(tdoc), now);
        if (tdoc.endAt.getTime() <= now && tdoc.endAt.getTime() > now - RECOVERY_MS) await captureEnd(tdoc).catch(warning);
    });
    ctx.on('contest/edit', async (tdoc) => {
        const id = unlockKey(tdoc);
        if (tdoc.unlocked && unlocking.delete(id)) await capture(tdoc, id, 'unlock').catch(warning);
    });
    ctx.on('contest/del', (domainId, tid) => store.remove({ domainId, contestId: String(tid) }).catch(warning));
    ctx.on('domain/delete', (domainId) => store.remove({ domainId }).catch(warning));

    async function beforeRejudge(domainId: string, contestsAffected: string[], jobId: string, operator: number) {
        for (const id of contestsAffected) {
            const tdoc = await ContestModel.get(domainId, new ObjectId(id));
            if (tdoc?.rule !== 'acm') continue;
            const now = Date.now();
            if (tdoc.endAt.getTime() <= now && tdoc.endAt.getTime() > now - RECOVERY_MS) await captureEnd(tdoc);
            await capture(tdoc, resultKey(scopeFor(tdoc), `rejudge-${jobId}`), 'rejudge', { jobId, operator });
        }
    }

    async function rejudgeHistory(tdoc: Tdoc): Promise<HistoryJob[]> {
        const { domainId, contestId } = scopeFor(tdoc);
        const ids = await items.distinct('job', { domainId, contest: contestId });
        if (!ids.length) return [];
        return jobs.find({ _id: { $in: ids }, domainId }).sort({ createdAt: -1, _id: -1 }).toArray();
    }

    async function readRejudge(tdoc: Tdoc, jobId: string, history: HistoryJob[], readCurrent: () => Promise<ResultsData>) {
        const index = history.findIndex((job) => String(job._id) === jobId);
        if (index < 0) throw new NotFoundError('本场比赛没有这次重测记录');
        const job = history[index];
        const { domainId, contestId } = scopeFor(tdoc);
        const relevant = await items.find({ domainId, contest: contestId, job: { $in: history.slice(0, index + 1).map((item) => item._id) } })
            .project<Pick<HistoryItem, 'rid' | 'job' | 'before' | 'beforeScore'>>({ rid: 1, job: 1, before: 1, beforeScore: 1 }).toArray();
        const order = new Map(history.map((item, position) => [String(item._id), position]));
        relevant.sort((a, b) => order.get(String(a.job))! - order.get(String(b.job))!);
        // Newest to oldest: the earliest job touching each record provides the verdict as of the baseline.
        const original = new Map(relevant.map((item) => [String(item.rid), { status: dependencies.statusOf(item.before), score: item.beforeScore }]));
        return restoreRejudge(await readCurrent(), new Date(job.createdAt).getTime(), original);
    }

    async function readSource(tdoc: Tdoc, source: string, current = () => load(tdoc), history = () => rejudgeHistory(tdoc)) {
        if (source === 'current') return current();
        if (/^history:[a-f0-9]{24}$/.test(source)) return readRejudge(tdoc, source.slice(8), await history(), current);
        const result = await store.read(scopeFor(tdoc), source);
        if (!result) throw new NotFoundError('本场比赛没有这个成绩快照');
        return result;
    }
    async function sources(tdoc: Tdoc, history = () => rejudgeHistory(tdoc)): Promise<ResultOption[]> {
        const [snapshots, jobs] = await Promise.all([store.list(scopeFor(tdoc)), history()]);
        const captured = new Set(snapshots.map((snapshot) => snapshot.jobId).filter(Boolean));
        return [
            { id: 'current', name: '当前成绩' }, ...snapshots.map(snapshotOption),
            ...jobs.filter((job) => !captured.has(String(job._id))).map((job) => ({
                id: `history:${job._id}`, name: `重测前还原 · ${String(job._id).slice(-6)} · ${optionDate(new Date(job.createdAt))}`,
            })),
        ];
    }

    class ResultsHandler extends Handler {
        tdoc!: Tdoc;
        private current?: Promise<ResultsData>;
        private history?: Promise<HistoryJob[]>;

        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            this.checkPriv(PRIV.PRIV_USER_PROFILE);
            const tdoc = await ContestModel.get(this.domain._id, tid);
            if (!tdoc || tdoc.rule !== 'acm') throw new NotFoundError('成绩与导出仅支持 ACM 比赛');
            if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            this.tdoc = tdoc;
        }

        private readCurrent = () => (this.current ||= load(this.tdoc));
        private readHistory = () => (this.history ||= rejudgeHistory(this.tdoc));

        protected readSource(source: string) {
            return readSource(this.tdoc, source, this.readCurrent, this.readHistory);
        }

        @param('board', Types.String, true)
        @param('before', Types.String, true)
        @param('after', Types.String, true)
        @param('filter', Types.String, true)
        @param('saved', Types.String, true)
        async get(_domainId: string, board = 'all', before = '', after = 'current', filter = '', saved = '') {
            const tdoc = this.tdoc;
            const [options, earlier, later] = await Promise.all([
                sources(tdoc, this.readHistory), before ? this.readSource(before) : undefined, this.readSource(after),
            ]);
            this.response.template = 'xcpcio_results.html';
            this.response.body = resultsPage({
                tdoc, codeBase: resolverCodeBase(pkg.version), contestUrl: baseFor(tdoc), submissionsUrl: `/d/${encodeURIComponent(tdoc.domainId)}/record/`,
                selectedBoard: board, beforeId: before, afterId: after, options, before: earlier, after: later, allRows: filter === 'all', saved: saved === '1',
            });
        }

        @param('snapshotName', Types.String, true)
        async post(_domainId: string, snapshotName = '') {
            const label = snapshotName.trim();
            if (label.length > 80) throw new ValidationError('snapshotName', '快照名称最多 80 字');
            await this.limitRate('xcpcio_results_snapshot', 60, 10);
            const id = resultKey(scopeFor(this.tdoc), `manual-${randomUUID()}`);
            await capture(this.tdoc, id, 'manual', { label, operator: this.user._id });
            this.response.redirect = `${baseFor(this.tdoc)}/results?${new URLSearchParams({ saved: '1', before: id })}`;
        }
    }

    class ResultsExportHandler extends ResultsHandler {
        @param('format', Types.String)
        @param('board', Types.String, true)
        @param('source', Types.String, true)
        async get(_domainId: string, format = '', board = 'all', source = 'current') {
            if (format !== 'standings' && format !== 'awards') throw new NotFoundError('未知的成绩导出格式');
            await this.limitRate('xcpcio_results_export', 60, 20);
            const payload = await this.readSource(source);
            const group = boardOptions(payload).find((option) => option.id === board);
            if (!group) throw new NotFoundError('这个成绩版本没有所选分榜');
            const result = resultBoard(payload, board);
            const csv = format === 'standings' ? standingsCsv(result) : awardsCsv(result);
            const state = settled(payload) && !source.startsWith('history:') ? '最终' : '暂定';
            const label = [...`${this.tdoc.title}-${group.name}`.replace(/[\\/:*?"<>|\x00-\x1f]/gu, '-')].slice(0, 140).join('');
            const name = `${label}-${state}${format === 'awards' ? '获奖名单' : '成绩'}.csv`;
            this.binary(Buffer.from(csv));
            this.response.type = 'text/csv; charset=utf-8';
            this.response.disposition = `attachment; filename="${format}.csv"; filename*=UTF-8''${StorageService.encodeRFC5987ValueChars(name)}`;
        }
    }

    // ---------------------------------------------------------------- 重测复核

    /** The contest's rejudged records, with what each team's result now is, and the teams' journals by record. */
    async function readReview(tdoc: Tdoc) {
        const { domainId, contestId } = scopeFor(tdoc);
        const [history, rows, entries] = await Promise.all([
            rejudgeHistory(tdoc),
            items.find({ domainId, contest: contestId }).toArray(),
            ContestModel.getMultiStatus(domainId, { docId: tdoc.docId }).project({ uid: 1, journal: 1 }).toArray(),
        ]);
        const journal = new Map<string, { uid: number; status: number; score: number | null; pid: number }>();
        for (const entry of entries as { uid: number; journal?: { rid: ObjectId; status: number; score?: number; pid: number }[] }[]) {
            for (const record of entry.journal || []) journal.set(String(record.rid), { uid: entry.uid, status: record.status, score: record.score ?? null, pid: record.pid });
        }
        const jobAt = new Map(history.map((job) => [String(job._id), new Date(job.createdAt).getTime()]));
        const time = (value?: Date | null) => (value ? new Date(value).getTime() : null);
        const reviewItems: (ReviewItem & { id: ObjectId })[] = rows.map((row) => ({
            id: row._id, rid: String(row.rid), job: String(row.job), jobAt: jobAt.get(String(row.job)) ?? row._id.getTimestamp().getTime(),
            pid: row.pid, before: row.before, beforeScore: row.beforeScore, after: row.after, afterScore: row.afterScore, judgedAt: time(row.judgedAt),
            restored: row.restored ? { at: time(row.restored.at)!, by: row.restored.by } : null,
            reapplied: row.reapplied ? { at: time(row.reapplied.at)!, by: row.reapplied.by } : null,
        }));
        // Records of this contest only (a domain-wide job also lists records of other contests).
        const known = reviewItems.filter((item) => journal.has(item.rid));
        const { changes, pending } = reviewChanges(known, new Map([...journal].map(([rid, entry]) => [rid, entry.status])));
        return { history, items: known, journal, changes, pending };
    }

    abstract class ReviewBase extends Handler {
        tdoc!: Tdoc;

        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            this.checkPriv(PRIV.PRIV_USER_PROFILE);
            const tdoc = await ContestModel.get(this.domain._id, tid);
            if (!tdoc || tdoc.rule !== 'acm') throw new NotFoundError('重测复核仅支持 ACM 比赛');
            if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            this.tdoc = tdoc;
        }

        canRestore() {
            return this.user.hasPerm(PERM.PERM_REJUDGE);
        }

        async review(filter: ReviewFilter = {}) {
            const tdoc = this.tdoc;
            const [review, current, sessions] = await Promise.all([readReview(tdoc), load(tdoc), dependencies.resolver?.ofContest(tdoc) ?? []]);
            const impact = impactOf(current, review.changes, dependencies.statusOf);
            const teamOf = (rid: string) => String(review.journal.get(rid)?.uid ?? '');
            const affects = (change: ReviewChange) => !!impact.get(teamOf(change.rid))?.changed;
            const changedAt = lastChange(review.changes);
            const stale = new Set(staleSessions(sessions, changedAt).map((session) => session.id));
            const owners = await UserModel.getList(tdoc.domainId, [...new Set(sessions.map((session) => session.ownerId))]);
            const jobs = new Map<string, { total: number; pending: number; changed: number }>();
            for (const item of review.items) {
                const stat = jobs.get(item.job) || { total: 0, pending: 0, changed: 0 };
                stat.total++;
                if (item.after === null) stat.pending++;
                else if (item.after !== item.before) stat.changed++;
                jobs.set(item.job, stat);
            }
            return {
                pending: review.pending, changedAt,
                problems: tdoc.pids.map((pid, index) => ({ pid, label: getAlphabeticId(index) })),
                jobs: review.history.filter((job) => jobs.has(String(job._id))).map((job) => ({
                    id: String(job._id), createdAt: job.createdAt, finishedAt: job.finishedAt, ...jobs.get(String(job._id))!,
                })),
                total: review.changes.length,
                changes: filterChanges(review.changes, filter, affects).map((change) => {
                    const team = teamOf(change.rid);
                    const index = tdoc.pids.indexOf(change.pid);
                    return {
                        ...change, team, teamName: impact.get(team)?.name || team, label: index >= 0 ? getAlphabeticId(index) : `#${change.pid}`,
                        time: Math.floor((new ObjectId(change.rid).getTimestamp().getTime() - tdoc.beginAt.getTime()) / 1000),
                        originalName: verdictName(change.original), rejudgedName: verdictName(change.rejudged), currentName: verdictName(change.current),
                        impact: impact.get(team) || null,
                    };
                }),
                sessions: sessions.map((session) => ({
                    id: session.id, createdAt: session.createdAt, board: session.config.boardId, rehearsal: session.config.rehearsal,
                    owner: owners[session.ownerId]?.uname || String(session.ownerId), own: session.ownerId === this.user._id, stale: stale.has(session.id),
                })),
            };
        }

        /** Puts the original (or, taking a restore back, the rejudged) result on the records and the teams' journals. */
        async apply(rids: string[], restore: boolean) {
            if (!this.canRestore()) throw new ForbiddenError('需要重测权限');
            const tdoc = this.tdoc;
            const review = await readReview(tdoc);
            const byRid = new Map(review.changes.map((change) => [change.rid, change]));
            const chosen = [...new Set(rids)].map((rid) => byRid.get(rid)).filter((change): change is ReviewChange => !!change)
                .filter((change) => (restore ? change.state !== 'restored' : change.state === 'restored'));
            if (!chosen.length) return { updated: 0 };
            // The results before the jury's change stay available on the results page.
            await capture(tdoc, resultKey(scopeFor(tdoc), `manual-${randomUUID()}`), 'manual', { label: restore ? '恢复重测前结果之前' : '撤销恢复之前', operator: this.user._id });
            const latest = new Map<string, ObjectId>();
            for (const item of [...review.items].sort((a, b) => a.jobAt - b.jobAt)) latest.set(item.rid, item.id);
            const now = new Date();
            for (const change of chosen) {
                const status = restore ? change.original : change.rejudged;
                const score = (restore ? change.originalScore : change.rejudgedScore) ?? 0;
                const rid = new ObjectId(change.rid);
                const rdoc = await RecordModel.get(tdoc.domainId, rid);
                const owner = review.journal.get(change.rid);
                if (!rdoc || !owner) continue;
                const judgeAt = rdoc.judgeAt || now;
                await RecordModel.update(tdoc.domainId, rid, { status, score, judgeAt });
                await ContestModel.updateStatus(tdoc.domainId, tdoc.docId, owner.uid, rid, owner.pid, { status, score, lang: rdoc.lang, subtasks: rdoc.subtasks });
                (ctx.broadcast as (event: string, ...args: unknown[]) => void)(VERDICT_CHANGED, verdictChange(rdoc, status, score));
                await items.updateOne({ _id: latest.get(change.rid) }, restore
                    ? { $set: { restored: { at: now, by: this.user._id }, reapplied: null } }
                    : { $set: { restored: null, reapplied: { at: now, by: this.user._id } } });
            }
            (ctx.broadcast as any)('xcpcio/ccs-touch', `${tdoc.domainId}/${tdoc.docId}`);
            return { updated: chosen.length };
        }

        payloadOf(input: string) {
            try { return JSON.parse(input) as Record<string, unknown>; } catch { throw new ValidationError('payload'); }
        }

    }

    class ReviewHandler extends ReviewBase {
        async get() {
            const base = `${baseFor(this.tdoc)}/rejudge-review`;
            this.response.template = 'xcpcio_rejudge_review.html';
            this.response.body = {
                tdoc: this.tdoc, codeBase: resolverCodeBase(pkg.version),
                runtimeJson: toScriptJson({ base, dataUrl: `${base}/data`, domainId: this.tdoc.domainId, contestUrl: baseFor(this.tdoc), resultsUrl: `${baseFor(this.tdoc)}/results`,
                    rejudgeUrl: `/manage/xcpcio-rejudge`, canRestore: this.canRestore() }),
            };
        }

        @param('payload', Types.String)
        async postRestore(_domainId: string, input: string) {
            await this.limitRate('xcpcio_rejudge_review', 60, 20);
            const payload = this.payloadOf(input);
            this.response.body = await this.apply(Array.isArray(payload.rids) ? payload.rids.map(String).slice(0, 2000) : [], payload.restore !== false);
        }

        @param('payload', Types.String)
        async postRebuild(_domainId: string, input: string) {
            if (!dependencies.resolver) throw new NotFoundError('滚榜不可用');
            await this.limitRate('xcpcio_rejudge_review', 60, 20);
            const payload = this.payloadOf(input);
            const ids = Array.isArray(payload.ids) ? payload.ids.map(String).slice(0, 20) : [];
            this.response.body = { created: await dependencies.resolver.rebuild(this.tdoc, ids, this.user._id, this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO)) };
        }
    }

    class ReviewDataHandler extends ReviewBase {
        @param('pids', Types.CommaSeperatedArray, true)
        @param('kinds', Types.CommaSeperatedArray, true)
        @param('states', Types.CommaSeperatedArray, true)
        @param('affecting', (value: unknown) => Types.Boolean[0](value), true)
        async get(_domainId: string, pids: string[] = [], kinds: string[] = [], states: string[] = [], affecting = false) {
            this.response.type = 'application/json';
            this.response.body = await this.review({
                pids: pids.map(Number).filter(Number.isSafeInteger),
                kinds: kinds.filter((kind): kind is ReviewChange['kind'] => ['lostAccept', 'gainedAccept', 'other'].includes(kind)),
                states: states.filter((state): state is ReviewChange['state'] => ['kept', 'restored', 'moved'].includes(state)),
                affecting,
            });
        }
    }

    ctx.Route('contest_xcpcio_rejudge_review', '/contest/:tid/rejudge-review', ReviewHandler);
    ctx.Route('contest_xcpcio_rejudge_review_data', '/contest/:tid/rejudge-review/data', ReviewDataHandler);
    ctx.Route('contest_xcpcio_results', '/contest/:tid/results', ResultsHandler);
    ctx.Route('contest_xcpcio_results_export', '/contest/:tid/results/export/:format', ResultsExportHandler);
    ctx.i18n.load('zh', { contest_xcpcio_results: '成绩快照与导出', contest_xcpcio_rejudge_review: '重测复核' });
    /** For 赛事中控: how many rejudged results the jury may want to look at, and the sessions built before them. */
    async function reviewSummary(tdoc: Tdoc) {
        const review = await readReview(tdoc);
        const sessions = await dependencies.resolver?.ofContest(tdoc) ?? [];
        return { changes: review.changes.length, pending: review.pending, stale: staleSessions(sessions, lastChange(review.changes)).length };
    }
    /** A manual snapshot of the current results, for certificates issued from a version that does not change. */
    async function snapshotNow(tdoc: Tdoc, label: string, operator: number) {
        const id = resultKey(scopeFor(tdoc), `manual-${randomUUID()}`);
        await capture(tdoc, id, 'manual', { label, operator });
        return id;
    }
    return { beforeRejudge, reviewSummary, snapshot: snapshotNow, readSource, sources };
}
