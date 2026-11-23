import fs from 'node:fs';
import path from 'node:path';
import {
    ConnectionHandler, ContestModel, Context, Handler, ObjectId, param, PRIV, SystemModel, Types, UserModel,
} from 'hydrooj';
import {
    CLAIM_TIMEOUT_MS, connectionCode, headerFields, languageOfFile, lineCount, MAX_ATTEMPTS, MAX_PRINT_BYTES, newPrintToken, hashToken,
    normalizePrinterPreference, normalizePrintSettings, normalizeServerInput, ONLINE_MS, PrintError, preferenceOf, type PrinterPreference,
    type PrintServerInput, type PrintSettings, seatOf, serverTakes, tokenMatches,
} from './print';
import type { ReceiptQueue } from './balloon-routes';
import type { ReceiptJob } from './escpos';
import { defaultReceiptConfig } from './balloons';
import { printJob, type PrintSheet } from './print-render';
import { resolverCodeBase } from './resolver-data';
import { toScriptJson } from './settings';
import { describeTeam, isTeamEntry, loadSeats, memberIds, type TeamEntry } from './teams';

/** Hydro's print requests: documents of type 32 under a contest (model/contest.ts addPrintTask). */
const TYPE_CONTEST_PRINT = 32;
const TYPE_CONTEST = 30;

interface ClientPrinter {
    name: string;
    /** As the operating system reports it: idle, printing, paused, error, offline. */
    status: string;
    queue: number;
    message: string;
    isDefault: boolean;
    /** PDF, XPS, fax: files rather than paper, so not used until enabled here. */
    virtual: boolean;
}

interface ServerDoc extends PrintServerInput {
    _id: ObjectId;
    tokenHash: string;
    createdAt: Date;
    createdBy: number;
    lastSeen: Date | null;
    client: { version: string; host: string; os: string; ip: string; capabilities?: string[] } | null;
    printers: ClientPrinter[];
    preferences: Record<string, PrinterPreference>;
    stats: { printed: number; failed: number };
    /** Test pages (or test tickets, for a receipt printer) waiting for the PC, each for one printer or any. */
    tests: { id: string; printer: string }[];
    lastTest: { at: Date; printer: string; status: string; message: string } | null;
}

interface PrintTask {
    _id: ObjectId;
    domainId: string;
    docId: ObjectId;
    parentId: ObjectId;
    owner: number;
    title?: string;
    content?: string;
    status: string;
    xcpcioServer?: string;
    xcpcioPrinter?: string;
    xcpcioAttempts?: number;
    xcpcioError?: string;
}

const clientPlatforms: Record<string, string> = {
    'windows-amd64.exe': 'Windows（x64）', 'windows-arm64.exe': 'Windows（ARM64）', 'darwin-arm64': 'macOS（Apple 芯片）',
    'darwin-amd64': 'macOS（Intel）', 'linux-amd64': 'Linux（x64）', 'linux-arm64': 'Linux（ARM64）',
};
const CLIENT_PREFIX = 'hydro-print-client-';
/** A poll looks at up to SCAN_PAGES × SCAN_PAGE waiting requests for ones this PC may take. */
const SCAN_PAGE = 200;
const SCAN_PAGES = 10;
const defaultPreference = (printer: { virtual?: boolean }): PrinterPreference => ({
    enabled: !printer.virtual, weight: 1, kind: 'document', receipt: defaultReceiptConfig(),
});
/** A printer's saved preference (or the default), also for preferences saved before printer types. */
const preferenceFor = (doc: { preferences?: Record<string, PrinterPreference> }, printer: { name: string; virtual?: boolean }) =>
    preferenceOf(doc.preferences?.[printer.name], () => defaultPreference(printer));
/** Clients from before 1.14.0 know no receipt printers: theirs must stay out of their rotation. */
const printsReceipts = (doc: { client: { capabilities?: string[] } | null }) => !!doc.client?.capabilities?.includes('receipt');

/**
 * Print servers for system administrators (/manage): each is a PC running the print client, which
 * takes Hydro's print requests for the contests and seats it is bound to and prints them on its
 * printers, balancing between them. The PC reports its printers, so they show here per server.
 */
export function applyPrintServers(ctx: Context, dependencies: { receipts?: ReceiptQueue } = {}) {
    const { receipts } = dependencies;
    const root = path.join(__dirname, '..');
    const codeBase = resolverCodeBase(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version);
    const raw = (name: string): any => ctx.db.collection(name as never);
    const servers = raw('xcpcio.print.servers');
    const config = raw('xcpcio.print.config');
    const documents = raw('document');
    const on = ctx.on.bind(ctx) as unknown as (name: string, listener: (...args: any[]) => unknown) => () => void;
    on('app/started', async () => {
        await documents.createIndex({ docType: 1, status: 1, _id: 1 }, { partialFilterExpression: { docType: TYPE_CONTEST_PRINT } }).catch(() => null);
    });

    async function loadSettings(): Promise<PrintSettings> {
        const doc = await config.findOne({ _id: 'global' });
        return normalizePrintSettings(doc?.settings || {});
    }

    function clientFiles() {
        const dir = path.join(root, 'public/hydro-print-client');
        let names: string[] = [];
        try { names = fs.readdirSync(dir); } catch { return []; }
        return names.filter((name) => name.startsWith(CLIENT_PREFIX)).map((name) => {
            const platform = name.slice(CLIENT_PREFIX.length);
            return { name, url: `/hydro-print-client/${name}`, label: clientPlatforms[platform] || platform, size: fs.statSync(path.join(dir, name)).size };
        }).sort((a, b) => a.name.localeCompare(b.name));
    }

    const serverUrl = (origin: unknown) => {
        const configured = SystemModel.get('server.url');
        if (typeof configured === 'string' && /^https?:\/\//.test(configured) && !/\/\/(localhost|127\.0\.0\.1)[:/]/.test(configured)) return configured;
        if (typeof origin === 'string' && /^https?:\/\/[^\s/]+$/.test(origin)) return origin;
        return typeof configured === 'string' ? configured : '';
    };

    /** Team names, schools, members and seats of a contest's participants (staff see identity). */
    async function contestInfo(domainId: string, tid: ObjectId) {
        const tdoc = await ContestModel.get(domainId, tid);
        if (!tdoc) return null;
        const entries = await ContestModel.getMultiStatus(domainId, { docId: tid }).toArray() as unknown as (TeamEntry & { unrank?: boolean })[];
        const uids = [...entries.map((entry) => entry.uid), ...memberIds(tdoc, entries)];
        const [users, seats] = await Promise.all([UserModel.getList(domainId, uids), loadSeats(ctx.db, uids)]);
        const byUid = new Map<number, { name: string; school: string; members: string[]; uname: string; seat: string; unofficial: boolean }>();
        for (const entry of entries) {
            const team = describeTeam(entry, users, true);
            if (!team) continue;
            const uname = users[entry.uid]?.uname || String(entry.uid);
            const info = { name: team.name, school: team.school || '', members: team.members || [], uname, unofficial: !!entry.unrank,
                seat: seatOf(seats, entry.uid, isTeamEntry(entry) ? entry.members : []) };
            byUid.set(entry.uid, info);
            // Members send print requests for their team.
            if (isTeamEntry(entry)) for (const member of entry.members) if (!byUid.has(member)) byUid.set(member, info);
        }
        const who = (uid: number) => byUid.get(uid) ?? {
            name: users[uid]?.displayName || users[uid]?.uname || `UID ${uid}`, school: '', members: [], uname: users[uid]?.uname || String(uid),
            unofficial: false, seat: seatOf(seats, uid),
        };
        return { tdoc, who };
    }

    function sheetOf(task: PrintTask, who: ReturnType<NonNullable<Awaited<ReturnType<typeof contestInfo>>>['who']>): PrintSheet {
        const content = task.content || '';
        return {
            id: String(task.docId), team: who.name, school: who.school, members: who.members, account: who.uname, seat: who.seat, unofficial: who.unofficial,
            problem: task.title || '', language: languageOfFile(task.title || ''), time: new ObjectId(String(task.docId)).getTimestamp(),
            lines: lineCount(content), code: Buffer.byteLength(content) > MAX_PRINT_BYTES ? null : content,
        };
    }

    /** Requests a PC claimed and never reported (closed, crashed) go back to the queue. */
    async function releaseStale(now: number) {
        await documents.updateMany(
            { docType: TYPE_CONTEST_PRINT, status: 'printing', xcpcioClaimedAt: { $lt: new Date(now - CLAIM_TIMEOUT_MS) } },
            { $set: { status: 'pending' }, $unset: { xcpcioServer: '', xcpcioClaimedAt: '' } },
        );
    }

    // ---------------------------------------------------------------- Live updates

    // The management page listens on a socket and reloads when the queue or a print server
    // changes; Hydro's broadcast reaches the sockets in every process (PM2 cluster included).
    const sockets = new Set<PrintersSocketHandler>();
    const changed = () => (ctx as unknown as { broadcast: (event: string, ...args: unknown[]) => void }).broadcast('xcpcio/print-changed');
    (ctx.on as unknown as (name: string, listener: () => void) => void)('xcpcio/print-changed', () => {
        for (const socket of sockets) socket.send({ type: 'changed' });
    });
    // A contestant's print request (Hydro's own handler, model/contest.ts addPrintTask).
    ctx.on('handler/after', (handler) => {
        if (handler.constructor?.name === 'ContestPrintHandler' && handler.request.method.toLowerCase() === 'post') changed();
    });

    class PrintersSocketHandler extends ConnectionHandler {
        async prepare() {
            this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
            sockets.add(this);
        }

        async cleanup() {
            sockets.delete(this);
        }
    }

    // ---------------------------------------------------------------- Administration

    abstract class AdminBase extends Handler {
        async prepare() {
            this.response.addHeader('Cache-Control', 'no-store');
            this.checkPriv(PRIV.PRIV_EDIT_SYSTEM);
        }

        payload(input: string) {
            if (input.length > 400000) throw new PrintError('请求内容过大');
            try { return JSON.parse(input); } catch { throw new PrintError('请求格式无效'); }
        }

        async verifyAdmin(password: unknown) {
            await this.limitRate('xcpcio_manage_verify', 300, 20);
            if (typeof password !== 'string' || !password) throw new PrintError('请输入管理员密码', 403);
            try {
                await (this.user as unknown as { checkPassword: (value: string) => Promise<void> }).checkPassword(password);
            } catch { throw new PrintError('管理员密码错误', 403); }
        }

        async server(id: unknown): Promise<ServerDoc> {
            if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) throw new PrintError('打印服务器编号无效');
            const doc = await servers.findOne({ _id: new ObjectId(id) });
            if (!doc) throw new PrintError('打印服务器不存在', 404);
            return doc;
        }

        async onerror(error: Parameters<Handler['onerror']>[0] | PrintError) {
            if (error instanceof PrintError) {
                this.response.status = error.status;
                this.response.body = { error: error.message };
                return;
            }
            return super.onerror(error);
        }

        /** Every management action changes a print server or the queue (failed ones never get here). */
        async after() {
            if (this.request.method.toLowerCase() === 'post') changed();
        }
    }

    class PrintersHandler extends AdminBase {
        async get() {
            this.response.template = 'xcpcio_manage_printers.html';
            this.response.body = {
                codeBase,
                runtimeJson: toScriptJson({ base: this.request.path, dataUrl: `${this.request.path}/data`, socket: `${this.request.path}/ws`, headerFields }),
            };
        }

        @param('payload', Types.String)
        async postCreate(_domainId: string, input: string) {
            const body = this.payload(input);
            const server = normalizeServerInput(body);
            const token = newPrintToken();
            const doc: ServerDoc = {
                _id: new ObjectId(), ...server, tokenHash: hashToken(token), createdAt: new Date(), createdBy: this.user._id, lastSeen: null, client: null,
                printers: [], preferences: {}, stats: { printed: 0, failed: 0 }, tests: [], lastTest: null,
            };
            await servers.insertOne(doc);
            this.response.body = { id: String(doc._id), code: connectionCode(serverUrl(body.origin), String(doc._id), token) };
        }

        @param('payload', Types.String)
        async postUpdate(_domainId: string, input: string) {
            const body = this.payload(input);
            const doc = await this.server(body.id);
            const server = normalizeServerInput(body.server, doc);
            await servers.updateOne({ _id: doc._id }, { $set: { name: server.name, note: server.note, enabled: server.enabled, contests: server.contests, seatPrefixes: server.seatPrefixes } });
            this.response.body = { ok: true };
        }

        /** A new secret: the PC's current connection stops working until it is given the new code. */
        @param('payload', Types.String)
        async postRegenerate(_domainId: string, input: string) {
            const body = this.payload(input);
            const doc = await this.server(body.id);
            const token = newPrintToken();
            await servers.updateOne({ _id: doc._id }, { $set: { tokenHash: hashToken(token) } });
            this.response.body = { code: connectionCode(serverUrl(body.origin), String(doc._id), token) };
        }

        @param('payload', Types.String)
        async postDelete(_domainId: string, input: string) {
            const body = this.payload(input);
            const doc = await this.server(body.id);
            await this.verifyAdmin(body.password);
            await servers.deleteOne({ _id: doc._id });
            // What it held goes back to the queue for the other print servers.
            await documents.updateMany({ docType: TYPE_CONTEST_PRINT, status: 'printing', xcpcioServer: String(doc._id) },
                { $set: { status: 'pending' }, $unset: { xcpcioServer: '', xcpcioClaimedAt: '' } });
            this.response.body = { ok: true };
        }

        @param('payload', Types.String)
        async postPrinter(_domainId: string, input: string) {
            const body = this.payload(input);
            const doc = await this.server(body.id);
            const name = String(body.printer || '');
            if (!doc.printers.some((printer) => printer.name === name) && !doc.preferences?.[name]) throw new PrintError('打印机不存在');
            const preferences = { ...doc.preferences, [name]: normalizePrinterPreference(body.preference) };
            await servers.updateOne({ _id: doc._id }, { $set: { preferences } });
            this.response.body = { preference: preferences[name] };
        }

        /** A test page for one printer (or the PC's choice), printed on its next poll. */
        @param('payload', Types.String)
        async postTest(_domainId: string, input: string) {
            const body = this.payload(input);
            const doc = await this.server(body.id);
            const test = { id: `test-${new ObjectId()}`, printer: String(body.printer || '') };
            await servers.updateOne({ _id: doc._id }, { $push: { tests: { $each: [test], $slice: -10 } } });
            this.response.body = { ok: true };
        }

        @param('payload', Types.String)
        async postSettings(_domainId: string, input: string) {
            const settings = normalizePrintSettings(this.payload(input).settings, await loadSettings());
            await config.updateOne({ _id: 'global' }, { $set: { settings, updatedAt: new Date(), updatedBy: this.user._id } }, { upsert: true });
            this.response.body = { settings };
        }

        @param('payload', Types.String)
        async postRequeue(_domainId: string, input: string) {
            const ids = (this.payload(input).tasks || []).map(String).filter((id: string) => /^[a-f\d]{24}$/i.test(id)).map((id: string) => new ObjectId(id));
            if (!ids.length) throw new PrintError('请选择打印请求');
            // Only finished requests: one a PC is printing now would come out twice.
            const result = await documents.updateMany({ docType: TYPE_CONTEST_PRINT, docId: { $in: ids }, status: { $in: ['printed', 'failed'] } },
                { $set: { status: 'pending', xcpcioAttempts: 0 }, $unset: { xcpcioServer: '', xcpcioClaimedAt: '', xcpcioError: '' } });
            this.response.body = { updated: result.modifiedCount, skipped: ids.length - result.modifiedCount };
        }
    }

    class PrintersDataHandler extends AdminBase {
        notUsage = true;

        async get() {
            const now = Date.now();
            await releaseStale(now);
            const settings = await loadSettings();
            const [list, contests, counts, perPrinter, recent] = await Promise.all([
                servers.find({}).sort({ createdAt: 1 }).toArray() as Promise<ServerDoc[]>,
                documents.find({ docType: TYPE_CONTEST }).project({ domainId: 1, docId: 1, title: 1, beginAt: 1, endAt: 1, allowPrint: 1, rule: 1 }).sort({ beginAt: -1 }).limit(300).toArray(),
                documents.aggregate([{ $match: { docType: TYPE_CONTEST_PRINT } }, { $group: { _id: '$status', n: { $sum: 1 } } }]).toArray(),
                documents.aggregate([{ $match: { docType: TYPE_CONTEST_PRINT, status: 'printed', xcpcioServer: { $exists: true } } },
                    { $group: { _id: { server: '$xcpcioServer', printer: '$xcpcioPrinter' }, n: { $sum: 1 } } }]).toArray(),
                documents.find({ docType: TYPE_CONTEST_PRINT }).project({ content: 0 }).sort({ _id: -1 }).limit(50).toArray() as Promise<PrintTask[]>,
            ]);
            // Bound contests stay listed even when they are older than the 300 most recent.
            const listed = new Set(contests.map((tdoc: { domainId: string; docId: ObjectId }) => `${tdoc.domainId}/${tdoc.docId}`));
            const missing = [...new Set(list.flatMap((doc) => doc.contests || []))].filter((key) => !listed.has(key));
            if (missing.length) {
                contests.push(...await documents.find({ docType: TYPE_CONTEST, $or: missing.map((key) => ({ domainId: key.split('/')[0], docId: new ObjectId(key.split('/')[1]) })) })
                    .project({ domainId: 1, docId: 1, title: 1, beginAt: 1, endAt: 1, allowPrint: 1, rule: 1 }).toArray());
            }
            const printed = new Map<string, number>(perPrinter.map((row: { _id: { server: string; printer: string }; n: number }) => [`${row._id.server}\n${row._id.printer}`, row.n]));
            // Balloon tickets each receipt printer printed (lib/balloon-routes.ts).
            const tickets = new Map<string, number>((await raw('xcpcio.balloons').aggregate([
                { $match: { 'ticket.prints': { $gt: 0 }, 'ticket.server': { $exists: true } } },
                { $group: { _id: { server: '$ticket.server', printer: '$ticket.printer' }, n: { $sum: '$ticket.prints' } } },
            ]).toArray()).map((row: { _id: { server: string; printer: string }; n: number }) => [`${row._id.server}\n${row._id.printer}`, row.n]));
            const names = new Map(list.map((doc) => [String(doc._id), doc.name]));
            const infos = new Map<string, Awaited<ReturnType<typeof contestInfo>>>();
            for (const task of recent) {
                const key = `${task.domainId}/${task.parentId}`;
                if (!infos.has(key)) infos.set(key, await contestInfo(task.domainId, task.parentId));
            }
            this.response.body = {
                settings, clients: clientFiles(),
                queue: Object.fromEntries(counts.map((row: { _id: string; n: number }) => [row._id, row.n])),
                contests: contests.map((tdoc: { domainId: string; docId: ObjectId; title: string; beginAt: Date; endAt: Date; allowPrint?: boolean; rule?: string }) => ({
                    key: `${tdoc.domainId}/${tdoc.docId}`, domainId: tdoc.domainId, title: tdoc.title, beginAt: tdoc.beginAt, endAt: tdoc.endAt,
                    allowPrint: !!tdoc.allowPrint, rule: tdoc.rule || '',
                })),
                servers: list.map((doc) => {
                    const online = !!doc.lastSeen && now - new Date(doc.lastSeen).getTime() < ONLINE_MS;
                    const reported = new Set(doc.printers.map((printer) => printer.name));
                    const printers = [...doc.printers, ...Object.keys(doc.preferences || {}).filter((name) => !reported.has(name))
                        .map((name) => ({ name, status: 'missing', queue: 0, message: '', isDefault: false, virtual: false }))];
                    return {
                        id: String(doc._id), name: doc.name, note: doc.note, enabled: doc.enabled, contests: doc.contests, seatPrefixes: doc.seatPrefixes,
                        online, lastSeen: doc.lastSeen, client: doc.client, stats: doc.stats, lastTest: doc.lastTest, testsWaiting: doc.tests?.length || 0,
                        receipts: printsReceipts(doc),
                        printers: printers.map((printer) => ({
                            ...printer, status: online ? printer.status : printer.status === 'missing' ? 'missing' : 'offline',
                            preference: preferenceFor(doc, printer),
                            printed: printed.get(`${doc._id}\n${printer.name}`) || 0,
                            tickets: tickets.get(`${doc._id}\n${printer.name}`) || 0,
                        })),
                    };
                }),
                recent: recent.map((task) => {
                    const info = infos.get(`${task.domainId}/${task.parentId}`);
                    const who = info?.who(task.owner);
                    return {
                        id: String(task.docId), contest: info?.tdoc.title || String(task.parentId), title: task.title || '', status: task.status,
                        team: who?.name || `UID ${task.owner}`, seat: who?.seat || '', time: new ObjectId(String(task.docId)).getTimestamp(),
                        server: task.xcpcioServer ? names.get(task.xcpcioServer) || '已删除的打印服务器' : '', printer: task.xcpcioPrinter || '',
                        attempts: task.xcpcioAttempts || 0, error: task.xcpcioError || '',
                    };
                }),
            };
        }
    }

    // ---------------------------------------------------------------- Print client protocol

    /** The PC proves itself with its print server's secret (`Authorization: Bearer …`); no Hydro login. */
    abstract class ClientBase extends Handler {
        noCheckPermView = true;
        notUsage = true;
        doc!: ServerDoc;

        @param('sid', Types.String)
        async prepare(_domainId: string, sid: string) {
            this.response.addHeader('Cache-Control', 'no-store');
            const header = String(this.request.headers.authorization || '');
            const token = /^Bearer\s+(\S+)$/i.exec(header)?.[1] || '';
            const doc = /^[a-f\d]{24}$/i.test(sid) ? await servers.findOne({ _id: new ObjectId(sid) }) : null;
            if (!doc || !token || !tokenMatches(token, doc.tokenHash)) throw new PrintError('连接信息无效或已重新生成，请在“打印服务器管理”中复制新的连接信息', 401);
            this.doc = doc;
        }

        body(): Record<string, any> {
            const value = this.request.body as unknown;
            return value && typeof value === 'object' ? value as Record<string, any> : {};
        }

        async onerror(error: Parameters<Handler['onerror']>[0] | PrintError) {
            if (error instanceof PrintError) {
                this.response.status = error.status;
                this.response.body = { error: error.message };
                return;
            }
            return super.onerror(error);
        }
    }

    const text = (value: unknown, max: number) => String(value ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);

    class HeartbeatHandler extends ClientBase {
        async post() {
            const body = this.body();
            const printers: ClientPrinter[] = (Array.isArray(body.printers) ? body.printers : []).slice(0, 50).map((printer: Record<string, unknown>) => ({
                name: text(printer.name, 200), status: text(printer.status, 20) || 'idle', queue: Math.max(0, Math.min(9999, Number(printer.queue) || 0)),
                message: text(printer.message, 200), isDefault: printer.isDefault === true, virtual: printer.virtual === true,
            })).filter((printer: ClientPrinter) => printer.name);
            const capabilities = (Array.isArray(body.capabilities) ? body.capabilities : []).map((value: unknown) => text(value, 20)).filter(Boolean).slice(0, 10);
            const client = { version: text(body.version, 40), host: text(body.host, 100), os: text(body.os, 60), ip: String(this.request.ip || ''), capabilities };
            await servers.updateOne({ _id: this.doc._id }, { $set: { lastSeen: new Date(), client, printers } });
            // Heartbeats come every few seconds: only coming back online or a printer change is news.
            const wasOnline = !!this.doc.lastSeen && Date.now() - new Date(this.doc.lastSeen).getTime() < ONLINE_MS;
            if (!wasOnline || JSON.stringify(printers) !== JSON.stringify(this.doc.printers)
                || JSON.stringify(capabilities) !== JSON.stringify(this.doc.client?.capabilities || [])) changed();
            const receiptsKnown = capabilities.includes('receipt');
            this.response.body = {
                name: this.doc.name, enabled: this.doc.enabled, pollMs: 3000,
                preferences: Object.fromEntries(printers.map((printer) => {
                    const preference = preferenceFor(this.doc, printer);
                    // An older client would send printouts to a receipt printer: it is off for it.
                    return [printer.name, preference.kind === 'receipt' && !receiptsKnown ? { ...preference, enabled: false } : preference];
                })),
            };
        }
    }

    class NextHandler extends ClientBase {
        async post() {
            const now = Date.now();
            await servers.updateOne({ _id: this.doc._id }, { $set: { lastSeen: new Date(now) } });
            if (!this.doc.enabled) { this.response.body = { jobs: [] }; return; }
            const settings = await loadSettings();
            const jobs: (ReturnType<typeof printJob> | ReceiptJob)[] = [];
            // A client that prints tickets polls also when none of its printers takes printouts (slots 0).
            const receiptsAsked = this.body().receipts === true;
            const requested = Number(this.body().slots);
            const slots = receiptsAsked && requested === 0 ? 0 : Math.max(1, Math.min(10, requested || 1));
            const testSlots = Math.max(slots, receiptsAsked ? 3 : 1);
            // Test pages first, taken atomically so two overlapping polls do not both print them.
            if (this.doc.tests?.length) {
                const taken = await servers.findOneAndUpdate({ _id: this.doc._id, 'tests.0': { $exists: true } }, { $set: { tests: [] } }, { returnDocument: 'before' }) as ServerDoc | null;
                const tests = taken?.tests || [];
                if (tests.length > testSlots) await servers.updateOne({ _id: this.doc._id }, { $push: { tests: { $each: tests.slice(testSlots), $position: 0 } } });
                for (const test of tests.slice(0, testSlots)) {
                    const printer = this.doc.printers.find((candidate) => candidate.name === test.printer);
                    const preference = printer ? preferenceFor(this.doc, printer) : null;
                    // A receipt printer gets a test ticket (if its client prints them; else nothing that could jam it).
                    if (preference?.kind === 'receipt') {
                        if (receipts && printsReceipts(this.doc)) jobs.push(receipts.testJob(test.id, this.doc.name, test.printer, preference.receipt));
                        continue;
                    }
                    jobs.push({ ...testJob(test.id, this.doc.name, settings), printer: test.printer });
                }
            }
            await releaseStale(now);
            const active = await servers.find({ enabled: true, lastSeen: { $gt: new Date(now - ONLINE_MS) } })
                .project({ contests: 1, seatPrefixes: 1 }).toArray() as { _id: ObjectId; contests: string[]; seatPrefixes: string[] }[];
            const others = active.map((doc) => ({ id: String(doc._id), contests: doc.contests || [], seatPrefixes: doc.seatPrefixes || [] }));
            const me = { id: String(this.doc._id), contests: this.doc.contests || [], seatPrefixes: this.doc.seatPrefixes || [] };
            const filter: Record<string, unknown> = { docType: TYPE_CONTEST_PRINT, parentType: TYPE_CONTEST, status: 'pending' };
            if (me.contests.length) {
                filter.$or = me.contests.map((key) => {
                    const [domainId, tid] = key.split('/');
                    return { domainId, parentId: new ObjectId(tid) };
                });
            }
            const infos = new Map<string, Awaited<ReturnType<typeof contestInfo>>>();
            // Page through the queue: the oldest requests may all belong to other PCs' seats.
            let after: ObjectId | null = null;
            for (let page = 0; page < SCAN_PAGES && jobs.length < slots; page++) {
                const candidates = await documents.find(after ? { ...filter, _id: { $gt: after } } : filter)
                    .project({ _id: 1, domainId: 1, parentId: 1, owner: 1 }).sort({ _id: 1 }).limit(SCAN_PAGE).toArray() as PrintTask[];
                if (!candidates.length) break;
                after = candidates[candidates.length - 1]._id;
                for (const candidate of candidates) {
                    if (jobs.length >= slots) break;
                    const key = `${candidate.domainId}/${candidate.parentId}`;
                    if (!infos.has(key)) infos.set(key, await contestInfo(candidate.domainId, candidate.parentId));
                    const info = infos.get(key);
                    if (!info) continue;
                    const who = info.who(candidate.owner);
                    if (!serverTakes(me, { contest: key, seat: who.seat }, others)) continue;
                    const task = await documents.findOneAndUpdate(
                        { _id: candidate._id, status: 'pending' },
                        { $set: { status: 'printing', xcpcioServer: me.id, xcpcioClaimedAt: new Date() } },
                        { returnDocument: 'after' },
                    ) as PrintTask | null;
                    if (!task) continue; // another PC took it
                    jobs.push(printJob(sheetOf(task, who), settings, info.tdoc.title));
                }
                if (candidates.length < SCAN_PAGE) break;
            }
            // Balloon tickets for this PC's receipt printers, from clients that print them.
            if (receipts && receiptsAsked && printsReceipts(this.doc)) jobs.push(...await receipts.claim(String(this.doc._id), now));
            this.response.body = { jobs };
            if (jobs.length) changed();
        }
    }

    class ReportHandler extends ClientBase {
        /** A printed or failed result (also of a test page) changes what the management page shows. */
        async after() {
            changed();
        }

        async post() {
            const body = this.body();
            const id = String(body.id || '');
            const printer = text(body.printer, 200);
            const message = text(body.message, 300);
            // `released`: the PC had no printer free for it; back to the queue without using up an attempt.
            const status = body.status === 'printed' ? 'printed' : body.status === 'released' ? 'released' : 'failed';
            if (id.startsWith('balloon-')) {
                if (!receipts || !await receipts.report(id, String(this.doc._id), status, printer, message)) throw new PrintError('气球小票不存在或已交给其他打印服务器', 404);
                await servers.updateOne({ _id: this.doc._id }, status === 'released' ? { $set: { lastSeen: new Date() } }
                    : { $set: { lastSeen: new Date() }, $inc: { [status === 'printed' ? 'stats.printed' : 'stats.failed']: 1 } });
                this.response.body = { ok: true };
                return;
            }
            if (id.startsWith('test-')) {
                await servers.updateOne({ _id: this.doc._id }, { $set: { lastTest: { at: new Date(), printer, status, message }, lastSeen: new Date() } });
                this.response.body = { ok: true };
                return;
            }
            if (!/^[a-f\d]{24}$/i.test(id)) throw new PrintError('打印请求编号无效');
            const task = await documents.findOne({ docType: TYPE_CONTEST_PRINT, docId: new ObjectId(id), xcpcioServer: String(this.doc._id), status: 'printing' }) as PrintTask | null;
            if (!task) throw new PrintError('打印请求不存在或已交给其他打印服务器', 404);
            if (status === 'released') {
                await documents.updateOne({ _id: task._id, status: 'printing' }, { $set: { status: 'pending' }, $unset: { xcpcioServer: '', xcpcioClaimedAt: '' } });
            } else if (status === 'printed') {
                await documents.updateOne({ _id: task._id }, {
                    $set: { status: 'printed', xcpcioPrinter: printer, xcpcioPrintedAt: new Date() }, $unset: { xcpcioClaimedAt: '', xcpcioError: '' },
                });
                await servers.updateOne({ _id: this.doc._id }, { $inc: { 'stats.printed': 1 } });
            } else {
                const attempts = (task.xcpcioAttempts || 0) + 1;
                // Back to the queue (perhaps for another PC) until it has failed a few times.
                await documents.updateOne({ _id: task._id }, attempts < MAX_ATTEMPTS
                    ? { $set: { status: 'pending', xcpcioAttempts: attempts, xcpcioError: message, xcpcioPrinter: printer }, $unset: { xcpcioServer: '', xcpcioClaimedAt: '' } }
                    : { $set: { status: 'failed', xcpcioAttempts: attempts, xcpcioError: message, xcpcioPrinter: printer }, $unset: { xcpcioClaimedAt: '' } });
                await servers.updateOne({ _id: this.doc._id }, { $inc: { 'stats.failed': 1 } });
            }
            this.response.body = { ok: true };
        }
    }

    function testJob(id: string, serverName: string, settings: PrintSettings) {
        const code = '#include <cstdio>\n\n// 打印测试页：确认中文、加粗与斜体显示正常\nint main() {\n    printf("Hello, %s!\\n", "打印服务器");\n    for (int i = 1; i <= 3; i++) printf("%d\\n", i);\n    return 0;\n}\n';
        return printJob({
            id, team: `测试页 · ${serverName}`, school: '', members: [], account: '', seat: 'A-01', problem: 'test.cpp', language: 'cpp',
            time: new Date(), lines: lineCount(code), code,
        }, settings, 'Hydro 打印服务器');
    }

    ctx.Route('manage_xcpcio_printers', '/manage/xcpcio-printers', PrintersHandler);
    ctx.Route('manage_xcpcio_printers_data', '/manage/xcpcio-printers/data', PrintersDataHandler);
    ctx.Route('xcpcio_print_heartbeat', '/xcpcio-print/:sid/heartbeat', HeartbeatHandler);
    ctx.Route('xcpcio_print_next', '/xcpcio-print/:sid/next', NextHandler);
    ctx.Route('xcpcio_print_report', '/xcpcio-print/:sid/report', ReportHandler);
    ctx.Connection('manage_xcpcio_printers_ws', '/manage/xcpcio-printers/ws', PrintersSocketHandler);
    // Right below 评测机控制.
    ctx.injectUI('ControlPanel', 'manage_xcpcio_printers', { before: 'manage_xcpcio_rejudge' }, PRIV.PRIV_EDIT_SYSTEM);
    ctx.i18n.load('zh', { manage_xcpcio_printers: '打印服务器管理' });
    ctx.i18n.load('en', { manage_xcpcio_printers: 'Print Servers' });
}
