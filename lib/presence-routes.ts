import fs from 'node:fs';
import path from 'node:path';
import { ContestModel, Context, Handler, NotFoundError, ObjectId, param, PERM, PRIV, Tdoc, Types, UserModel } from 'hydrooj';
import { isCaptureOnline } from './live/capture';
import { applyBeat, BEAT_MS, type PresenceDoc, presenceSnapshot, type PresenceTeam } from './presence';
import { seatOf } from './print';
import { resolverCodeBase } from './resolver-data';
import { createSeatStore } from './seat-store';
import { toScriptJson } from './settings';
import { describeTeam, isTeamEntry, loadSeats, memberIds, type TeamEntry } from './teams';

declare module 'hydrooj' {
    interface Collections {
        'xcpcio.presence': PresenceDoc;
    }
}

const contestKey = (tdoc: Tdoc) => `${tdoc.domainId}/${tdoc.docId}`;
const contestBase = (tdoc: Tdoc) => `/d/${encodeURIComponent(tdoc.domainId)}/contest/${tdoc.docId}`;

/**
 * 机位监控 for contest managers: every team's computer, online or not, from the reports of its
 * contest pages (frontend/presence.js) and from the pages it opens; with IP login (onsite-toolkit)
 * and 画面采集 compared against what is seen. Before the start it is the check-in list.
 */
export function applyPresence(ctx: Context) {
    const codeBase = resolverCodeBase(JSON.parse(fs.readFileSync(path.join(__dirname, '../package.json'), 'utf8')).version);
    const records = ctx.db.collection('xcpcio.presence');
    const raw = (name: string): any => ctx.db.collection(name as never);
    const seats = createSeatStore(ctx);
    const on = ctx.on.bind(ctx) as unknown as (name: string, listener: (...args: any[]) => unknown) => () => void;
    on('app/started', async () => {
        await records.createIndex({ contest: 1 }).catch(() => null);
    });

    /** The team a user plays for in the contest (their own uid outside team contests), cached a minute. */
    const teams = new Map<string, { expires: number; value: Promise<number | null> }>();
    function participation(tdoc: Tdoc, uid: number) {
        const name = `${contestKey(tdoc)}/${uid}`;
        const now = Date.now();
        const cached = teams.get(name);
        if (cached && cached.expires > now) return cached.value;
        if (teams.size > 5000) for (const [key, entry] of teams) if (entry.expires <= now) teams.delete(key);
        const value = (async () => {
            const entries = await ContestModel.getMultiStatus(tdoc.domainId, { docId: tdoc.docId, $or: [{ uid }, { members: uid }] })
                .project<TeamEntry & { attend?: number }>({ uid: 1, members: 1, attend: 1 }).toArray();
            return entries.find((entry) => !!entry.attend && (entry.uid === uid || !!entry.members?.includes(uid)))?.uid ?? null;
        })();
        teams.set(name, { expires: now + 60_000, value });
        value.catch(() => teams.delete(name));
        return value;
    }

    const isStaff = (handler: Handler, tdoc: Tdoc) => handler.user.own(tdoc) || handler.user.hasPerm(PERM.PERM_EDIT_CONTEST);
    // Writes from page views are spread out: one per team every few seconds is plenty.
    const lastWrite = new Map<string, number>();

    async function record(tdoc: Tdoc, team: number, member: number, ip: string, ua: string, visible: boolean) {
        const key = `${contestKey(tdoc)}/${team}`;
        const prev = await records.findOne({ _id: key });
        const next = applyBeat(prev, { contest: contestKey(tdoc), uid: team, member, ip, ua, visible }, new Date());
        if (next) {
            const { _id, ...fields } = next;
            await records.updateOne({ _id }, { $set: fields }, { upsert: true });
        }
        lastWrite.set(key, Date.now());
    }

    // Every contest page a participant opens counts as a report, and carries the reporting script.
    on('handler/after', async (handler: Handler) => {
        const tdoc = (handler.response?.body as { tdoc?: Tdoc } | undefined)?.tdoc;
        if (!tdoc || tdoc.rule !== 'acm' || !tdoc.docId || !handler.user?._id || handler.user._id <= 1 || !handler.UiContext) return;
        if (Date.now() >= new Date(tdoc.endAt).getTime() || isStaff(handler, tdoc)) return;
        try {
            const team = await participation(tdoc, handler.user._id);
            if (team === null) return;
            handler.UiContext.xcpcioPresence = { url: `${contestBase(tdoc)}/presence/beat`, interval: BEAT_MS };
            const key = `${contestKey(tdoc)}/${team}`;
            // Not awaited: the page is not held up by the write.
            if (Date.now() - (lastWrite.get(key) || 0) > 5000) {
                if (lastWrite.size > 20000) lastWrite.clear();
                lastWrite.set(key, Date.now());
                record(tdoc, team, handler.user._id, handler.request.ip, String(handler.request.headers['user-agent'] || ''), true).catch(() => null);
            }
        } catch { /* the contest page works without it */ }
    });

    class BeatHandler extends Handler {
        noCheckPermView = true;
        notUsage = true;

        // `hidden` only when the page is in the background, so a missing value means visible.
        @param('tid', Types.ObjectId)
        @param('hidden', (value: unknown) => Types.Boolean[0](value), true)
        async post(domainId: string, tid: ObjectId, hidden = false) {
            this.response.addHeader('Cache-Control', 'no-store');
            const tdoc = await ContestModel.get(domainId, tid);
            const now = Date.now();
            if (!tdoc || tdoc.rule !== 'acm' || !this.user._id || this.user._id <= 1 || now >= new Date(tdoc.endAt).getTime() || isStaff(this, tdoc)) {
                this.response.body = { ok: false };
                return;
            }
            const team = await participation(tdoc, this.user._id);
            if (team === null) { this.response.body = { ok: false }; return; }
            await this.limitRate('xcpcio_presence_beat', 60, 30, '{{user}}');
            await record(tdoc, team, this.user._id, this.request.ip, String(this.request.headers['user-agent'] || ''), !hidden);
            this.response.body = { ok: true, interval: BEAT_MS };
        }
    }

    async function captureStatus(tdoc: Tdoc, seatOfTeam: Map<number, string>, now: number) {
        const config = await raw('xcpcio.live.capture.config').findOne({ _id: contestKey(tdoc) });
        if (!config?.settings?.enabled) return null;
        const devices: { teamUid: number | null; seat: string; connection: string | null; lastSeen: Date | null }[] = await raw('xcpcio.live.capture')
            .find({ contestKey: contestKey(tdoc) }).project({ teamUid: 1, seat: 1, connection: 1, lastSeen: 1 }).toArray();
        const bySeat = new Map([...seatOfTeam].filter(([, seat]) => seat).map(([uid, seat]) => [seat.toLowerCase(), uid]));
        const online = new Map<number, boolean>();
        for (const device of devices) {
            const uid = device.teamUid ?? bySeat.get(String(device.seat || '').toLowerCase());
            if (uid !== undefined) online.set(uid, online.get(uid) || isCaptureOnline(device, now));
        }
        return online;
    }

    async function snapshot(tdoc: Tdoc) {
        const now = Date.now();
        const entries = (await ContestModel.getMultiStatus(tdoc.domainId, { docId: tdoc.docId })
            .project<TeamEntry & { attend?: number }>({ uid: 1, members: 1, displayName: 1, attend: 1 }).toArray()).filter((entry) => !!entry.attend);
        const members = memberIds(tdoc, entries);
        const uids = [...entries.map((entry) => entry.uid), ...members];
        const [users, seatMap, docs, mapped] = await Promise.all([
            UserModel.getList(tdoc.domainId, uids),
            loadSeats(ctx.db, uids),
            records.find({ contest: contestKey(tdoc) }).toArray(),
            seats.ipOwners(uids.filter((uid) => uid > 0)),
        ]);
        const seatOfTeam = new Map(entries.map((entry) => [entry.uid, seatOf(seatMap, entry.uid, isTeamEntry(entry) ? entry.members : [])]));
        const capture = await captureStatus(tdoc, seatOfTeam, now);
        const list: PresenceTeam[] = entries.flatMap((entry) => {
            const team = describeTeam(entry, users, false);
            if (!team) return [];
            const accounts = [entry.uid, ...isTeamEntry(entry) ? entry.members : []];
            return [{
                uid: entry.uid, name: team.name, seat: seatOfTeam.get(entry.uid) || '', members: team.members || [],
                mapped: [...new Set(accounts.flatMap((uid) => mapped.get(uid) || []))],
                capture: capture ? capture.get(entry.uid) ?? false : null,
            }];
        });
        return presenceSnapshot(list, docs, tdoc, now);
    }

    abstract class ManagerHandler extends Handler {
        tdoc!: Tdoc;

        @param('tid', Types.ObjectId)
        async prepare(domainId: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            const tdoc = await ContestModel.get(domainId, tid);
            if (!tdoc) throw new NotFoundError('Contest not found');
            this.checkPriv(PRIV.PRIV_USER_PROFILE);
            if (!this.user.own(tdoc)) this.checkPerm(PERM.PERM_EDIT_CONTEST);
            this.tdoc = tdoc;
        }
    }

    class PresenceHandler extends ManagerHandler {
        async get() {
            const base = contestBase(this.tdoc);
            this.response.template = 'xcpcio_presence.html';
            this.response.body = {
                tdoc: this.tdoc, codeBase,
                runtimeJson: toScriptJson({
                    dataUrl: `${base}/presence/data`, contestUrl: base, title: this.tdoc.title,
                    // 座位与 IP (system administrators): where seats and IP login are fixed.
                    seatsUrl: this.user.hasPriv(PRIV.PRIV_EDIT_SYSTEM) ? '/manage/xcpcio-users#seats' : null,
                    beginAt: this.tdoc.beginAt, endAt: this.tdoc.endAt, refreshMs: 5000,
                }),
            };
        }
    }

    const cache = new Map<string, { expires: number; value: ReturnType<typeof snapshot> }>();
    class PresenceDataHandler extends ManagerHandler {
        notUsage = true;

        async get() {
            const key = contestKey(this.tdoc);
            const now = Date.now();
            for (const [name, entry] of cache) if (entry.expires <= now) cache.delete(name);
            let entry = cache.get(key);
            if (!entry) {
                entry = { expires: now + 2000, value: snapshot(this.tdoc) };
                entry.value.catch(() => cache.delete(key));
                cache.set(key, entry);
            }
            this.response.body = await entry.value;
        }
    }

    ctx.Route('contest_xcpcio_presence', '/contest/:tid/presence', PresenceHandler);
    ctx.Route('contest_xcpcio_presence_data', '/contest/:tid/presence/data', PresenceDataHandler);
    ctx.Route('contest_xcpcio_presence_beat', '/contest/:tid/presence/beat', BeatHandler);
    ctx.i18n.load('zh', { contest_xcpcio_presence: '机位监控' });
}
