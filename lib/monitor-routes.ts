import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    ContestModel, Context, getAlphabeticId, Handler, NotFoundError, ObjectId, param, PERM, PRIV, RecordModel, TaskModel, Tdoc, Types, UserModel,
} from 'hydrooj';
import { hostPressure, type HostPressure, reportHostname, reportMetrics, type StatusReport } from './host';
import { JudgeTracker, mergeJudges, taskInfo, type TrackedJudge } from './judge-tracker';
import { type MachineMetrics, type MonitorMachine, monitorSnapshot, type MonitorRecord, type MonitorSnapshot } from './monitor';
import { resolverCodeBase } from './resolver-data';
import { toScriptJson } from './settings';
import { describeTeam, isTeamEntry, memberIds, type TeamEntry } from './teams';

interface ProcessDoc {
    _id: string;
    host: string;
    pid: number;
    updateAt: Date;
    /** This server sampled live, when it runs the built-in judge. */
    pressure: HostPressure | null;
    judges: TrackedJudge[];
}

/** How often each Hydro process shares its live judging, and when a silent process is gone. */
const PUBLISH_MS = 3000;
const PROCESS_STALE_MS = 20_000;
/** Daemon reports older than this are machines retired long ago. */
const REPORT_FORGET_MS = 6 * 3600_000;

/**
 * Judge monitoring for contest managers: every judge machine's load and performance, live judging
 * on each, and the contest's waiting submissions (no external alerts yet).
 *
 * Judge daemons are watched on their WebSocket (Hydro's JudgeConnectionHandler): the tasks handed
 * to them, their progress and results. The built-in hydrojudge is watched through Hydro's
 * record/change and record/judge events. Each process shares what it sees every few seconds in
 * `xcpcio.monitor.judges`, so the monitor shows all PM2 instances.
 */
export function applyMonitor(ctx: Context) {
    const version = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version;
    const codeBase = resolverCodeBase(version);
    // Judge machines report to Hydro's `status` collection (service/monitor.ts), every 20 minutes.
    const judgeStatus = ctx.db.collection('status' as never) as unknown as {
        find: (query: object, options?: object) => { toArray: () => Promise<StatusReport[]> };
    };
    const shared = ctx.db.collection('xcpcio.monitor.judges' as never) as unknown as {
        find: (query: object) => { toArray: () => Promise<ProcessDoc[]> };
        updateOne: (filter: object, update: object, options?: object) => Promise<unknown>;
        deleteOne: (filter: object) => Promise<unknown>;
        createIndex?: (keys: object, options?: object) => Promise<unknown>;
    };
    const contestBase = (tdoc: Tdoc) => `/d/${encodeURIComponent(tdoc.domainId)}/contest/${tdoc.docId}`;
    // Hydro lists its loaded addons by name in global.Hydro.version (loader.ts): `@hydrooj/hydrojudge` is
    // listed as `hydrojudge`; an addon added by path or under another scope keeps its package name.
    const localJudge = () => Object.keys((globalThis as { Hydro?: { version?: Record<string, unknown> } }).Hydro?.version || {})
        .some((name) => name === 'hydrojudge' || name.endsWith('/hydrojudge'));
    const host = os.hostname();
    const processKey = `${host}:${process.pid}`;
    const tracker = new JudgeTracker(host);

    // --- Live judging in this process ---
    type JudgeConnection = {
        constructor: { name: string };
        category?: string;
        user?: { uname?: string };
        request?: { ip?: string };
        message?: (msg: unknown) => unknown;
        newTask?: (task: Record<string, unknown>) => Promise<unknown>;
    };
    const connections = new WeakMap<object, string>();
    const on = ctx.on.bind(ctx) as unknown as (name: string, listener: (...args: any[]) => unknown) => () => void;
    on('app/started', async () => {
        await shared.createIndex?.({ updateAt: 1 }, { expireAfterSeconds: 600 }).catch(() => null);
    });
    on('connection/active', (handler: JudgeConnection) => {
        if (handler?.category !== '#judge' && handler?.constructor?.name !== 'JudgeConnectionHandler') return;
        if (typeof handler.message !== 'function' || typeof handler.newTask !== 'function') return;
        const id = `${processKey}:${Math.random().toString(36).slice(2, 10)}`;
        connections.set(handler, id);
        tracker.connect(id, { uname: handler.user?.uname ?? null, ip: handler.request?.ip ?? null });
        // Observe before Hydro handles them; never change what Hydro does.
        const message = handler.message.bind(handler);
        handler.message = (msg: unknown) => {
            try { tracker.message(id, msg as Record<string, unknown>); } catch { /* monitoring only */ }
            return message(msg);
        };
        // Hydro binds newTask when the daemon sends `start`, after this event, so the wrapper is used.
        const newTask = handler.newTask.bind(handler);
        handler.newTask = async (task: Record<string, unknown>) => {
            const info = taskInfo(task);
            if (info) tracker.taskStart(id, info);
            try {
                return await newTask(task);
            } finally {
                if (info) tracker.taskDone(id, info.rid);
            }
        };
    });
    on('connection/close', (handler: object) => {
        const id = connections.get(handler);
        if (id) tracker.disconnect(id);
    });
    on('record/change', (rdoc: Record<string, any>) => {
        if (!rdoc || !localJudge()) return;
        const info = taskInfo({ ...rdoc, rid: rdoc._id });
        if (info) tracker.builtinChange(info, rdoc.status, Array.isArray(rdoc.testCases) ? rdoc.testCases.length : 0, typeof rdoc.progress === 'number' ? rdoc.progress : null);
    });
    on('record/judge', (rdoc: Record<string, any>) => {
        if (!rdoc || !localJudge()) return;
        const info = taskInfo({ ...rdoc, rid: rdoc._id });
        if (info) tracker.builtinFinish(info, { status: rdoc.status, time: rdoc.time, memory: rdoc.memory });
    });

    let published = false;
    const ownDoc = (): ProcessDoc => {
        const builtin = localJudge();
        if (builtin) tracker.builtin();
        return { _id: processKey, host, pid: process.pid, updateAt: new Date(), pressure: builtin ? hostPressure() : null, judges: tracker.snapshot() };
    };
    async function publish() {
        const doc = ownDoc();
        if (!doc.judges.length && !published) return;
        published = doc.judges.length > 0;
        const { _id, ...fields } = doc;
        await shared.updateOne({ _id }, { $set: fields }, { upsert: true });
    }
    const publisher = setInterval(() => { publish().catch(() => null); }, PUBLISH_MS);
    publisher.unref?.();
    ctx.effect(() => async () => {
        clearInterval(publisher);
        if (published) await shared.deleteOne({ _id: processKey }).catch(() => null);
    });

    /** Every judge machine: live judging from all processes, machine numbers live or as reported. */
    async function machines(now: number): Promise<MonitorMachine[]> {
        const [reports, others] = await Promise.all([
            judgeStatus.find({ type: 'judge' }, { projection: { mid: 1, type: 1, updateAt: 1, memory: 1, load: 1, CpuTemp: 1, cpu: 1, osinfo: 1, compilers: 1 } }).toArray(),
            shared.find({ updateAt: { $gt: new Date(now - PROCESS_STALE_MS) } }).toArray(),
        ]);
        // This process's own state is current, not the copy from the last publish.
        const processes = [...others.filter((doc) => doc._id !== processKey), ownDoc()];
        let judges = mergeJudges(processes);
        // A daemon that reconnected is listed once, by its live connection.
        const identity = (judge: TrackedJudge) => judge.mid ?? `${judge.uname}@${judge.ip}`;
        const live = new Set(judges.filter((judge) => judge.disconnectedAt === null).map(identity));
        judges = judges.filter((judge) => judge.disconnectedAt === null || !live.has(identity(judge)));
        const byMid = new Map(reports.filter((report) => report.mid !== undefined).map((report) => [String(report.mid), report]));
        const pressureOf = (judgeHost: string | null) => processes
            .filter((doc) => doc.host === judgeHost && doc.pressure)
            .sort((a, b) => new Date(b.updateAt).getTime() - new Date(a.updateAt).getTime())[0]?.pressure ?? null;
        const result: MonitorMachine[] = judges.map((judge) => {
            if (judge.kind === 'builtin') {
                const pressure = pressureOf(judge.host);
                const metrics: MachineMetrics | null = pressure ? {
                    cpu: pressure.cpu, memoryRate: pressure.memoryRate, memoryTotal: pressure.memoryTotal, temperature: null,
                    cores: pressure.cores, model: pressure.model, os: pressure.os, compilers: null, reportedAt: null,
                } : null;
                return { key: judge.id, name: `内置评测（${judge.host}）`, kind: 'builtin', tracked: judge, metrics };
            }
            const report = judge.mid ? byMid.get(judge.mid) : undefined;
            return {
                key: judge.id, kind: 'remote', tracked: judge, metrics: report ? reportMetrics(report) : null,
                name: (report && reportHostname(report)) || judge.uname || judge.ip || '评测机',
            };
        });
        // Daemons known only from reports: not connected to Hydro now.
        const tracked = new Set(judges.map((judge) => judge.mid).filter(Boolean));
        for (const [mid, report] of byMid) {
            const metrics = reportMetrics(report);
            if (tracked.has(mid) || now - metrics.reportedAt > REPORT_FORGET_MS) continue;
            result.push({ key: `report:${mid}`, kind: 'remote', tracked: null, metrics, name: reportHostname(report) || mid });
        }
        // Two machines with one name (same hostname or account) are told apart by address.
        const counts = new Map<string, number>();
        for (const machine of result) counts.set(machine.name, (counts.get(machine.name) || 0) + 1);
        for (const machine of result) if (counts.get(machine.name)! > 1 && machine.tracked?.ip) machine.name = `${machine.name}（${machine.tracked.ip}）`;
        return result;
    }

    // Every open monitor polls; one computation per contest and identity view every few seconds.
    const cache = new Map<string, { expires: number; value: Promise<MonitorSnapshot> }>();

    async function snapshot(tdoc: Tdoc, identity: boolean): Promise<MonitorSnapshot> {
        const cursor = ContestModel.getMultiStatus(tdoc.domainId, { docId: tdoc.docId }) as unknown as {
            project?: (spec: object) => { toArray: () => Promise<TeamEntry[]> };
            toArray: () => Promise<TeamEntry[]>;
        };
        const entries = await (typeof cursor.project === 'function' ? cursor.project({ uid: 1, members: 1, displayName: 1 }) : cursor).toArray();
        const users = await UserModel.getList(tdoc.domainId, [...entries.map((entry) => entry.uid), ...memberIds(tdoc, entries)]);
        // Team contests: members submit, the team is credited.
        const teamOf = new Map<number, { id: string; name: string }>();
        for (const entry of entries) {
            const team = describeTeam(entry, users, identity);
            if (!team) continue;
            const value = { id: `${entry.uid}`, name: team.name };
            teamOf.set(entry.uid, value);
            if (isTeamEntry(entry)) for (const member of entry.members) teamOf.set(member, value);
        }
        const now = Date.now();
        const [records, queueLength, judges] = await Promise.all([
            RecordModel.getMulti(tdoc.domainId, { contest: tdoc.docId }, {
                projection: { _id: 1, status: 1, uid: 1, pid: 1, lang: 1, judgeAt: 1, rejudged: 1 },
            }).toArray(),
            TaskModel.count({ type: 'judge' }),
            machines(now),
        ]);
        return monitorSnapshot({
            now,
            contest: { domainId: tdoc.domainId, id: `${tdoc.docId}` },
            records: records.map((record): MonitorRecord => ({
                id: `${record._id}`, submittedAt: new ObjectId(record._id).getTimestamp().getTime(), status: record.status,
                uid: record.uid, pid: record.pid, lang: record.lang,
                judgeAt: record.judgeAt ? new Date(record.judgeAt).getTime() : null, rejudged: !!record.rejudged,
            })),
            machines: judges,
            queueLength,
            problems: tdoc.pids.map((pid, index) => ({ pid, label: getAlphabeticId(index) })),
            teamOf: (uid) => teamOf.get(uid) ?? null,
        });
    }

    class MonitorHandler extends Handler {
        tdoc!: Tdoc;

        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            const tdoc = await ContestModel.get(this.domain._id, tid);
            if (!tdoc) throw new NotFoundError('Contest not found');
            this.checkPriv(PRIV.PRIV_USER_PROFILE);
            if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            this.tdoc = tdoc;
        }

        async get() {
            const base = contestBase(this.tdoc);
            this.response.template = 'xcpcio_monitor.html';
            this.response.body = {
                tdoc: this.tdoc, codeBase,
                runtimeJson: toScriptJson({ dataUrl: `${base}/monitor/data`, contestUrl: base, title: this.tdoc.title, refreshMs: 3000 }),
            };
        }
    }

    class MonitorDataHandler extends MonitorHandler {
        notUsage = true;

        async get() {
            // Real names only for those who may see private user information, as on the board.
            const identity = this.user.own(this.tdoc) || this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO);
            const key = `${this.tdoc.domainId}/${this.tdoc.docId}/${identity ? 1 : 0}`;
            const now = Date.now();
            for (const [name, entry] of cache) if (entry.expires <= now) cache.delete(name);
            let entry = cache.get(key);
            if (!entry) {
                entry = { expires: now + 2000, value: snapshot(this.tdoc, identity) };
                entry.value.catch(() => cache.delete(key));
                cache.set(key, entry);
            }
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await entry.value);
        }
    }

    ctx.Route('contest_xcpcio_monitor', '/contest/:tid/monitor', MonitorHandler);
    ctx.Route('contest_xcpcio_monitor_data', '/contest/:tid/monitor/data', MonitorDataHandler);
    ctx.i18n.load('zh', { contest_xcpcio_monitor: '评测队列与监控' });
    return { tracker, machines };
}
