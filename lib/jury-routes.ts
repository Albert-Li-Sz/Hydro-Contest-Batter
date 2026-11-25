/**
 * 裁判操作 page: 暂缓公布, 计时补偿 and 人工改判, each recorded with its reason and operator (lib/jury.ts).
 */
import { randomUUID } from 'node:crypto';
import {
    ContestModel, type Context, ForbiddenError, getAlphabeticId, Handler, NotFoundError, ObjectId, param, PERM, PRIV, RecordModel, type Tdoc, Types, UserModel, ValidationError,
} from 'hydrooj';
import type { BoardData } from './board';
import { emptyJury, JuryError, readCredit, readHold, readReason, verdictChoices, type JuryState, type ProblemHold, type TimeCredit } from './jury';
import { resolverCodeBase } from './resolver-data';
import { toScriptJson } from './settings';
import pkg from '../package.json';

interface JuryDoc extends JuryState { _id: string; domainId: string; contestId: string }
export interface JuryLog {
    _id: ObjectId;
    domainId: string;
    contestId: string;
    action: 'hold' | 'release' | 'credit' | 'uncredit' | 'verdict';
    text: string;
    reason: string;
    by: number;
    at: Date;
    rid?: string;
}
declare module 'hydrooj' {
    interface Collections {
        'xcpcio.jury': JuryDoc;
        'xcpcio.jury.log': JuryLog;
    }
}

const scopeFor = (tdoc: Pick<Tdoc, 'domainId' | 'docId'>) => ({ domainId: tdoc.domainId, contestId: String(tdoc.docId) });
const idFor = (scope: { domainId: string; contestId: string }) => `${scope.domainId}/${scope.contestId}`;
const baseFor = (tdoc: Pick<Tdoc, 'domainId' | 'docId'>) => `/d/${encodeURIComponent(tdoc.domainId)}/contest/${tdoc.docId}`;
const clock = (seconds: number) => `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;

/** The jury's state of a contest, for the board data of every channel. */
export function juryStore(db: Context['db']) {
    const states = db.collection('xcpcio.jury');
    const logs = db.collection('xcpcio.jury.log');
    const load = async (tdoc: Pick<Tdoc, 'domainId' | 'docId'>): Promise<JuryState> => {
        const doc = await states.findOne({ _id: idFor(scopeFor(tdoc)) });
        return doc ? { holds: doc.holds || [], credits: doc.credits || [] } : emptyJury();
    };
    async function addHold(tdoc: Tdoc, hold: ProblemHold, onlyIfNew = false) {
        const scope = scopeFor(tdoc);
        const _id = idFor(scope);
        if (onlyIfNew) {
            await states.updateOne({ _id }, { $setOnInsert: { ...scope, holds: [], credits: [] } }, { upsert: true });
            const result = await states.updateOne({ _id, holds: { $not: { $elemMatch: { pid: hold.pid, since: 0 } } } }, { $push: { holds: hold } });
            return result.modifiedCount === 1;
        }
        await states.updateOne({ _id }, { $setOnInsert: { ...scope, credits: [] }, $push: { holds: hold } }, { upsert: true });
        return true;
    }
    async function addCredit(tdoc: Tdoc, credit: TimeCredit) {
        const scope = scopeFor(tdoc);
        await states.updateOne({ _id: idFor(scope) }, { $setOnInsert: { ...scope, holds: [] }, $push: { credits: credit } }, { upsert: true });
    }
    async function removeHold(tdoc: Tdoc, id: string) {
        const before = await states.findOneAndUpdate({ _id: idFor(scopeFor(tdoc)), 'holds.id': id }, { $pull: { holds: { id } } }, { returnDocument: 'before' });
        return before?.holds.find((entry) => entry.id === id);
    }
    async function removeCredit(tdoc: Tdoc, id: string) {
        const before = await states.findOneAndUpdate({ _id: idFor(scopeFor(tdoc)), 'credits.id': id }, { $pull: { credits: { id } } }, { returnDocument: 'before' });
        return before?.credits.find((entry) => entry.id === id);
    }
    const log = async (tdoc: Pick<Tdoc, 'domainId' | 'docId'>, entry: Omit<JuryLog, '_id' | 'domainId' | 'contestId' | 'at'>) => {
        await logs.insertOne({ _id: new ObjectId(), ...scopeFor(tdoc), ...entry, at: new Date() });
    };
    return { load, addHold, addCredit, removeHold, removeCredit, log, logs };
}

export function applyJuryRoutes(ctx: Context, dependencies: {
    store: ReturnType<typeof juryStore>;
    /** Staff board data: real-time results, names and schools. */
    loadData: (tdoc: Tdoc) => Promise<BoardData>;
    /** Saves the current results as a snapshot before a verdict changes them (lib/results-routes.ts). */
    snapshot: (tdoc: Tdoc, label: string, operator: number) => Promise<string>;
}) {
    const { store } = dependencies;
    async function record(tdoc: Tdoc, entry: Parameters<typeof store.log>[1]) {
        await store.log(tdoc, entry);
        (ctx.broadcast as (event: string, ...args: unknown[]) => void)('xcpcio/ccs-touch', idFor(scopeFor(tdoc)));
    }

    /** 批量重测 with 暂缓公布: the problems wait for the jury's approval on this page. */
    async function holdForRejudge(domainId: string, contestId: string, pids: number[], jobId: string, uid: number) {
        const tdoc = await ContestModel.get(domainId, new ObjectId(contestId));
        if (!tdoc || tdoc.rule !== 'acm') return;
        const chosen = (pids.length ? pids : tdoc.pids).filter((pid) => tdoc.pids.includes(pid));
        for (const pid of chosen) {
            const added = await store.addHold(tdoc, { id: randomUUID(), pid, since: 0, reason: '批量重测，待复核后公布', by: uid, at: Date.now(), jobId }, true);
            if (!added) continue;
            await record(tdoc, { action: 'hold', text: `${getAlphabeticId(tdoc.pids.indexOf(pid))} 题暂缓公布（批量重测）`, reason: '批量重测，待复核后公布', by: uid });
        }
    }

    abstract class JuryBase extends Handler {
        tdoc!: Tdoc;

        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            this.checkPriv(PRIV.PRIV_USER_PROFILE);
            const tdoc = await ContestModel.get(this.domain._id, tid);
            if (!tdoc || tdoc.rule !== 'acm') throw new NotFoundError('裁判操作仅支持 ACM 比赛');
            if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            this.tdoc = tdoc;
        }

        get duration() { return Math.floor((this.tdoc.endAt.getTime() - this.tdoc.beginAt.getTime()) / 1000); }
        label(pid: number) { const index = this.tdoc.pids.indexOf(pid); return index >= 0 ? getAlphabeticId(index) : `#${pid}`; }

        payloadOf(input: string) {
            try { return JSON.parse(input) as Record<string, unknown>; } catch { throw new ValidationError('payload'); }
        }

        async run<T>(work: () => Promise<T>) {
            try { return await work(); } catch (error) {
                if (!(error instanceof JuryError)) throw error;
                if (error.status === 403) throw new ForbiddenError(error.message);
                throw new ValidationError(error.message);
            }
        }
    }

    class JuryHandler extends JuryBase {
        async get() {
            const base = `${baseFor(this.tdoc)}/jury`;
            this.response.template = 'xcpcio_jury.html';
            this.response.body = {
                tdoc: this.tdoc, codeBase: resolverCodeBase(pkg.version),
                runtimeJson: toScriptJson({ base, dataUrl: `${base}/data`, recordBase: `/d/${encodeURIComponent(this.tdoc.domainId)}/record/`,
                    reviewUrl: `${baseFor(this.tdoc)}/rejudge-review`, verdicts: verdictChoices, canVerdict: this.user.hasPerm(PERM.PERM_REJUDGE) }),
            };
        }

        @param('payload', Types.String)
        async postHold(_domainId: string, input: string) {
            await this.run(async () => {
                const hold = readHold(this.payloadOf(input), this.tdoc.pids, this.duration);
                await store.addHold(this.tdoc, { id: randomUUID(), ...hold, by: this.user._id, at: Date.now() });
                await record(this.tdoc, { action: 'hold', text: `${this.label(hold.pid)} 题自 ${clock(hold.since)} 起暂缓公布`, reason: hold.reason, by: this.user._id });
            });
            this.response.body = { ok: true };
        }

        @param('payload', Types.String)
        async postRelease(_domainId: string, input: string) {
            await this.run(async () => {
                const payload = this.payloadOf(input);
                const reason = readReason(payload.reason);
                const hold = await store.removeHold(this.tdoc, String(payload.id));
                if (!hold) throw new JuryError('这条暂缓已经公布');
                await record(this.tdoc, { action: 'release', text: `${this.label(hold.pid)} 题恢复公布`, reason, by: this.user._id });
            });
            this.response.body = { ok: true };
        }

        @param('payload', Types.String)
        async postCredit(_domainId: string, input: string) {
            await this.run(async () => {
                const data = await dependencies.loadData(this.tdoc);
                const credit = readCredit(this.payloadOf(input), new Set(data.teams.map((team) => team.team_id)), this.duration);
                await store.addCredit(this.tdoc, { id: randomUUID(), ...credit, by: this.user._id, at: Date.now() });
                const team = data.teams.find((item) => item.team_id === credit.teamId)!;
                await record(this.tdoc, { action: 'credit', text: `${team.name} 自 ${clock(credit.from)} 起补偿 ${credit.minutes} 分钟`, reason: credit.reason, by: this.user._id });
            });
            this.response.body = { ok: true };
        }

        @param('payload', Types.String)
        async postUncredit(_domainId: string, input: string) {
            await this.run(async () => {
                const payload = this.payloadOf(input);
                const reason = readReason(payload.reason);
                const credit = await store.removeCredit(this.tdoc, String(payload.id));
                if (!credit) throw new JuryError('这条补偿已经撤销');
                await record(this.tdoc, { action: 'uncredit', text: `撤销队伍 ${credit.teamId} 自 ${clock(credit.from)} 起的 ${credit.minutes} 分钟补偿`, reason, by: this.user._id });
            });
            this.response.body = { ok: true };
        }

        /** 人工改判: a result set by hand, confirmed with the operator's password and kept in the log. */
        @param('payload', Types.String)
        async postVerdict(_domainId: string, input: string) {
            if (!this.user.hasPerm(PERM.PERM_REJUDGE)) throw new ForbiddenError('需要重测权限');
            await this.limitRate('xcpcio_jury_verdict', 300, 20);
            await this.run(async () => {
                const payload = this.payloadOf(input);
                if (typeof payload.password !== 'string' || !payload.password) throw new JuryError('请输入当前账号的密码', 403);
                try {
                    await (this.user as unknown as { checkPassword: (value: string) => Promise<void> }).checkPassword(payload.password);
                } catch {
                    throw new JuryError('密码错误', 403);
                }
                const reason = readReason(payload.reason);
                const status = Number(payload.status);
                const choice = verdictChoices.find(([code]) => code === status);
                if (!choice) throw new JuryError('请选择改判结果');
                if (typeof payload.rid !== 'string' || !/^[a-f\d]{24}$/i.test(payload.rid)) throw new JuryError('提交编号无效');
                const rid = new ObjectId(payload.rid);
                const rdoc = await RecordModel.get(this.tdoc.domainId, rid);
                if (!rdoc || String(rdoc.contest) !== String(this.tdoc.docId)) throw new JuryError('这不是本场比赛的提交');
                const [owner] = await ContestModel.getMultiStatus(this.tdoc.domainId, { docId: this.tdoc.docId, 'journal.rid': rid }).project({ uid: 1 }).toArray() as { uid: number }[];
                if (!owner) throw new JuryError('找不到这条提交所属的队伍');
                const before = verdictChoices.find(([code]) => code === rdoc.status)?.[1] ?? String(rdoc.status);
                if (rdoc.status === status) throw new JuryError(`这条提交已经是 ${choice[1]}`);
                // The results before the change stay on the results page.
                await dependencies.snapshot(this.tdoc, `人工改判之前 · ${payload.rid.slice(-6)}`, this.user._id);
                const score = status === 1 ? 100 : 0;
                await RecordModel.update(this.tdoc.domainId, rid, { status, score });
                await ContestModel.updateStatus(this.tdoc.domainId, this.tdoc.docId, owner.uid, rid, rdoc.pid, { status, score, lang: rdoc.lang, subtasks: rdoc.subtasks });
                await record(this.tdoc, { action: 'verdict', text: `${this.label(rdoc.pid)} 题提交 ${payload.rid.slice(-6)}：${before} → ${choice[1]}`, reason, by: this.user._id, rid: payload.rid });
            });
            this.response.body = { ok: true };
        }
    }

    class JuryDataHandler extends JuryBase {
        async get() {
            const [state, data, entries] = await Promise.all([
                store.load(this.tdoc), dependencies.loadData(this.tdoc),
                store.logs.find(scopeFor(this.tdoc)).sort({ at: -1 }).limit(200).toArray(),
            ]);
            const names = new Map(data.teams.map((team) => [team.team_id, team.name]));
            const operators = new Map<number, string>();
            const users = await UserModel.getList(this.tdoc.domainId, [...new Set([...state.holds.map((item) => item.by), ...state.credits.map((item) => item.by), ...entries.map((item) => item.by)])]);
            for (const [uid, user] of Object.entries(users)) operators.set(Number(uid), (user as { uname?: string }).uname || uid);
            const who = (uid: number) => operators.get(uid) || String(uid);
            this.response.type = 'application/json';
            this.response.body = {
                duration: this.duration,
                problems: this.tdoc.pids.map((pid, index) => ({ pid, label: getAlphabeticId(index) })),
                teams: data.teams.map((team) => ({ id: team.team_id, name: team.name, school: team.organization || '' })),
                holds: state.holds.map((hold) => ({ ...hold, label: this.label(hold.pid), operator: who(hold.by) })),
                credits: state.credits.map((credit) => ({ ...credit, team: names.get(credit.teamId) || credit.teamId, operator: who(credit.by) })),
                submissions: [...data.submissions].sort((a, b) => b.timestamp - a.timestamp).slice(0, 2000).map((run) => ({
                    rid: run.submission_id, team: names.get(run.team_id) || run.team_id, teamId: run.team_id,
                    label: getAlphabeticId(run.problem_id), time: Math.floor(run.timestamp / 1000), status: run.status,
                })),
                log: entries.map((entry) => ({ action: entry.action, text: entry.text, reason: entry.reason, operator: who(entry.by), at: entry.at, rid: entry.rid ?? null })),
            };
        }
    }

    ctx.Route('contest_xcpcio_jury', '/contest/:tid/jury', JuryHandler);
    ctx.Route('contest_xcpcio_jury_data', '/contest/:tid/jury/data', JuryDataHandler);
    ctx.i18n.load('zh', { contest_xcpcio_jury: '裁判操作' });
    return { holdForRejudge };
}
