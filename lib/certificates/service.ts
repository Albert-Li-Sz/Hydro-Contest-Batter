/**
 * 证书 storage and operations, shared by the Hydro routes (lib/certificates/routes.ts) and the local preview.
 * Certificates are issued from one results snapshot; each keeps the values it was issued with, so a later
 * change of the results or the sheet reaches a certificate only through a new issue, which replaces it.
 */
import { randomBytes } from 'node:crypto';
import type { Context } from 'hydrooj';
import { writeZip } from '../ccs/zip';
import { boardOptions, resultBoard, resultsCsv, settled, type ResultsData } from '../results';
import { snapshotOption } from '../results-page';
import { ResultsStore, type SnapshotScope } from '../results-store';
import {
    certificateCode, certificateEntries, defaultConfig, fingerprint, kindNames, missingFields, normalizeConfig, normalizeOverride,
    overridesFromCsv, placeholders, planIssue, safeName, sheetOf, sheetRows, templateFor, type CertificateConfig, type CertificateKind, type Placeholder,
} from './model';
import { buildPdf, parseImage, type PdfImage } from './pdf';
import { certificatePage } from './render';

interface ConfigDoc extends CertificateConfig { _id: string; domainId: string; contestId: string; updatedAt: Date; updatedBy: number }
export type IssuedStatus = 'valid' | 'corrected' | 'revoked' | 'pending';
export interface IssuedDoc {
    _id: string;
    domainId: string;
    contestId: string;
    key: string;
    kind: CertificateKind;
    awardId: string;
    teamId: string;
    /** Accounts that may download it themselves: the participant, or the members of a Hydro team. */
    uids: number[];
    values: Record<Placeholder, string>;
    fingerprint: string;
    version: number;
    status: IssuedStatus;
    previous?: string;
    replacedBy?: string;
    reason?: string;
    source: string;
    issuedAt: Date;
    issuedBy: number;
    changedAt?: Date;
}
interface AssetDoc { _id: string; domainId: string; contestId: string; data: Buffer; type: string; createdAt: Date }
declare module 'hydrooj' {
    interface Collections {
        'xcpcio.certificates': ConfigDoc;
        'xcpcio.certificates.issued': IssuedDoc;
        'xcpcio.certificates.assets': AssetDoc;
    }
}

export class CertificateError extends Error {
    constructor(message: string, public status = 400) { super(message); }
}

export interface CertificateRequest {
    scope: SnapshotScope;
    /** The contest's title, the default 比赛名称. */
    title: string;
    uid: number;
    /** Site address ending in `/`, for the verification links in the QR codes. */
    site: string;
}
export interface CertificateFile { data: Buffer; type: string; name: string; inline: boolean }

const MAX_IMAGE = 6 * 1024 * 1024;
const configId = (scope: SnapshotScope) => `${scope.domainId}/${scope.contestId}`;
const bytes = (data: unknown): Buffer => {
    if (Buffer.isBuffer(data)) return data;
    const inner = (data as { buffer?: unknown }).buffer;
    return Buffer.from(inner instanceof Uint8Array ? inner : new Uint8Array(inner as ArrayBuffer));
};
export const verifyUrl = (site: string, domainId: string, code: string) => `${site}d/${encodeURIComponent(domainId)}/certificate/${code}`;
const fileName = (doc: Pick<IssuedDoc, '_id' | 'kind' | 'values'>) => `${[doc.values.team, doc.values.name, doc.values.award || kindNames[doc.kind]].map(safeName).join('-')}-${doc._id}.pdf`;

export function certificateService(db: Context['db'], dependencies: {
    /** Saves the contest's current results as a snapshot and returns its id. */
    snapshot: (scope: SnapshotScope, label: string, uid: number) => Promise<string>;
    /** Team id to the accounts behind it. */
    accounts: (scope: SnapshotScope) => Promise<Map<string, number[]>>;
    showIdentity: (scope: SnapshotScope) => Promise<boolean>;
}) {
    const configs = db.collection('xcpcio.certificates');
    const issued = db.collection('xcpcio.certificates.issued');
    const assets = db.collection('xcpcio.certificates.assets');
    const store = new ResultsStore(db);

    async function ensureIndexes() {
        await Promise.all([
            issued.createIndex({ domainId: 1, contestId: 1, key: 1, version: 1 }, { unique: true }),
            issued.createIndex({ domainId: 1, contestId: 1, uids: 1 }),
            assets.createIndex({ domainId: 1, contestId: 1 }),
        ]);
    }

    async function readConfig(request: Pick<CertificateRequest, 'scope' | 'title'>): Promise<CertificateConfig> {
        const doc = await configs.findOne({ _id: configId(request.scope) });
        const fallback = defaultConfig(request.title);
        if (!doc) return fallback;
        const { _id, domainId: _domain, contestId: _contest, updatedAt: _at, updatedBy: _by, ...saved } = doc;
        return { ...fallback, ...saved, kinds: { ...fallback.kinds, ...saved.kinds }, templates: { ...fallback.templates, ...saved.templates }, sheet: saved.sheet || {} };
    }
    async function writeConfig(request: CertificateRequest, config: CertificateConfig) {
        await configs.updateOne({ _id: configId(request.scope) },
            { $set: { ...config, ...request.scope, updatedAt: new Date(), updatedBy: request.uid } }, { upsert: true });
    }
    async function readSource(scope: SnapshotScope, id: string): Promise<ResultsData> {
        if (!id) throw new CertificateError('请先选择出证依据的成绩快照');
        const data = await store.read(scope, id);
        if (!data) throw new CertificateError('所选成绩快照已不存在，请重新选择');
        return data;
    }
    const boardOf = (data: ResultsData, board: string) => {
        if (!boardOptions(data).some((option) => option.id === board)) throw new CertificateError('所选成绩快照中没有这个榜单');
        return resultBoard(data, board);
    };
    async function background(scope: SnapshotScope, id: string | null, cache: Map<string, PdfImage | null>) {
        if (!id) return null;
        if (!cache.has(id)) {
            const doc = await assets.findOne({ _id: id, ...scope });
            cache.set(id, doc ? parseImage(bytes(doc.data)) : null);
        }
        return cache.get(id)!;
    }
    async function pages(request: CertificateRequest, config: CertificateConfig, docs: Pick<IssuedDoc, '_id' | 'kind' | 'values'>[]) {
        const cache = new Map<string, PdfImage | null>();
        const result = [];
        for (const doc of docs) {
            const template = templateFor(config, doc.kind);
            result.push(certificatePage(template, doc.kind, doc.values, verifyUrl(request.site, request.scope.domainId, doc._id),
                await background(request.scope, template.background, cache)));
        }
        return result;
    }

    // Stage a correction before retiring the old number. Both writes can be replayed after an interruption.
    async function finishCorrection(doc: IssuedDoc) {
        if (!doc.previous || doc.status !== 'pending') return;
        const previous = await issued.updateOne({ _id: doc.previous, status: 'valid' }, {
            $set: { status: 'corrected', replacedBy: doc._id, changedAt: doc.issuedAt },
        });
        if (!previous.matchedCount && !(await issued.findOne({ _id: doc.previous, replacedBy: doc._id }))) {
            await issued.updateOne({ _id: doc._id, status: 'pending' }, { $set: { status: 'revoked', reason: '原证书已撤销', changedAt: new Date() } });
            throw new CertificateError('原证书已变化，请重新出证');
        }
        await issued.updateOne({ _id: doc._id, status: 'pending' }, { $set: { status: 'valid' } });
    }

    async function finishPending(scope: SnapshotScope) {
        const pending = await issued.find({ ...scope, status: 'pending' }).toArray();
        for (const doc of pending) await finishCorrection(doc);
    }

    async function data(request: CertificateRequest) {
        const { scope } = request;
        await finishPending(scope);
        const [config, snapshots, docs, showIdentity] = await Promise.all([
            readConfig(request), store.list(scope), issued.find(scope).sort({ issuedAt: 1 }).toArray(), dependencies.showIdentity(scope),
        ]);
        let preview: unknown = null;
        let error = '';
        if (config.source) {
            try {
                const source = await readSource(scope, config.source);
                const result = boardOf(source, config.board);
                const entries = certificateEntries(result, config);
                const current = new Map(docs.filter((doc) => doc.status === 'valid').map((doc) => [doc.key, doc]));
                const official = new Set(result.rows.filter((row) => row.rank).map((row) => row.id));
                preview = {
                    final: settled(source), boards: boardOptions(source),
                    awards: result.awards.filter((award) => award.teamIds.length).map((award) => ({ id: award.id, name: award.name, kind: award.kind, teams: award.teamIds.length })),
                    sheet: sheetOf(result, config.sheet).map((team) => ({ ...team, official: official.has(team.teamId) })),
                    entries: entries.map((entry) => {
                        const existing = current.get(entry.key);
                        return {
                            key: entry.key, kind: entry.kind, teamId: entry.teamId, name: entry.values.name, school: entry.values.school, award: entry.values.award,
                            missing: missingFields(templateFor(config, entry.kind), entry),
                            state: !existing ? 'new' : existing.fingerprint === fingerprint(entry) ? 'same' : 'changed', code: existing?._id ?? null,
                        };
                    }),
                    stale: docs.filter((doc) => doc.status === 'valid' && !entries.some((entry) => entry.key === doc.key)).length,
                    // One entry of each kind, for the template editor to show real values.
                    samples: Object.fromEntries(certificateEntries(result, { ...config, kinds: { team: true, member: true, coach: true, participation: true } })
                        .reduce((found, entry) => (found.has(entry.kind) ? found : found.set(entry.kind, entry.values)), new Map<string, Record<string, string>>())),
                };
            } catch (caught) {
                if (!(caught instanceof CertificateError)) throw caught;
                error = caught.message;
            }
        }
        return {
            config, error, preview, showIdentity,
            snapshots: snapshots.map((snapshot) => ({ ...snapshotOption(snapshot), final: snapshot.final })),
            issued: docs.map((doc) => ({
                code: doc._id, kind: doc.kind, teamId: doc.teamId, name: doc.values.name, team: doc.values.team, school: doc.values.school, award: doc.values.award,
                status: doc.status, version: doc.version, replacedBy: doc.replacedBy ?? null, reason: doc.reason ?? null, issuedAt: doc.issuedAt, changedAt: doc.changedAt ?? null,
            })),
        };
    }

    async function issue(request: CertificateRequest): Promise<{ created: number; corrected: number; revoked: number; unchanged: number }> {
        const config = await readConfig(request);
        if (!config.locked) throw new CertificateError('请先核对并锁定制证信息表');
        const source = await readSource(request.scope, config.source);
        if (!settled(source)) throw new CertificateError('这份成绩快照不是最终成绩（有未完成的评测或仍在封榜中），请在最终成绩上拍快照后再出证');
        const entries = certificateEntries(boardOf(source, config.board), config);
        await finishPending(request.scope);
        const all = await issued.find(request.scope).toArray();
        if (all.some((doc) => doc.status === 'pending')) return issue(request);
        const versions = new Map<string, number>();
        for (const doc of all) versions.set(doc.key, Math.max(versions.get(doc.key) ?? 0, doc.version));
        const plan = planIssue(entries, all.filter((doc) => doc.status === 'valid').map((doc) => ({ code: doc._id, key: doc.key, fingerprint: doc.fingerprint })));
        const accounts = await dependencies.accounts(request.scope);
        const now = new Date();
        const counts = { created: 0, corrected: 0, revoked: 0, unchanged: plan.unchanged };
        const create = async (entry: typeof entries[number], previous?: string) => {
            const version = (versions.get(entry.key) ?? 0) + 1;
            const digest = fingerprint(entry);
            for (let attempt = 0; attempt < 5; attempt++) {
                const code = certificateCode();
                const doc: IssuedDoc = {
                    _id: code, ...request.scope, key: entry.key, kind: entry.kind, awardId: entry.awardId, teamId: entry.teamId,
                    uids: accounts.get(entry.teamId) || [], values: { ...entry.values, number: code }, fingerprint: digest,
                    version, status: previous ? 'pending' : 'valid', ...(previous ? { previous } : {}),
                    source: config.source, issuedAt: now, issuedBy: request.uid,
                };
                try {
                    await issued.insertOne(doc);
                } catch (error) {
                    if ((error as { code?: number }).code !== 11000) throw error;
                    const winner = await issued.findOne({ ...request.scope, key: entry.key, version });
                    if (!winner) continue; // Random number collision with a different certificate.
                    if (winner.fingerprint !== digest || winner.previous !== previous || !['valid', 'pending'].includes(winner.status)) {
                        throw new CertificateError('另一位裁判已更改这张证书，请重新出证');
                    }
                    await finishCorrection(winner);
                    counts.unchanged++;
                    return;
                }
                await finishCorrection(doc);
                if (previous) counts.corrected++;
                else counts.created++;
                return;
            }
            throw new CertificateError('证书编号生成失败，请重试');
        };
        for (const entry of plan.create) await create(entry);
        for (const { previous, entry } of plan.correct) await create(entry, previous);
        for (const code of plan.revoke) {
            const result = await issued.updateOne({ _id: code, status: 'valid' }, { $set: { status: 'revoked', reason: '获奖情况已变化', changedAt: now } });
            counts.revoked += result.matchedCount;
        }
        return counts;
    }

    /** `post<Operation>` of the certificates page. */
    async function operate(request: CertificateRequest, operation: string, payload: Record<string, unknown>) {
        if (operation === 'issue') return issue(request);
        const config = await readConfig(request);
        if (operation === 'config') {
            const next = normalizeConfig(payload, config);
            // A different source or board gives other certificates: the sheet must be checked again.
            if (next.source !== config.source || next.board !== config.board) next.locked = false;
            await writeConfig(request, next);
            return { ok: true };
        }
        if (operation === 'team' || operation === 'upload') {
            if (config.locked) throw new CertificateError('信息表已锁定，请先解除锁定再修改');
            if (operation === 'team') {
                const teamId = String(payload.teamId ?? '');
                if (!/^-?\d{1,16}$/.test(teamId)) throw new CertificateError('队伍无效');
                config.sheet = { ...config.sheet, [teamId]: normalizeOverride(payload.override ?? {}) };
                await writeConfig(request, config);
                return { ok: true };
            }
            if (typeof payload.csv !== 'string' || payload.csv.length > 4_000_000) throw new CertificateError('信息表文件无效或过大');
            const result = boardOf(await readSource(request.scope, config.source), config.board);
            const { overrides, updated, unknown } = overridesFromCsv(payload.csv, result, config.sheet);
            config.sheet = overrides;
            await writeConfig(request, config);
            return { updated, unknown };
        }
        if (operation === 'background') {
            const which = payload.template === 'participation' ? 'participation' : 'award';
            let id: string | null = null;
            if (payload.data !== null) {
                if (typeof payload.data !== 'string' || payload.data.length > MAX_IMAGE * 1.4) throw new CertificateError('背景图片最大 6 MB');
                const image = Buffer.from(payload.data, 'base64');
                const parsed = parseImage(image);
                id = randomBytes(12).toString('hex');
                await assets.insertOne({ _id: id, ...request.scope, data: image, type: parsed.filter === 'DCTDecode' ? 'image/jpeg' : 'image/png', createdAt: new Date() });
            }
            const previous = config.templates[which].background;
            config.templates = { ...config.templates, [which]: { ...config.templates[which], background: id } };
            await writeConfig(request, config);
            const other = which === 'award' ? config.templates.participation.background : config.templates.award.background;
            if (previous && previous !== other) await assets.deleteOne({ _id: previous, ...request.scope });
            return { id };
        }
        if (operation === 'snapshot') {
            const label = typeof payload.label === 'string' ? payload.label.trim().slice(0, 80) : '';
            const id = await dependencies.snapshot(request.scope, label || '出证', request.uid);
            await writeConfig(request, { ...config, source: id, locked: false });
            return { id };
        }
        throw new CertificateError('未知的操作');
    }

    async function file(request: CertificateRequest, format: string, query: { code?: string; school?: string; kind?: string; template?: string }): Promise<CertificateFile> {
        const config = await readConfig(request);
        const title = safeName(request.title);
        if (format === 'sheet') {
            const result = boardOf(await readSource(request.scope, config.source), config.board);
            return { data: Buffer.from(resultsCsv(sheetRows(sheetOf(result, config.sheet)))), type: 'text/csv; charset=utf-8', name: `${title}-制证信息表.csv`, inline: false };
        }
        if (format === 'sample') {
            const kind: CertificateKind = query.template === 'participation' ? 'participation' : (query.kind === 'team' || query.kind === 'coach' ? query.kind : 'member');
            let values = Object.fromEntries(Object.entries(placeholders).map(([key, label]) => [key, `〔${label}〕`])) as Record<Placeholder, string>;
            if (config.source) {
                try {
                    const all = { ...config, kinds: { team: true, member: true, coach: true, participation: true } };
                    const entry = certificateEntries(boardOf(await readSource(request.scope, config.source), config.board), all).find((item) => item.kind === kind);
                    if (entry) values = entry.values;
                } catch (error) {
                    if (!(error instanceof CertificateError)) throw error;
                }
            }
            const doc = { _id: 'SAMPLE0000', kind, values: { ...values, number: 'SAMPLE0000' } };
            return { data: buildPdf(await pages(request, config, [doc]), '证书样张'), type: 'application/pdf', name: `${title}-证书样张.pdf`, inline: true };
        }
        await finishPending(request.scope);
        const filter: Record<string, unknown> = { ...request.scope };
        if (query.code) filter._id = query.code; else filter.status = 'valid';
        if (query.kind && Object.hasOwn(kindNames, query.kind)) filter.kind = query.kind;
        let docs = await issued.find(filter).sort({ issuedAt: 1 }).toArray();
        if (query.school) docs = docs.filter((doc) => doc.values.school === query.school);
        if (!docs.length) throw new CertificateError(query.code ? '没有这张证书' : '没有可下载的证书，请先出证', 404);
        const suffix = query.school ? `-${safeName(query.school)}` : '';
        if (format === 'pdf') {
            return { data: buildPdf(await pages(request, config, docs), request.title), type: 'application/pdf',
                name: query.code ? fileName(docs[0]) : `${title}${suffix}-证书.pdf`, inline: !!query.code };
        }
        if (format === 'zip') {
            const rendered = await pages(request, config, docs);
            const entries = docs.map((doc, index) => ({ name: `${safeName(doc.values.school || '未填写学校')}/${fileName(doc)}`, data: buildPdf([rendered[index]], `${doc.values.name} ${doc.values.award}`) }));
            return { data: writeZip(entries), type: 'application/zip', name: `${title}${suffix}-证书.zip`, inline: false };
        }
        throw new CertificateError('未知的下载格式', 404);
    }

    async function asset(scope: SnapshotScope, id: string) {
        const doc = /^[a-f0-9]{24}$/.test(id) ? await assets.findOne({ _id: id, ...scope }) : null;
        if (!doc) throw new CertificateError('背景图片不存在', 404);
        return { data: bytes(doc.data), type: doc.type };
    }

    /** A participant's certificates, or one of them as a PDF. */
    async function mine(request: CertificateRequest, code = '') {
        await finishPending(request.scope);
        const docs = await issued.find({ ...request.scope, status: 'valid', uids: request.uid }).sort({ issuedAt: 1 }).toArray();
        if (!code) return { list: docs.map((doc) => ({ code: doc._id, kind: kindNames[doc.kind], name: doc.values.name, award: doc.values.award || kindNames[doc.kind], team: doc.values.team })) };
        const doc = docs.find((item) => item._id === code);
        if (!doc) throw new CertificateError('这不是你的证书', 403);
        const config = await readConfig(request);
        return { file: { data: buildPdf(await pages(request, config, [doc]), doc.values.name), type: 'application/pdf', name: fileName(doc), inline: true } as CertificateFile };
    }

    /** What the verification page shows of a certificate; the school only where the contest shows schools. */
    async function verify(domainId: string, code: string) {
        const normalized = code.trim().toUpperCase();
        let doc = /^[2-9A-HJ-NP-Z]{10}$/.test(normalized) ? await issued.findOne({ _id: normalized, domainId }) : null;
        if (doc?.status === 'pending') {
            await finishCorrection(doc);
            doc = await issued.findOne({ _id: normalized, domainId });
        }
        if (!doc) return { code: normalized, found: false, certificate: null };
        const showSchool = await dependencies.showIdentity({ domainId: doc.domainId, contestId: doc.contestId }).catch(() => false);
        return {
            code: normalized, found: true,
            certificate: {
                status: doc.status, kind: kindNames[doc.kind], name: doc.values.name, nameEn: doc.values.nameEn, award: doc.values.award,
                contest: doc.values.contest, team: doc.values.team, school: showSchool ? doc.values.school : '', issuedAt: doc.issuedAt,
                version: doc.version, replacedBy: doc.replacedBy ?? null, reason: doc.reason ?? null,
            },
        };
    }

    return { ensureIndexes, readConfig, data, operate, file, asset, mine, verify };
}
