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

/** Read the identity fields stored by onsite-toolkit on the account that entered the contest. */
export async function loadBoardProfiles(db: Context['db'], uids: number[]) {
    const ids = [...new Set(uids)];
    type Profile = { _id: number; coach?: unknown; coaches?: unknown; girl?: unknown; isGirl?: unknown; 女队?: unknown; seat?: unknown };
    const read = (name: 'user' | 'vuser', subset: number[]) => subset.length
        ? db.collection(name).find({ _id: { $in: subset } } as never)
            .project<Profile>({ _id: 1, coach: 1, coaches: 1, girl: 1, isGirl: 1, 女队: 1, seat: 1 }).toArray() : [];
    const [users, teams] = await Promise.all([read('user', ids.filter((id) => id > 0)), read('vuser', ids.filter((id) => id < 0))]);
    return new Map([...users, ...teams].map((account) => {
        const coaches = [...new Set([...profileValues(account.coach), ...profileValues(account.coaches)])];
        const seat = typeof account.seat === 'string' || typeof account.seat === 'number' ? String(account.seat).trim() : '';
        const girl = [account.girl, account.isGirl, account.女队].some((v) => /^(?:true|1|yes|y|是|女|女队)$/i.test(String(v ?? '').trim()));
        return [account._id, { ...(girl ? { girl: true as const } : {}), ...(coaches.length ? { coaches } : {}), ...(seat ? { location: seat } : {}) }];
    }));
}

export async function loadCoaches(db: Context['db'], uids: number[]) {
    const profiles = await loadBoardProfiles(db, uids);
    return Object.fromEntries([...profiles].flatMap(([uid, profile]) => profile.coaches ? [[String(uid), profile.coaches] as const] : []));
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
