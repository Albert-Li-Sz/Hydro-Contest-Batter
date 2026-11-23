/**
 * The event writer: in one Hydro process at a time (a lease in MongoDB), rebuilds each CCS-enabled
 * contest's objects in both views, compares them with what was last notified and appends the
 * differences to the event logs. It also keeps state the API promises but Hydro does not have:
 * judging start times, the thaw time, scheduled thaws, a paused countdown and finalization.
 * Webhooks are delivered from here too.
 */
import { randomUUID } from 'node:crypto';
import type { Context, Tdoc } from 'hydrooj';
import { endpointProperties } from './access';
import { isPending } from './judgement-types';
import { buildObjects, type CcsSource, contestTimes, type View } from './model';
import type { SourceDependencies, HydroApi, createCcsSourceLoader } from './source';
import { type CcsStore, contestKey, type EventDoc, type WebhookDoc } from './store';
import { type Endpoint } from './types';

const LEASE = 'ccs-writer';
const LEASE_MS = 15_000;
const FAST_MS = 2000;
const SLOW_MS = 30_000;
/** Webhooks failing longer than this are deactivated (the spec's "configured period"). */
export const WEBHOOK_GIVE_UP_MS = 30 * 60_000;
const VIEWS: View[] = ['full', 'public'];

export { diffNotifications, eventLine, notificationsOf } from './events';
import { diffNotifications, notificationsOf, eventLine } from './events';

export function applyWriter(host: HydroApi, ctx: Context, store: CcsStore, dependencies: SourceDependencies, loadCcsSource: ReturnType<typeof createCcsSourceLoader>['loadCcsSource']) {
    const { ContestModel, ObjectId, UserModel, PERM, PRIV } = host;
    const owner = randomUUID();
    const settings = ctx.db.collection('xcpcio.enhanced.settings' as never) as unknown as {
        find: (filter: object) => { toArray: () => Promise<{ _id: string }[]> };
    };
    let leader = false;
    let stopped = false;
    const hashes = new Map<string, Map<string, string>>();
    const nextTick = new Map<string, number>();
    const finished = new Set<string>();
    const quiet = new Map<string, { signature: string; since: number }>();
    /** What the last complete tick was built from: an unchanged contest needs no rebuild or diff. */
    const built = new Map<string, string>();
    let contests: { key: string; domainId: string; tid: string }[] = [];
    let contestsCheckedAt = 0;
    let running: Promise<void> | null = null;
    let delivering: Promise<void> | null = null;

    async function viewHashes(key: string, view: View) {
        const name = `${key}:${view}`;
        if (!hashes.has(name)) hashes.set(name, await store.hashes(key, view));
        return hashes.get(name)!;
    }

    /** Records judging that just started: Hydro keeps no start time. */
    async function observeJudging(source: CcsSource) {
        for (const record of source.records) {
            const judging = record.judgings.at(-1)!;
            if (judging.startAt !== null || !isPending(judging.status) || judging.status === 0) continue;
            judging.startAt = source.now;
            await store.recordJudgeStart(`${record.rid}.${record.judgings.length}`, source.now);
        }
    }

    /** Keeps what Hydro cannot: a scheduled thaw, a paused countdown, the thaw and final times. */
    async function keepContest(tdoc: Tdoc, key: string): Promise<Tdoc> {
        const now = Date.now();
        const { meta } = await store.contest(tdoc.domainId, `${tdoc.docId}`);
        let current = tdoc;
        const reload = async () => { current = await ContestModel.get(tdoc.domainId, tdoc.docId) as Tdoc; };
        if (meta.thawAt && now >= meta.thawAt && current.lockAt && !(current as { unlocked?: boolean }).unlocked && now >= current.endAt.getTime()) {
            await ContestModel.unlockScoreboard(current.domainId, current.docId);
            await store.setMeta(key, current.domainId, `${current.docId}`, { thawedAt: now, thawAt: null });
            await reload();
        } else if (current.lockAt && (current as { unlocked?: boolean }).unlocked && !meta.thawedAt) {
            await store.setMeta(key, current.domainId, `${current.docId}`, { thawedAt: Math.max(now, current.endAt.getTime() + 1) });
        }
        // While paused, the start keeps moving so the contest never begins: the time left stays.
        if (meta.countdownPauseMs != null && now + Math.max(meta.countdownPauseMs, 60_000) > current.beginAt.getTime()) {
            const shift = now + Math.max(meta.countdownPauseMs, 60_000) - current.beginAt.getTime();
            await ContestModel.edit(current.domainId, current.docId, {
                beginAt: new Date(current.beginAt.getTime() + shift),
                endAt: new Date(current.endAt.getTime() + shift),
                ...current.lockAt ? { lockAt: new Date(new Date(current.lockAt).getTime() + shift) } : {},
            });
            await reload();
        }
        return current;
    }

    async function tickContest(domainId: string, tid: string) {
        const key = contestKey(domainId, tid);
        let tdoc = await ContestModel.get(domainId, new ObjectId(tid)) as Tdoc | null;
        if (!tdoc || tdoc.rule !== 'acm') return;
        const boardSettings = await dependencies.loadSettings(tdoc);
        if (!boardSettings.ccsApi) return;
        if (!(await store.contest(domainId, tid)).snapshotId) tdoc = await keepContest(tdoc, key);
        const source = await loadCcsSource(ctx, store, dependencies, tdoc);
        await observeJudging(source);
        const times = contestTimes(source);
        // A manual confirmation or optional quiet-period auto-finalization closes an immutable dataset.
        const canFinalize = times.ended && (!times.freezes || times.thawedAt !== null)
            && !source.records.some(record => isPending(record.judgings.at(-1)!.status))
            && !source.full.submissions.some(record => record.status === 'PENDING');
        const signature = JSON.stringify([source.contest, source.full, source.settings, source.problems, source.languages, source.persons, source.accounts, source.records, source.comments, source.awardOverrides, source.clarifications, source.extraClarifications]);
        if (quiet.get(key)?.signature !== signature) quiet.set(key, { signature, since: source.now });
        const autoReady = boardSettings.ccsAutoFinalize && source.now - quiet.get(key)!.since >= 30_000;
        if (!source.meta.endOfUpdatesAt && canFinalize && (source.meta.finalizeRequested || autoReady)) {
            source.meta.finalizedAt = Math.max(source.now, source.contest.endAt + 1);
            source.meta.endOfUpdatesAt = Math.max(source.meta.finalizedAt, times.thawedAt ?? 0) + 1;
            // All timestamps must describe changes that already happened.
            if (source.meta.endOfUpdatesAt > Date.now()) await new Promise(resolve => setTimeout(resolve, 2));
            source.now = source.meta.endOfUpdatesAt;
            await store.freezeSource(key, source);
        }
        const stored = await store.contest(domainId, tid);
        const views: View[] = [...VIEWS, ...(stored.feedTeams || []).map(team => `team-${team}` as View)];
        const fingerprint = JSON.stringify([signature, source.public, source.publicVisible, source.meta, contestTimes(source), views]);
        const active = source.now >= source.contest.beginAt - 10 * 60_000 && !source.meta.endOfUpdatesAt;
        if (built.get(key) === fingerprint) {
            nextTick.set(key, Date.now() + (active ? FAST_MS : SLOW_MS));
            return;
        }
        for (const view of views) {
            const previous = await viewHashes(key, view);
            const { changed, removed, notifications } = diffNotifications(notificationsOf(buildObjects(source, view)), previous);
            if (!notifications.length) continue;
            if (!await store.ownsLease(LEASE, owner)) { leader = false; hashes.clear(); built.clear(); return; }
            await store.append(key, view, notifications);
            await store.updateHashes(key, view, Object.fromEntries(changed.map((item) => [item.key, item.hash])), removed);
            for (const item of changed) previous.set(item.key, item.hash);
            for (const name of removed) previous.delete(name);
        }
        built.set(key, fingerprint);
        const state = buildObjects(source, 'full').state;
        if (state.end_of_updates) finished.add(key);
        // Running contests are watched closely, others now and then.
        nextTick.set(key, Date.now() + (active && !state.end_of_updates ? FAST_MS : SLOW_MS));
    }

    async function refreshContests() {
        if (Date.now() - contestsCheckedAt < SLOW_MS) return;
        contestsCheckedAt = Date.now();
        const rows = await settings.find({ 'settings.ccsApi': true }).toArray();
        contests = rows.map((row) => {
            const [domainId, tid] = String(row._id).split('/');
            return { key: String(row._id), domainId, tid };
        }).filter((item) => item.domainId && /^[a-f\d]{24}$/.test(item.tid));
    }

    async function deliverWebhooks() {
        const hooks = await store.activeWebhooks();
        const adminProps = endpointProperties({ role: 'admin', identity: true, teamContest: false });
        for (const hook of hooks) await deliver(hook, adminProps);
    }

    async function deliver(hook: WebhookDoc, props: Partial<Record<Endpoint, string[]>>) {
        const user = await UserModel.getById(hook.domainId, hook.owner).catch(() => null);
        if (!user?.hasPriv(PRIV.PRIV_USER_PROFILE)) {
            await store.webhooks.updateOne({ _id: hook._id }, { $set: { active: false, lastError: 'Webhook owner no longer has contest administration permission' } });
            return;
        }
        const targets = contests.filter((item) => item.domainId === hook.domainId && (!hook.contest_ids.length || hook.contest_ids.includes(item.tid)));
        const owned = await Promise.all(targets.map(async target => ({ target, contest: await ContestModel.get(target.domainId, new ObjectId(target.tid)) })));
        if (!user.hasPerm(PERM.PERM_EDIT_CONTEST) && !owned.some(item => item.contest && user.own(item.contest))) {
            await store.webhooks.updateOne({ _id: hook._id }, { $set: { active: false, lastError: 'Webhook owner no longer administers the subscribed contests' } });
            return;
        }
        for (const target of targets) {
            if (stopped || !await store.ownsLease(LEASE, owner) || !(await store.webhooks.findOne({ _id: hook._id }))?.active) return;
            const contest = await ContestModel.get(target.domainId, new ObjectId(target.tid));
            if (!contest || !user.hasPerm(PERM.PERM_EDIT_CONTEST) && !user.own(contest) || !(await dependencies.loadSettings(contest)).ccsApi) continue;
            const cursorKey = Buffer.from(target.key).toString('base64url');
            const cursor = hook.cursors[cursorKey] ?? 0;
            const events = await store.eventsAfter(target.key, 'full', cursor, 200);
            if (!events.length) continue;
            const wanted = (event: EventDoc) => !hook.endpoints.length || hook.endpoints.includes(event.type === 'contest' ? 'contests' : event.type);
            const notifications = events.filter(wanted).map((event) => eventLine(event, props)).filter(Boolean);
            const last = events.at(-1)!.seq;
            let ok = true;
            let error: string | null = null;
            if (notifications.length) {
                try {
                    const response = await fetch(hook.url, {
                        method: 'POST', redirect: 'error',
                        headers: { 'Content-Type': 'application/json', 'Webhook-Token': hook.token },
                        body: JSON.stringify({ contest_id: target.tid, notifications }),
                        signal: AbortSignal.timeout(10_000),
                    });
                    ok = response.ok;
                    if (!ok) error = `HTTP ${response.status}`;
                } catch (caught) {
                    ok = false;
                    error = caught instanceof Error ? caught.message : String(caught);
                }
            }
            if (ok) {
                hook.cursors[cursorKey] = last;
                hook.failingSince = null;
                await store.webhooks.updateOne({ _id: hook._id }, { $set: { [`cursors.${cursorKey}`]: last, failingSince: null, lastError: null } });
                continue;
            }
            // Delivered in order: stop at the first failure and retry later.
            const since = hook.failingSince ? new Date(hook.failingSince).getTime() : Date.now();
            const active = Date.now() - since < WEBHOOK_GIVE_UP_MS;
            await store.webhooks.updateOne({ _id: hook._id }, { $set: { failingSince: new Date(since), lastError: error, active } });
            return;
        }
    }

    function scheduleWebhooks() {
        delivering ||= deliverWebhooks().catch(error => console.error('[ccs] webhook delivery failed', error)).finally(() => { delivering = null; });
        return delivering;
    }

    async function loop(waitForWebhooks = true) {
        if (stopped) return;
        const wasLeader = leader;
        leader = await store.acquireLease(LEASE, owner, LEASE_MS).catch(() => false);
        if (!leader) { hashes.clear(); built.clear(); return; }
        if (!wasLeader) { hashes.clear(); built.clear(); nextTick.clear(); finished.clear(); contestsCheckedAt = 0; }
        await refreshContests();
        const now = Date.now();
        for (const target of contests) {
            if (finished.has(target.key) || (nextTick.get(target.key) ?? 0) > now) continue;
            try {
                await tickContest(target.domainId, target.tid);
            } catch (error) {
                nextTick.set(target.key, Date.now() + SLOW_MS);
                console.error('[ccs] event writer failed for', target.key, error);
            }
        }
        const delivery = scheduleWebhooks();
        if (waitForWebhooks) await delivery;
    }

    const heartbeat = setInterval(() => {
        if (leader && !stopped) store.acquireLease(LEASE, owner, LEASE_MS).then(ok => { leader = ok; }).catch(() => { leader = false; });
    }, LEASE_MS / 3);
    heartbeat.unref?.();
    const timer = setInterval(() => {
        if (running) return;
        running = loop(false).catch(error => console.error('[ccs] writer failed', error)).finally(() => { running = null; });
    }, 1000);
    timer.unref?.();
    // A submission or verdict in a CCS contest: look again soon rather than at the next slow tick.
    const on = ctx.on.bind(ctx) as unknown as (name: string, listener: (...args: any[]) => unknown) => () => void;
    on('record/change', (rdoc: { domainId?: string; contest?: unknown }) => {
        if (!leader || !rdoc?.contest) return;
        const key = contestKey(String(rdoc.domainId), String(rdoc.contest));
        if (nextTick.has(key)) nextTick.set(key, Math.min(nextTick.get(key)!, Date.now() + 300));
    });
    on('record/judge', (record: any) => {
        if (!record?.contest) return;
        const key = contestKey(String(record.domainId), String(record.contest));
        if (nextTick.has(key)) nextTick.set(key, 0);
    });
    on('contest/edit', (tdoc: any) => {
        if (tdoc?.domainId && tdoc?.docId) nextTick.set(contestKey(tdoc.domainId, String(tdoc.docId)), 0);
        contestsCheckedAt = 0;
    });
    ctx.effect(() => async () => {
        stopped = true;
        clearInterval(timer);
        clearInterval(heartbeat);
        await running;
        await delivering;
        if (leader) await store.releaseLease(LEASE, owner).catch(() => null);
    });

    return {
        tick: loop,
        /** A change made through the API (thaw, start time, final): notify it at once. */
        touch(key: string) {
            finished.delete(key);
            built.delete(key);
            nextTick.set(key, 0);
            contestsCheckedAt = 0;
        },
        isLeader: () => leader,
    };
}

export type CcsWriter = ReturnType<typeof applyWriter>;
