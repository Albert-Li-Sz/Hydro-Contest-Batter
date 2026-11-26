/**
 * 证书 storage and operations, shared by the Hydro routes (lib/certificates/routes.ts) and the local preview.
 * Certificates are issued from one results snapshot; each keeps the values it was issued with, so a later
 * change of the results or the sheet reaches a certificate only through a new issue, which replaces it.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Context } from 'hydrooj';
import { writeZip } from '../ccs/zip';
import { boardOptions, resultBoard, resultsCsv, settled, type ResultsData } from '../results';
import { snapshotOption } from '../results-page';
import { ResultsStore, type SnapshotScope } from '../results-store';
import {
    certificateCode, certificateEntries, certificateSheet, competitionTemplate, defaultConfig, fingerprint, freezeEnglish, kindNames, missingFields, normalizeConfig, normalizeOverride,
    overridesFromCsv, placeholders, planIssue, restoreTextColors, safeName, sheetOf, sheetRows, templateFor, type CertificateConfig, type CertificateKind, type Placeholder,
} from './model';
import { buildPdf, parseImage, type PdfImage } from './pdf';
import { certificatePage } from './render';
import type { DecorationPlacement } from '../../resolver/public/js/certificate-frame.js';
import { eventSignatures, isEventDesign, type EventDesign } from '../../resolver/public/js/certificate-event.js';
import { isInkColor } from '../../resolver/public/js/certificate-colors.js';

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
type TemplateKind = 'award' | 'participation';
type EmblemMode = 'icpc' | 'custom' | 'none';
interface AssetDoc {
    _id: string; domainId: string; contestId: string; data: Buffer; type: string; createdAt: Date; slot?: 0 | 1; label?: string;
    decoration?: TemplateKind; placement?: DecorationPlacement; revision?: number;
    signatureSlot?: number; signatureDesign?: 'event-zh'; signatureInk?: Buffer; signer?: string; role?: string; captionColor?: string | null; hidden?: boolean;
    emblemMode?: EmblemMode;
}
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
const MAX_DECORATIONS_PER_TEMPLATE = 20;
const MAX_IMAGE_CACHE = 64;
const yieldLoop = () => new Promise<void>((resolve) => setImmediate(resolve));
const configId = (scope: SnapshotScope) => `${scope.domainId}/${scope.contestId}`;
const bytes = (data: unknown): Buffer => {
    if (Buffer.isBuffer(data)) return data;
    if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    const { buffer, position } = data as { buffer: Uint8Array | ArrayBuffer; position?: number };
    const raw = ArrayBuffer.isView(buffer) ? Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength) : Buffer.from(buffer);
    return raw.subarray(0, position ?? raw.length);
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

    const parsedImages = new Map<string, PdfImage>();
    function cachedImage(doc: Pick<AssetDoc, '_id' | 'data' | 'revision' | 'createdAt'>, preserveAlpha: boolean): PdfImage {
        const stamp = doc.revision ?? (doc.createdAt ? new Date(doc.createdAt).getTime() : 0);
        const key = `${doc._id}:${stamp}:${preserveAlpha ? 1 : 0}`;
        const hit = parsedImages.get(key);
        if (hit) {
            parsedImages.delete(key);
            parsedImages.set(key, hit);
            return hit;
        }
        const parsed = parseImage(bytes(doc.data), preserveAlpha);
        if (parsedImages.size >= MAX_IMAGE_CACHE) parsedImages.delete(parsedImages.keys().next().value!);
        parsedImages.set(key, parsed);
        return parsed;
    }

    async function readConfigDoc(request: Pick<CertificateRequest, 'scope' | 'title'>) {
        const doc = await configs.findOne({ _id: configId(request.scope) });
        const fallback = defaultConfig(request.title);
        if (!doc) return { doc: null as ConfigDoc | null, config: fallback };
        const { _id, domainId: _domain, contestId: _contest, updatedAt: _at, updatedBy: _by, ...saved } = doc;
        const templates = { ...fallback.templates, ...saved.templates };
        return {
            doc,
            config: {
                ...fallback, ...saved, kinds: { ...fallback.kinds, ...saved.kinds }, templates: {
                    award: restoreTextColors(templates.award, 'award'), participation: restoreTextColors(templates.participation, 'participation'),
                }, sheet: saved.sheet || {},
            },
        };
    }
    async function readConfig(request: Pick<CertificateRequest, 'scope' | 'title'>): Promise<CertificateConfig> {
        return (await readConfigDoc(request)).config;
    }
    async function writeConfig(request: CertificateRequest, config: CertificateConfig, expectedUpdatedAt?: Date | null) {
        const _id = configId(request.scope);
        const now = new Date();
        if (expectedUpdatedAt === undefined) {
            await configs.updateOne({ _id }, { $set: { ...config, ...request.scope, updatedAt: now, updatedBy: request.uid } }, { upsert: true });
            return true;
        }
        if (expectedUpdatedAt === null) {
            try {
                await configs.insertOne({ _id, ...config, ...request.scope, updatedAt: now, updatedBy: request.uid });
                return true;
            } catch (error) {
                if ((error as { code?: number }).code === 11000) return false;
                throw error;
            }
        }
        const res = await configs.updateOne({ _id, updatedAt: expectedUpdatedAt }, { $set: { ...config, ...request.scope, updatedAt: now, updatedBy: request.uid } });
        return res.matchedCount > 0;
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
            const doc = await assets.findOne({ _id: id, ...scope, slot: { $exists: false }, decoration: { $exists: false }, signatureSlot: { $exists: false }, emblemMode: { $exists: false } });
            cache.set(id, doc ? cachedImage(doc, false) : null);
        }
        return cache.get(id)!;
    }
    const logoFilter = (scope: SnapshotScope) => ({ ...scope, slot: { $in: [0, 1] as (0 | 1)[] } });
    const recommended = {
        landscape: { award: competitionTemplate('award', 'landscape'), participation: competitionTemplate('participation', 'landscape') },
        portrait: { award: competitionTemplate('award', 'portrait'), participation: competitionTemplate('participation', 'portrait') },
    };
    function uploadedImage(data: unknown) {
        if (typeof data !== 'string' || !data || data.length > Math.ceil(MAX_IMAGE / 3) * 4) throw new CertificateError('请上传 6 MB 以内的 PNG 或 JPEG 图片');
        const raw = Buffer.from(data, 'base64');
        if (raw.length > MAX_IMAGE) throw new CertificateError('图片最大 6 MB');
        let parsed: PdfImage;
        try { parsed = parseImage(raw); } catch (error) { throw new CertificateError((error as Error).message); }
        return { data: raw, type: parsed.filter === 'DCTDecode' ? 'image/jpeg' : 'image/png', aspect: parsed.width / parsed.height };
    }
    const decorationInfo = (doc: AssetDoc) => ({ id: doc._id, template: doc.decoration!, label: doc.label || '装饰图片', revision: doc.revision!, ...doc.placement! });
    const emblemFilter = (scope: SnapshotScope) => ({ ...scope, _id: createHash('sha256')
        .update(JSON.stringify(['certificate-emblem', scope.domainId, scope.contestId])).digest('hex').slice(0, 24) });
    const emblemInfo = (doc: AssetDoc | null) => ({ mode: doc?.emblemMode ?? 'icpc', id: doc?.label ? doc._id : null,
        label: doc?.label || '', revision: doc?.revision ?? 0 });
    async function editEmblem(scope: SnapshotScope, input: Record<string, unknown>) {
        const mode = input.mode;
        if (mode !== 'icpc' && mode !== 'custom' && mode !== 'none') throw new CertificateError('左侧标识类型无效');
        const filter = emblemFilter(scope);
        const old = await assets.findOne(filter, { projection: { data: 0 } });
        const revision = input.revision ?? 0;
        const conflict = () => new CertificateError('左侧标识已被修改，请刷新后重试', 409);
        if (revision !== (old?.revision ?? 0)) throw conflict();
        if (input.data !== undefined && mode !== 'custom') throw new CertificateError('请选择自定义标识再上传图片');
        const image = input.data === undefined ? null : uploadedImage(input.data);
        if (mode === 'custom' && !image && !old?.label) throw new CertificateError('请先选择学校校徽或上传标识');
        if (!image && mode === (old?.emblemMode ?? 'icpc')) return emblemInfo(old);
        const changes = { emblemMode: mode as EmblemMode, revision: (old?.revision ?? 0) + 1, createdAt: new Date(),
            ...(image ? { data: image.data, type: image.type, label: String(input.label || '自定义标识').trim().slice(0, 100) || '自定义标识' } : {}) };
        if (old) {
            if (!(await assets.updateOne({ ...filter, revision: old.revision }, { $set: changes })).matchedCount) throw conflict();
            return emblemInfo({ ...old, ...changes });
        }
        const doc = { ...filter, data: Buffer.alloc(0), type: 'image/png', ...changes };
        try { await assets.insertOne(doc); } catch (error) {
            if ((error as { code?: number }).code === 11000) throw conflict();
            throw error;
        }
        return emblemInfo(doc);
    }
    const signatureInfo = (doc: AssetDoc) => ({ id: doc._id, slot: doc.signatureSlot!, design: doc.signatureDesign ?? 'event' as const,
        name: doc.signer || '', role: doc.role || '', captionColor: doc.captionColor ?? null, hidden: !!doc.hidden, revision: doc.revision! });
    async function editSignature(scope: SnapshotScope, input: Record<string, unknown>) {
        const slot = input.slot;
        if (typeof slot !== 'number' || !Number.isInteger(slot) || !eventSignatures[slot]) throw new CertificateError('请选择左、中、右三个签名位之一');
        const revision = input.revision ?? 0;
        if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 0) throw new CertificateError('签名版本无效');
        const design = input.design ?? 'event';
        if (!isEventDesign(design)) throw new CertificateError('请选择赛事模板');
        const key = ['certificate-signature', scope.domainId, scope.contestId, slot];
        if (design === 'event-zh') key.push(design);
        const id = createHash('sha256').update(JSON.stringify(key)).digest('hex').slice(0, 24);
        const filter = { _id: id, ...scope, signatureSlot: slot, ...(design === 'event-zh' ? { signatureDesign: design } : {}) };
        const conflict = () => new CertificateError('这个签名已被修改，请刷新后重试', 409);
        if (input.action === 'reset') {
            if (!revision || !(await assets.deleteOne({ ...filter, revision })).deletedCount) {
                if (await assets.findOne(filter, { projection: { _id: 1 } })) throw conflict();
            }
            return { slot };
        }
        if (input.action !== 'save' && input.action !== 'clear') throw new CertificateError('签名操作无效');
        const hidden = input.action === 'clear';
        if (!hidden && input.captionColor !== undefined && !isInkColor(input.captionColor)) throw new CertificateError('署名颜色应为六位十六进制 RGB 色值');
        const caption = (value: unknown) => {
            if (typeof value !== 'string' || value.length > 120 || /[\r\n]/.test(value)) throw new CertificateError('每行署名最多 120 个字符');
            return value.trim();
        };
        const png = (value: unknown) => {
            const image = uploadedImage(value);
            if (image.type !== 'image/png') throw new CertificateError('请使用生成的 PNG 签名图片');
            return image.data;
        };
        const data = hidden ? Buffer.alloc(0) : png(input.data);
        const signatureInk = hidden ? Buffer.alloc(0) : png(input.ink);
        const changes = { data, type: 'image/png', signatureInk, hidden, signer: hidden ? '' : caption(input.name), role: hidden ? '' : caption(input.role),
            captionColor: !hidden && isInkColor(input.captionColor) ? input.captionColor.toLowerCase() : null,
            revision: Math.max(Date.now(), revision + 1), createdAt: new Date() };
        if (revision) {
            if (!(await assets.updateOne({ ...filter, revision }, { $set: changes })).matchedCount) throw conflict();
        } else {
            try { await assets.insertOne({ ...filter, ...changes }); } catch (error) {
                if ((error as { code?: number }).code === 11000) throw conflict();
                throw error;
            }
        }
        return signatureInfo({ ...filter, ...changes });
    }
    async function editDecoration(scope: SnapshotScope, input: Record<string, unknown>) {
        if (input.template !== 'award' && input.template !== 'participation') throw new CertificateError('请选择证书模板');
        if (typeof input.id !== 'string' || !/^[a-f0-9]{24}$/.test(input.id)) throw new CertificateError('装饰图片编号无效');
        const filter = { _id: input.id, ...scope, decoration: input.template as TemplateKind };
        if (input.action === 'add') {
            const existingCount = await assets.countDocuments({ ...scope, decoration: input.template as TemplateKind });
            if (existingCount >= MAX_DECORATIONS_PER_TEMPLATE) throw new CertificateError(`每个模板最多添加 ${MAX_DECORATIONS_PER_TEMPLATE} 张装饰图片`);
            const { data, type, aspect } = uploadedImage(input.data);
            const label = typeof input.label === 'string' ? input.label.trim().slice(0, 100) : '';
            const placement = { x: .42, y: .42, width: Math.min(.18, .15 * aspect), aspect };
            const doc: AssetDoc = { ...filter, data, type, createdAt: new Date(), label, placement, revision: 1 };
            try { await assets.insertOne(doc); } catch (error) {
                if ((error as { code?: number }).code !== 11000) throw error;
                const existing = await assets.findOne(filter);
                if (existing && bytes(existing.data).equals(data)) return decorationInfo(existing);
                throw new CertificateError('图片编号已经使用，请重新添加');
            }
            return decorationInfo(doc);
        }
        if (!Number.isSafeInteger(input.revision)) throw new CertificateError('装饰图片版本无效');
        const checked = { ...filter, revision: input.revision as number };
        if (input.action === 'remove') {
            if ((await assets.deleteOne(checked)).deletedCount || !await assets.findOne(filter, { projection: { _id: 1 } })) return { ok: true };
        } else if (input.action === 'move') {
            const { x, y, width } = input;
            const fraction = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1;
            if (!fraction(x) || !fraction(y) || !fraction(width) || width === 0) throw new CertificateError('图片位置或宽度超出纸面');
            if ((await assets.updateOne(checked, { $set: { 'placement.x': x, 'placement.y': y, 'placement.width': width }, $inc: { revision: 1 } })).matchedCount) {
                return { revision: checked.revision + 1 };
            }
        } else throw new CertificateError('未知的图片操作');
        throw new CertificateError('装饰图片已被修改，请刷新后重试', 409);
    }
    async function pages(request: CertificateRequest, config: CertificateConfig, docs: Pick<IssuedDoc, '_id' | 'kind' | 'values'>[]) {
        const cache = new Map<string, PdfImage | null>();
        const kinds = [...new Set(docs.map((doc): TemplateKind => doc.kind === 'participation' ? 'participation' : 'award'))];
        const designs = kinds.map((kind) => config.templates[kind].frame);
        const [logoDocs, artwork, signatureDocs, emblemDoc] = await Promise.all([assets.find(logoFilter(request.scope)).toArray(),
            assets.find({ ...request.scope, decoration: { $in: kinds } }).sort({ createdAt: 1, _id: 1 }).toArray(),
            designs.some(isEventDesign)
                ? assets.find({ ...request.scope, signatureSlot: { $exists: true } }, { projection: { signatureInk: 0 } }).toArray() : [],
            designs.includes('event-zh') ? assets.findOne(emblemFilter(request.scope)) : null]);
        const signatures: Record<EventDesign, Map<number, PdfImage | null>> = { event: new Map(), 'event-zh': new Map() };
        for (const doc of signatureDocs) {
            const design = doc.signatureDesign ?? 'event';
            if (designs.includes(design)) signatures[design].set(doc.signatureSlot!, doc.hidden ? null : cachedImage(doc, true));
        }
        const emblem = emblemDoc?.emblemMode === 'custom' ? cachedImage(emblemDoc, true) : emblemDoc?.emblemMode ?? 'icpc';
        const logos = logoDocs.map((doc) => ({ slot: doc.slot!, image: cachedImage(doc, true) }));
        const decorations = artwork.map((doc) => ({ template: doc.decoration, ...doc.placement!, image: cachedImage(doc, true) }));
        const result = [];
        for (let i = 0; i < docs.length; i++) {
            const doc = docs[i];
            const template = templateFor(config, doc.kind);
            result.push(certificatePage(template, doc.kind, doc.values, verifyUrl(request.site, request.scope.domainId, doc._id),
                await background(request.scope, template.background, cache), logos, decorations.filter((d) => d.template === (doc.kind === 'participation' ? 'participation' : 'award')),
                isEventDesign(template.frame) ? signatures[template.frame] : undefined, emblem));
            if ((i + 1) % 20 === 0) await yieldLoop();
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
        const [config, snapshots, docs, showIdentity, logoDocs, artwork, signatureDocs, emblemDoc] = await Promise.all([
            readConfig(request), store.list(scope), issued.find(scope).sort({ issuedAt: 1 }).toArray(), dependencies.showIdentity(scope),
            assets.find(logoFilter(scope), { projection: { data: 0 } }).sort({ slot: 1 }).toArray(),
            assets.find({ ...scope, decoration: { $exists: true } }, { projection: { data: 0 } }).sort({ createdAt: 1, _id: 1 }).toArray(),
            assets.find({ ...scope, signatureSlot: { $exists: true } }, { projection: { data: 0, signatureInk: 0 } }).sort({ signatureSlot: 1 }).toArray(),
            assets.findOne(emblemFilter(scope), { projection: { data: 0 } }),
        ]);
        let preview: unknown = null;
        let error = '';
        if (config.source) {
            try {
                const source = await readSource(scope, config.source);
                const result = boardOf(source, config.board);
                const sheet = certificateSheet(result, config);
                const entries = certificateEntries(result, config, sheet);
                const current = new Map(docs.filter((doc) => doc.status === 'valid').map((doc) => [doc.key, doc]));
                const official = new Set(result.rows.filter((row) => row.rank).map((row) => row.id));
                preview = {
                    final: settled(source), boards: boardOptions(source),
                    awards: result.awards.filter((award) => award.teamIds.length).map((award) => ({ id: award.id, name: award.name, kind: award.kind, teams: award.teamIds.length })),
                    sheet: sheet.map((team) => ({ ...team, official: official.has(team.teamId) })),
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
                    samples: Object.fromEntries(certificateEntries(result, { ...config, kinds: { team: true, member: true, coach: true, participation: true } }, sheet)
                        .reduce((found, entry) => (found.has(entry.kind) ? found : found.set(entry.kind, entry.values)), new Map<string, Record<string, string>>())),
                };
            } catch (caught) {
                if (!(caught instanceof CertificateError)) throw caught;
                error = caught.message;
            }
        }
        const { lockedEnglish: _frozen, ...settings } = config;
        return {
            config: settings, error, preview, showIdentity, recommended,
            decorations: artwork.map(decorationInfo),
            signatures: signatureDocs.map(signatureInfo),
            eventEmblem: emblemInfo(emblemDoc),
            logos: logoDocs.map((doc) => ({ id: doc._id, slot: doc.slot!, label: doc.label || '学校校徽', revision: doc.createdAt.getTime() })),
            snapshots: snapshots.map((snapshot) => ({ ...snapshotOption(snapshot), final: snapshot.final })),
            issued: docs.map((doc) => ({
                code: doc._id, kind: doc.kind, teamId: doc.teamId, name: doc.values.name, team: doc.values.team, school: doc.values.school, award: doc.values.award,
                status: doc.status, version: doc.version, replacedBy: doc.replacedBy ?? null, reason: doc.reason ?? null, issuedAt: doc.issuedAt, changedAt: doc.changedAt ?? null,
            })),
        };
    }

    async function issue(request: CertificateRequest, attemptDepth = 0): Promise<{ created: number; corrected: number; revoked: number; unchanged: number }> {
        const config = await readConfig(request);
        if (!config.locked) throw new CertificateError('请先核对并锁定制证信息表');
        const source = await readSource(request.scope, config.source);
        if (!settled(source)) throw new CertificateError('这份成绩快照不是最终成绩（有未完成的评测或仍在封榜中），请在最终成绩上拍快照后再出证');
        const entries = certificateEntries(boardOf(source, config.board), config);
        await finishPending(request.scope);
        const all = await issued.find(request.scope).toArray();
        if (all.some((doc) => doc.status === 'pending')) {
            if (attemptDepth >= 5) throw new CertificateError('另有出证任务正在进行，请稍后重试', 409);
            await new Promise((resolve) => setTimeout(resolve, 50 * (attemptDepth + 1)));
            return issue(request, attemptDepth + 1);
        }
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
        if (operation === 'decoration') return editDecoration(request.scope, payload);
        if (operation === 'signature') return editSignature(request.scope, payload);
        if (operation === 'emblem') return editEmblem(request.scope, payload);
        if (operation === 'logo') {
            const slot = payload.slot;
            if (slot !== 0 && slot !== 1) throw new CertificateError('每张证书最多两个校徽，请选择左侧或右侧');
            // Each slot has a stable, contest-scoped identity, so simultaneous uploads cannot create a third.
            const id = createHash('sha256').update(JSON.stringify(['certificate-logo', request.scope.domainId, request.scope.contestId, slot])).digest('hex').slice(0, 24);
            const filter = { _id: id, ...request.scope, slot: slot as 0 | 1 };
            if (payload.data === null) {
                await assets.deleteOne(filter);
                return { id: null };
            }
            const { data, type } = uploadedImage(payload.data);
            const label = typeof payload.label === 'string' ? payload.label.trim().slice(0, 100) : '';
            const createdAt = new Date();
            await assets.updateOne(filter, { $set: { data, type, label, createdAt } }, { upsert: true });
            return { id, slot, label: label || '学校校徽', revision: createdAt.getTime() };
        }
        if (operation === 'team') {
            const teamId = String(payload.teamId ?? '');
            if (!/^-?\d{1,16}$/.test(teamId)) throw new CertificateError('队伍无效');
            const override = normalizeOverride(payload.override ?? {});
            const _id = configId(request.scope);
            for (let attempt = 0; attempt < 3; attempt++) {
                const { doc, config } = await readConfigDoc(request);
                if (config.locked) throw new CertificateError('信息表已锁定，请先解除锁定再修改');
                if (!doc) {
                    config.sheet = { ...config.sheet, [teamId]: override };
                    if (await writeConfig(request, config, null)) return { ok: true };
                    continue;
                }
                const updated = await configs.updateOne(
                    { _id, locked: { $ne: true } },
                    { $set: { [`sheet.${teamId}`]: override, updatedAt: new Date(), updatedBy: request.uid } },
                );
                if (updated.matchedCount) return { ok: true };
            }
            throw new CertificateError('信息表已锁定，请先解除锁定再修改');
        }
        if (operation === 'config') {
            for (let attempt = 0; attempt < 3; attempt++) {
                const { doc, config } = await readConfigDoc(request);
                const next = normalizeConfig(payload, config);
                // A different source or board gives other certificates: the sheet must be checked again.
                if (next.source !== config.source || next.board !== config.board) next.locked = false;
                if (!next.locked) next.lockedEnglish = null;
                else if (!config.locked && next.source) {
                    const result = boardOf(await readSource(request.scope, next.source), next.board);
                    next.lockedEnglish = freezeEnglish(sheetOf(result, next.sheet));
                }
                if (await writeConfig(request, next, doc?.updatedAt ?? null)) return { ok: true };
            }
            throw new CertificateError('证书配置已被他人修改，请刷新后重试', 409);
        }
        if (operation === 'upload') {
            if (typeof payload.csv !== 'string' || payload.csv.length > 4_000_000) throw new CertificateError('信息表文件无效或过大');
            for (let attempt = 0; attempt < 3; attempt++) {
                const { doc, config } = await readConfigDoc(request);
                if (config.locked) throw new CertificateError('信息表已锁定，请先解除锁定再修改');
                const result = boardOf(await readSource(request.scope, config.source), config.board);
                const { overrides, updated, unknown } = overridesFromCsv(payload.csv, result, config.sheet);
                config.sheet = overrides;
                if (await writeConfig(request, config, doc?.updatedAt ?? null)) return { updated, unknown };
            }
            throw new CertificateError('信息表已被他人修改，请刷新后重试', 409);
        }
        if (operation === 'background') {
            const which = payload.template === 'participation' ? 'participation' : 'award';
            let id: string | null = null;
            if (payload.data !== null) {
                const { data, type } = uploadedImage(payload.data);
                id = randomBytes(12).toString('hex');
                await assets.insertOne({ _id: id, ...request.scope, data, type, createdAt: new Date() });
            }
            let previous: string | null = null;
            let other: string | null = null;
            let saved = false;
            for (let attempt = 0; attempt < 3; attempt++) {
                const { doc, config } = await readConfigDoc(request);
                previous = config.templates[which].background;
                other = which === 'award' ? config.templates.participation.background : config.templates.award.background;
                config.templates = { ...config.templates, [which]: { ...config.templates[which], background: id } };
                if (await writeConfig(request, config, doc?.updatedAt ?? null)) { saved = true; break; }
            }
            if (!saved) {
                if (id) await assets.deleteOne({ _id: id, ...request.scope }).catch(() => null);
                throw new CertificateError('证书配置已被他人修改，请刷新后重试', 409);
            }
            if (previous && previous !== other) await assets.deleteOne({ _id: previous, ...request.scope, slot: { $exists: false }, decoration: { $exists: false }, signatureSlot: { $exists: false }, emblemMode: { $exists: false } });
            return { id };
        }
        if (operation === 'snapshot') {
            const label = typeof payload.label === 'string' ? payload.label.trim().slice(0, 80) : '';
            const id = await dependencies.snapshot(request.scope, label || '出证', request.uid);
            for (let attempt = 0; attempt < 3; attempt++) {
                const { doc, config } = await readConfigDoc(request);
                if (await writeConfig(request, { ...config, source: id, locked: false, lockedEnglish: null }, doc?.updatedAt ?? null)) return { id };
            }
            throw new CertificateError('证书配置已被他人修改，请刷新后重试', 409);
        }
        throw new CertificateError('未知的操作');
    }

    async function file(request: CertificateRequest, format: string, query: { code?: string; school?: string; kind?: string; template?: string }): Promise<CertificateFile> {
        const config = await readConfig(request);
        const title = safeName(request.title);
        if (format === 'sheet') {
            const result = boardOf(await readSource(request.scope, config.source), config.board);
            return { data: Buffer.from(resultsCsv(sheetRows(certificateSheet(result, config)))), type: 'text/csv; charset=utf-8', name: `${title}-制证信息表.csv`, inline: false };
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
            const entries: { name: string; data: Buffer }[] = [];
            for (let index = 0; index < docs.length; index++) {
                const doc = docs[index];
                entries.push({ name: `${safeName(doc.values.school || '未填写学校')}/${fileName(doc)}`, data: buildPdf([rendered[index]], `${doc.values.name} ${doc.values.award}`) });
                if ((index + 1) % 10 === 0) await yieldLoop();
            }
            return { data: writeZip(entries), type: 'application/zip', name: `${title}${suffix}-证书.zip`, inline: false };
        }
        throw new CertificateError('未知的下载格式', 404);
    }

    async function asset(scope: SnapshotScope, id: string, part = '') {
        const doc = /^[a-f0-9]{24}$/.test(id) ? await assets.findOne({ _id: id, ...scope }) : null;
        if (!doc || doc.hidden || (doc.emblemMode && !doc.label) || (part && (part !== 'ink' || !doc.signatureInk))) throw new CertificateError('证书图片不存在', 404);
        return { data: bytes(part ? doc.signatureInk : doc.data), type: doc.type };
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
