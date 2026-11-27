/**
 * MongoDB storage of the CCS API: per-contest metadata, the event logs (one per view, each with
 * its own sequence numbers as tokens), the writer's lease, judge start times, ids chosen through
 * PUT, award overrides, posted commentary and webhooks.
 */
import { randomUUID } from 'node:crypto';
import type { Context } from 'hydrooj';
import type { AwardOverride, CcsMeta, CcsSource, PostedComment, View } from './model';
import type { Clarification } from './types';
import type { Notification } from './events';

export interface ContestDoc {
    _id: string;
    domainId: string;
    tid: string;
    meta: CcsMeta;
    /** Last sequence number used per view. */
    seq: Partial<Record<View, number>>;
    committed?: Partial<Record<View, number>>;
    ended?: Partial<Record<View, boolean>>;
    pending?: Partial<Record<View, {
        first: number;
        notifications: Notification[];
        changed?: Record<string, string>;
        removed?: string[];
        at: Date;
    }>>;
    /** Hash of every object as last notified, per view (`type/id` → hash). */
    hashes?: Partial<Record<View, Record<string, string>>>;
    feedTeams?: string[];
    feedTeamSeen?: Record<string, number>;
    snapshotId?: string;
}

export interface EventDoc extends Notification {
    _id: string;
    key: string;
    view: View;
    seq: number;
    at: Date;
}

export interface WebhookDoc {
    _id: string;
    domainId: string;
    owner: number;
    url: string;
    endpoints: string[];
    contest_ids: string[];
    token: string;
    active: boolean;
    /** Last delivered event per contest (contest key → sequence number of the full view). */
    cursors: Record<string, number>;
    /** When deliveries started failing, while they keep failing. */
    failingSince: Date | null;
    lastError: string | null;
    createdAt: Date;
}

interface Cursor<T> { sort: (order: object) => Cursor<T>; limit: (count: number) => Cursor<T>; toArray: () => Promise<T[]> }
type Collection<T> = {
    findOne: (filter: object) => Promise<T | null>;
    find: (filter?: object) => Cursor<T>;
    insertOne: (doc: T) => Promise<unknown>;
    insertMany: (docs: T[]) => Promise<unknown>;
    bulkWrite?: (operations: object[], options?: object) => Promise<unknown>;
    updateOne: (filter: object, update: object, options?: object) => Promise<unknown>;
    findOneAndUpdate: (filter: object, update: object, options?: object) => Promise<T | null>;
    deleteOne: (filter: object) => Promise<unknown>;
    deleteMany: (filter: object) => Promise<unknown>;
    createIndex?: (keys: object, options?: object) => Promise<unknown>;
};

export const contestKey = (domainId: string, tid: string) => `${domainId}/${tid}`;

export function ccsStore(ctx: Context) {
    const collection = <T>(name: string) => ctx.db.collection(name as never) as unknown as Collection<T>;
    const contests = collection<ContestDoc>('xcpcio.ccs.contests');
    const events = collection<EventDoc>('xcpcio.ccs.events');
    const judging = collection<{ _id: string; startAt: Date }>('xcpcio.ccs.judging');
    const ids = collection<{ _id: string; key: string; type: string; ccsId: string; ref: string }>('xcpcio.ccs.ids');
    const awards = collection<AwardOverride & { _id: string; key: string }>('xcpcio.ccs.awards');
    const comments = collection<Omit<PostedComment, 'at'> & { _id: string; key: string; at: Date; seq: number }>('xcpcio.ccs.comments');
    const webhooks = collection<WebhookDoc>('xcpcio.ccs.webhooks');
    const leases = collection<{ _id: string; owner: string; until: Date }>('xcpcio.ccs.leases');
    const snapshots = collection<{ _id: string; key: string; generation: string; part: number; data: string }>('xcpcio.ccs.snapshots');
    const clarifications = collection<Clarification & { _id: string; key: string }>('xcpcio.ccs.clarifications');
    const objectHashes = collection<{ _id: string; key: string; view: View; name: string; hash: string }>('xcpcio.ccs.hashes');

    async function updateHashes(key: string, view: View, changed: Record<string, string>, removed: string[]) {
        const entries = Object.entries(changed);
        for (let i = 0; i < entries.length; i += 500) {
            const batch = entries.slice(i, i + 500).map(([name, hash]) => ({ updateOne: {
                filter: { _id: `${key}:${view}:${name}` }, update: { $set: { key, view, name, hash } }, upsert: true,
            } }));
            if (objectHashes.bulkWrite) await objectHashes.bulkWrite(batch);
            else for (const { updateOne: op } of batch) await objectHashes.updateOne(op.filter, op.update, { upsert: true });
        }
        if (removed.length) await objectHashes.deleteMany({ key, view, name: { $in: removed } });
    }

    async function recoverPending(key: string, view: View) {
        const doc = await contests.findOne({ _id: key });
        const pending = doc?.pending?.[view];
        if (!pending) return;
        const operations = pending.notifications.map((notification, i) => {
            const seq = pending.first + i;
            const event = { _id: `${key}:${view}:${seq}`, key, view, seq, ...notification, at: pending.at };
            return { updateOne: { filter: { _id: event._id }, update: { $setOnInsert: event }, upsert: true } };
        });
        if (events.bulkWrite) await events.bulkWrite(operations);
        else for (const { updateOne: op } of operations) await events.updateOne(op.filter, op.update, { upsert: true });
        if (pending.changed || pending.removed?.length) {
            await updateHashes(key, view, pending.changed || {}, pending.removed || []);
        }
        const ended = pending.notifications.some(event => event.type === 'state' && (event.data as any)?.end_of_updates);
        await contests.updateOne({ _id: key, [`pending.${view}.first`]: pending.first }, {
            $set: { [`committed.${view}`]: pending.first + pending.notifications.length - 1, ...(ended ? { [`ended.${view}`]: true } : {}) }, $unset: { [`pending.${view}`]: '' },
        });
    }

    return {
        async ensureIndexes() {
            await Promise.all([
                events.createIndex?.({ key: 1, view: 1, seq: 1 }, { unique: true }),
                ids.createIndex?.({ key: 1, type: 1, ref: 1 }),
                comments.createIndex?.({ key: 1, seq: 1 }),
                objectHashes.createIndex?.({ key: 1, view: 1 }),
                snapshots.createIndex?.({ key: 1, generation: 1, part: 1 }),
                clarifications.createIndex?.({ key: 1 }),
                awards.createIndex?.({ key: 1 }),
                webhooks.createIndex?.({ active: 1 }),
                webhooks.createIndex?.({ domainId: 1, owner: 1 }),
            ]);
        },

        async contest(domainId: string, tid: string): Promise<ContestDoc> {
            const key = contestKey(domainId, tid);
            const doc = await contests.findOne({ _id: key });
            return { ...doc, _id: key, domainId, tid, meta: doc?.meta || {}, seq: doc?.seq || {} };
        },
        async setMeta(key: string, domainId: string, tid: string, meta: Partial<Record<keyof CcsMeta, number | null>>) {
            const $set: Record<string, unknown> = { domainId, tid };
            for (const [name, value] of Object.entries(meta)) $set[`meta.${name}`] = value;
            await contests.updateOne({ _id: key }, { $set }, { upsert: true });
        },
        /** Separate documents avoid MongoDB's 16 MB limit on a contest with many test-case runs. */
        updateHashes,
        recoverPending,
        async hashes(key: string, view: View) {
            await recoverPending(key, view);
            return new Map((await objectHashes.find({ key, view }).toArray()).map(row => [row.name, row.hash]));
        },

        /** A pending batch is committed (with its object hash delta) before being exposed, and recovered idempotently after a crash. */
        async append(key: string, view: View, notifications: Notification[], changedHashes?: Map<string, string>) {
            await contests.updateOne({ _id: key }, { $setOnInsert: { seq: {} } }, { upsert: true });
            await recoverPending(key, view);
            for (let offset = 0; offset < notifications.length; offset += 250) {
                const batch = notifications.slice(offset, offset + 250);
                const doc = (await contests.findOne({ _id: key }))!;
                if (doc.ended?.[view]) break;
                const first = (doc.seq?.[view] ?? 0) + 1;
                const batchChanged: Record<string, string> = {};
                const batchRemoved: string[] = [];
                if (changedHashes) {
                    for (const item of batch) {
                        const name = `${item.type}/${item.id ?? ''}`;
                        if (item.data === null) batchRemoved.push(name);
                        else {
                            const hash = changedHashes.get(name);
                            if (hash !== undefined) batchChanged[name] = hash;
                        }
                    }
                }
                const claimed = await contests.findOneAndUpdate({ _id: key,
                    [`seq.${view}`]: doc.seq?.[view] ?? { $exists: false },
                    [`pending.${view}`]: { $exists: false }, [`ended.${view}`]: { $ne: true },
                }, { $set: {
                    [`seq.${view}`]: first + batch.length - 1,
                    [`pending.${view}`]: {
                        first, notifications: batch, at: new Date(),
                        ...(Object.keys(batchChanged).length ? { changed: batchChanged } : {}),
                        ...(batchRemoved.length ? { removed: batchRemoved } : {}),
                    },
                } }, { returnDocument: 'after' });
                if (!claimed) throw new Error('CCS event append lost its writer claim; retry from the committed log');
                await recoverPending(key, view);
            }
            return (await contests.findOne({ _id: key }))?.committed?.[view] ?? 0;
        },
        async eventsAfter(key: string, view: View, seq: number, limit = 500) {
            const last = (await contests.findOne({ _id: key }))?.committed?.[view] ?? 0;
            return events.find({ key, view, seq: { $gt: seq, $lte: last } }).sort({ seq: 1 }).limit(limit).toArray();
        },
        async lastSeq(key: string, view: View) {
            return (await contests.findOne({ _id: key }))?.committed?.[view] ?? 0;
        },

        /** Freeze the CCS dataset when end_of_updates is set. Native Hydro edits cannot rewrite it. */
        async freezeSource(key: string, source: CcsSource) {
            const generation = randomUUID();
            const json = JSON.stringify({ ...source, teamOfUser: [...source.teamOfUser] });
            const chunks: { _id: string; key: string; generation: string; part: number; data: string }[] = [];
            for (let offset = 0; offset < json.length; offset += 250_000) {
                const part = chunks.length;
                chunks.push({ _id: `${key}:${generation}:${part}`, key, generation, part, data: json.slice(offset, offset + 250_000) });
            }
            await snapshots.insertMany(chunks);
            await contests.updateOne({ _id: key }, { $set: { snapshotId: generation, meta: source.meta } }, { upsert: true });
        },
        async frozenSource(key: string): Promise<CcsSource | null> {
            const generation = (await contests.findOne({ _id: key }))?.snapshotId;
            if (!generation) return null;
            const chunks = await snapshots.find({ key, generation }).sort({ part: 1 }).toArray();
            const source = JSON.parse(chunks.map(part => part.data).join(''));
            source.teamOfUser = new Map(source.teamOfUser);
            return source;
        },

        async registerTeamView(key: string, team: string) {
            await contests.updateOne({ _id: key }, { $addToSet: { feedTeams: team }, $set: { [`feedTeamSeen.${team}`]: Date.now() } }, { upsert: true });
        },
        async pruneTeamViews(key: string, staleTeams: string[]) {
            if (!staleTeams.length) return;
            const $unset = Object.fromEntries(staleTeams.map((team) => [`feedTeamSeen.${team}`, '']));
            await contests.updateOne({ _id: key }, { $pull: { feedTeams: { $in: staleTeams } }, $unset });
            await objectHashes.deleteMany({ key, view: { $in: staleTeams.map((team) => `team-${team}`) } });
        },
        async deleteContest(domainId: string, tid: string) {
            const key = contestKey(domainId, tid);
            await Promise.all([
                contests.deleteOne({ _id: key }),
                events.deleteMany({ key }),
                ids.deleteMany({ key }),
                awards.deleteMany({ key }),
                comments.deleteMany({ key }),
                snapshots.deleteMany({ key }),
                clarifications.deleteMany({ key }),
                objectHashes.deleteMany({ key }),
            ]);
        },
        async deleteDomain(domainId: string) {
            const pattern = new RegExp(`^${domainId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`);
            await Promise.all([
                contests.deleteMany({ _id: pattern }),
                events.deleteMany({ key: pattern }),
                ids.deleteMany({ key: pattern }),
                awards.deleteMany({ key: pattern }),
                comments.deleteMany({ key: pattern }),
                snapshots.deleteMany({ key: pattern }),
                clarifications.deleteMany({ key: pattern }),
                objectHashes.deleteMany({ key: pattern }),
                webhooks.deleteMany({ domainId }),
            ]);
        },
        async clarifications(key: string): Promise<Clarification[]> {
            return (await clarifications.find({ key }).toArray()).map(({ _id, key: _key, ...clar }) => clar);
        },
        async addClarification(key: string, clarification: Clarification) {
            await clarifications.insertOne({ ...clarification, _id: `${key}:${clarification.id}`, key });
        },

        async judgeStarts(rids: string[]) {
            if (!rids.length) return new Map<string, number>();
            const rows = await judging.find({ _id: { $in: rids } }).toArray();
            return new Map(rows.map((row) => [row._id, new Date(row.startAt).getTime()]));
        },
        async recordJudgeStart(judgementKey: string, at: number) {
            await judging.updateOne({ _id: judgementKey }, { $setOnInsert: { startAt: new Date(at) } }, { upsert: true });
        },

        /** Ids chosen by an admin's PUT, for submissions and clarifications. */
        async mappedIds(key: string, type: string) {
            const rows = await ids.find({ key, type }).toArray();
            return new Map(rows.map((row) => [row.ref, row.ccsId]));
        },
        async refOf(key: string, type: string, ccsId: string) {
            return (await ids.findOne({ _id: `${key}:${type}:${ccsId}` }))?.ref ?? null;
        },
        async mapId(key: string, type: string, ccsId: string, ref: string) {
            await ids.insertOne({ _id: `${key}:${type}:${ccsId}`, key, type, ccsId, ref });
        },
        async releaseId(key: string, type: string, ccsId: string, ref: string) {
            await ids.deleteOne({ _id: `${key}:${type}:${ccsId}`, ref });
        },

        async awardOverrides(key: string): Promise<AwardOverride[]> {
            const rows = await awards.find({ key }).toArray();
            return rows.map(({ _id, key: _key, ...override }) => override);
        },
        async setAward(key: string, override: AwardOverride) {
            await awards.updateOne({ _id: `${key}:${override.id}` }, {
                $set: { key, id: override.id, citation: override.citation ?? null, team_ids: override.team_ids ?? null, deleted: !!override.deleted },
            }, { upsert: true });
        },

        async comments(key: string): Promise<PostedComment[]> {
            const rows = await comments.find({ key }).sort({ seq: 1 }).toArray();
            return rows.map(({ _id, key: _key, seq: _seq, at, ...comment }) => ({ ...comment, at: new Date(at).getTime() }));
        },
        async addComment(key: string, comment: Omit<PostedComment, 'id'>) {
            const doc = await contests.findOneAndUpdate({ _id: key }, { $inc: { commentSeq: 1 } }, { upsert: true, returnDocument: 'after' }) as { commentSeq?: number } | null;
            const seq = doc?.commentSeq ?? 1;
            const id = `m${seq}`;
            await comments.insertOne({ ...comment, id, _id: `${key}:${id}`, key, seq, at: new Date(comment.at) });
            return id;
        },

        webhooks,
        async activeWebhooks() {
            return webhooks.find({ active: true }).toArray();
        },

        /** One process at a time writes events: a lease renewed while it lives. */
        async acquireLease(name: string, owner: string, ms: number) {
            const now = new Date();
            const until = new Date(now.getTime() + ms);
            const held = await leases.findOneAndUpdate({ _id: name, owner }, { $set: { until } }, { returnDocument: 'after' });
            if (held) return true;
            const taken = await leases.findOneAndUpdate({ _id: name, until: { $lt: now } }, { $set: { owner, until } }, { returnDocument: 'after' });
            if (taken) return true;
            try {
                await leases.insertOne({ _id: name, owner, until });
                return true;
            } catch {
                return false;
            }
        },
        async releaseLease(name: string, owner: string) {
            await leases.deleteOne({ _id: name, owner });
        },
        async ownsLease(name: string, owner: string) {
            return !!await leases.findOne({ _id: name, owner, until: { $gt: new Date() } });
        },
    };
}

export type CcsStore = ReturnType<typeof ccsStore>;
