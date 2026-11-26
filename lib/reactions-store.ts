import fs from 'node:fs';
import path from 'node:path';
import { type Context, type Tdoc } from 'hydrooj';
import type { BoardData } from './board';
import type { Clip as ReactionClip, Segment } from './recording-store';
import { buildContestInfo, buildRuns } from './live/model';
import { rankOf, scoreboardRow } from './live/scoreboard';
import type { RunInfo } from './live/types';
import type { BoardSettings } from './settings';
import {
    canPublish,
    layoutHistory,
    defaultReactionPublic,
    matchesLayout,
    layoutsAt,
    needsRender,
    type ReactionLayout,
    type ReactionPublic,
} from './reactions';

interface LayoutDoc {
    _id: string;
    contestKey: string;
    layout: ReactionLayout;
    effectiveAt: number;
}
interface VideoDoc {
    _id: string;
    contestKey: string;
    rid: string;
    layoutId: string;
    generation: number;
    layout: ReactionLayout;
    layoutRevision: number;
    teamUid: number;
    pid: number;
    team: string;
    school: string;
    problem: string;
    verdict: string;
    firstSolve: boolean;
    accepted: boolean;
    priority: number;
    state: 'waiting' | 'ready' | 'failed' | 'stale' | 'rendering' | 'ineligible' | 'removed';
    hidden: { at: number; by: number } | null;
    path?: string;
    bytes?: number;
    durationMs?: number;
    codec?: string;
    error?: string;
    worker?: string;
    workerOwner?: string;
    leaseAt?: number;
    createdAt: number;
    readyAt?: number;
    updatedAt: number;
    submittedAt: number;
    attempts: number;
}
interface WorkerDoc {
    _id: string;
    contestKey: string;
    name: string;
    version: string;
    partition: string;
    lastSeen: number;
    connectionId?: string | null;
    connectionRevision?: number;
    ip: string;
    current: { runId: string; layoutId: string; generation: number } | null;
    queue: number;
}
interface AssetDoc {
    _id: string;
    contestKey: string;
    path: string;
    mime: string;
    bytes: number;
}
interface ConnectionDoc {
    _id: string;
    contestKey: string;
    name: string;
    tokenHash: string;
    revision: number;
    issuedAt: Date;
    issuedBy: number;
}
interface ConfigDoc {
    _id: string;
    syncThrough?: number;
    fixedLayouts?: boolean;
    token?: string;
    tokenAt?: Date;
    public?: ReactionPublic;
}
declare module 'hydrooj' {
    interface Collections {
        'xcpcio.reactions.layouts': LayoutDoc;
        'xcpcio.reactions.config': ConfigDoc;
        'xcpcio.reactions.videos': VideoDoc;
        'xcpcio.reactions.workers': WorkerDoc;
        'xcpcio.reactions.connections': ConnectionDoc;
        'xcpcio.reactions.assets': AssetDoc;
    }
}
export interface ReactionDependencies {
    loadSettings: (tdoc: Tdoc) => Promise<BoardSettings>;
    loadData: (tdoc: Tdoc, realtime: boolean, identity: boolean, results: boolean | 'live') => Promise<BoardData>;
    screenDuringContest?: (tdoc: Tdoc) => Promise<boolean>;
}
export const contestKey = (tdoc: Tdoc) => `${tdoc.domainId}/${tdoc.docId}`;
export const reactionBase = (tdoc: Tdoc) => `/d/${encodeURIComponent(tdoc.domainId)}/contest/${tdoc.docId}/reactions`;
export const videoKey = (contest: string, rid: string, layout: string) => `${contest}/${rid}/${layout}`;
export const videoId = (video: Pick<VideoDoc, 'rid' | 'layoutId'>) => `${video.rid}~${video.layoutId}`;
export function createReactionStore(ctx: Context, deps: ReactionDependencies) {
    const layouts = ctx.db.collection('xcpcio.reactions.layouts'),
        videos = ctx.db.collection('xcpcio.reactions.videos');
    const configs = ctx.db.collection('xcpcio.reactions.config'),
        workers = ctx.db.collection('xcpcio.reactions.workers');
    const connections = ctx.db.collection('xcpcio.reactions.connections');
    const assets = ctx.db.collection('xcpcio.reactions.assets');
    const clips = ctx.db.collection('xcpcio.recording.clips' as never);
    const segments = ctx.db.collection('xcpcio.recording.segments' as never);
    const logoNames = JSON.parse(fs.readFileSync(path.join(__dirname, '../logos/index.json'), 'utf8')).names;
    const cfg = async (key: string) => (await configs.findOne({ _id: key })) || ({ _id: key } as ConfigDoc);
    const policy = (doc: ConfigDoc) => ({ ...defaultReactionPublic, ...doc.public });
    async function versions(key: string) {
        const docs = await layouts.find({ contestKey: key }).sort({ 'layout.revision': 1 }).toArray();
        return layoutHistory(docs);
    }
    const latest = (docs: { layout: ReactionLayout }[]) => [...new Map(docs.filter(d => d.layout.template).map(d => [d.layout.id, d.layout])).values()];
    async function loadContest(tdoc: Tdoc) {
        const [data, settings] = await Promise.all([deps.loadData(tdoc, true, true, 'live'), deps.loadSettings(tdoc)]);
        const source = { data, settings, contest: tdoc, identity: true, boards: [], logoNames, now: Date.now() };
        const info = buildContestInfo(source, { fallbackOrganizationLogo: false });
        return { info, runs: buildRuns(source, info) };
    }
    const contexts = new Map<string, { until: number; run: ReturnType<typeof loadContest> }>();
    function context(tdoc: Tdoc, force = false) {
        const key = contestKey(tdoc),
            now = Date.now();
        for (const [id, entry] of contexts) if (entry.until <= now) contexts.delete(id);
        const existing = contexts.get(key);
        if (existing && !force) return existing.run;
        const run = loadContest(tdoc);
        contexts.set(key, { until: now + 4000, run });
        run.catch(() => {
            if (contexts.get(key)?.run === run) contexts.delete(key);
        });
        return run;
    }
    async function clipList(key: string, query: Record<string, unknown> = {}, limit = 0) {
        return (await clips
            .find({ contestKey: key, ...query })
            .sort({ submittedAt: -1 })
            .limit(limit)
            .toArray()) as unknown as ReactionClip[];
    }
    async function mediaSegments(key: string, ids: string[]) {
        if (!ids.length) return [];
        return (await segments
            .find({ contestKey: key, _id: { $in: ids } as never })
            .sort({ startAt: 1 })
            .toArray()) as unknown as Segment[];
    }
    async function reconcile(tdoc: Tdoc, since: number, force: boolean) {
        const key = contestKey(tdoc);
        const source = await clipList(key, { state: { $in: ['ready', 'partial'] }, ...(since ? { readyAt: { $gte: since - 15000 } } : {}) });
        if (!source.length) return;
        const [{ info, runs }, history, previous] = await Promise.all([
            context(tdoc, force),
            versions(key),
            videos.find({ contestKey: key, ...(since ? { rid: { $in: source.map((c) => c.rid) } } : {}) }).toArray(),
        ]);
        const runMap = new Map(runs.map((r) => [r.id, r])),
            teams = new Map(info.teams.map((t) => [t.id, t]));
        const schools = new Map(info.organizations.map((o) => [o.id, o.displayName])),
            prior = new Map(previous.map((v) => [v._id, v]));
        const migrated = new Set(history.filter(row => row.migrated).map(row => row.layout));
        const updates: Array<Parameters<typeof videos.bulkWrite>[0][number]> = [];
        for (const clip of source) {
            const run = runMap.get(clip.rid),
                team = teams.get(String(clip.teamUid));
            const eligible = layoutsAt(history, clip.judgedAt).filter(l => l.template);
            for (const layout of eligible) {
                const _id = videoKey(key, clip.rid, layout.id),
                    old = prior.get(_id);
                const outcome = run?.result.type === 'ICPC' ? run.result : null;
                const first = !!outcome?.isFirstToSolveRun,
                    accepted = !!outcome?.verdict.isAccepted;
                if (!outcome || !team || !matchesLayout(layout, accepted, first)) {
                    if (old && old.state !== 'ineligible')
                        updates.push({
                            updateOne: {
                                filter: { _id, generation: old.generation },
                                update: { $set: { state: 'ineligible', updatedAt: Date.now() }, $inc: { generation: 1 } },
                            },
                        });
                    continue;
                }
                const verdict = outcome.verdict.shortName;
                if (old?.state === 'removed') continue;
                const meta = {
                    layout,
                    layoutId: layout.id,
                    layoutRevision: layout.revision,
                    rid: clip.rid,
                    teamUid: clip.teamUid,
                    pid: clip.pid,
                    team: team.name,
                    school: schools.get(team.organizationId || '') || '',
                    problem: info.problems.find((p) => p.id === run!.problemId)?.letter || '',
                    firstSolve: first,
                    accepted,
                    verdict,
                    priority: first ? 0 : accepted ? 1 : 2,
                    submittedAt: clip.submittedAt,
                    updatedAt: Date.now(),
                };
                if (!old)
                    updates.push({
                        updateOne: {
                            filter: { _id },
                            update: {
                                $setOnInsert: {
                                    _id,
                                    contestKey: key,
                                    ...meta,
                                    state: 'waiting',
                                    createdAt: Date.now(),
                                    hidden: null,
                                    generation: 1,
                                    attempts: 0,
                                },
                            },
                            upsert: true,
                        },
                    });
                else if (needsRender(old, verdict, first, layout.revision)) {
                    // Keep a previously finished file until a rejudge or an explicit backfill.
                    if (migrated.has(layout) && old.state === 'ready' && !old.layout.template && old.verdict === verdict && old.firstSolve === first) continue;
                    updates.push({
                        updateOne: {
                            filter: { _id, generation: old.generation },
                            update: { $set: { ...meta, state: 'stale' }, $inc: { generation: 1 } },
                        },
                    });
                }
            }
        }
        if (updates.length) await videos.bulkWrite(updates, { ordered: false });
    }
    // The durable watermark keeps idle media workers from rescanning a whole tournament on every poll.
    // Advance it only after the batch completes; the overlap covers Mongo writes spanning the query.
    const synced = new Map<string, { until: number; run: Promise<void> }>();
    function invalidate(key: string) {
        synced.delete(key);
        contexts.delete(key);
    }
    function sync(tdoc: Tdoc, force = false) {
        const key = contestKey(tdoc),
            now = Date.now();
        for (const [id, entry] of synced) if (entry.until <= now) synced.delete(id);
        const old = synced.get(key);
        if (old && !force) return old.run;
        const run = (old?.run.catch(() => {}) || Promise.resolve()).then(async () => {
            const doc = await cfg(key);
            const previous = force || !doc.fixedLayouts ? 0 : doc.syncThrough || 0;
            await reconcile(tdoc, previous, force);
            await configs.updateOne({ _id: key }, { $max: { syncThrough: now }, $set: { fixedLayouts: true } }, { upsert: true });
        });
        synced.set(key, { until: now + 5000, run });
        run.catch(() => {
            if (synced.get(key)?.run === run) synced.delete(key);
        });
        return run;
    }
    async function publicAccess(tdoc: Tdoc, layoutId?: string) {
        const config = policy(await cfg(contestKey(tdoc)));
        if (layoutId) config.layoutId = layoutId;
        // Avoid scoreboard and capture reads on contests which have not enabled publication.
        if (!config.enabled) return { config, showSchool: false, allows: (_v: Parameters<typeof canPublish>[0]) => false };
        const [board, screen] = await Promise.all([deps.loadSettings(tdoc), deps.screenDuringContest?.(tdoc) ?? false]);
        return {
            config,
            showSchool: config.school === 'show' || (config.school === 'board' && board.showIdentity),
            allows: (v: Parameters<typeof canPublish>[0]) => canPublish(v, config, tdoc, board, screen, Date.now()),
        };
    }
    type VideoFilter = NonNullable<Parameters<typeof videos.find>[0]>;
    type ListQuery = Record<string, unknown>;
    const publicProjection = {
        _id: 0,
        rid: 1,
        teamUid: 1,
        pid: 1,
        firstSolve: 1,
        accepted: 1,
        layoutId: 1,
        team: 1,
        school: 1,
        problem: 1,
        verdict: 1,
        durationMs: 1,
        submittedAt: 1,
    };
    function publicRow(v: VideoDoc, tdoc: Tdoc, school: boolean) {
        return {
            id: videoId(v),
            rid: v.rid,
            teamUid: v.teamUid,
            pid: v.pid,
            firstSolve: v.firstSolve,
            accepted: v.accepted,
            layoutId: v.layoutId,
            url: reactionBase(tdoc) + '/video/' + videoId(v),
            team: v.team,
            school: school ? v.school : '',
            problem: v.problem,
            verdict: v.verdict,
            durationMs: v.durationMs || 0,
            submittedAt: v.submittedAt,
        };
    }
    async function audienceFilter(tdoc: Tdoc, access: Awaited<ReturnType<typeof publicAccess>>): Promise<VideoFilter> {
        const key = contestKey(tdoc),
            policy = access.config;
        // Each immutable revision describes what was baked into that specific file. Validate
        // historical as well as current layouts before counting rows or publishing filter values.
        const allowed = (await versions(key))
            .filter(({ layout }) => access.allows({ state: 'ready', firstSolve: true, accepted: true, submittedAt: +tdoc.beginAt, layout }))
            .map((v) => v.layout.revision);
        return {
            contestKey: key,
            state: 'ready',
            hidden: null,
            path: { $type: 'string' },
            layoutId: policy.layoutId,
            layoutRevision: { $in: allowed },
            ...(policy.scope === 'first' ? { firstSolve: true } : policy.scope === 'accepted' ? { accepted: true } : {}),
            ...(tdoc.lockAt && !tdoc.unlocked ? { submittedAt: { $lte: +tdoc.lockAt } } : {}),
        };
    }
    async function publicVideos(tdoc: Tdoc, layoutId?: string) {
        const access = await publicAccess(tdoc, layoutId);
        if (!access.config.enabled) return [];
        const match = await audienceFilter(tdoc, access);
        return (await videos.find(match, { projection: publicProjection }).sort({ firstSolve: -1, submittedAt: -1, _id: 1 }).toArray()).map(
            (v) => publicRow(v, tdoc, access.showSchool),
        );
    }
    async function selectedPage(
        base: VideoFilter,
        query: ListQuery,
        fields: ('team' | 'problem' | 'verdict' | 'school')[],
        mode: 'queue' | 'public' | 'admin',
    ) {
        const match: VideoFilter = { ...base };
        for (const name of fields) if (typeof query[name] === 'string' && query[name]) match[name] = query[name].slice(0, 500);
        if (mode !== 'public') {
            if (typeof query.layoutId === 'string' && query.layoutId) match.layoutId = query.layoutId;
            if (query.state === 'hidden') match.hidden = { $ne: null };
            else if (
                typeof query.state === 'string' &&
                ['waiting', 'ready', 'stale', 'rendering', 'failed', 'removed'].includes(query.state)
            ) {
                match.$and = [{ state: query.state as VideoDoc['state'] }];
            }
        }
        const [total, options] = await Promise.all([
            videos.countDocuments(match),
            Promise.all(
                fields.map(
                    async (name) =>
                        [name, (await videos.distinct(name, base)).filter(Boolean).sort((a, b) => a.localeCompare(b, 'zh-CN'))] as const,
                ),
            ),
        ]);
        const size = 40,
            pages = Math.max(1, Math.ceil(total / size)),
            n = Number(query.page),
            page = Number.isSafeInteger(n) ? Math.max(1, Math.min(pages, n)) : 1;
        const cursor = videos.find(match, {
            projection: mode === 'public' ? publicProjection : { 'layout.items': 0, 'layout.card': 0, 'layout.background': 0 },
        });
        if (mode === 'queue') cursor.sort({ priority: 1, createdAt: 1, _id: 1 });
        else if (mode === 'public' && query.sort === 'problem') cursor.sort({ firstSolve: -1, problem: 1, submittedAt: -1, _id: 1 });
        else if (mode === 'public') cursor.sort({ firstSolve: -1, submittedAt: -1, _id: 1 });
        else cursor.sort({ submittedAt: -1, _id: 1 });
        return {
            rows: await cursor
                .skip((page - 1) * size)
                .limit(size)
                .toArray(),
            paging: { total, page, pages, options: Object.fromEntries(options) },
        };
    }
    async function publicPage(tdoc: Tdoc, query: ListQuery) {
        const access = await publicAccess(tdoc);
        if (!access.config.enabled) return null;
        const match = await audienceFilter(tdoc, access);
        const { rows, paging } = await selectedPage(
            match,
            query,
            access.showSchool ? ['team', 'school', 'problem', 'verdict'] : ['team', 'problem', 'verdict'],
            'public',
        );
        const selected = typeof query.video === 'string' ? query.video.split('~') : [];
        const shared =
            selected.length === 2 && selected[1] === access.config.layoutId
                ? await videos.findOne({ ...match, rid: selected[0] }, { projection: publicProjection })
                : null;
        return {
            videos: rows.map((v) => publicRow(v, tdoc, access.showSchool)),
            paging,
            shared: shared ? publicRow(shared, tdoc, access.showSchool) : null,
            download: access.config.download,
        };
    }
    async function adminPage(tdoc: Tdoc, query: ListQuery) {
        const key = contestKey(tdoc),
            queue = query.tab === 'queue';
        const match: VideoFilter = {
            contestKey: key,
            state: queue ? { $in: ['waiting', 'stale', 'failed', 'rendering'] } : { $ne: 'ineligible' },
        };
        const { rows, paging } = await selectedPage(match, query, ['team', 'problem', 'verdict'], queue ? 'queue' : 'admin');
        const since = Date.now() - 3600000;
        const counts = queue
            ? await Promise.all([
                  videos.countDocuments({ contestKey: key, state: 'ready', readyAt: { $gte: since } }),
                  videos.countDocuments({ contestKey: key, state: 'failed', updatedAt: { $gte: since } }),
                  videos.countDocuments({ contestKey: key, state: { $in: ['waiting', 'stale'] } }),
                  videos.countDocuments({ contestKey: key, state: 'rendering' }),
              ])
            : null;
        return { rows, paging, stats: counts ? { done: counts[0], fail: counts[1], waiting: counts[2], rendering: counts[3] } : null };
    }
    async function staffReplay(tdoc: Tdoc, filter: { rid?: string; teamUid?: string } = {}) {
        const key = contestKey(tdoc),
            base = reactionBase(tdoc);
        const runs = await clipList(
            key,
            {
                state: { $in: ['ready', 'partial'] },
                ...(filter.rid ? { rid: filter.rid } : {}),
                ...(filter.teamUid ? { teamUid: Number(filter.teamUid) } : {}),
            },
            100,
        );
        const files = await videos.find({ contestKey: key, rid: { $in: runs.map((c) => c.rid) }, state: 'ready' }).toArray();
        const ids = [...new Set(runs.flatMap((c) => Object.values(c.streams).flatMap((s) => s.segments)))];
        const media = new Map((await mediaSegments(key, ids)).map((s) => [s._id, s]));
        const grouped = new Map<string, VideoDoc[]>();
        for (const file of files) {
            const list = grouped.get(file.rid) || [];
            list.push(file);
            grouped.set(file.rid, list);
        }
        return runs.map((c) => {
            const products = grouped.get(c.rid) || [];
            return {
                rid: c.rid,
                teamUid: c.teamUid,
                team: products[0]?.team || String(c.teamUid),
                problem: products[0]?.problem || String(c.pid),
                videos: products.map((v) => ({ label: v.layout.name, url: `${base}/manage/video/${videoId(v)}` })),
                streams: Object.entries(c.streams).map(([stream, s]) => ({
                    stream,
                    segments: s.segments.flatMap((id) => {
                        const m = media.get(id);
                        return m
                            ? [
                                  {
                                      url: `${base.replace(/\/reactions$/, '')}/live/capture/recordings/media/${id}`,
                                      startMs: m.startAt,
                                      endMs: m.endAt,
                                  },
                              ]
                            : [];
                    }),
                })),
            };
        });
    }
    async function summary(tdoc: Tdoc) {
        const key = contestKey(tdoc);
        const [ready, waiting, failed, doc] = await Promise.all([
            videos.countDocuments({ contestKey: key, state: 'ready' }),
            videos.countDocuments({ contestKey: key, state: { $in: ['waiting', 'stale', 'rendering'] } }),
            videos.countDocuments({ contestKey: key, state: 'failed' }),
            cfg(key),
        ]);
        return { ready, waiting, failed, publicEnabled: policy(doc).enabled };
    }
    async function setPublic(tdoc: Tdoc, enabled: boolean) {
        await configs.updateOne({ _id: contestKey(tdoc) }, { $set: { 'public.enabled': enabled } }, { upsert: true });
    }
    async function remove(key: string) {
        const [files, images] = await Promise.all([videos.find({ contestKey: key }).toArray(), assets.find({ contestKey: key }).toArray()]);
        for (const file of [...files, ...images]) if (file.path) await ctx.storage.del(file.path);
        await Promise.all([videos, assets, workers, layouts, connections].map((c) => c.deleteMany({ contestKey: key })));
        await configs.deleteOne({ _id: key });
    }
    return {
        layouts,
        videos,
        workers,
        connections,
        configs,
        assets,
        invalidate,
        cfg,
        policy,
        versions,
        latest,
        context,
        sync,
        clipList,
        mediaSegments,
        publicVideos,
        publicPage,
        adminPage,
        publicAccess,
        staffReplay,
        summary,
        setPublic,
        remove,
    };
}
export function runDetails(context: Awaited<ReturnType<ReturnType<typeof createReactionStore>['context']>>, ids: Set<string>) {
    const { info, runs } = context,
        teams = new Map(info.teams.map((t) => [t.id, t]));
    const byTeam = new Map<string, RunInfo[]>(),
        rows = new Map(info.teams.map((t) => [t.id, scoreboardRow(info, [], 'normal')]));
    const details = new Map<
        string,
        { run: RunInfo; problem: (typeof info.problems)[number]; team: Record<string, unknown>; rankBefore: number; rankAfter: number }
    >();
    const first = runs.findIndex((r) => ids.has(r.id));
    if (first < 0) return details;
    // Materialize standings once before the first requested submission; a single fullRun request for
    // today's latest clip should not recompute every intermediate team's ranking since contest start.
    for (const run of runs.slice(0, first)) {
        if (run.isHidden) continue;
        const list = byTeam.get(run.teamId) || [];
        list.push(run);
        byTeam.set(run.teamId, list);
    }
    for (const [id, list] of byTeam) rows.set(id, scoreboardRow(info, list, 'normal'));
    for (const run of runs.slice(first)) {
        if (run.isHidden) continue;
        const saved = rows.get(run.teamId)!,
            wanted = ids.has(run.id),
            before = wanted ? rankOf(info, rows, run.teamId) : 0;
        const list = byTeam.get(run.teamId) || [];
        list.push(run);
        byTeam.set(run.teamId, list);
        const after = scoreboardRow(info, list, 'normal');
        rows.set(run.teamId, after);
        if (!wanted) continue;
        const team = teams.get(run.teamId)!,
            org = info.organizations.find((o) => o.id === team.organizationId),
            rankAfter = rankOf(info, rows, run.teamId);
        details.set(run.id, {
            run,
            rankBefore: before,
            rankAfter,
            problem: info.problems.find((p) => p.id === run.problemId)!,
            team: {
                id: team.id,
                displayName: team.shortName,
                fullName: team.name,
                groups: info.groups.filter((g) => team.groups.includes(g.id)),
                hashTag: team.hashTag,
                medias: {},
                isOutOfContest: team.isOutOfContest,
                color: team.color || null,
                organization: org ? { id: org.id, displayName: org.displayName, fullName: org.fullName, logo: org.logo[0] || null } : null,
                customFields: { ...team.customFields, clicsTeamFullName: org?.fullName || '' },
                scoreboardRowBefore: saved,
                rankBefore: before,
                scoreboardRowAfter: after,
                rankAfter,
            },
        });
        if (details.size === ids.size) break;
    }
    return details;
}
