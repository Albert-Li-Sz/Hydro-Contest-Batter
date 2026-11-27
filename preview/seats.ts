import {
    backupFile, backupOf, BACKUPS_KEPT, buildSeatRows, clearPlan, normalizeBackup, normalizeClearOptions, normalizeSeatEdit, normalizeSeatQuery,
    type SeatAccount, type SeatBackupData, parseSeatImport, seatImportData, seatCoverage, scopeLabel, selectSeatRows,
} from '../lib/manage/seats';
import { bindCollectedIp, type CollectBindings, type CollectedIp } from '../lib/ip-collect';
import { ManageError } from '../lib/manage/users';
import type { ContestLinks, LinkStatus } from '../lib/links';

interface PreviewAccount { _id: number; uname: string; displayName: string; school?: string; priv: number; loginat: Date }
interface PreviewTeam { _id: number; uname: string; displayName: string; members: number[] }
interface PreviewContest { id: string; title: string; beginAt: Date; endAt: Date }

/**
 * The 座位与 IP tab of the /manage preview: onsite-toolkit seats and IP login in memory, with
 * the same selection, backup, cleanup and restore rules as lib/seat-store.ts.
 */
export function createSeatsPreview(users: PreviewAccount[], teams: PreviewTeam[], contests: PreviewContest[], verify: (password: unknown) => void, demoLinks?: ContestLinks) {
    const now = Date.now();
    const seats = new Map<number, string>();
    const ips = new Map<string, number>();
    const collected = new Map<string, CollectedIp['xcpcioCollect']>();
    function setManual(ip: string, uid: number) { ips.set(ip, uid); collected.delete(ip); }
    function forgetIp(ip: string) { collected.delete(ip); return ips.delete(ip); }
    const loginip = new Map<number, string>();
    const players = users.filter((user) => /^player\d+$/.test(user.uname));
    players.slice(0, 48).forEach((user, index) => {
        const room = index < 24 ? 'A' : 'B';
        const number = String((index % 24) + 1).padStart(2, '0');
        seats.set(user._id, `${room}-${number}`);
        // The last four of room B have no IP login yet; one signed in from another computer.
        if (index < 44) ips.set(`10.${room === 'A' ? 1 : 2}.0.${(index % 24) + 11}`, user._id);
        loginip.set(user._id, index === 5 ? '10.1.0.99' : `10.${room === 'A' ? 1 : 2}.0.${(index % 24) + 11}`);
    });
    // Left over from the warm-up: a second account on B-07, and an address of a deleted account.
    seats.set(players[50]._id, 'B-07');
    ips.set('10.9.9.9', 9999);
    for (const team of teams.slice(0, 2)) seats.set(team._id, team._id === -1001 ? 'C-01' : 'C-02');
    const participants: Record<string, number[]> = {
        [contests[0].id]: players.slice(0, 52).map((user) => user._id),
        [contests[1].id]: teams.slice(0, 2).map((team) => team._id),
    };
    const links: Record<string, LinkStatus[]> = Object.fromEntries(contests.map((tdoc, index) => [tdoc.id, [
        { id: 'screen-devices', label: '大屏设备', count: 0, issuedAt: null },
        { id: 'resolver-photos', label: '滚榜队伍照片', count: 0, issuedAt: null },
        { id: 'screens', label: '大屏', count: 1, issuedAt: new Date(tdoc.beginAt.getTime() - 86400_000) },
        { id: 'balloons', label: '气球台', count: index ? 0 : 1, issuedAt: index ? null : new Date(tdoc.beginAt.getTime() - 3600_000) },
        { id: 'live', label: '直播 overlay', count: 1, issuedAt: new Date(tdoc.beginAt.getTime() - 7200_000) },
        { id: 'capture', label: '画面采集设备', count: index ? 0 : 48, issuedAt: index ? null : new Date(tdoc.beginAt.getTime() - 1800_000) },
    ]]));
    const backups: (SeatBackupData & { _id: string; createdAt: Date; createdBy: number; reason: string; label: string })[] = [];
    const contestKey = (tdoc: PreviewContest) => `system/${tdoc.id}`;
    const findContest = (key: unknown) => contests.find((tdoc) => contestKey(tdoc) === key) || null;

    function accounts(uids: number[], team: Map<number, { name: string; group: number }>): SeatAccount[] {
        return uids.flatMap((uid): SeatAccount[] => {
            if (uid < 0) {
                const doc = teams.find((item) => item._id === uid);
                return doc ? [{ uid, kind: 'team', uname: doc.uname, name: doc.displayName, seat: seats.get(uid) || '' }] : [];
            }
            const user = users.find((item) => item._id === uid);
            return user ? [{
                uid, kind: 'user', uname: user.uname, school: user.school, name: user.displayName, seat: seats.get(uid) || '', loginat: user.loginat, loginip: loginip.get(uid) || '',
                team: team.get(uid)?.name, group: team.get(uid)?.group, keepSessions: user.priv === -1,
            }] : [];
        });
    }

    function rows(scope: PreviewContest | null) {
        const team = new Map<number, { name: string; group: number }>();
        const list = scope ? participants[scope.id] || [] : null;
        // A contest's teams are those attending it; the site-wide list knows every team.
        for (const doc of teams) if (!list || list.includes(doc._id)) for (const member of doc.members) team.set(member, { name: doc.displayName, group: doc._id });
        const ipDocs = [...ips].map(([ip, uid]) => ({ _id: ip, uid }));
        if (list) {
            const uids = [...new Set(list.flatMap((uid) => [uid, ...teams.find((doc) => doc._id === uid)?.members || []]))];
            return buildSeatRows(accounts(uids, team), ipDocs.filter((doc) => uids.includes(doc.uid)), false);
        }
        const uids = [...new Set([...seats.keys(), ...ips.values()])];
        return buildSeatRows(accounts(uids, team), ipDocs, true);
    }

    function selection(input: Record<string, unknown>) {
        const scope = input.contest ? findContest(input.contest) : null;
        if (input.contest && !scope) throw new ManageError('比赛不存在', 404);
        const query = normalizeSeatQuery(input);
        return { scope, meta: { contest: scope ? { domainId: 'system', tid: scope.id, title: scope.title } : null, ...query }, ...selectSeatRows(rows(scope), query) };
    }

    function save(data: SeatBackupData, label: string, reason: string) {
        const doc = { _id: `6741${String(Date.now()).padStart(16, '0')}${String(backups.length).padStart(4, '0')}`, createdAt: new Date(), createdBy: 2, reason, label, ...data };
        backups.unshift(doc);
        backups.splice(BACKUPS_KEPT);
        return doc;
    }
    save(backupOf(rows(null)), '全站', 'manual').createdAt = new Date(now - 2 * 86400_000);

    const contestRow = (tdoc: PreviewContest) => ({ key: contestKey(tdoc), title: tdoc.title, domainId: 'system', beginAt: tdoc.beginAt, endAt: tdoc.endAt });

    async function data(query: URLSearchParams) {
        const tab = query.get('tab');
        if (tab === 'seat-backups') {
            return { backups: backups.map(({ seats: list, ips: addresses, ...doc }) => ({ ...doc, seats: list.length + (doc.emptySeats?.length || 0), ips: addresses.length + (doc.freeIps?.length || 0), operator: 'admin' })) };
        }
        if (tab === 'seat-backup') {
            const doc = backups.find((item) => item._id === query.get('id'));
            if (!doc) throw new ManageError('备份不存在', 404);
            return backupFile(doc, doc);
        }
        const chosen = selection(Object.fromEntries(query));
        if (tab === 'seat-roster') {
            if (!chosen.scope) throw new ManageError('请选择比赛');
            const roster = rows(chosen.scope), uids = new Set(roster.map(row => row.uid));
            return seatCoverage(roster, [...ips].filter(([, uid]) => !uids.has(uid)).map(([ip, uid]) => ({ ip, uid })));
        }
        const number = Math.max(1, Number(query.get('page')) || 1);
        const active = chosen.scope === contests[0] && demoLinks ? await demoLinks.status({ domainId: 'system', docId: 'demo' }) : [];
        return {
            contests: contests.map(contestRow), contest: chosen.scope ? contestRow(chosen.scope) : null,
            total: chosen.rows.length, page: number, pageSize: 50, rows: chosen.rows.slice((number - 1) * 50, number * 50),
            counts: chosen.counts, zones: chosen.zones, links: chosen.scope ? [...links[chosen.scope.id].filter(row => !active.some(a => a.id === row.id)), ...active] : null,
        };
    }

    function operate(name: string, payload: any) {
        switch (name) {
        case 'update_seat': {
            const edit = normalizeSeatEdit(payload);
            if (!accounts([edit.uid], new Map()).length) throw new ManageError('账号不存在', 404);
            if (edit.seat) seats.set(edit.uid, edit.seat); else seats.delete(edit.uid);
            if (edit.kind === 'team') return { moved: [] };
            const moved = edit.ips.filter((ip) => ips.has(ip) && ips.get(ip) !== edit.uid).map((ip) => ({ ip, uid: ips.get(ip)! }));
            for (const [ip, uid] of ips) if (uid === edit.uid && !edit.ips.includes(ip)) forgetIp(ip);
            for (const ip of edit.ips) setManual(ip, edit.uid);
            return { moved };
        }
        case 'backup_seats': {
            const chosen = selection(payload);
            const backup = backupOf(chosen.rows);
            if (!backup.seats.length && !backup.ips.length) throw new ManageError('当前列表没有座位或 IP 登录');
            const doc = save(backup, scopeLabel(chosen.meta), 'manual');
            return { id: doc._id, seats: backup.seats.length, ips: backup.ips.length, file: backupFile(backup, doc) };
        }
        case 'clear_seats': {
            const options = normalizeClearOptions(payload.options);
            verify(payload.password);
            const chosen = selection(payload);
            if (!chosen.rows.length) throw new ManageError('当前列表为空');
            const plan = clearPlan(chosen.rows, options, 2);
            const doc = save(backupOf(chosen.rows), scopeLabel(chosen.meta), 'clear');
            for (const uid of [...plan.userSeats, ...plan.teamSeats]) seats.delete(uid);
            let removed = 0;
            for (const ip of plan.ips) if (forgetIp(ip)) removed++;
            return { backup: doc._id, seats: plan.userSeats.length + plan.teamSeats.length, ips: removed, sessions: plan.sessions.length };
        }
        case 'import_seats':
        case 'restore_seats': {
            let backup: SeatBackupData, reason: string, label: string;
            if (name === 'import_seats') {
                const entries = parseSeatImport(payload.mode, payload.text);
                const docs = [...users, ...teams];
                const uids = entries.map(({ account }) => {
                    const doc = docs.find(item => item.uname.toLowerCase() === account.toLowerCase()) || docs.find(item => String(item._id) === account);
                    if (!doc) throw new ManageError(`账号 ${account} 不存在`);
                    return doc._id;
                });
                const scope = selection(payload).scope;
                backup = seatImportData(payload.mode, entries, uids, scope ? new Set(rows(scope).map(row => row.uid)) : undefined);
                reason = 'import'; label = `导入“${scope?.title || '全站'}”之前`;
            } else {
                verify(payload.password);
                const source = payload.id ? backups.find(item => item._id === payload.id) : null;
                if (payload.id && !source) throw new ManageError('备份不存在', 404);
                backup = source || normalizeBackup(payload.data);
                reason = 'restore'; label = `恢复“${source?.label || '备份文件'}”之前`;
            }
            const exists = (uid: number) => accounts([uid], new Map()).length > 0;
            const writeSeats = payload.seats === false ? [] : backup.seats.filter(item => exists(item.uid));
            const writeIps = payload.ips === false ? [] : backup.ips.filter(item => exists(item.uid));
            const empty = payload.seats === false ? [] : (backup.emptySeats || []).filter(exists);
            const free = payload.ips === false ? [] : backup.freeIps || [];
            const seatIds = new Set([...writeSeats.map(item => item.uid), ...empty]);
            const addresses = new Set([...writeIps.map(item => item.ip), ...free]);
            const before = {
                seats: [...seatIds].filter(uid => seats.has(uid)).map(uid => ({ uid, kind: uid < 0 ? 'team' as const : 'user' as const, seat: seats.get(uid)! })),
                ips: [...addresses].filter(ip => ips.has(ip)).map(ip => ({ ip, uid: ips.get(ip)! })),
                emptySeats: [...seatIds].filter(uid => !seats.has(uid)), freeIps: [...addresses].filter(ip => !ips.has(ip)),
            };
            const saved = (seatIds.size || addresses.size) ? save(before, label, reason) : null;
            for (const item of writeSeats) seats.set(item.uid, item.seat);
            for (const uid of empty) seats.delete(uid);
            for (const item of writeIps) setManual(item.ip, item.uid);
            for (const ip of free) forgetIp(ip);
            const wanted = (payload.seats === false ? 0 : backup.seats.length + (backup.emptySeats?.length || 0)) + (payload.ips === false ? 0 : backup.ips.length + (backup.freeIps?.length || 0));
            return { seats: seatIds.size, ips: addresses.size, skipped: wanted - seatIds.size - addresses.size, backup: saved?._id };
        }
        case 'revoke_links': {
            const scope = findContest(payload.contest);
            if (!scope) throw new ManageError('比赛不存在', 404);
            const list = links[scope.id];
            for (const item of list) if (item.count) item.issuedAt = new Date();
            if (scope === contests[0] && demoLinks) return demoLinks.revoke({ domainId: 'system', docId: 'demo' }).then(active => ({
                links: [...list.filter(row => !active.some(a => a.id === row.id)).map(item => ({ ...item, error: null })), ...active],
            }));
            return { links: list.map((item) => ({ id: item.id, label: item.label, count: item.count, error: null })) };
        }
        default: return undefined;
        }
    }

    const bindings: CollectBindings = {
        async findOne({ _id }) { return ips.has(_id) ? { _id, uid: ips.get(_id)!, xcpcioCollect: collected.get(_id) } : null; },
        async insertOne(item) {
            if (ips.has(item._id)) throw Object.assign(new Error('Duplicate'), { code: 11000 });
            ips.set(item._id, item.uid); collected.set(item._id, item.xcpcioCollect);
        },
        async updateOne(filter, change) {
            const old = collected.get(filter._id);
            if (ips.get(filter._id) !== filter.uid || !old || old.uid !== filter.uid || old.contest !== filter['xcpcioCollect.contest']) return { matchedCount: 0 };
            ips.set(filter._id, change.$set.uid); collected.set(filter._id, change.$set.xcpcioCollect);
            return { matchedCount: 1 };
        },
    };
    async function collect(ip: string, name: string) {
        const user = users.find(item => item.uname.toLowerCase() === name.toLowerCase());
        if (!user || !participants[contests[0].id].includes(user._id)) throw new ManageError('该账号不是本场可登记的参赛账号');
        await bindCollectedIp(bindings, contestKey(contests[0]), ip, user._id);
        return { name: user.displayName, account: user.uname, ip };
    }
    return { data, operate, collect };
}
