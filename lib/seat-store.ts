import { type Context, ObjectId, TokenModel, UserModel } from 'hydrooj';
import {
    backupOf, BACKUPS_KEPT, buildSeatRows, type ClearOptions, clearPlan, type SeatAccount, type SeatBackupData, type SeatBackupMeta, SEAT_LIMIT,
    type SeatRow, scopeLabel,
} from './manage/seats';
import { ManageError } from './manage/users';
import { hasSeat, IP_LOGIN, type IpLoginDoc, seatText } from './onsite';

const TYPE_CONTEST = 30;

export interface SeatContest {
    domainId: string;
    docId: ObjectId;
    title: string;
    beginAt: Date;
    endAt: Date;
}

export interface SeatBackupDoc extends SeatBackupData {
    _id: ObjectId;
    createdAt: Date;
    createdBy: number;
    reason: 'manual' | 'clear' | 'restore' | 'import';
    label: string;
}

export const contestKeyOf = (tdoc: { domainId: string; docId: unknown }) => `${tdoc.domainId}/${tdoc.docId}`;

/**
 * Seats and IP login as onsite-toolkit stores them (lib/onsite.ts), for the /manage page's
 * "座位与 IP" tab: listing, backups, cleanup and restore.
 */
export function createSeatStore(ctx: Context) {
    const raw = (name: string): any => ctx.db.collection(name as never);
    const ipLogins = raw(IP_LOGIN);
    const backups = raw('xcpcio.manage.seat.backups');
    const broadcast = (event: string, ...args: unknown[]) => (ctx as unknown as { broadcast: (e: string, ...a: unknown[]) => void }).broadcast(event, ...args);
    // Account documents are cached by Hydro in every process.
    const forgetAccounts = () => broadcast('user/delcache', true);

    async function contest(key: string): Promise<SeatContest | null> {
        const at = key.lastIndexOf('/');
        const domainId = key.slice(0, at);
        const tid = key.slice(at + 1);
        if (at <= 0 || !ObjectId.isValid(tid)) return null;
        return raw('document').findOne({ domainId, docType: TYPE_CONTEST, docId: new ObjectId(tid) }, { projection: { domainId: 1, docId: 1, title: 1, beginAt: 1, endAt: 1 } });
    }

    /** Newest contests of every domain, for the scope picker. */
    async function contests(): Promise<SeatContest[]> {
        return raw('document').find({ docType: TYPE_CONTEST }).sort({ beginAt: -1 }).limit(100)
            .project({ domainId: 1, docId: 1, title: 1, beginAt: 1, endAt: 1 }).toArray();
    }

    async function accounts(uids: number[], domainId: string, teams: Map<number, { name: string; group: number }>): Promise<SeatAccount[]> {
        const people = uids.filter((uid) => uid > 0);
        const virtual = uids.filter((uid) => uid < 0);
        const [udocs, vdocs, names] = await Promise.all([
            people.length ? UserModel.coll.find({ _id: { $in: people } })
                .project<{ _id: number; uname: string; school?: string; seat?: unknown; loginat?: Date; loginip?: string; priv: number }>({ _id: 1, uname: 1, school: 1, seat: 1, loginat: 1, loginip: 1, priv: 1 }).toArray() : [],
            virtual.length ? raw('vuser').find({ _id: { $in: virtual } }).project({ _id: 1, uname: 1, displayName: 1, school: 1, seat: 1 }).toArray() : [],
            people.length ? raw('domain.user').find({ domainId, uid: { $in: people } }).project({ uid: 1, displayName: 1 }).toArray() : [],
        ]);
        const displayName = new Map<number, string>(names.map((doc: { uid: number; displayName?: string }) => [doc.uid, doc.displayName || '']));
        return [
            ...vdocs.map((doc: { _id: number; uname: string; displayName?: string; school?: string; seat?: unknown }): SeatAccount => ({
                uid: doc._id, kind: 'team', uname: doc.uname, school: doc.school, name: doc.displayName || teams.get(doc._id)?.name || '', seat: seatText(doc.seat),
            })),
            ...udocs.map((doc): SeatAccount => ({
                uid: doc._id, kind: 'user', uname: doc.uname, school: doc.school, name: displayName.get(doc._id) || '', seat: seatText(doc.seat),
                loginat: doc.loginat || null, loginip: doc.loginip || '', team: teams.get(doc._id)?.name, group: teams.get(doc._id)?.group,
                keepSessions: doc._id <= 1 || doc.priv === -1,
            })),
        ];
    }

    /** A contest's participants (and the members of its teams), or every account with a seat or IP login. */
    async function rows(scope: SeatContest | null, domainId: string): Promise<SeatRow[]> {
        const teams = new Map<number, { name: string; group: number }>();
        if (scope) {
            const entries: { uid: number; members?: number[]; displayName?: string }[] = await raw('document.status')
                .find({ domainId: scope.domainId, docType: TYPE_CONTEST, docId: scope.docId, attend: { $gte: 1 } }).project({ uid: 1, members: 1, displayName: 1 }).toArray();
            const uids = new Set<number>();
            for (const entry of entries) {
                uids.add(entry.uid);
                if (entry.uid < 0) teams.set(entry.uid, { name: entry.displayName || '', group: entry.uid });
                for (const member of Array.isArray(entry.members) ? entry.members : []) {
                    uids.add(member);
                    teams.set(member, { name: entry.displayName || '', group: entry.uid });
                }
            }
            const list = [...uids];
            const ipDocs: IpLoginDoc[] = list.length ? await ipLogins.find({ uid: { $in: list.filter((uid) => uid > 0) } }).toArray() : [];
            return buildSeatRows(await accounts(list, scope.domainId, teams), ipDocs, false);
        }
        const [seatUsers, seatTeams, ipDocs, teamDocs] = await Promise.all([
            UserModel.coll.find(hasSeat as never).project<{ _id: number }>({ _id: 1 }).limit(SEAT_LIMIT).toArray(),
            raw('vuser').find(hasSeat).project({ _id: 1 }).limit(SEAT_LIMIT).toArray(),
            ipLogins.find({}).limit(SEAT_LIMIT).toArray() as Promise<IpLoginDoc[]>,
            raw('vuser').find({ members: { $exists: true } }).project({ _id: 1, displayName: 1, members: 1 }).limit(SEAT_LIMIT).toArray(),
        ]);
        for (const team of teamDocs) for (const member of team.members || []) teams.set(member, { name: team.displayName || '', group: team._id });
        const uids = [...new Set<number>([...seatUsers.map((doc) => doc._id), ...seatTeams.map((doc: { _id: number }) => doc._id), ...ipDocs.map((doc) => doc.uid)])];
        return buildSeatRows(await accounts(uids, domainId, teams), ipDocs, true);
    }

    async function saveBackup(data: SeatBackupData, label: string, reason: SeatBackupDoc['reason'], operator: number) {
        const doc: SeatBackupDoc = { _id: new ObjectId(), createdAt: new Date(), createdBy: operator, reason, label, ...data };
        await backups.insertOne(doc);
        const old = await backups.find({}).sort({ _id: -1 }).skip(BACKUPS_KEPT).project({ _id: 1 }).toArray();
        if (old.length) await backups.deleteMany({ _id: { $in: old.map((item: { _id: ObjectId }) => item._id) } });
        return doc;
    }

    async function listBackups() {
        const countKeys = (value: string, empty: string) => ({ $add: [{ $size: value }, { $size: { $ifNull: [empty, []] } }] });
        const docs = await backups.aggregate([
            { $sort: { _id: -1 } },
            { $project: { createdAt: 1, createdBy: 1, reason: 1, label: 1, seats: countKeys('$seats', '$emptySeats'), ips: countKeys('$ips', '$freeIps') } },
        ]).toArray();
        const operators = await UserModel.coll.find({ _id: { $in: [...new Set<number>(docs.map((doc: { createdBy: number }) => doc.createdBy))] } })
            .project<{ _id: number; uname: string }>({ _id: 1, uname: 1 }).toArray();
        const unames = new Map(operators.map((udoc) => [udoc._id, udoc.uname]));
        return docs.map((doc: { _id: ObjectId; createdBy: number }) => ({ ...doc, _id: String(doc._id), operator: unames.get(doc.createdBy) || `UID ${doc.createdBy}` }));
    }

    async function backup(id: string): Promise<SeatBackupDoc> {
        const doc = ObjectId.isValid(id) ? await backups.findOne({ _id: new ObjectId(id) }) : null;
        if (!doc) throw new ManageError('备份不存在', 404);
        return doc;
    }

    async function signOut(uids: number[]) {
        for (const uid of uids) await TokenModel.delByUid(uid, TokenModel.TYPE_SESSION);
    }

    /** Backs the rows up, then removes their seats, IP login and sessions as asked. */
    async function clear(selected: SeatRow[], options: ClearOptions, meta: SeatBackupMeta, operator: number) {
        const plan = clearPlan(selected, options, operator);
        const saved = await saveBackup(backupOf(selected), scopeLabel(meta), 'clear', operator);
        if (plan.userSeats.length) await UserModel.coll.updateMany({ _id: { $in: plan.userSeats } }, { $unset: { seat: '' } } as never);
        if (plan.teamSeats.length) await raw('vuser').updateMany({ _id: { $in: plan.teamSeats } }, { $unset: { seat: '' } });
        const ips = plan.ips.length ? (await ipLogins.deleteMany({ _id: { $in: plan.ips } })).deletedCount : 0;
        await signOut(plan.sessions);
        if (plan.userSeats.length || plan.teamSeats.length) forgetAccounts();
        return { backup: String(saved._id), seats: plan.userSeats.length + plan.teamSeats.length, ips, sessions: plan.sessions.length };
    }

    /** Apply a restore/import after recording every targeted key, including formerly empty keys. */
    async function restore(data: SeatBackupData, options: { seats: boolean; ips: boolean }, source: string, operator: number, reason: 'restore' | 'import' = 'restore') {
        const requestedSeats = options.seats ? data.seats : [];
        const emptySeats = options.seats ? data.emptySeats || [] : [];
        const requestedIps = options.ips ? data.ips : [];
        const freeIps = options.ips ? data.freeIps || [] : [];
        const ids = [...new Set([...requestedSeats.map(item => item.uid), ...emptySeats, ...requestedIps.map(item => item.uid)])];
        const users = await accounts(ids, 'system', new Map());
        const present = new Map(users.map(user => [user.uid, user]));
        const seats = requestedSeats.filter(item => present.has(item.uid));
        const clearSeats = emptySeats.filter(uid => present.has(uid));
        const ips = requestedIps.filter(item => present.has(item.uid));
        const seatIds = [...new Set([...seats.map(item => item.uid), ...clearSeats])];
        const addresses = [...new Set([...ips.map(item => item.ip), ...freeIps])];
        const wanted = requestedSeats.length + emptySeats.length + requestedIps.length + freeIps.length;
        const changedSeats = seats.length + clearSeats.length;
        const changedIps = ips.length + freeIps.length;
        const skipped = wanted - changedSeats - changedIps;
        if (reason === 'import' && skipped) throw new ManageError('导入名单中的账号已变更，请刷新后重试');
        let saved: SeatBackupDoc | undefined;
        if (seatIds.length || addresses.length) {
            const previous: IpLoginDoc[] = addresses.length ? await ipLogins.find({ _id: { $in: addresses } }).toArray() : [];
            const occupied = new Set(previous.map(doc => doc._id));
            const targets = seatIds.map(uid => present.get(uid)!);
            const before = {
                seats: targets.filter(user => user.seat).map(({ uid, kind, seat }) => ({ uid, kind, seat })),
                ips: previous.map(doc => ({ ip: doc._id, uid: doc.uid })),
                emptySeats: targets.filter(user => !user.seat).map(user => user.uid),
                freeIps: addresses.filter(ip => !occupied.has(ip)),
            };
            saved = await saveBackup(before, `${reason === 'import' ? '导入' : '恢复'}“${source}”之前`, reason, operator);
        }
        try {
            for (const item of seats) await (item.uid < 0 ? raw('vuser') : UserModel.coll).updateOne({ _id: item.uid }, { $set: { seat: item.seat } } as never);
            for (const uid of clearSeats) await (uid < 0 ? raw('vuser') : UserModel.coll).updateOne({ _id: uid }, { $unset: { seat: '' } } as never);
            if (freeIps.length) await ipLogins.deleteMany({ _id: { $in: freeIps } });
            for (const item of ips) await ipLogins.updateOne({ _id: item.ip }, { $set: { uid: item.uid }, $unset: { xcpcioCollect: '' } }, { upsert: true });
        } finally {
            if (changedSeats || changedIps) forgetAccounts();
        }
        return { seats: changedSeats, ips: changedIps, skipped, backup: saved ? String(saved._id) : undefined };
    }

    async function unmatchedIps(participants: SeatRow[]) {
        const docs: IpLoginDoc[] = await ipLogins.find({ uid: { $nin: participants.map(row => row.uid) } }).project({ _id: 1, uid: 1 }).toArray();
        return docs.map(doc => ({ ip: doc._id, uid: doc.uid }));
    }

    /** One account's seat and addresses; an address held by another account moves to this one. */
    async function update(edit: { uid: number; kind: 'user' | 'team'; seat: string }, ips: string[] | null) {
        const coll = edit.kind === 'team' ? raw('vuser') : UserModel.coll;
        const exists = await coll.findOne({ _id: edit.uid }, { projection: { _id: 1 } });
        if (!exists) throw new ManageError('账号不存在', 404);
        await coll.updateOne({ _id: edit.uid }, (edit.seat ? { $set: { seat: edit.seat } } : { $unset: { seat: '' } }) as never);
        forgetAccounts();
        if (!ips) return { moved: [] as { ip: string; uid: number }[] };
        const others: IpLoginDoc[] = ips.length ? await ipLogins.find({ _id: { $in: ips }, uid: { $ne: edit.uid } }).toArray() : [];
        await ipLogins.deleteMany({ uid: edit.uid, _id: { $nin: ips } });
        for (const ip of ips) await ipLogins.updateOne({ _id: ip }, { $set: { uid: edit.uid }, $unset: { xcpcioCollect: '' } }, { upsert: true });
        return { moved: others.map((doc) => ({ ip: doc._id, uid: doc.uid })) };
    }

    /** The account an address signs in as, if any (机位监控 compares it with the address used). */
    async function ipOwners(uids: number[]) {
        const docs: IpLoginDoc[] = uids.length ? await ipLogins.find({ uid: { $in: uids } }).toArray() : [];
        const owners = new Map<number, string[]>();
        for (const doc of docs) owners.set(doc.uid, [...owners.get(doc.uid) || [], doc._id]);
        return owners;
    }

    return { contest, contests, rows, saveBackup, listBackups, backup, clear, restore, update, ipOwners, unmatchedIps };
}

export type SeatStore = ReturnType<typeof createSeatStore>;
