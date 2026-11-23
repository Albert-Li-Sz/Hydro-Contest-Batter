import { randomUUID } from 'node:crypto';
import {
    ContestModel, type Context, DocumentModel, Handler, NotFoundError, ObjectId, param, PERM, PRIV,
    StorageService, type Tdoc, Types, ValidationError,
} from 'hydrooj';
import type { BoardData } from './board';
import type { RejudgeItem, RejudgeJob } from './manage/rejudge';
import { resolverCodeBase } from './resolver-data';
import { resultsPage, optionDate, snapshotOption, type ResultOption } from './results-page';
import { ResultsStore, resultKey, type SnapshotReason } from './results-store';
import { awardsCsv, boardOptions, resultBoard, restoreRejudge, settled, standingsCsv, type ResultsData } from './results';
import { profileValues } from './roster';
import type { BoardSettings } from './settings';
import pkg from '../package.json';

interface HistoryJob extends Omit<RejudgeJob, '_id'> { _id: ObjectId }
interface HistoryItem extends Omit<RejudgeItem, 'job' | 'rid'> { _id: ObjectId; job: ObjectId; rid: ObjectId }
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

export function applyResults(ctx: Context, dependencies: {
    loadData: (tdoc: Tdoc, realtime: boolean, identity: boolean, staffResults: boolean) => Promise<BoardData>;
    loadSettings: (tdoc: Tdoc) => Promise<BoardSettings>;
    statusOf: (status: number) => string;
}) {
    const store = new ResultsStore(ctx.db);
    const jobs = ctx.db.collection('xcpcio.manage.rejudge.jobs');
    const items = ctx.db.collection('xcpcio.manage.rejudge.items');
    const contests = ctx.db.collection('document');

    async function readCoaches(data: BoardData) {
        type AccountCoach = { _id: number; coach?: unknown; coaches?: unknown };
        const teamIds = data.teams.map((team) => Number(team.team_id));
        const read = (name: 'user' | 'vuser', ids: number[]) => ids.length
            ? ctx.db.collection(name).find({ _id: { $in: ids }, $or: [{ coaches: { $exists: true } }, { coach: { $exists: true } }] } as never)
                .project<AccountCoach>({ _id: 1, coach: 1, coaches: 1 }).toArray()
            : [];
        const [accounts, virtual] = await Promise.all([read('user', teamIds.filter((id) => id > 0)), read('vuser', teamIds.filter((id) => id < 0))]);
        return Object.fromEntries([...accounts, ...virtual].map((account) => [account._id, [...new Set([...profileValues(account.coach), ...profileValues(account.coaches)])]]));
    }

    async function load(tdoc: Tdoc): Promise<ResultsData> {
        const [data, settings] = await Promise.all([dependencies.loadData(tdoc, true, true, true), dependencies.loadSettings(tdoc)]);
        if (data.contest.problem_quantity !== tdoc.pids.length) throw new Error('比赛题目数据不完整，无法读取成绩');
        const at = Date.now();
        return {
            data, settings, at, problemIds: [...tdoc.pids], beginAt: tdoc.beginAt.getTime(), endAt: tdoc.endAt.getTime(),
            lockAt: tdoc.lockAt?.getTime() ?? null, unlocked: !!tdoc.unlocked, coaches: await readCoaches(data),
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

        protected async readSource(source: string) {
            if (source === 'current') return this.readCurrent();
            if (/^history:[a-f0-9]{24}$/.test(source)) {
                return readRejudge(this.tdoc, source.slice('history:'.length), await this.readHistory(), this.readCurrent);
            }
            const result = await store.read(scopeFor(this.tdoc), source);
            if (!result) throw new NotFoundError('本场比赛没有这个成绩快照');
            return result;
        }

        @param('board', Types.String, true)
        @param('before', Types.String, true)
        @param('after', Types.String, true)
        @param('filter', Types.String, true)
        @param('saved', Types.String, true)
        async get(_domainId: string, board = 'all', before = '', after = 'current', filter = '', saved = '') {
            const tdoc = this.tdoc;
            const [snapshots, history, earlier, later] = await Promise.all([
                store.list(scopeFor(tdoc)), this.readHistory(), before ? this.readSource(before) : undefined, this.readSource(after),
            ]);
            const captured = new Set(snapshots.map((snapshot) => snapshot.jobId).filter(Boolean));
            const options: ResultOption[] = [
                { id: 'current', name: '当前成绩' }, ...snapshots.map(snapshotOption),
                ...history.filter((job) => !captured.has(String(job._id))).map((job) => ({
                    id: `history:${job._id}`, name: `重测前还原 · ${String(job._id).slice(-6)} · ${optionDate(new Date(job.createdAt))}`,
                })),
            ];
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

    ctx.Route('contest_xcpcio_results', '/contest/:tid/results', ResultsHandler);
    ctx.Route('contest_xcpcio_results_export', '/contest/:tid/results/export/:format', ResultsExportHandler);
    ctx.i18n.load('zh', { contest_xcpcio_results: '成绩与导出' });
    return { beforeRejudge };
}
