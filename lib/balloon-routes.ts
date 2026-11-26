/**
 * 气球配送 in Hydro: the contest's balloons (lib/balloons.ts) kept in MongoDB and in step with the
 * contest's journals, the management page for contest managers, a no-login page for volunteers,
 * and the receipt queue print servers take balloon tickets from (lib/print-routes.ts).
 */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
    ContestModel, Context, getAlphabeticId, Handler, NotFoundError, ObjectId, param, PERM, PRIV, ProblemModel, Tdoc, Types, UserModel,
} from 'hydrooj';
import {
    BalloonError, balloonKey, balloonLook, defaultReceiptConfig, dueBalloons, firstBalloons, firstNumbers, normalizeBalloonSettings, pickTarget, problemColors,
    reconcile, ticketLines, ticketReady, ticketTargets, testTicketLines, zoneOf,
    type BalloonSettings, type ReceiptConfig, type ReceiptPrinter, type StoredBalloon, type TicketStatus,
} from './balloons';
import { gbkAvailable, receiptJob, type ReceiptJob } from './escpos';
import { ONLINE_MS, preferenceOf, seatOf, type PrinterPreference } from './print';
import type { ContestLinks } from './links';
import { heldProblems, type JuryState } from './jury';
import { resolverCodeBase } from './resolver-data';
import { awardsFor, toScriptJson, type BoardSettings } from './settings';
import { describeTeam, isTeamEntry, loadSeats, memberIds, type TeamEntry } from './teams';

interface SettingsDoc {
    _id: string;
    settings: Partial<BalloonSettings>;
    token: string;
    /** When the desk token was issued (absent on documents from before 1.15). */
    tokenAt?: Date;
    /** Bumped on every change, so pages poll cheaply. */
    revision: number;
    /** The last ticket number handed out. */
    seq: number;
    /** Secret seed of the teams' own colours (lib/balloons.ts teamPalette); never shown. */
    seed?: string;
    syncedAt?: Date;
    updatedAt?: Date;
}

interface BalloonDoc {
    _id: ObjectId;
    key: string;
    contest: string;
    domainId: string;
    tid: ObjectId;
    uid: number;
    pid: number;
    rid: string;
    submittedAt: Date;
    seq: number;
    state: 'active' | 'revoked';
    held: boolean;
    delivered: { at: Date; by: string } | null;
    ticket: { status: TicketStatus; server?: string; printer?: string; claimedAt?: Date; printedAt?: Date; attempts: number; error?: string; prints: number };
    createdAt: Date;
}

/** A print server as the receipt queue sees it (lib/print-routes.ts ServerDoc). */
interface PrintServerDoc {
    _id: ObjectId;
    name: string;
    enabled: boolean;
    contests: string[];
    seatPrefixes: string[];
    lastSeen: Date | null;
    client: { version: string; capabilities?: string[] } | null;
    printers: { name: string; status: string; virtual?: boolean }[];
    preferences: Record<string, Partial<PrinterPreference>>;
}

export interface ReceiptQueue {
    /** Up to `limit` tickets for this print server's receipt printers, taken from the queue. */
    claim(serverId: string, now: number, limit?: number): Promise<ReceiptJob[]>;
    /** A ticket's result from the print client; false when the id is not a ticket this server holds. */
    report(id: string, serverId: string, status: 'printed' | 'failed' | 'released', printer: string, message: string): Promise<boolean>;
    testJob(id: string, serverName: string, printer: string, config: ReceiptConfig): ReceiptJob;
}

export interface BalloonScreenData {
    /** Balloons waiting for delivery, as the 气球配送图 lists them. */
    pending: { teamId: string; problemId: string; submissionId: string }[];
    /** `#rrggbb` per problem (index), '' when none is set. */
    colors: string[];
    /** The balloons' colours are not the problems' (teams' own colours, one first-solve balloon): the screen would tell. */
    withheld?: boolean;
}

const TICKET_CLAIM_MS = 2 * 60_000;
const MAX_TICKET_ATTEMPTS = 3;
const newToken = () => randomBytes(24).toString('base64url');
const contestKey = (tdoc: Tdoc) => `${tdoc.domainId}/${tdoc.docId}`;
const contestBase = (tdoc: Tdoc) => `/d/${encodeURIComponent(tdoc.domainId)}/contest/${tdoc.docId}`;

function toStored(doc: BalloonDoc): StoredBalloon {
    return {
        id: String(doc._id), key: doc.key, uid: doc.uid, pid: doc.pid, rid: doc.rid, submittedAt: new Date(doc.submittedAt).getTime(), seq: doc.seq,
        state: doc.state, held: doc.held, delivered: doc.delivered ? { at: new Date(doc.delivered.at).getTime(), by: doc.delivered.by } : null,
        ticket: {
            ...doc.ticket, claimedAt: doc.ticket.claimedAt ? new Date(doc.ticket.claimedAt).getTime() : undefined,
            printedAt: doc.ticket.printedAt ? new Date(doc.ticket.printedAt).getTime() : undefined,
        },
    };
}

/** Pure-side fields as MongoDB stores them (dates as dates). */
function toDocSet(set: Partial<StoredBalloon>) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(set)) {
        if (key === 'submittedAt') out.submittedAt = new Date(value as number);
        else if (key === 'delivered') out.delivered = value ? { at: new Date((value as { at: number }).at), by: (value as { by: string }).by } : null;
        else if (key === 'ticket') {
            const ticket = value as StoredBalloon['ticket'];
            out.ticket = { ...ticket, ...ticket.claimedAt ? { claimedAt: new Date(ticket.claimedAt) } : {}, ...ticket.printedAt ? { printedAt: new Date(ticket.printedAt) } : {} };
        } else out[key] = value;
    }
    return out;
}

export function applyBalloons(ctx: Context, dependencies: {
    loadSettings: (tdoc: Tdoc) => Promise<BoardSettings>;
    /** The contest's no-login links, revoked together after the contest (lib/links.ts). */
    links?: ContestLinks<Tdoc>;
    /** 裁判操作: balloons of problems held from the public wait too (lib/jury.ts). */
    jury?: (tdoc: Tdoc) => Promise<JuryState>;
}) {
    const root = path.join(__dirname, '..');
    const codeBase = resolverCodeBase(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
    const raw = (name: string): any => ctx.db.collection(name as never);
    const settingsColl = raw('xcpcio.balloon.settings');
    const balloons = raw('xcpcio.balloons');
    const printServers = raw('xcpcio.print.servers');
    const hydroBalloons = raw('contest.balloon');
    const on = ctx.on.bind(ctx) as unknown as (name: string, listener: (...args: any[]) => unknown) => () => void;
    on('app/started', async () => {
        await balloons.createIndex({ key: 1 }, { unique: true }).catch(() => null);
        await balloons.createIndex({ contest: 1, seq: 1 }).catch(() => null);
        await balloons.createIndex({ 'ticket.status': 1, contest: 1, seq: 1 }).catch(() => null);
    });

    async function loadDoc(key: string): Promise<SettingsDoc> {
        await settingsColl.updateOne({ _id: key }, { $setOnInsert: { settings: {}, token: newToken(), tokenAt: new Date(), revision: 1, seq: 0, seed: newToken() } }, { upsert: true });
        return (await withSeed(await settingsColl.findOne({ _id: key })))!;
    }
    /** Documents from before 1.20 have no seed: give them one, once (a concurrent first use keeps the winner's). */
    async function withSeed(doc: SettingsDoc | null): Promise<SettingsDoc | null> {
        if (!doc || doc.seed) return doc;
        await settingsColl.updateOne({ _id: doc._id, seed: { $exists: false } }, { $set: { seed: newToken() } });
        return settingsColl.findOne({ _id: doc._id });
    }
    /** Colour and first-solve mark of every balloon in `stored`, as staff hand them out. */
    function looks(tdoc: Tdoc, settings: BalloonSettings, doc: SettingsDoc, stored: { key: string; uid: number; pid: number; submittedAt: number; seq: number }[], first: Set<string>) {
        const context = { settings, pids: tdoc.pids, colors: problemColors(settings, tdoc.pids, tdoc.balloon as Record<string, unknown> | undefined),
            seed: doc.seed || doc._id, first, numbers: firstNumbers(stored, first) };
        return new Map(stored.map((balloon) => [balloon.key, balloonLook(balloon, context)]));
    }
    const bump = (key: string) => settingsColl.updateOne({ _id: key }, { $inc: { revision: 1 } });
    const resetToken = async (key: string) => {
        const token = newToken();
        await settingsColl.updateOne({ _id: key }, { $set: { token, tokenAt: new Date() }, $inc: { revision: 1 } });
        return token;
    };
    const settingsOf = (doc: SettingsDoc | null, tdoc: Tdoc) => normalizeBalloonSettings(doc?.settings || {}, tdoc.pids);

    dependencies.links?.add({
        id: 'balloons', label: '气球台',
        async status(tdoc) {
            const doc: SettingsDoc | null = await settingsColl.findOne({ _id: contestKey(tdoc) });
            return { count: doc ? 1 : 0, issuedAt: doc?.tokenAt ?? null };
        },
        // Desks poll with their token, so open ones stop at their next refresh.
        async revoke(tdoc) {
            if (!await settingsColl.findOne({ _id: contestKey(tdoc) }, { projection: { _id: 1 } })) return 0;
            await resetToken(contestKey(tdoc));
            return 1;
        },
    });

    /** Teams with what staff need: name, school, members, seat; members of a team map to it. */
    const teamCache = new Map<string, { at: number; value: Promise<Map<number, { name: string; school: string; members: string[]; seat: string; unofficial: boolean }>> }>();
    function contestTeams(tdoc: Tdoc) {
        const key = contestKey(tdoc);
        const now = Date.now();
        for (const [k, item] of teamCache) if (now - item.at >= 10_000) teamCache.delete(k);
        const cached = teamCache.get(key);
        if (cached && now - cached.at < 10_000) return cached.value;
        const value = (async () => {
            const entries = await ContestModel.getMultiStatus(tdoc.domainId, { docId: tdoc.docId })
                .project<TeamEntry & { unrank?: boolean }>({ uid: 1, members: 1, displayName: 1, unrank: 1 }).toArray();
            const uids = [...entries.map((entry) => entry.uid), ...memberIds(tdoc, entries)];
            const [users, seats] = await Promise.all([UserModel.getList(tdoc.domainId, uids), loadSeats(ctx.db, uids)]);
            const teams = new Map<number, { name: string; school: string; members: string[]; seat: string; unofficial: boolean }>();
            for (const entry of entries) {
                const team = describeTeam(entry, users, true);
                if (!team) continue;
                teams.set(entry.uid, {
                    name: team.name, school: team.school || '', members: team.members || [], unofficial: !!entry.unrank,
                    seat: seatOf(seats, entry.uid, isTeamEntry(entry) ? entry.members : []),
                });
            }
            return teams;
        })();
        value.catch(() => teamCache.delete(key));
        teamCache.set(key, { at: Date.now(), value });
        return value;
    }

    // ---------------------------------------------------------------- Keeping balloons in step

    /**
     * Brings the stored balloons in line with the contest's journals. One process at a time per
     * contest (a lease on the settings document); returns `'synced'` on completion, `'busy'` when
     * another process holds the lease, or `'skip'` when disabled/deleted so callers do not retry forever.
     */
    async function sync(key: string, soon = false): Promise<'synced' | 'busy' | 'skip'> {
        const now = Date.now();
        const minGap = soon ? 1500 : 4000;
        const leaseMs = 15_000;
        const lease = await settingsColl.findOneAndUpdate(
            {
                _id: key, 'settings.enabled': true,
                $and: [
                    { $or: [{ syncedAt: { $exists: false } }, { syncedAt: { $lt: new Date(now - minGap) } }] },
                    { $or: [{ syncLeaseUntil: { $exists: false } }, { syncLeaseUntil: { $lt: new Date(now) } }] },
                ],
            },
            { $set: { syncedAt: new Date(now), syncLeaseUntil: new Date(now + leaseMs) } }, { returnDocument: 'after' },
        ) as SettingsDoc | null;
        if (!lease) {
            const existing = await settingsColl.findOne({ _id: key }, { projection: { 'settings.enabled': 1 } }) as { settings?: { enabled?: boolean } } | null;
            return existing?.settings?.enabled ? 'busy' : 'skip';
        }
        try {
            const [domainId, tid] = key.split('/');
            const tdoc = await ContestModel.get(domainId, new ObjectId(tid));
            if (!tdoc) return 'skip';
            const settings = settingsOf(lease, tdoc);
            const [entries, stored, sent, jury] = await Promise.all([
                ContestModel.getMultiStatus(domainId, { docId: tdoc.docId }).project({ uid: 1, journal: 1 }).toArray(),
                balloons.find({ contest: key }).toArray() as Promise<BalloonDoc[]>,
                hydroBalloons.find({ domainId, tid: tdoc.docId, sent: { $exists: true } }).project({ uid: 1, pid: 1 }).toArray() as Promise<{ uid: number; pid: number }[]>,
                dependencies.jury?.(tdoc) ?? null,
            ]);
            const due = dueBalloons(key, tdoc, entries as never);
            const { inserts, updates } = reconcile(stored.map(toStored), due, {
                now, lockAt: tdoc.lockAt ? tdoc.lockAt.getTime() : null, locked: ContestModel.isLocked(tdoc),
                hold: settings.afterFreeze !== 'continue', encourage: settings.afterFreeze === 'encourage' ? settings.encourageCount : undefined,
                heldProblems: heldProblems(jury, tdoc.beginAt.getTime()), tickets: settings.tickets.enabled,
                hydroSent: new Set(sent.map((row) => balloonKey(key, row.uid, row.pid))),
            });
            if (inserts.length) {
                const counter = await settingsColl.findOneAndUpdate({ _id: key }, { $inc: { seq: inserts.length } }, { returnDocument: 'after' }) as SettingsDoc;
                const first = counter.seq - inserts.length + 1;
                const docs = inserts.map((balloon, index) => ({
                    _id: new ObjectId(), contest: key, domainId, tid: tdoc.docId, seq: first + index, createdAt: new Date(now), ...toDocSet(balloon),
                }));
                // Only ignore duplicate-key races (11000); surface real write failures.
                await balloons.insertMany(docs, { ordered: false }).catch((error: { code?: number; writeErrors?: { code?: number }[] }) => {
                    const onlyDup = error?.code === 11000 && (!error.writeErrors || error.writeErrors.every((entry) => entry.code === 11000));
                    if (!onlyDup) throw error;
                });
            }
            for (const update of updates) {
                const { ticket, ...otherFields } = toDocSet(update.set);
                if (Object.keys(otherFields).length) {
                    await balloons.updateOne({ _id: new ObjectId(update.id) }, { $set: otherFields });
                }
                // Guard ticket transitions so sync never clobbers a concurrently claimed/printed receipt.
                if (ticket && typeof ticket === 'object') {
                    const nextStatus = (ticket as { status?: string }).status;
                    if (nextStatus === 'pending' || nextStatus === 'none') {
                        await balloons.updateOne(
                            { _id: new ObjectId(update.id), 'ticket.status': { $nin: ['printing', 'printed'] } },
                            { $set: { 'ticket.status': nextStatus } },
                        );
                    }
                }
            }
            if (inserts.length || updates.length) await bump(key);
            return 'synced';
        } finally {
            await settingsColl.updateOne({ _id: key }, { $unset: { syncLeaseUntil: '' } }).catch(() => null);
        }
    }

    // The process that judged a record learns of it first (Hydro's record/judge), after the journal is saved.
    const enabled = { keys: new Set<string>(), at: 0 };
    async function enabledKeys() {
        if (Date.now() - enabled.at > 10_000) {
            const docs = await settingsColl.find({ 'settings.enabled': true }).project({ _id: 1 }).toArray() as { _id: string }[];
            enabled.keys = new Set(docs.map((doc) => doc._id));
            enabled.at = Date.now();
        }
        return enabled.keys;
    }
    const scheduled = new Map<string, NodeJS.Timeout>();
    let disposed = false;
    function schedule(key: string, delay = 300, attempts = 0) {
        if (disposed || scheduled.has(key) || attempts >= 10) return;
        const timer = setTimeout(async () => {
            scheduled.delete(key);
            if (disposed) return;
            // Only retry when another process actively held the lease; never loop if disabled/deleted/errored.
            const outcome = await sync(key, true).catch(() => 'skip' as const);
            if (outcome === 'busy') schedule(key, 1200, attempts + 1);
        }, delay);
        timer.unref?.();
        scheduled.set(key, timer);
    }
    on('record/judge', async (rdoc: { domainId?: string; contest?: unknown } | null) => {
        if (!rdoc?.contest || !rdoc.domainId) return;
        const key = `${rdoc.domainId}/${rdoc.contest}`;
        if ((await enabledKeys().catch(() => new Set<string>())).has(key)) schedule(key);
    });
    // Everything else (events another process missed, the freeze and its end): every few seconds while it matters.
    const sweeper = setInterval(async () => {
        try {
            const now = Date.now();
            for (const key of await enabledKeys()) {
                const [domainId, tid] = key.split('/');
                const tdoc = await ContestModel.get(domainId, new ObjectId(tid)).catch(() => null);
                if (!tdoc || now < tdoc.beginAt.getTime() - 30 * 60_000) continue;
                // After the contest only until the board is unlocked (held balloons) or a few hours have passed.
                if (now > tdoc.endAt.getTime() + 6 * 3600_000 && !ContestModel.isLocked(tdoc)) continue;
                await sync(key);
            }
            // Tickets a client claimed and never reported go back to the queue.
            await balloons.updateMany({ 'ticket.status': 'printing', 'ticket.claimedAt': { $lt: new Date(now - TICKET_CLAIM_MS) } },
                { $set: { 'ticket.status': 'pending' }, $unset: { 'ticket.server': '', 'ticket.claimedAt': '' } });
        } catch { /* the next round tries again */ }
    }, 5000);
    sweeper.unref?.();
    ctx.effect(() => () => {
        disposed = true;
        clearInterval(sweeper);
        for (const timer of scheduled.values()) clearTimeout(timer);
        scheduled.clear();
    });
    on('contest/del', (domainId: string, tid: ObjectId) => {
        const key = `${domainId}/${tid}`;
        const timer = scheduled.get(key);
        if (timer) { clearTimeout(timer); scheduled.delete(key); }
        teamCache.delete(key);
        enabled.at = 0;
        void Promise.all([settingsColl.deleteOne({ _id: key }), balloons.deleteMany({ contest: key })]).catch(() => null);
    });
    on('domain/delete', (domainId: string) => {
        const pattern = new RegExp(`^${domainId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`);
        enabled.at = 0;
        void Promise.all([settingsColl.deleteMany({ _id: pattern }), balloons.deleteMany({ domainId })]).catch(() => null);
    });

    // ---------------------------------------------------------------- Receipt printers

    async function receiptPrinters(now: number): Promise<ReceiptPrinter[]> {
        const docs = await printServers.find({}).toArray() as PrintServerDoc[];
        return docs.flatMap((doc) => {
            const online = doc.enabled && !!doc.lastSeen && now - new Date(doc.lastSeen).getTime() < ONLINE_MS;
            const capable = !!doc.client?.capabilities?.includes('receipt');
            const reported = new Map(doc.printers.map((printer) => [printer.name, printer]));
            const names = [...new Set([...doc.printers.map((printer) => printer.name), ...Object.keys(doc.preferences || {})])];
            return names.flatMap((name) => {
                const preference = preferenceOf(doc.preferences?.[name] as PrinterPreference | undefined, () => ({
                    enabled: !reported.get(name)?.virtual, weight: 1, kind: 'document', receipt: defaultReceiptConfig(),
                }));
                if (preference.kind !== 'receipt') return [];
                const status = reported.get(name)?.status || 'missing';
                return [{
                    server: String(doc._id), serverName: doc.name, printer: name, contests: doc.contests || [], seatPrefixes: doc.seatPrefixes || [],
                    usable: online && capable && preference.enabled && reported.has(name) && !['offline', 'error', 'paused'].includes(status),
                    config: preference.receipt, online, capable, status,
                } as ReceiptPrinter & { online: boolean; capable: boolean; status: string }];
            });
        });
    }

    /** What a ticket needs to print: the contest, its teams, problems, colours and every active balloon. */
    async function ticketContext(key: string) {
        const doc = await withSeed(await settingsColl.findOne({ _id: key }) as SettingsDoc | null);
        const [domainId, tid] = key.split('/');
        const tdoc = await ContestModel.get(domainId, new ObjectId(tid));
        if (!doc || !tdoc) return null;
        const settings = settingsOf(doc, tdoc);
        const teams = await contestTeams(tdoc);
        const pdict = await ProblemModel.getList(domainId, tdoc.pids, true, false, ['docId', 'title'] as never) as Record<number, { title?: string }>;
        const active: BalloonDoc[] = await balloons.find({ contest: key, state: 'active' }).project({ key: 1, uid: 1, pid: 1, submittedAt: 1, state: 1, seq: 1 }).toArray();
        const board = await dependencies.loadSettings(tdoc);
        const unofficialFirst = awardsFor(board, 'all').unofficialFirstSolve;
        const first = firstBalloons(active.map((balloon) => ({ ...balloon, submittedAt: new Date(balloon.submittedAt).getTime() })),
            (uid) => unofficialFirst || !teams.get(uid)?.unofficial);
        const look = looks(tdoc, settings, doc, active.map((balloon) => ({ ...balloon, submittedAt: new Date(balloon.submittedAt).getTime() })), first);
        return { tdoc, settings, teams, pdict, active, first, look };
    }

    function ticketFor(balloon: BalloonDoc, context: NonNullable<Awaited<ReturnType<typeof ticketContext>>>, target: ReceiptPrinter, now: number) {
        const { tdoc } = context;
        const index = tdoc.pids.indexOf(balloon.pid);
        const team = context.teams.get(balloon.uid);
        const label = getAlphabeticId(index);
        const solved = context.active.filter((other) => other.uid === balloon.uid).map((other) => tdoc.pids.indexOf(other.pid))
            .filter((value) => value >= 0).sort((a, b) => a - b).map((value) => getAlphabeticId(value));
        const lines = ticketLines({
            contest: tdoc.title, seq: balloon.seq, seat: team?.seat || '', label, problemTitle: context.pdict[balloon.pid]?.title || '',
            color: context.look.get(balloon.key)?.color ?? null, first: context.first.has(balloon.key), firstLabel: context.look.get(balloon.key)?.firstLabel || '', team: team?.name || `UID ${balloon.uid}`, school: team?.school || '',
            members: team?.members || [], unofficial: !!team?.unofficial, submittedAt: new Date(balloon.submittedAt).getTime(), beginAt: tdoc.beginAt.getTime(),
            solved, printedAt: now, copy: (balloon.ticket.prints || 0) + 1,
        }, context.settings.tickets);
        return receiptJob(`balloon-${balloon._id}`, `气球 #${balloon.seq} · ${team?.seat || '无座位'} · ${label}`, target.printer, lines, target.config);
    }

    const receipts: ReceiptQueue = {
        async claim(serverId, now, limit = 10) {
            const printers = await receiptPrinters(now);
            if (!printers.some((printer) => printer.server === serverId && printer.usable)) return [];
            const contests = await settingsColl.find({ 'settings.enabled': true, 'settings.tickets.enabled': true }).project({ _id: 1, settings: 1 }).toArray() as SettingsDoc[];
            const jobs: ReceiptJob[] = [];
            for (const doc of contests) {
                if (jobs.length >= limit) break;
                const waiting = (await balloons.find({ contest: doc._id, 'ticket.status': 'pending', state: 'active', held: false, delivered: null })
                    .sort({ seq: 1 }).limit(50).toArray() as BalloonDoc[]).filter((balloon) => ticketReady(toStored(balloon)));
                if (!waiting.length) continue;
                const context = await ticketContext(doc._id);
                if (!context) continue;
                let taken = 0;
                for (const balloon of waiting) {
                    if (jobs.length >= limit) break;
                    const seat = context.teams.get(balloon.uid)?.seat || '';
                    const target = pickTarget(String(balloon._id), ticketTargets(balloon, seat, doc._id, context.settings.tickets.rules, printers).printers);
                    if (!target || target.server !== serverId) continue;
                    const claimed = await balloons.findOneAndUpdate({ _id: balloon._id, 'ticket.status': 'pending' }, {
                        $set: { 'ticket.status': 'printing', 'ticket.server': serverId, 'ticket.printer': target.printer, 'ticket.claimedAt': new Date(now) },
                    }, { returnDocument: 'after' }) as BalloonDoc | null;
                    if (!claimed) continue; // another server took it
                    jobs.push(ticketFor(claimed, context, target, now));
                    taken++;
                }
                if (taken) await bump(doc._id);
            }
            return jobs;
        },
        async report(id, serverId, status, printer, message) {
            const hex = /^balloon-([a-f\d]{24})$/i.exec(id)?.[1];
            if (!hex) return false;
            const filter = { _id: new ObjectId(hex), 'ticket.server': serverId, 'ticket.status': 'printing' };
            const balloon = await balloons.findOne(filter) as BalloonDoc | null;
            if (!balloon) return false;
            let result: { matchedCount?: number };
            if (status === 'released') {
                result = await balloons.updateOne(filter, { $set: { 'ticket.status': 'pending' }, $unset: { 'ticket.server': '', 'ticket.claimedAt': '' } });
            } else if (status === 'printed') {
                result = await balloons.updateOne(filter, {
                    $set: { 'ticket.status': 'printed', 'ticket.printer': printer || balloon.ticket.printer, 'ticket.printedAt': new Date(), 'ticket.attempts': 0 },
                    $inc: { 'ticket.prints': 1 }, $unset: { 'ticket.claimedAt': '', 'ticket.error': '' },
                });
            } else {
                const attempts = (balloon.ticket.attempts || 0) + 1;
                result = await balloons.updateOne(filter, attempts < MAX_TICKET_ATTEMPTS
                    ? { $set: { 'ticket.status': 'pending', 'ticket.attempts': attempts, 'ticket.error': message }, $unset: { 'ticket.server': '', 'ticket.claimedAt': '' } }
                    : { $set: { 'ticket.status': 'failed', 'ticket.attempts': attempts, 'ticket.error': message }, $unset: { 'ticket.claimedAt': '' } });
            }
            if (!result.matchedCount) return false;
            await bump(balloon.contest);
            return true;
        },
        testJob(id, serverName, printer, config) {
            return receiptJob(id, `测试小票 · ${serverName}`, printer, testTicketLines(serverName, printer, config), config);
        },
    };

    /** Saves a contest's balloon settings (the balloon page and 赛事中控), retrying on concurrent revision updates. */
    async function saveSettings(tdoc: Tdoc, input: unknown) {
        const key = contestKey(tdoc);
        for (let attempt = 0; attempt < 6; attempt++) {
            const doc = await loadDoc(key);
            const before = settingsOf(doc, tdoc);
            const settings = normalizeBalloonSettings(input, tdoc.pids, before);
            const result = await settingsColl.updateOne(
                { _id: key, revision: doc.revision },
                { $set: { settings, updatedAt: new Date() }, $inc: { revision: 1 }, $unset: { syncedAt: '' } },
            );
            if (!result.matchedCount) continue;
            // Tickets switched off: those still waiting are not printed later by surprise.
            if (before.tickets.enabled && !settings.tickets.enabled) await balloons.updateMany({ contest: key, 'ticket.status': 'pending' }, { $set: { 'ticket.status': 'none' } });
            enabled.at = 0;
            if (settings.enabled) await sync(key);
            return settings;
        }
        throw new BalloonError('其他管理员正在修改气球设置，请重试', 409);
    }

    // ---------------------------------------------------------------- Pages

    async function view(tdoc: Tdoc, doc: SettingsDoc, manager: boolean) {
        const settings = settingsOf(doc, tdoc);
        const key = contestKey(tdoc);
        const now = Date.now();
        const teams = await contestTeams(tdoc);
        const pdict = await ProblemModel.getList(tdoc.domainId, tdoc.pids, true, false, ['docId', 'title'] as never) as Record<number, { title?: string }>;
        const stored: BalloonDoc[] = await balloons.find({ contest: key }).sort({ seq: 1 }).toArray();
        const board = await dependencies.loadSettings(tdoc);
        const printers: ReceiptPrinter[] = manager ? await receiptPrinters(now) : [];
        const unofficialFirst = awardsFor(board, 'all').unofficialFirstSolve;
        const first = firstBalloons(stored.map(toStored), (uid) => unofficialFirst || !teams.get(uid)?.unofficial);
        const look = looks(tdoc, settings, doc, stored.map(toStored), first);
        const serverNames = new Map(printers.map((printer) => [printer.server, printer.serverName]));
        const colors = problemColors(settings, tdoc.pids, tdoc.balloon as Record<string, unknown> | undefined);
        return {
            revision: doc.revision,
            contest: {
                title: tdoc.title, beginAt: tdoc.beginAt, endAt: tdoc.endAt, lockAt: tdoc.lockAt || null,
                locked: ContestModel.isLocked(tdoc), ended: ContestModel.isDone(tdoc),
            },
            enabled: settings.enabled, tickets: settings.tickets.enabled, afterFreeze: settings.afterFreeze, encourageCount: settings.encourageCount,
            firstStyle: settings.first.style, teamColors: settings.teamColors,
            problems: tdoc.pids.map((pid, index) => ({
                pid, label: getAlphabeticId(index), title: pdict[pid]?.title || '', color: colors[index],
            })),
            teams: [...teams].map(([uid, team]) => ({ uid, name: team.name, school: team.school, seat: team.seat, zone: zoneOf(team.seat), unofficial: team.unofficial })),
            balloons: stored.map((balloon) => ({
                id: String(balloon._id), uid: balloon.uid, pid: balloon.pid, seq: balloon.seq, at: balloon.submittedAt, state: balloon.state, held: balloon.held,
                first: first.has(balloon.key), delivered: balloon.delivered,
                // The colour handed out, when it is not the problem's (one first-solve balloon, the team's own colours).
                ...settings.teamColors || settings.first.style !== 'problem' ? { color: look.get(balloon.key)?.color ?? null, firstLabel: look.get(balloon.key)?.firstLabel || '' } : {},
                ticket: { status: balloon.ticket.status, printer: balloon.ticket.printer || '', server: serverNames.get(balloon.ticket.server || '') || '',
                    error: balloon.ticket.error || '', prints: balloon.ticket.prints || 0 },
            })),
            ...manager ? {
                settings, deskUrl: `${contestBase(tdoc)}/balloon-desk/${doc.token}`, gbk: gbkAvailable(),
                hydroColors: tdoc.pids.map((pid) => tdoc.balloon?.[pid] ?? null),
                printers: printers.map((printer) => {
                    const extra = printer as ReceiptPrinter & { online: boolean; capable: boolean; status: string };
                    return { server: printer.server, serverName: printer.serverName, printer: printer.printer, usable: printer.usable, online: extra.online,
                        capable: extra.capable, status: extra.status, config: printer.config, seatPrefixes: printer.seatPrefixes, contests: printer.contests };
                }),
                contestKey: key,
            } : {},
        };
    }

    async function deliver(tdoc: Tdoc, payload: Record<string, unknown>, by: string, staffUid: number) {
        const ids = (Array.isArray(payload.ids) ? payload.ids : []).map(String).filter((id) => /^[a-f\d]{24}$/i.test(id)).slice(0, 500).map((id) => new ObjectId(id));
        if (!ids.length) throw new BalloonError('请选择气球');
        const key = contestKey(tdoc);
        const undo = payload.undo === true;
        const filter = { _id: { $in: ids }, contest: key };
        if (undo) await balloons.updateMany(filter, { $set: { delivered: null } });
        else {
            await balloons.updateMany({ ...filter, delivered: null }, { $set: { delivered: { at: new Date(), by } } });
            // Delivered before its ticket came out: no ticket any more.
            await balloons.updateMany({ ...filter, 'ticket.status': 'pending' }, { $set: { 'ticket.status': 'none' } });
        }
        // Hydro's own balloon page shows the same (its records exist when the contest has balloon colours).
        const touched = await balloons.find(filter).project({ uid: 1, pid: 1 }).toArray() as BalloonDoc[];
        for (const balloon of touched) {
            await hydroBalloons.updateMany({ domainId: tdoc.domainId, tid: tdoc.docId, uid: balloon.uid, pid: balloon.pid },
                undo ? { $unset: { sent: '', sentAt: '' } } : { $set: { sent: staffUid, sentAt: new Date() } }).catch(() => null);
        }
        await bump(key);
        return { updated: touched.length };
    }

    async function reprint(tdoc: Tdoc, payload: Record<string, unknown>) {
        const doc = await loadDoc(contestKey(tdoc));
        if (!settingsOf(doc, tdoc).tickets.enabled) throw new BalloonError('请先在设置中开启小票打印');
        const filter: Record<string, unknown> = { contest: contestKey(tdoc), state: 'active', delivered: null, 'ticket.status': { $ne: 'printing' } };
        if (payload.all !== true) {
            const ids = (Array.isArray(payload.ids) ? payload.ids : []).map(String).filter((id) => /^[a-f\d]{24}$/i.test(id)).slice(0, 500);
            if (!ids.length) throw new BalloonError('请选择气球');
            filter._id = { $in: ids.map((id) => new ObjectId(id)) };
        } else filter['ticket.status'] = { $in: ['none', 'failed'] };
        const result = await balloons.updateMany(filter, { $set: { 'ticket.status': 'pending', 'ticket.attempts': 0 }, $unset: { 'ticket.error': '', 'ticket.server': '' } });
        await bump(contestKey(tdoc));
        return { updated: result.modifiedCount };
    }

    abstract class BalloonBase extends Handler {
        tdoc!: Tdoc;

        payload(input: string): Record<string, unknown> {
            if (input.length > 200000) throw new BalloonError('请求内容过大');
            try {
                const value = JSON.parse(input);
                return value && typeof value === 'object' ? value : {};
            } catch { throw new BalloonError('请求格式无效'); }
        }

        async onerror(error: Parameters<Handler['onerror']>[0] | BalloonError) {
            if (error instanceof BalloonError) {
                this.response.status = error.status;
                this.response.body = { error: error.message };
                return;
            }
            return super.onerror(error);
        }
    }

    /** Contest managers: the same people as for 大屏, 滚榜 and 直播. */
    abstract class ManagerBase extends BalloonBase {
        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            const tdoc = await ContestModel.get(this.domain._id, tid);
            if (!tdoc) throw new NotFoundError('Contest not found');
            if (!this.user._id) throw new BalloonError('请登录比赛管理账号', 403);
            this.checkPriv(PRIV.PRIV_USER_PROFILE);
            if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            if (tdoc.rule !== 'acm') throw new BalloonError('气球配送仅支持 ACM 比赛');
            this.tdoc = tdoc;
        }
    }

    class BalloonsHandler extends ManagerBase {
        async get() {
            await loadDoc(contestKey(this.tdoc));
            const base = `${contestBase(this.tdoc)}/balloons`;
            this.response.template = 'xcpcio_balloons.html';
            this.response.body = {
                tdoc: this.tdoc, codeBase, desk: false,
                runtimeJson: toScriptJson({ mode: 'manager', base, dataUrl: `${base}/data`, contestUrl: contestBase(this.tdoc), printersUrl: '/manage/xcpcio-printers', title: this.tdoc.title }),
            };
        }

        @param('payload', Types.String)
        async postEnable(_domainId: string, input: string) {
            await saveSettings(this.tdoc, { enabled: this.payload(input).enabled === true });
            this.response.body = { ok: true };
        }

        @param('payload', Types.String)
        async postSettings(_domainId: string, input: string) {
            this.response.body = { settings: await saveSettings(this.tdoc, this.payload(input).settings) };
        }

        @param('payload', Types.String)
        async postDeliver(_domainId: string, input: string) {
            this.response.body = await deliver(this.tdoc, this.payload(input), this.user.uname, this.user._id);
        }

        @param('payload', Types.String)
        async postReprint(_domainId: string, input: string) {
            this.response.body = await reprint(this.tdoc, this.payload(input));
        }

        async postResetToken() {
            const key = contestKey(this.tdoc);
            await loadDoc(key);
            const token = await resetToken(key);
            this.response.body = { deskUrl: `${contestBase(this.tdoc)}/balloon-desk/${token}` };
        }
    }

    class BalloonsDataHandler extends ManagerBase {
        notUsage = true;

        @param('rev', Types.Int, true)
        async get(_domainId: string, rev?: number) {
            const key = contestKey(this.tdoc);
            await sync(key).catch(() => false);
            const doc = await loadDoc(key);
            this.response.type = 'application/json';
            this.response.body = rev === doc.revision ? { revision: doc.revision, unchanged: true } : await view(this.tdoc, doc, true);
        }
    }

    /** Volunteers: the link is the capability (no Hydro account); they see and mark balloons, nothing else. */
    abstract class DeskBase extends BalloonBase {
        noCheckPermView = true;
        doc!: SettingsDoc;

        @param('tid', Types.ObjectId)
        @param('token', Types.String)
        async prepare(_domainId: string, tid: ObjectId, token: string) {
            this.response.addHeader('Cache-Control', 'no-store');
            const tdoc = await ContestModel.get(this.domain._id, tid);
            const doc = tdoc?.rule === 'acm' ? await withSeed(await settingsColl.findOne({ _id: contestKey(tdoc) }) as SettingsDoc | null) : null;
            const given = Buffer.from(String(token));
            if (!tdoc || !doc?.token || given.length !== Buffer.byteLength(doc.token) || !timingSafeEqual(given, Buffer.from(doc.token))) {
                throw new NotFoundError('气球配送链接无效或已作废');
            }
            if (!normalizeBalloonSettings(doc.settings || {}, tdoc.pids).enabled) throw new BalloonError('这场比赛的气球配送尚未开启', 403);
            this.tdoc = tdoc;
            this.doc = doc;
        }
    }

    class BalloonDeskHandler extends DeskBase {
        async get() {
            const base = `${contestBase(this.tdoc)}/balloon-desk/${this.doc.token}`;
            this.response.template = 'xcpcio_balloons.html';
            this.response.body = {
                tdoc: { title: this.tdoc.title, docId: this.tdoc.docId, domainId: this.tdoc.domainId }, codeBase, desk: true,
                runtimeJson: toScriptJson({ mode: 'desk', base, dataUrl: `${base}/data`, title: this.tdoc.title }),
            };
        }

        @param('payload', Types.String)
        async postDeliver(_domainId: string, input: string) {
            await this.limitRate('xcpcio_balloon_desk', 60, 240);
            const payload = this.payload(input);
            const by = String(payload.by || '').replace(/[\u0000-\u001f]/g, '').trim().slice(0, 20) || '配送员';
            this.response.body = await deliver(this.tdoc, payload, `${by}（配送员链接）`, this.tdoc.owner);
        }

        @param('payload', Types.String)
        async postReprint(_domainId: string, input: string) {
            await this.limitRate('xcpcio_balloon_desk', 60, 240);
            const payload = this.payload(input);
            if (payload.all === true) throw new BalloonError('配送员链接只能补打所选气球的小票', 403);
            this.response.body = await reprint(this.tdoc, payload);
        }
    }

    class BalloonDeskDataHandler extends DeskBase {
        notUsage = true;

        @param('rev', Types.Int, true)
        async get(_domainId: string, rev?: number) {
            const key = contestKey(this.tdoc);
            await sync(key).catch(() => false);
            const doc = await loadDoc(key);
            this.response.type = 'application/json';
            this.response.body = rev === doc.revision ? { revision: doc.revision, unchanged: true } : await view(this.tdoc, doc, false);
        }
    }

    ctx.Route('contest_xcpcio_balloons', '/contest/:tid/balloons', BalloonsHandler);
    ctx.Route('contest_xcpcio_balloons_data', '/contest/:tid/balloons/data', BalloonsDataHandler);
    ctx.Route('contest_xcpcio_balloon_desk', '/contest/:tid/balloon-desk/:token', BalloonDeskHandler);
    ctx.Route('contest_xcpcio_balloon_desk_data', '/contest/:tid/balloon-desk/:token/data', BalloonDeskDataHandler);
    ctx.i18n.load('zh', { contest_xcpcio_balloons: '气球配送与小票', contest_xcpcio_balloon_desk: '气球配送' });

    return {
        receipts,
        /** Balloon settings for 赛事中控. */
        control: {
            get: async (tdoc: Tdoc) => settingsOf(await loadDoc(contestKey(tdoc)), tdoc),
            save: saveSettings,
        },
        /** The 气球配送图 screen shows these when the contest uses 气球配送 (else Hydro's balloon records). */
        async screen(tdoc: Tdoc): Promise<BalloonScreenData | null> {
            const key = contestKey(tdoc);
            const doc = await settingsColl.findOne({ _id: key }) as SettingsDoc | null;
            const settings = settingsOf(doc, tdoc);
            if (!settings.enabled) return null;
            if (settings.teamColors || settings.first.style !== 'problem') return { pending: [], colors: [], withheld: true };
            await sync(key).catch(() => false);
            const index = new Map(tdoc.pids.map((pid, position) => [pid, String(position)]));
            const waiting = await balloons.find({ contest: key, state: 'active', held: false, delivered: null }).project({ uid: 1, pid: 1, rid: 1 }).toArray() as BalloonDoc[];
            return {
                pending: waiting.flatMap((balloon) => (index.has(balloon.pid) ? [{ teamId: String(balloon.uid), problemId: index.get(balloon.pid)!, submissionId: balloon.rid }] : [])),
                colors: problemColors(settings, tdoc.pids, tdoc.balloon as Record<string, unknown> | undefined).map((color) => color?.hex || ''),
            };
        },
    };
}
