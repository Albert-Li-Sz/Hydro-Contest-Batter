import { randomBytes } from 'node:crypto';
import type { Context } from 'hydrooj';
import { decodePoster } from './screens-data';
import { ResolverError } from './resolver-data';

interface Photo {
    _id: string;
    contestKey: string;
    uid: string;
    mime: string;
    data: Buffer;
    width: number;
    height: number;
    updatedAt: Date;
    updatedBy: number;
    staged?: boolean;
    predecessor?: string;
    replacement?: string;
}
declare module 'hydrooj' { interface Collections { 'xcpcio.resolver.photos': Photo } }

export const photoUrl = (base: string, id: string) => `${base}/photos/${id}.jpg`;

/** Dimensions of a browser-encoded JPEG or WebP. Never trust the dimensions in the request. */
export function decodeTeamPhoto(image: string) {
    let file;
    try { file = decodePoster(image, 1024 ** 2); } catch (error) { throw new ResolverError((error as Error).message); }
    const { data, mime } = file;
    let width = 0, height = 0;
    if (mime === 'image/jpeg') {
        for (let i = 2; i + 8 < data.length && data[i] === 0xff;) {
            const marker = data[i + 1], size = data.readUInt16BE(i + 2);
            if (marker === 0xda || size < 2 || i + 2 + size > data.length) break;
            if ([0xc0, 0xc1, 0xc2].includes(marker) && size >= 8) {
                height = data.readUInt16BE(i + 5); width = data.readUInt16BE(i + 7); break;
            }
            i += size + 2;
        }
    } else if (mime === 'image/webp' && data.length >= 30) {
        const format = data.toString('ascii', 12, 16);
        if (format === 'VP8X') {
            width = 1 + data.readUIntLE(24, 3); height = 1 + data.readUIntLE(27, 3);
        } else if (format === 'VP8 ') {
            width = data.readUInt16LE(26) & 0x3fff; height = data.readUInt16LE(28) & 0x3fff;
        } else if (format === 'VP8L' && data[20] === 0x2f) {
            const bits = data.readUInt32LE(21);
            width = 1 + (bits & 0x3fff); height = 1 + ((bits >>> 14) & 0x3fff);
        }
    }
    if (!width || !height || Math.max(width, height) > 1600) throw new ResolverError('请选择长边不超过 1600 像素的 JPEG 或 WebP 照片');
    return { ...file, width, height };
}

export class ResolverPhotos {
    private collection;
    private index?: Promise<string>;
    constructor(db: Context['db']) { this.collection = db.collection('xcpcio.resolver.photos'); }
    ensureIndexes() {
        return this.index ??= this.collection.createIndex({ contestKey: 1, uid: 1 }, { unique: true })
            .catch(error => { this.index = undefined; throw error; });
    }
    // MongoDB cannot update _id. Persist the new bytes first, then atomically retire the
    // old capability. Another Hydro process can finish the handoff after an interruption.
    private async finish(old: Pick<Photo, '_id' | 'contestKey' | 'uid' | 'replacement'>) {
        const uid = old.uid.slice('retired:'.length);
        if (!old.replacement) return;
        const draft = { _id: old.replacement, contestKey: old.contestKey, staged: true };
        try { await this.collection.updateOne(draft, { $set: { uid }, $unset: { staged: '', predecessor: '' } }); }
        catch (error) {
            if ((error as { code?: number }).code !== 11000) throw error;
            // A concurrent new upload already owns the team slot.
            await this.collection.deleteOne(draft);
        }
        await this.collection.deleteOne({ _id: old._id, replacement: old.replacement });
    }
    private async publish(draft: Pick<Photo, '_id' | 'contestKey' | 'uid' | 'predecessor'>) {
        const { contestKey, predecessor } = draft;
        if (!predecessor) return false;
        const uid = draft.uid.slice('draft:'.length);
        const retired = { _id: predecessor, contestKey, uid: 'retired:' + uid, replacement: draft._id };
        const change = await this.collection.updateOne({ _id: predecessor, contestKey, uid },
            { $set: { uid: retired.uid, replacement: draft._id } });
        if (change.matchedCount || await this.collection.findOne(retired, { projection: { _id: 1 } })) {
            await this.finish(retired);
            return true;
        }
        // A helper may already have finished, or a concurrent delete superseded this draft.
        await this.collection.deleteOne({ _id: draft._id, staged: true });
        return !!await this.collection.findOne({ _id: draft._id, uid }, { projection: { _id: 1 } });
    }
    private async settle(contestKey: string, uid?: string) {
        const pending = await this.collection.find({ contestKey, replacement: { $exists: true },
            ...(uid === undefined ? {} : { uid: 'retired:' + uid }) }, { projection: { uid: 1, contestKey: 1, replacement: 1 } }).toArray();
        for (const old of pending) await this.finish(old);
        const drafts = await this.collection.find({ contestKey, staged: true,
            ...(uid === undefined ? {} : { uid: 'draft:' + uid }) }, { projection: { uid: 1, contestKey: 1, predecessor: 1 } }).toArray();
        for (const draft of drafts) await this.publish(draft);
    }
    private active(contestKey: string) {
        return { contestKey, staged: { $exists: false }, replacement: { $exists: false } };
    }
    async urls(contestKey: string, base: string) {
        await this.settle(contestKey);
        const rows = await this.collection.find(this.active(contestKey), { projection: { uid: 1 } }).toArray();
        return Object.fromEntries(rows.map(row => [row.uid, photoUrl(base, row._id)])) as Record<string, string>;
    }
    exists(contestKey: string, id: string) {
        return this.collection.findOne({ ...this.active(contestKey), _id: id }, { projection: { _id: 1 } });
    }
    get(contestKey: string, id: string) { return this.collection.findOne({ ...this.active(contestKey), _id: id }); }
    remove(contestKey: string | RegExp) { return this.collection.deleteMany({ contestKey }); }
    async delete(contestKey: string, uid: string) {
        await this.settle(contestKey, uid);
        return this.collection.deleteOne({ contestKey, uid });
    }
    async status(contestKey: string) {
        await this.settle(contestKey);
        const active = this.active(contestKey);
        const [count, newest] = await Promise.all([this.collection.countDocuments(active),
            this.collection.findOne(active, { sort: { updatedAt: -1 }, projection: { updatedAt: 1 } })]);
        return { count, issuedAt: newest?.updatedAt ?? null };
    }
    async put(contestKey: string, uid: string, image: string, updatedBy: number) {
        const file = decodeTeamPhoto(image);
        await this.ensureIndexes();
        await this.settle(contestKey, uid);
        const previous = await this.collection.findOne({ contestKey, uid }, { projection: { _id: 1 } });
        return this.replace({ ...file, contestKey, uid, updatedBy }, previous?._id);
    }
    private async replace(fields: Omit<Photo, '_id' | 'updatedAt'>, previous?: string) {
        const { contestKey, uid } = fields;
        const doc = { ...fields, _id: randomBytes(16).toString('hex'), updatedAt: new Date() };
        const conflict = () => new ResolverError('照片已更换，请刷新后重试', 409);
        const draft = previous ? { ...doc, uid: 'draft:' + uid, staged: true, predecessor: previous } : doc;
        try { await this.collection.insertOne(draft); }
        catch (error) { if ((error as { code?: number }).code === 11000) throw conflict(); throw error; }
        if (previous && !await this.publish(draft)) throw conflict();
        return doc._id;
    }
    async rotate(contestKey: string) {
        await this.ensureIndexes();
        await this.settle(contestKey);
        const ids = await this.collection.find(this.active(contestKey), { projection: { _id: 1 } }).toArray();
        let count = 0;
        for (const { _id } of ids) {
            const old = await this.get(contestKey, _id);
            if (old) { await this.replace(old, old._id); count++; }
        }
        return count;
    }
}
