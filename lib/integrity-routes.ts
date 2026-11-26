/**
 * 诚信复核 page: code similarity, each team's timeline (submissions, recordings and their gaps, screen signals,
 * 计时补偿), and review cases with an assignee, a deadline and a conclusion tied to a results snapshot.
 */
import {
    ContestModel, type Context, ForbiddenError, getAlphabeticId, Handler, NotFoundError, ObjectId, param, PERM, PRIV, StorageService, type Tdoc, Types, UserModel, ValidationError,
} from 'hydrooj';
import type { BoardData } from './board';
import { writeZip } from './ccs/zip';
import { resultsCsv } from './results';
import {
    casePairs, caseStatuses, defaultSimilarity, IntegrityError, mergeIntervals, readCase, similarityGroups, similarPairsAsync, uncovered, type CaseStatus, type CodeSample, type SimilarPair,
} from './integrity';
import type { JuryState } from './jury';
import { verdictChoices } from './jury';
import { resolverCodeBase } from './resolver-data';
import { toScriptJson } from './settings';
import pkg from '../package.json';

interface RunDoc {
    _id: string;
    at: Date;
    by: number;
    options: { threshold: number; includeRejected: boolean; pids: number[] };
    samples: number;
    pairs: SimilarPair[];
}
interface CaseDoc {
    _id: ObjectId;
    domainId: string;
    contestId: string;
    teams: string[];
    evidence?: { at: Date | null; options: RunDoc['options'] | null; pairs: SimilarPair[] };
    title: string;
    detail: string;
    assignee: string;
    due: Date | null;
    status: CaseStatus;
    conclusion: string;
    /** Results snapshot taken when the conclusion was reached. */
    snapshot: string | null;
    createdBy: number;
    createdAt: Date;
    updatedAt: Date;
    history: { at: Date; by: number; status: CaseStatus; note: string }[];
}
interface SignalDoc { _id: string; contestKey: string; teamUid: number | null; device: string; deviceName: string; kind: 'extended'; value: boolean; at: number }
declare module 'hydrooj' {
    interface Collections {
        'xcpcio.integrity.runs': RunDoc;
        'xcpcio.integrity.cases': CaseDoc;
        'xcpcio.integrity.signals': SignalDoc;
    }
}

const REVIEW_HOURS = 168;
const contestKey = (tdoc: Pick<Tdoc, 'domainId' | 'docId'>) => `${tdoc.domainId}/${tdoc.docId}`;
const baseFor = (tdoc: Pick<Tdoc, 'domainId' | 'docId'>) => `/d/${encodeURIComponent(tdoc.domainId)}/contest/${tdoc.docId}`;
const verdictName = (code: number) => verdictChoices.find(([value]) => value === code)?.[1] ?? (code === 0 ? 'WAIT' : String(code));
const safe = (value: string) => value.replace(/[\\/:*?"<>|\x00-\x1f]/gu, '-').slice(0, 60);

export function applyIntegrity(ctx: Context, dependencies: {
    /** Staff board data: names and schools. */
    loadData: (tdoc: Tdoc) => Promise<BoardData>;
    snapshot: (tdoc: Tdoc, label: string, operator: number) => Promise<string>;
    jury: (tdoc: Tdoc) => Promise<JuryState>;
}) {
    const runs = ctx.db.collection('xcpcio.integrity.runs');
    const cases = ctx.db.collection('xcpcio.integrity.cases');
    const signals = ctx.db.collection('xcpcio.integrity.signals');
    const records = ctx.db.collection('record');
    const coll = (name: string) => ctx.db.collection(name as never) as unknown as {
        find: (filter: Record<string, unknown>) => { sort: (order: Record<string, number>) => { toArray: () => Promise<any[]> } };
    };
    const segments = coll('xcpcio.recording.segments');
    const gaps = coll('xcpcio.recording.gaps');

    ctx.on('app/started', async () => {
        await Promise.all([
            cases.createIndex({ domainId: 1, contestId: 1, createdAt: -1 }),
            signals.createIndex({ contestKey: 1, teamUid: 1, at: 1 }),
        ]).catch((error) => console.warn('[xcpcio] 诚信复核索引创建失败', error));
    });
    ctx.on('contest/del', (domainId, tid) => {
        const key = `${domainId}/${tid}`;
        void Promise.all([
            runs.deleteOne({ _id: key }),
            cases.deleteMany({ domainId, contestId: String(tid) }),
            signals.deleteMany({ contestKey: key }),
        ]).catch(() => null);
    });
    ctx.on('domain/delete', (domainId) => {
        const pattern = new RegExp(`^${domainId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`);
        void Promise.all([
            runs.deleteMany({ _id: pattern }),
            cases.deleteMany({ domainId }),
            signals.deleteMany({ contestKey: pattern }),
        ]).catch(() => null);
    });

    /** Record id to the team it counts for, from the contest's participation records. */
    async function journals(tdoc: Tdoc) {
        const entries = await ContestModel.getMultiStatus(tdoc.domainId, { docId: tdoc.docId }).project({ uid: 1, journal: 1 }).toArray() as
            { uid: number; journal?: { rid: ObjectId; pid: number; status: number }[] }[];
        const owner = new Map<string, number>();
        const byTeam = new Map<number, { rid: string; pid: number; status: number; at: number }[]>();
        for (const entry of entries) {
            const list: { rid: string; pid: number; status: number; at: number }[] = [];
            for (const record of new Map((entry.journal || []).map((item) => [String(item.rid), item])).values()) {
                owner.set(String(record.rid), entry.uid);
                list.push({ rid: String(record.rid), pid: record.pid, status: record.status, at: new ObjectId(record.rid).getTimestamp().getTime() });
            }
            byTeam.set(entry.uid, list.sort((a, b) => a.at - b.at));
        }
        return { owner, byTeam };
    }

    /** The program each team is judged on per problem: its first accept, or with `includeRejected` its last try. */
    async function samples(tdoc: Tdoc, pids: number[], includeRejected: boolean): Promise<CodeSample[]> {
        const { byTeam } = await journals(tdoc);
        const chosen: { rid: string; teamId: string; pid: number }[] = [];
        for (const [uid, list] of byTeam) {
            for (const pid of pids) {
                const tries = list.filter((item) => item.pid === pid && item.at >= tdoc.beginAt.getTime() && item.at < tdoc.endAt.getTime());
                const accept = tries.find((item) => item.status === 1);
                const pick = accept || (includeRejected ? tries.filter((item) => item.status !== 7).at(-1) : undefined);
                if (pick) chosen.push({ rid: pick.rid, teamId: String(uid), pid });
            }
        }
        const codes = new Map<string, string>();
        for (let i = 0; i < chosen.length; i += 500) {
            const batch = chosen.slice(i, i + 500).map((item) => new ObjectId(item.rid));
            for (const doc of await records.find({ domainId: tdoc.domainId, _id: { $in: batch } }).project({ code: 1 }).toArray() as { _id: ObjectId; code?: string }[]) {
                if (typeof doc.code === 'string') codes.set(String(doc._id), doc.code.slice(0, 200_000));
            }
        }
        return chosen.filter((item) => codes.has(item.rid)).map((item) => ({ ...item, code: codes.get(item.rid)! }));
    }

    async function teamJournal(tdoc: Tdoc, uid: number) {
        const entry = await ContestModel.getStatus(tdoc.domainId, tdoc.docId, uid) as
            { journal?: { rid: ObjectId; pid: number; status: number }[] } | null;
        const list: { rid: string; pid: number; status: number; at: number }[] = [];
        for (const record of new Map((entry?.journal || []).map((item) => [String(item.rid), item])).values()) {
            list.push({ rid: String(record.rid), pid: record.pid, status: record.status, at: new ObjectId(record.rid).getTimestamp().getTime() });
        }
        return list.sort((a, b) => a.at - b.at);
    }

    async function timeline(tdoc: Tdoc, teamId: string) {
        const uid = Number(teamId);
        const key = contestKey(tdoc);
        const begin = tdoc.beginAt.getTime();
        const end = tdoc.endAt.getTime();
        const [teamRecords, archive, missing, screens, jury] = await Promise.all([
            teamJournal(tdoc, uid),
            segments.find({ contestKey: key, teamUid: uid, kind: 'archive', deleting: { $ne: true } }).sort({ startAt: 1 }).toArray(),
            gaps.find({ contestKey: key, teamUid: uid }).sort({ from: 1 }).toArray(),
            signals.find({ contestKey: key, teamUid: uid }).sort({ at: 1 }).toArray(),
            dependencies.jury(tdoc),
        ]);
        const label = (pid: number) => { const index = tdoc.pids.indexOf(pid); return index >= 0 ? getAlphabeticId(index) : `#${pid}`; };
        const streams = ['screen', 'webcam'].map((stream) => {
            const own = archive.filter((segment) => segment.stream === stream);
            const covered = mergeIntervals(own.map((segment) => ({ from: Math.max(begin, segment.startAt), to: Math.min(end, segment.endAt) })));
            return {
                stream, covered: covered.map((item) => ({ from: item.from - begin, to: item.to - begin })),
                uncovered: own.length ? uncovered(begin, end, covered).map((item) => ({ from: item.from - begin, to: item.to - begin })) : [],
                segments: own.map((segment) => ({ id: segment._id, from: segment.startAt - begin, to: segment.endAt - begin })),
                reported: missing.filter((gap) => gap.stream === stream).map((gap) => ({ from: gap.from - begin, to: gap.to - begin, reason: gap.reason })),
            };
        });
        return {
            teamId, duration: end - begin,
            submissions: teamRecords.filter((item) => item.at >= begin && item.at < end)
                .map((item) => ({ rid: item.rid, at: item.at - begin, label: label(item.pid), verdict: verdictName(item.status) })),
            streams,
            signals: screens.map((signal) => ({ at: signal.at - begin, kind: signal.kind, value: signal.value, device: signal.deviceName })),
            credits: jury.credits.filter((credit) => credit.teamId === teamId).map((credit) => ({ from: credit.from * 1000, minutes: credit.minutes, reason: credit.reason })),
            mediaBase: `${baseFor(tdoc)}/live/capture/recordings/media/`,
        };
    }

    abstract class IntegrityBase extends Handler {
        tdoc!: Tdoc;

        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            this.checkPriv(PRIV.PRIV_USER_PROFILE);
            const tdoc = await ContestModel.get(this.domain._id, tid);
            if (!tdoc || tdoc.rule !== 'acm') throw new NotFoundError('诚信复核仅支持 ACM 比赛');
            if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            this.tdoc = tdoc;
        }

        payloadOf(input: string) {
            try { return JSON.parse(input) as Record<string, unknown>; } catch { throw new ValidationError('payload'); }
        }

        async run<T>(work: () => Promise<T>) {
            try { return await work(); } catch (error) {
                if (!(error instanceof IntegrityError)) throw error;
                if (error.status === 404) throw new NotFoundError(error.message);
                if (error.status === 403) throw new ForbiddenError(error.message);
                throw new ValidationError(error.message);
            }
        }
    }

    class IntegrityHandler extends IntegrityBase {
        async get() {
            const base = `${baseFor(this.tdoc)}/integrity`;
            this.response.template = 'xcpcio_integrity.html';
            this.response.body = {
                tdoc: this.tdoc, codeBase: resolverCodeBase(pkg.version),
                runtimeJson: toScriptJson({ base, dataUrl: `${base}/data`, recordBase: `/d/${encodeURIComponent(this.tdoc.domainId)}/record/`,
                    statuses: caseStatuses, reviewHours: REVIEW_HOURS, resultsUrl: `${baseFor(this.tdoc)}/results`, juryUrl: `${baseFor(this.tdoc)}/jury` }),
            };
        }

        @param('payload', Types.String)
        async postAnalyze(_domainId: string, input: string) {
            await this.limitRate('xcpcio_integrity_analyze', 60, 6);
            this.response.body = await this.run(async () => {
                const payload = this.payloadOf(input);
                const pids = Array.isArray(payload.pids) && payload.pids.length ? payload.pids.map(Number).filter((pid) => this.tdoc.pids.includes(pid)) : [...this.tdoc.pids];
                const threshold = Number(payload.threshold ?? defaultSimilarity.threshold);
                if (!(threshold >= 0.3 && threshold <= 1)) throw new IntegrityError('相似度门槛应在 0.3 至 1 之间');
                const includeRejected = payload.includeRejected === true;
                const list = await samples(this.tdoc, pids, includeRejected);
                const pairs = (await similarPairsAsync(list, { ...defaultSimilarity, threshold })).slice(0, 2000);
                await runs.updateOne({ _id: contestKey(this.tdoc) }, { $set: { at: new Date(), by: this.user._id, options: { threshold, includeRejected, pids }, samples: list.length, pairs } }, { upsert: true });
                return { samples: list.length, pairs: pairs.length };
            });
        }

        @param('payload', Types.String)
        async postCase(_domainId: string, input: string) {
            this.response.body = await this.run(async () => {
                const payload = this.payloadOf(input);
                const [data, analysis] = await Promise.all([dependencies.loadData(this.tdoc), runs.findOne({ _id: contestKey(this.tdoc) })]);
                const fields = readCase(payload, new Set(data.teams.map((team) => team.team_id)));
                if (payload.analysisAt && payload.analysisAt !== analysis?.at.toISOString()) throw new IntegrityError('分析结果已更新，请重新选择要复核的记录');
                const evidence = { at: analysis?.at ?? null, options: analysis?.options ?? null,
                    pairs: casePairs(analysis?.pairs || [], fields.teams, typeof payload.pid === 'number' ? payload.pid : undefined) };
                const now = new Date();
                const due = fields.due ?? new Date(Math.max(now.getTime(), this.tdoc.endAt.getTime()) + REVIEW_HOURS * 3600_000);
                const _id = new ObjectId();
                await cases.insertOne({ _id, domainId: this.tdoc.domainId, contestId: String(this.tdoc.docId), ...fields, evidence, due, status: 'open', conclusion: '', snapshot: null,
                    createdBy: this.user._id, createdAt: now, updatedAt: now, history: [{ at: now, by: this.user._id, status: 'open', note: '建立复核' }] });
                return { id: String(_id) };
            });
        }

        @param('payload', Types.String)
        async postCaseUpdate(_domainId: string, input: string) {
            this.response.body = await this.run(async () => {
                const payload = this.payloadOf(input);
                if (typeof payload.id !== 'string' || !/^[a-f\d]{24}$/.test(payload.id)) throw new IntegrityError('复核任务无效');
                const doc = await cases.findOne({ _id: new ObjectId(payload.id), domainId: this.tdoc.domainId, contestId: String(this.tdoc.docId) });
                if (!doc) throw new IntegrityError('复核任务不存在', 404);
                const status = (payload.status ?? doc.status) as CaseStatus;
                if (!Object.hasOwn(caseStatuses, status)) throw new IntegrityError('复核结论无效');
                const conclusion = typeof payload.conclusion === 'string' ? payload.conclusion.trim().slice(0, 4000) : doc.conclusion;
                if (status !== 'open' && !conclusion) throw new IntegrityError('请填写复核结论');
                const assignee = typeof payload.assignee === 'string' ? payload.assignee.trim().slice(0, 40) : doc.assignee;
                const due = payload.due ? new Date(String(payload.due)) : doc.due;
                if (due && Number.isNaN(due.getTime())) throw new IntegrityError('复核期限无效');
                const now = new Date();
                const entry = { at: now, by: this.user._id, status, note: status === doc.status ? '更新' : caseStatuses[status] };
                const needsSnapshot = status === 'violation' && doc.status !== 'violation';
                const updated = await cases.updateOne(
                    { _id: doc._id, updatedAt: doc.updatedAt },
                    { $set: { status, conclusion, assignee, due, updatedAt: now }, $push: { history: entry } },
                );
                if (!updated.matchedCount) throw new IntegrityError('复核任务已被其他裁判修改，请刷新后重试', 409);
                // The results the conclusion was reached on stay on the results page.
                let snapshot = doc.snapshot;
                if (needsSnapshot) {
                    try {
                        snapshot = await dependencies.snapshot(this.tdoc, `诚信复核认定 · ${doc.title.slice(0, 40)}`, this.user._id);
                    } catch (error) {
                        // No violation without the results it was found on: put the case back as it was (unless changed since).
                        await cases.updateOne({ _id: doc._id, updatedAt: now }, {
                            $set: { status: doc.status, conclusion: doc.conclusion, assignee: doc.assignee, due: doc.due, updatedAt: doc.updatedAt }, $pop: { history: 1 },
                        }).catch(() => null);
                        throw error;
                    }
                    await cases.updateOne({ _id: doc._id }, { $set: { snapshot } });
                }
                return { ok: true, snapshot };
            });
        }
    }

    class IntegrityDataHandler extends IntegrityBase {
        async get() {
            const [data, run, list] = await Promise.all([
                dependencies.loadData(this.tdoc), runs.findOne({ _id: contestKey(this.tdoc) }),
                cases.find({ domainId: this.tdoc.domainId, contestId: String(this.tdoc.docId) }, { projection: { evidence: 0 } }).sort({ createdAt: -1 }).toArray(),
            ]);
            const teams = new Map(data.teams.map((team) => [team.team_id, team]));
            const schoolOf = (id: string) => teams.get(id)?.organization || '未填写学校';
            const users = await UserModel.getList(this.tdoc.domainId, [...new Set([...list.map((item) => item.createdBy), ...run ? [run.by] : []])]);
            const name = (uid: number) => (users[uid] as { uname?: string } | undefined)?.uname || String(uid);
            const label = (pid: number) => { const index = this.tdoc.pids.indexOf(pid); return index >= 0 ? getAlphabeticId(index) : `#${pid}`; };
            this.response.type = 'application/json';
            this.response.body = {
                duration: this.tdoc.endAt.getTime() - this.tdoc.beginAt.getTime(), endAt: this.tdoc.endAt,
                problems: this.tdoc.pids.map((pid, index) => ({ pid, label: getAlphabeticId(index) })),
                teams: data.teams.map((team) => ({ id: team.team_id, name: team.name, school: team.organization || '', official: !team.group.includes('unofficial') })),
                run: run && {
                    at: run.at, by: name(run.by), options: run.options, samples: run.samples,
                    pairs: run.pairs.map((pair) => ({ ...pair, label: label(pair.pid), sameSchool: schoolOf(pair.a.teamId) === schoolOf(pair.b.teamId) })),
                    groups: similarityGroups(run.pairs, schoolOf),
                },
                cases: list.map((item) => ({ ...item, id: String(item._id), _id: undefined, creator: name(item.createdBy), overdue: item.status === 'open' && !!item.due && item.due.getTime() < Date.now() })),
            };
        }
    }

    class IntegrityCodeHandler extends IntegrityBase {
        @param('rid', Types.ObjectId)
        async get(_domainId: string, rid: ObjectId) {
            if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_READ_RECORD_CODE);
            const doc = await records.findOne({ _id: rid, domainId: this.tdoc.domainId, contest: this.tdoc.docId }) as { code?: string; lang?: string } | null;
            if (!doc) throw new NotFoundError('这不是本场比赛的提交');
            this.response.type = 'application/json';
            this.response.body = { code: doc.code || '', lang: doc.lang || '' };
        }
    }

    class IntegrityTimelineHandler extends IntegrityBase {
        @param('team', Types.String)
        async get(_domainId: string, team: string) {
            if (!/^-?\d{1,16}$/.test(team)) throw new ValidationError('team');
            this.response.type = 'application/json';
            this.response.body = await timeline(this.tdoc, team);
        }
    }

    /** 证据: the case, the similar pairs among its teams with both programs, and each team's timeline. */
    class IntegrityExportHandler extends IntegrityBase {
        @param('case', Types.ObjectId)
        async get(_domainId: string, id: ObjectId) {
            if (!this.user.own(this.tdoc)) this.checkPerm(PERM.PERM_READ_RECORD_CODE);
            const doc = await cases.findOne({ _id: id, domainId: this.tdoc.domainId, contestId: String(this.tdoc.docId) });
            if (!doc) throw new NotFoundError('复核任务不存在');
            const [data, legacyAnalysis] = await Promise.all([dependencies.loadData(this.tdoc), doc.evidence ? null : runs.findOne({ _id: contestKey(this.tdoc) })]);
            const teams = new Map(data.teams.map((team) => [team.team_id, team]));
            const pairs = doc.evidence?.pairs ?? casePairs(legacyAnalysis?.pairs || [], doc.teams);
            const label = (pid: number) => { const index = this.tdoc.pids.indexOf(pid); return index >= 0 ? getAlphabeticId(index) : `#${pid}`; };
            const teamName = (teamId: string) => teams.get(teamId)?.name || teamId;
            const allRids = [...new Set(pairs.flatMap((pair) => [pair.a.rid, pair.b.rid]))];
            const rids = allRids.slice(0, 400);
            const entries = [
                { name: 'case.json', data: Buffer.from(JSON.stringify({ ...doc, _id: String(doc._id),
                    ...(allRids.length > rids.length ? { omittedSourceIds: allRids.slice(rids.length) } : {}),
                    teams: doc.teams.map((teamId) => ({ id: teamId, name: teamName(teamId), school: teams.get(teamId)?.organization || '' })) }, null, 2)) },
                { name: 'similarity.csv', data: Buffer.from(resultsCsv([['题目', '队伍 A', '学校 A', '提交 A', '队伍 B', '学校 B', '提交 B', '相似度', '共同指纹'],
                    ...pairs.map((pair) => [label(pair.pid), teamName(pair.a.teamId), teams.get(pair.a.teamId)?.organization || '', pair.a.rid,
                        teamName(pair.b.teamId), teams.get(pair.b.teamId)?.organization || '', pair.b.rid, pair.score, pair.shared])])) },
            ];
            const codes = await records.find({ domainId: this.tdoc.domainId, contest: this.tdoc.docId, _id: { $in: rids.map((rid) => new ObjectId(rid)) } }).project({ code: 1, pid: 1, uid: 1, lang: 1 }).toArray() as
                { _id: ObjectId; code?: string; pid: number; lang?: string }[];
            const ownerOf = new Map(pairs.flatMap((pair) => [[pair.a.rid, pair.a.teamId], [pair.b.rid, pair.b.teamId]] as [string, string][]));
            for (const code of codes) {
                entries.push({ name: `code/${safe(teamName(ownerOf.get(String(code._id)) || ''))}-${label(code.pid)}-${code._id}.${safe(code.lang || 'txt')}.txt`, data: Buffer.from(code.code || '') });
            }
            for (const teamId of doc.teams) entries.push({ name: `timeline/${safe(teamName(teamId))}-${teamId}.json`, data: Buffer.from(JSON.stringify(await timeline(this.tdoc, teamId), null, 2)) });
            this.binary(writeZip(entries));
            this.response.type = 'application/zip';
            this.response.disposition = `attachment; filename="evidence.zip"; filename*=UTF-8''${StorageService.encodeRFC5987ValueChars(`${safe(this.tdoc.title)}-诚信复核-${safe(doc.title)}.zip`)}`;
        }
    }

    ctx.Route('contest_xcpcio_integrity', '/contest/:tid/integrity', IntegrityHandler);
    ctx.Route('contest_xcpcio_integrity_data', '/contest/:tid/integrity/data', IntegrityDataHandler);
    ctx.Route('contest_xcpcio_integrity_code', '/contest/:tid/integrity/code', IntegrityCodeHandler);
    ctx.Route('contest_xcpcio_integrity_timeline', '/contest/:tid/integrity/timeline', IntegrityTimelineHandler);
    ctx.Route('contest_xcpcio_integrity_export', '/contest/:tid/integrity/export', IntegrityExportHandler);
    ctx.i18n.load('zh', { contest_xcpcio_integrity: '诚信复核' });
}
