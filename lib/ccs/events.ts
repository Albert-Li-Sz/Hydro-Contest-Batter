/** Pure notification ordering and projection shared by HTTP and durable event delivery. */
import { createHash } from 'node:crypto';
import { identityBoard } from '../board';
import type { BoardSettings } from '../settings';
import { project } from './access';
import type { CcsObjects } from './model';
import type { EventDoc } from './store';
import { CcsError, stableId, type Endpoint, EVENT_TYPES, type EventType } from './types';
const ORDER: EventType[] = ['judgement-types', 'languages', 'groups', 'organizations', 'teams', 'persons', 'accounts', 'contest', 'problems', 'state', 'submissions', 'judgements', 'runs', 'clarifications', 'awards', 'commentary'];
export interface Notification { type: EventType; id: string | null; data: unknown; identityOnly?: true }

/** Record the award's scope at creation, so replay respects privacy even after a rule is deleted. */
export const identityAwardIds = (settings: BoardSettings) => new Set(settings.specialAwards
    .filter(award => identityBoard(award.board)).map(award => stableId(`special-${award.id}`)));
export function identityAward(id: string | null, special?: ReadonlySet<string>) {
    return !!id && (special?.has(id) || (id.startsWith('group-winner-') && identityBoard(id.slice('group-winner-'.length))));
}

const hash = (value: unknown) => createHash('sha1').update(JSON.stringify(value)).digest('base64url');

/** Every object of a view as a notification keyed `type/id`. */
export function notificationsOf(objects: CcsObjects, special?: ReadonlySet<string>): Map<string, Notification> {
    const result = new Map<string, Notification>();
    result.set('contest/', { type: 'contest', id: null, data: objects.contest });
    result.set('state/', { type: 'state', id: null, data: objects.state });
    for (const type of EVENT_TYPES) {
        if (type === 'contest' || type === 'state') continue;
        for (const item of objects[type] as { id: string }[]) {
            result.set(`${type}/${item.id}`, { type, id: item.id, data: item,
                ...(type === 'awards' && identityAward(item.id, special) ? { identityOnly: true } : {}) });
        }
    }
    return result;
}

/**
 * Updates introduce referenced objects before dependents and remove references before deletions.
 * Rejudging clears/removes old judgements before introducing a new current judgement.
 */
export function diffNotifications(current: Map<string, Notification>, previous: Map<string, string>) {
    const order = (type: EventType) => ORDER.indexOf(type);
    const changed: { key: string; hash: string; notification: Notification }[] = [];
    for (const [key, notification] of current) {
        const value = (notification.identityOnly ? 'identity:' : '') + hash(notification.data);
        if (previous.get(key) !== value) changed.push({ key, hash: value, notification });
    }
    const removed = [...previous.keys()].reverse().filter((key) => !current.has(key));
    const deletions = removed.map((key) => {
        const [type, ...rest] = key.split('/');
        return { key, notification: { type: type as EventType, id: rest.join('/') || null, data: null,
            ...(previous.get(key)?.startsWith('identity:') ? { identityOnly: true as const } : {}) } };
    }).sort((a, b) => order(b.notification.type) - order(a.notification.type));
    changed.sort((a, b) => order(a.notification.type) - order(b.notification.type)
        || (a.notification.type === 'judgements' ? Number(!!(a.notification.data as any).current) - Number(!!(b.notification.data as any).current) : 0));
    // Imported clarification IDs need not be chronological: publish parents before replies.
    const ordered: typeof changed = [];
    const visiting = new Set<string>();
    const done = new Set<string>();
    const byKey = new Map(changed.map(item => [item.key, item]));
    const visit = (item: typeof changed[number]) => {
        if (done.has(item.key) || visiting.has(item.key)) return;
        visiting.add(item.key);
        const parent = item.notification.type === 'clarifications' && (item.notification.data as any).reply_to_id;
        const dependency = parent && byKey.get(`clarifications/${parent}`);
        if (dependency) visit(dependency);
        ordered.push(item); done.add(item.key);
    };
    changed.forEach(visit);
    const before = deletions.filter(item => ['runs', 'judgements'].includes(item.notification.type));
    const after = deletions.filter(item => !['runs', 'judgements'].includes(item.notification.type));
    const notifications = [...before.map(item => item.notification), ...ordered.map(item => item.notification), ...after.map(item => item.notification)];
    const ending = notifications.findIndex(item => item.type === 'state' && (item.data as any)?.end_of_updates);
    if (ending >= 0) notifications.push(notifications.splice(ending, 1)[0]);
    return { changed, removed, notifications };
}

/** An event as sent in the event feed and webhooks: projected to what the role may see. */
export function eventLine(event: Pick<EventDoc, 'type' | 'id' | 'data' | 'seq' | 'identityOnly'>, props: Partial<Record<Endpoint, string[]>>, identity = true) {
    const endpoint = (event.type === 'contest' ? 'contests' : event.type) as Endpoint;
    const list = props[endpoint];
    if (!list) return null;
    let data = event.data;
    if (!identity) {
        if (event.type === 'groups' && identityBoard(event.id)) return null;
        if (event.identityOnly || (event.type === 'awards' && identityAward(event.id))) return null;
        if (event.type === 'teams' && data && !Array.isArray(data)) {
            const team = data as { group_ids?: string[] };
            data = { ...team, group_ids: team.group_ids?.filter(id => !identityBoard(id)) };
        }
    }
    if (Array.isArray(data)) data = data.map((item) => project(item, list));
    else if (data && typeof data === 'object') data = project(data, list);
    return { type: event.type, id: event.id, data, token: String(event.seq) };
}


/** Bind resumption to the contest and visibility; a token from another feed is never accepted. */
export function tokenPrefix(key: string, view: string, identity: boolean) {
    return createHash('sha256').update(`${key}\n${view}\n${identity}`).digest('hex').slice(0, 16);
}
export const feedToken = (prefix: string, sequence: number) => `${prefix}-${sequence}`;
export function parseFeedToken(token: unknown, prefix: string, last: number) {
    if (typeof token !== 'string' || !token.startsWith(`${prefix}-`)) throw new CcsError(400, 'since_token 无效');
    const number = token.slice(prefix.length + 1);
    const seq = Number(number);
    if (!/^[1-9]\d*$/.test(number) || !Number.isSafeInteger(seq) || seq > last) throw new CcsError(400, 'since_token 无效');
    return seq;
}
