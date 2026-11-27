import { timeZone } from './time-zone';
import fs from 'node:fs';
import path from 'node:path';
import {
    ContestModel, Context, Handler, NotFoundError, ObjectId, param, PERM, PRIV, TaskModel, Tdoc, Types,
} from 'hydrooj';
import type { BoardData } from './board';
import { hostPressure, judgePressure, type StatusReport } from './host';
import { contestOverview, type ContestOverview } from './overview';
import { resolverCodeBase } from './resolver-data';
import { type BoardSettings, toScriptJson } from './settings';

/**
 * Inspection screen: the contest at a glance for visitors, on a manager's computer. Behind the
 * Hydro login (contest managers), so it shows real-time numbers also while the board is frozen.
 */
export function applyOverview(ctx: Context, dependencies: {
    loadData: (tdoc: Tdoc, realtime: boolean, identity: boolean, staffResults: boolean) => Promise<BoardData>;
    loadSettings: (tdoc: Tdoc) => Promise<BoardSettings>;
}) {
    const version = JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version;
    const codeBase = resolverCodeBase(version);
    const contestBase = (tdoc: Tdoc) => `/d/${encodeURIComponent(tdoc.domainId)}/contest/${tdoc.docId}`;
    const cache = new Map<string, { expires: number; value: Promise<OverviewBody> }>();
    type OverviewBody = ContestOverview & { system: Awaited<ReturnType<typeof system>> };
    // Judge machines and Hydro servers report to Hydro's `status` collection (service/monitor.ts).
    const status = ctx.db.collection('status' as never) as unknown as {
        find: (query: object, options?: object) => { toArray: () => Promise<StatusReport[]> };
    };
    // Hydro lists its loaded addons in global.Hydro.version; hydrojudge judges inside this server.
    const localJudge = () => Object.keys((globalThis as { Hydro?: { version?: Record<string, unknown> } }).Hydro?.version || {})
        .some((name) => name === 'hydrojudge' || name.endsWith('/hydrojudge'));

    /** Machine pressure: this server live, judges as last reported, and Hydro's whole judge queue. */
    async function system() {
        const host = hostPressure();
        const [reports, queue] = await Promise.all([
            status.find({ $or: [{ type: 'judge' }, { type: 'server', compilers: { $exists: true } }] },
                { projection: { mid: 1, type: 1, updateAt: 1, memory: 1, load: 1 } }).toArray(),
            TaskModel.count({ type: 'judge' }),
        ]);
        return { host, judges: judgePressure(reports, Date.now(), localJudge() ? host : null), queue };
    }

    class OverviewHandler extends Handler {
        tdoc!: Tdoc;

        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            const tdoc = await ContestModel.get(this.domain._id, tid);
            if (!tdoc) throw new NotFoundError('Contest not found');
            this.checkPriv(PRIV.PRIV_USER_PROFILE);
            if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            if (tdoc.rule !== 'acm') throw new NotFoundError('赛况总览仅支持 ACM 比赛');
            this.tdoc = tdoc;
        }

        async get() {
            const base = contestBase(this.tdoc);
            this.response.template = 'xcpcio_overview.html';
            this.response.body = {
                codeBase, title: `${this.tdoc.title} · 赛况总览`,
                runtimeJson: toScriptJson({ timeZone: timeZone(), dataUrl: `${base}/overview/data`, contestUrl: base, refreshMs: 3000 }),
            };
        }
    }

    class OverviewDataHandler extends OverviewHandler {
        notUsage = true;

        async get() {
            const tdoc = this.tdoc;
            const settings = await dependencies.loadSettings(tdoc);
            const identity = settings.showIdentity || this.user.own(tdoc) || this.user.hasPerm(PERM.PERM_VIEW_USER_PRIVATE_INFO);
            const key = `${tdoc.domainId}/${tdoc.docId}/${identity ? 1 : 0}`;
            const now = Date.now();
            for (const [name, entry] of cache) if (entry.expires <= now) cache.delete(name);
            let entry = cache.get(key);
            if (!entry) {
                entry = {
                    expires: now + 2000,
                    value: Promise.all([dependencies.loadData(tdoc, true, identity, true), system()]).then(([data, machines]) => ({
                        ...contestOverview({
                            title: tdoc.title, beginAt: tdoc.beginAt.getTime(), endAt: tdoc.endAt.getTime(),
                            lockAt: tdoc.lockAt ? tdoc.lockAt.getTime() : null, now: Date.now(), data,
                            unofficialFirstSolve: settings.unofficialFirstSolve, tieBreak: settings.tieBreak,
                        }),
                        system: machines,
                    })),
                };
                entry.value.catch(() => cache.delete(key));
                cache.set(key, entry);
            }
            this.response.type = 'application/json';
            this.response.body = JSON.stringify(await entry.value);
        }
    }

    ctx.Route('contest_xcpcio_overview', '/contest/:tid/overview', OverviewHandler);
    ctx.Route('contest_xcpcio_overview_data', '/contest/:tid/overview/data', OverviewDataHandler);
    ctx.i18n.load('zh', { contest_xcpcio_overview: '赛况总览' });
}
