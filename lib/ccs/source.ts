/**
 * Gathers a contest's Hydro data for the CCS model (lib/ccs/model.ts): board data in both views,
 * problems, languages, records with their judging history, clarifications, people and what the
 * plugin stored itself.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Context, Tdoc } from 'hydrooj';
export type HydroApi = typeof import('hydrooj');
import { type BoardData, problemColor, UNSET_PROBLEM_COLOR } from '../board';
import { resolverBoards } from '../resolver-data';
import { applyBoardRules, labelsHidden } from '../ccpc-board';
import { applyJury, heldProblems, type JuryState } from '../jury';
import type { BoardSettings } from '../settings';
import { isTeamEntry, memberIds, type TeamEntry } from '../teams';
import type {
    AccountSource, CcsSource, ClarificationSource, JudgingSource, LanguageSource, PersonSource, ProblemSource, RecordSource,
} from './model';
import { type CcsStore, contestKey } from './store';

export interface SourceDependencies {
    loadData: (tdoc: Tdoc, realtime: boolean, identity: boolean, staffResults: boolean) => Promise<BoardData>;
    loadJury: (tdoc: Tdoc) => Promise<JuryState>;
    loadSettings: (tdoc: Tdoc) => Promise<BoardSettings>;
}

const pluginRoot = path.join(__dirname, '../..');
const readJson = (file: string, fallback: unknown) => {
    try { return JSON.parse(fs.readFileSync(path.join(pluginRoot, file), 'utf8')); } catch { return fallback; }
};
let logos: { names: Record<string, string>; png: Record<string, { width: number; height: number; md5: string }> } | null = null;
export function logoRegistry() {
    logos ||= { names: readJson('logos/index.json', { names: {} }).names || {}, png: readJson('logos/png/index.json', {}) };
    return logos;
}

/** The public board's rule for a guest (as the live module and screens use it). */
const nobody = { user: { _id: 0, own: () => false, hasPerm: () => false, hasPriv: () => false } };

const toMs = (value: unknown) => (value ? new Date(value as string).getTime() : null);
/** Hydro problem time limits: a number of ms, or a string such as `1s`, `1000ms`. */
export function timeLimitMs(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    const match = typeof value === 'string' ? /^\s*([\d.]+)\s*(ms|s)?\s*$/i.exec(value) : null;
    if (!match) return null;
    const amount = Number(match[1]);
    return match[2]?.toLowerCase() === 'ms' ? amount : amount * 1000;
}

/** Hydro memory limits: MB as a number, or a string such as `256m`, `512MB`, `1g`. */
export function memoryLimitMb(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    const match = typeof value === 'string' ? /^\s*([\d.]+)\s*([kmg])?i?b?\s*$/i.exec(value) : null;
    if (!match) return null;
    const amount = Number(match[1]);
    const unit = (match[2] || 'm').toLowerCase();
    return unit === 'g' ? amount * 1024 : unit === 'k' ? amount / 1024 : amount;
}

/** Bind all Hydro access to its host; the preview supplies an isolated in-memory host. */
export function createCcsSourceLoader(host: HydroApi) {
const { ContestModel, DomainModel, ObjectId, ProblemModel, RecordModel, SettingModel, SystemModel, PERM, PRIV, BUILTIN_ROLES, UserModel, getAlphabeticId } = host;
const idTime = (id: unknown) => {
    try { return new ObjectId(String(id)).getTimestamp().getTime(); } catch { return 0; }
};

/** The same language intersection as Hydro's problem submission handler, including remote tasks. */
async function problemLanguages(tdoc: Tdoc, pdoc: any): Promise<string[]> {
    const langs = (SettingModel as unknown as { langs: Record<string, any> }).langs || {};
    const config = pdoc.reference ? (await ProblemModel.get(pdoc.reference.domainId, pdoc.reference.pid))?.config : pdoc.config;
    if (!config || typeof config !== 'object') return [];
    if (['objective', 'submit_answer'].includes(config.type)) return ['_'];
    const domains = await Promise.all([DomainModel.get(tdoc.domainId), ...(pdoc.reference ? [DomainModel.get(pdoc.reference.domainId)] : [])]);
    const restrictions: string[][] = [config.langs, (tdoc as any).langs?.length ? (tdoc as any).langs : null,
        ...domains.map(domain => domain?.langs ? domain.langs.split(',').map((item: string) => item.trim()).filter(Boolean) : null)].filter(Array.isArray);
    const remote = config.type === 'remote_judge';
    return Object.entries(langs).filter(([key, lang]) => !lang.disabled
        && (remote ? key === config.subType || key.startsWith(`${config.subType}.`) || lang.validAs?.[config.subType]
            : !lang.remote && (restrictions.length || !lang.hidden))
        && restrictions.every(list => list.includes(key))).map(([key]) => key);
}

async function contestLanguages(tdoc: Tdoc): Promise<LanguageSource[]> {
    const langs = (SettingModel as unknown as { langs: Record<string, any> }).langs || {};
    const problems = await Promise.all(tdoc.pids.map(pid => ProblemModel.get(tdoc.domainId, pid)));
    const allowed = new Set((await Promise.all(problems.filter(Boolean).map(problem => problemLanguages(tdoc, problem)))).flat());
    return [...allowed].map(key => [key, langs[key] || { display: '提交答案' }] as const)
        .map(([key, lang]) => ({
            key,
            display: String(lang.display || key),
            extension: typeof lang.code_file === 'string' && lang.code_file.includes('.') ? lang.code_file.split('.').pop()! : null,
            compile: typeof lang.compile === 'string' && lang.compile ? lang.compile : null,
            execute: typeof lang.execute === 'string' && lang.execute ? lang.execute : null,
        }));
}

async function contestProblems(tdoc: Tdoc): Promise<ProblemSource[]> {
    const pdict = await ProblemModel.getList(tdoc.domainId, tdoc.pids, true, false, ProblemModel.PROJECTION_PUBLIC as never, true) as Record<number, any>;
    const balloon = (tdoc as { balloon?: Record<number, unknown> }).balloon || {};
    return Promise.all(tdoc.pids.map(async (pid, index) => {
        const original = pdict[pid];
        const pdoc = original?.reference ? await ProblemModel.get(original.reference.domainId, original.reference.pid) : original;
        const config = pdoc && typeof pdoc.config === 'object' ? pdoc.config : {};
        const colorEntry = balloon[pid];
        const color = problemColor(colorEntry);
        const colorName = colorEntry && typeof colorEntry === 'object' && typeof (colorEntry as { name?: unknown }).name === 'string'
            ? (colorEntry as { name: string }).name.trim() || null : null;
        return {
            pid,
            label: getAlphabeticId(index),
            title: original?.title || getAlphabeticId(index),
            timeLimitMs: timeLimitMs(config.timeMax),
            memoryMb: memoryLimitMb(config.memoryMax),
            testCount: Number.isSafeInteger(config.count) ? config.count : 0,
            color: color === UNSET_PROBLEM_COLOR ? null : color,
            colorName,
            attachments: (pdoc?.additional_file || []).map((file: { name: string; size?: number }) => ({ name: file.name, size: file.size || 0 })),
        };
    }));
}

/** Everything the model needs about one contest, read now. */
async function loadCcsSource(ctx: Context, store: CcsStore, dependencies: SourceDependencies, tdoc: Tdoc): Promise<CcsSource> {
    const domainId = tdoc.domainId;
    const tid = `${tdoc.docId}`;
    const key = contestKey(domainId, tid);
    const frozen = await store.frozenSource(key);
    if (frozen) return frozen;
    const [settings, jury] = await Promise.all([dependencies.loadSettings(tdoc), dependencies.loadJury(tdoc)]);
    const [rawFull, rawPublic, stored, entries] = await Promise.all([
        dependencies.loadData(tdoc, true, true, true),
        dependencies.loadData(tdoc, false, settings.showIdentity, false),
        store.contest(domainId, tid),
        ContestModel.getMultiStatus(domainId, { docId: tdoc.docId }).toArray() as Promise<(TeamEntry & { unrank?: boolean })[]>,
    ]);
    // CCS retains the original problem IDs, even when the public board hides labels.
    const plain = (data: BoardData, publicView: boolean) => applyBoardRules(applyJury(data, jury, tdoc.pids, publicView), settings, tdoc, Date.now(), true);
    const full = plain(rawFull, false);
    const publicData = plain(rawPublic, true);
    const holds = heldProblems(jury, tdoc.beginAt.getTime());
    const credits: NonNullable<CcsSource['credits']> = {};
    for (const { teamId, from, minutes } of jury.credits) (credits[teamId] ||= []).push({ from, minutes });
    const domain = await DomainModel.get(domainId);
    const roles = Object.entries({ ...BUILTIN_ROLES, ...domain?.roles }).filter(([, value]) => {
        const perm = BigInt(String(value));
        return (perm & PERM.PERM_EDIT_CONTEST) === PERM.PERM_EDIT_CONTEST || (perm & PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD) === PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD;
    }).map(([role]) => role);
    const [domainUsers, globalAdmins] = await Promise.all([
        DomainModel.getMultiUserInDomain(domainId, { role: { $in: roles } }).toArray(),
        UserModel.getMulti({ priv: { $bitsAllSet: PRIV.PRIV_MANAGE_ALL_DOMAIN } }, ['_id']).toArray(),
    ]);
    const staffUids = [...new Set([tdoc.owner, ...((tdoc as { maintainer?: number[] }).maintainer || []),
        ...domainUsers.map((u: any) => u.uid), ...globalAdmins.map(u => u._id)].filter((uid) => uid > 0))];
    const users = await UserModel.getList(domainId, [...entries.map((entry) => entry.uid), ...memberIds(tdoc, entries), ...staffUids]) as Record<number, any>;
    const nameOf = (uid: number) => (users[uid]?.displayName?.trim() || users[uid]?.uname || String(uid));

    const teamOfUser = new Map<number, number>();
    const persons: PersonSource[] = [];
    const accounts: AccountSource[] = [];
    for (const entry of entries) {
        if (!users[entry.uid]) continue;
        const members = isTeamEntry(entry) ? entry.members.filter((uid) => users[uid]) : [entry.uid];
        for (const member of members) {
            teamOfUser.set(member, entry.uid);
            persons.push({ uid: member, name: nameOf(member), teamUid: entry.uid, role: 'contestant' });
            const user = users[member];
            const type = member === tdoc.owner || user.hasPerm?.(PERM.PERM_EDIT_CONTEST) ? 'admin' : user.hasPerm?.(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD) ? 'judge' : 'team';
            accounts.push({ uid: member, uname: user.uname, name: nameOf(member), type, teamUid: entry.uid });
        }
    }
    const contestants = new Set(persons.map((person) => person.uid));
    for (const uid of staffUids) {
        if (!users[uid] || contestants.has(uid)) continue;
        const user = users[uid];
        const type = uid === tdoc.owner || user.hasPerm?.(PERM.PERM_EDIT_CONTEST) ? 'admin'
            : user.hasPerm?.(PERM.PERM_VIEW_CONTEST_HIDDEN_SCOREBOARD) ? 'judge' : null;
        if (!type) continue;
        persons.push({ uid, name: nameOf(uid), teamUid: null, role: 'staff' });
        accounts.push({ uid, uname: users[uid].uname, name: nameOf(uid), type, teamUid: null });
    }

    const recordDocs = await RecordModel.getMulti(domainId, { contest: tdoc.docId }, {
        projection: { _id: 1, uid: 1, pid: 1, lang: 1, status: 1, time: 1, judgeAt: 1, ccsTime: 1, 'testCases.status': 1, 'testCases.time': 1 },
    }).toArray() as any[];
    const rids = recordDocs.map((doc) => doc._id);
    const historyDocs = rids.length ? await (ctx.db.collection('record.history' as never) as any)
        .find({ rid: { $in: rids } }, { projection: { rid: 1, status: 1, judgeAt: 1, time: 1, 'testCases.status': 1, 'testCases.time': 1 } })
        .toArray() as any[] : [];
    const history = new Map<string, any[]>();
    for (const doc of historyDocs) history.set(`${doc.rid}`, [...(history.get(`${doc.rid}`) || []), doc]);
    const judging = (doc: any): JudgingSource => ({
        status: Number(doc.status),
        startAt: null,
        judgeAt: toMs(doc.judgeAt),
        time: Number.isFinite(doc.time) ? doc.time : null,
        cases: (doc.testCases || []).map((item: any) => ({ status: Number(item.status), time: Number(item.time) || 0 })),
    });
    const [submissionIds, clarificationIds] = await Promise.all([store.mappedIds(key, 'submissions'), store.mappedIds(key, 'clarifications')]);
    const records: RecordSource[] = recordDocs.map((doc) => {
        const rid = `${doc._id}`;
        const submittedAt = toMs(doc.ccsTime) ?? idTime(doc._id);
        const heldSince = holds.get(doc.pid);
        const previous = (history.get(rid) || []).sort((a, b) => (toMs(a.judgeAt) ?? 0) - (toMs(b.judgeAt) ?? 0)).map(judging);
        return {
            rid,
            submissionId: submissionIds.get(rid) ?? rid,
            uid: doc.uid,
            teamUid: teamOfUser.get(doc.uid) ?? doc.uid,
            pid: doc.pid,
            lang: String(doc.lang || ''),
            submittedAt,
            held: heldSince !== undefined && submittedAt >= heldSince,
            judgings: [...previous, judging(doc)],
        };
    });
    // Judging start times the writer saw (Hydro keeps none).
    const starts = await store.judgeStarts(records.flatMap((record) => record.judgings.map((_, index) => `${record.rid}.${index + 1}`)));
    const tracked = await (ctx.db.collection('xcpcio.monitor.judges' as never) as any).find({}).toArray();
    const active = tracked.flatMap((p: any) => (p.judges || []).flatMap((j: any) => j.active || []));
    const recent = tracked.flatMap((p: any) => (p.judges || []).flatMap((j: any) => j.recent || []));
    for (const record of records) record.judgings.forEach((item, index) => {
        item.startAt = starts.get(`${record.rid}.${index + 1}`) ?? null;
        if (item.startAt !== null) return;
        const task = item.judgeAt === null ? active.find((t: any) => t.domainId === domainId && t.rid === record.rid)
            : recent.find((t: any) => t.domainId === domainId && t.rid === record.rid && t.durationMs !== null
                && t.status === item.status && Math.abs(t.at - item.judgeAt!) < 5000);
        if (task) item.startAt = task.startedAt ?? task.at - task.durationMs;
    });

    const clarificationDocs = (await ContestModel.getMultiClarification(domainId, tdoc.docId) as any[]).filter(doc => !doc.ccsMirror);
    const clarifications: ClarificationSource[] = clarificationDocs.map((doc) => ({
        docId: `${doc.docId}`,
        ccsId: clarificationIds.get(`${doc.docId}`),
        owner: Number(doc.owner) || 0,
        subject: Number(doc.subject) || 0,
        content: String(doc.content ?? ''),
        at: idTime(doc.docId),
        replies: (doc.reply || []).filter((reply: any) => !reply.ccsMirror).map((reply: any) => ({
            id: `${reply._id}`, owner: Number(reply.owner) || 0, content: String(reply.content ?? ''), at: idTime(reply._id),
        })),
    }));

    const registry = logoRegistry();
    const [problems, languages, awardOverrides, comments] = await Promise.all([
        contestProblems(tdoc), contestLanguages(tdoc), store.awardOverrides(key), store.comments(key),
    ]);
    for (const record of records) if (!languages.some(lang => lang.key === record.lang)) {
        const lang = (SettingModel as any).langs?.[record.lang] || {};
        languages.push({ key: record.lang, display: String(lang.display || record.lang), submittable: false,
            extension: typeof lang.code_file === 'string' && lang.code_file.includes('.') ? lang.code_file.split('.').pop() : null,
            compile: typeof lang.compile === 'string' ? lang.compile : null, execute: typeof lang.execute === 'string' ? lang.execute : null });
    }
    return {
        now: Date.now(),
        contest: {
            id: tid, domainId, title: tdoc.title, beginAt: tdoc.beginAt.getTime(), endAt: tdoc.endAt.getTime(),
            lockAt: tdoc.lockAt ? new Date(tdoc.lockAt).getTime() : null, unlocked: !!(tdoc as { unlocked?: boolean }).unlocked,
            allowTeam: !!(tdoc as { allowTeam?: boolean }).allowTeam,
        },
        meta: stored.meta || {},
        settings,
        full,
        public: publicData, credits,
        // CCPC 新榜单模式: no public scoreboard while the board hides problem labels.
        publicVisible: !!ContestModel.canShowScoreboard.call(nobody as never, tdoc, false) && !labelsHidden(settings.ccpcBoard, tdoc, Date.now()),
        boards: resolverBoards(full, settings, true),
        publicBoards: resolverBoards(publicData, settings, settings.showIdentity),
        logoNames: registry.names,
        logoIndex: registry.png,
        problems,
        languages,
        records,
        clarifications,
        persons,
        accounts,
        teamOfUser,
        awardOverrides,
        comments,
        extraClarifications: await store.clarifications(key),
        codeLimit: Number(SystemModel.get('limit.codelength')) || 128 * 1024,
    };
}

return { loadCcsSource, contestLanguages, contestProblems, problemLanguages };
}
