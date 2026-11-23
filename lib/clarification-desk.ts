export const clarificationReplyPresets = [
    '否', '是', '请仔细阅读题面', '无可奉告', '不提供额外数据',
];
export const clarificationAnnouncements = [
    { name: '封榜时间', text: '本场比赛将在 {封榜时间} 封榜。封榜期间仍可正常提交。' },
    { name: '比赛延时', text: '本场比赛延长至 {结束时间}。' },
    { name: '题面更正', text: '题面更正：\n请刷新题面查看修订内容。' },
];
export const clarificationClaimMs = 10 * 60_000;
export const clarificationTextLimit = 2000;

export class ClarificationDeskError extends Error {
    constructor(message: string, readonly status = 400) { super(message); }
}

export interface DeskSettings {
    replies: string[];
    freezeMinutes: number;
}

export interface DeskSubject { pid: number; label: string }
export interface DeskIdentity { name: string; seat: string }
export interface DeskActor {
    id: string;
    label: string;
    /** null for a manager, one problem ID for a delegate. */
    pid: number | null;
}
export interface DeskClaim {
    actor: string;
    name: string;
    at: number;
    until: number;
}
interface DeskObjectId { toString(): string; getTimestamp(): Date }
export interface DeskClarification {
    docId: DeskObjectId;
    owner: number;
    subject: number;
    content: string;
    reply?: { _id: DeskObjectId; owner: number; content: string }[];
}

export function deskSettings(input?: Partial<DeskSettings> | null): DeskSettings {
    return { replies: input?.replies ?? [...clarificationReplyPresets], freezeMinutes: input?.freezeMinutes ?? 0 };
}

export function readDeskSettings(input: unknown): DeskSettings {
    const { replies, freezeMinutes } = (input ?? {}) as Record<string, unknown>;
    if (!Array.isArray(replies) || replies.length > 20 || replies.some((reply) => typeof reply !== 'string' || !reply.trim() || reply.trim().length > 250)) {
        throw new ClarificationDeskError('请填写最多 20 条回复模板，每条 1 到 250 个字');
    }
    if (typeof freezeMinutes !== 'number' || !Number.isInteger(freezeMinutes) || freezeMinutes < 0 || freezeMinutes > 120) {
        throw new ClarificationDeskError('封榜提醒请输入 0 到 120 分钟（0 为关闭）');
    }
    return { replies: [...new Set(replies.map((reply: string) => reply.trim()))], freezeMinutes };
}

export function readDeskText(value: unknown, label = '内容', max = clarificationTextLimit): string {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text || text.length > max) throw new ClarificationDeskError(`请填写${label}（1 到 ${max} 个字）`);
    return text;
}

const originHost = (origin: string) => {
    // URL.parse arrived in Node 22.1; the plugin supports every Node 22.
    try { return new URL(origin).host; } catch { return null; }
};

export function isDeskWrite(host: string, headers: { origin?: string; 'x-requested-with'?: string | string[] }) {
    return headers['x-requested-with'] === 'XMLHttpRequest' && (!headers.origin || originHost(headers.origin) === host);
}

export function readDeskSubject(value: unknown, pids: number[], allowGeneral = false) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)
        || !(pids.includes(value) || allowGeneral && (value === 0 || value === -1))) {
        throw new ClarificationDeskError(allowGeneral ? '请选择公告分类' : '请选择本场比赛的题目');
    }
    return value;
}

export function activeDeskClaim(claim: DeskClaim | undefined, now: number) {
    return claim && claim.until > now ? claim : null;
}

export function firstDeskReply(doc: DeskClarification) {
    return (doc.reply ?? []).find((reply) => reply.owner !== doc.owner);
}

export function deskView(
    docs: DeskClarification[], subjects: DeskSubject[], people: ReadonlyMap<number, DeskIdentity>,
    claims: ReadonlyMap<string, DeskClaim>, actor: DeskActor, now: number,
) {
    const visibleSubjects = actor.pid === null ? subjects : subjects.filter(({ pid }) => pid === actor.pid);
    const names = new Map(visibleSubjects.map(({ pid, label }) => [pid, label]));
    const counts = new Map(visibleSubjects.map(({ pid }) => [pid, 0]));
    const pending = [];
    const answered = [];
    const announcements = [];
    let responseTotal = 0;
    for (const doc of docs) {
        if (actor.pid !== null && doc.subject !== actor.pid) continue;
        const id = String(doc.docId);
        const at = doc.docId.getTimestamp().getTime();
        const label = names.get(doc.subject) ?? `题目 #${doc.subject}`;
        if (doc.owner === 0) {
            if (announcements.length < 50) announcements.push({ id, at, label, subject: doc.subject, text: doc.content });
            continue;
        }
        const reply = firstDeskReply(doc);
        const responseAt = reply?._id.getTimestamp().getTime() ?? null;
        const claim = reply ? null : activeDeskClaim(claims.get(id), now);
        const question = {
            id, at, label, subject: doc.subject, text: doc.content,
            team: people.get(doc.owner) ?? { name: `账号 #${doc.owner}`, seat: '' },
            reply: reply && { text: reply.content, at: responseAt },
            claim: claim && { name: claim.name, mine: claim.actor === actor.id, until: claim.until },
        };
        counts.set(doc.subject, (counts.get(doc.subject) ?? 0) + 1);
        if (responseAt === null) pending.push(question);
        else {
            answered.push(question);
            responseTotal += Math.max(responseAt - at, 0);
        }
    }
    pending.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
    answered.sort((a, b) => (b.reply?.at ?? 0) - (a.reply?.at ?? 0) || b.id.localeCompare(a.id));
    return {
        pending, answered: answered.slice(0, 100), announcements, subjects: visibleSubjects,
        stats: {
            pending: pending.length, answered: answered.length,
            averageResponseMs: answered.length ? Math.round(responseTotal / answered.length) : null,
            subjects: [...counts.entries()].map(([pid, count]) => ({ pid, label: names.get(pid) ?? `题目 #${pid}`, count })),
        },
    };
}

/** An automatic reminder is due once before each scheduled freeze. */
export function freezeNotice(beginAt: number, lockAt: number, endAt: number, minutes: number, now: number, unlocked: boolean) {
    if (!minutes || !(beginAt <= now && now < lockAt && lockAt < endAt) || unlocked) return null;
    return now >= lockAt - minutes * 60_000 ? lockAt : null;
}
