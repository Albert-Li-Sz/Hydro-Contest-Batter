import type { Context } from 'hydrooj';
import { profileValues } from './roster';

/**
 * Hydro team contests (Hydro 5.1, `tdoc.allowTeam`): a team is a virtual user whose contest status
 * carries `displayName` and the member user ids in `members`. A participant who attends alone has
 * no members and stays a one-person team, as in every contest before.
 */

export interface TeamEntry {
    uid: number;
    displayName?: string;
    members?: number[];
}

export interface TeamUser {
    _id: number;
    uname: string;
    displayName?: string;
    school?: string;
}

export function isTeamEntry(entry: TeamEntry): entry is TeamEntry & { members: number[] } {
    return Array.isArray(entry.members) && entry.members.length > 0;
}

/** Member ids to load with the participants (only team contests have any). */
export function memberIds(tdoc: object, entries: TeamEntry[]) {
    // `allowTeam` exists from Hydro 5.1 on; older versions have no team contests.
    if (!(tdoc as { allowTeam?: unknown }).allowTeam) return [];
    return [...new Set(entries.flatMap((entry) => (isTeamEntry(entry) ? entry.members : [])))];
}

/** onsite-toolkit imports the seat into the corresponding user or virtual user document. */
export async function loadSeats(db: Context['db'], uids: number[]) {
    const distinct = [...new Set(uids)];
    const read = (name: 'user' | 'vuser', ids: number[]) => ids.length
        ? db.collection(name).find({ _id: { $in: ids }, seat: { $exists: true } } as never)
            .project<{ _id: number; seat?: unknown }>({ _id: 1, seat: 1 }).toArray()
        : [];
    const [users, teams] = await Promise.all([read('user', distinct.filter((uid) => uid > 0)), read('vuser', distinct.filter((uid) => uid < 0))]);
    return new Map([...users, ...teams].flatMap(({ _id, seat }) => (typeof seat === 'string' || typeof seat === 'number'
        ? [[_id, String(seat)] as const] : [])));
}

/** onsite-toolkit imports coaches as `coach` or `coaches` on the user or virtual user; teams with any, by id. */
export async function loadCoaches(db: Context['db'], uids: number[]) {
    const distinct = [...new Set(uids.filter((uid) => Number.isFinite(uid)))];
    type AccountCoach = { _id: number; coach?: unknown; coaches?: unknown };
    const read = (name: 'user' | 'vuser', ids: number[]) => ids.length
        ? db.collection(name).find({ _id: { $in: ids }, $or: [{ coaches: { $exists: true } }, { coach: { $exists: true } }] } as never)
            .project<AccountCoach>({ _id: 1, coach: 1, coaches: 1 }).toArray()
        : [];
    const [users, teams] = await Promise.all([read('user', distinct.filter((uid) => uid > 0)), read('vuser', distinct.filter((uid) => uid < 0))]);
    const coaches: Record<string, string[]> = Object.create(null);
    for (const account of [...users, ...teams]) {
        const names = [...new Set([...profileValues(account.coach), ...profileValues(account.coaches)])];
        if (names.length) coaches[String(account._id)] = names;
    }
    return coaches;
}

/**
 * A participant's name: the display name set in Hydro, shown to every viewer (the account name
 * only when there is none). The school stays private unless identity may be shown.
 */
const personName = (user: TeamUser) => user.displayName?.trim() || user.uname;

/** The school most members share; ties go to the earlier member. */
function teamSchool(members: TeamUser[]) {
    const counts = new Map<string, number>();
    for (const member of members) {
        const school = (member.school || '').trim();
        if (school) counts.set(school, (counts.get(school) || 0) + 1);
    }
    let best = '';
    for (const [school, count] of counts) if (count > (counts.get(best) || 0)) best = school;
    return best;
}

export function describeTeam(entry: TeamEntry, users: Record<number, TeamUser | undefined>, identity: boolean) {
    const user = users[entry.uid];
    if (!user) return null;
    if (!isTeamEntry(entry)) {
        return { name: personName(user), school: identity ? user.school : undefined, members: undefined };
    }
    const members = entry.members.map((uid) => users[uid]).filter((member): member is TeamUser => !!member && !!member._id);
    return {
        // Team names are public in Hydro (its board shows them to everyone); the virtual user's
        // generated login name is only a fallback.
        name: user.displayName || entry.displayName || user.uname,
        school: identity ? teamSchool(members) : undefined,
        members: members.map(personName),
    };
}
