import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import type { Context } from 'hydrooj';
import { settled, type ResultsData } from './results';

export type SnapshotReason = 'manual' | 'end' | 'unlock' | 'rejudge';
export interface SnapshotScope { domainId: string; contestId: string }
export interface SnapshotMeta {
    _id: string;
    reason: SnapshotReason;
    createdAt: Date;
    eventAt: Date;
    final: boolean;
    label?: string;
    operator?: number;
    jobId?: string;
}
interface SnapshotDoc extends SnapshotMeta, SnapshotScope {
    data?: string;
    dataKey?: string;
    blocks?: number;
}
interface SnapshotBlock extends SnapshotScope {
    _id: string;
    dataKey: string;
    sequence: number;
    data: string;
    createdAt: Date;
}
declare module 'hydrooj' {
    interface Collections {
        'xcpcio.results.snapshots': SnapshotDoc;
        'xcpcio.results.chunks': SnapshotBlock;
    }
}

const compress = promisify(gzip);
const decompress = promisify(gunzip);
// Base64 grows by 4/3. This leaves more than 3 MiB for metadata below Mongo's 16 MiB document limit.
const inlineBytes = 9 * 1024 * 1024;
const blockBytes = 3 * 1024 * 1024;

export const resultKey = (scope: SnapshotScope, id: string) => `${scope.domainId}/${scope.contestId}/${id}`;

export class ResultsStore {
    private snapshots;
    private chunks;

    constructor(db: Context['db']) {
        this.snapshots = db.collection('xcpcio.results.snapshots');
        this.chunks = db.collection('xcpcio.results.chunks');
    }

    async ensureIndexes() {
        await Promise.all([
            this.snapshots.createIndex({ domainId: 1, contestId: 1, createdAt: -1 }),
            this.snapshots.createIndex({ dataKey: 1 }, { sparse: true }),
            this.chunks.createIndex({ dataKey: 1, sequence: 1 }, { unique: true }),
            this.chunks.createIndex({ domainId: 1, contestId: 1 }),
            this.chunks.createIndex({ createdAt: 1 }),
        ]);
    }

    async list(scope: SnapshotScope): Promise<SnapshotMeta[]> {
        return this.snapshots.find(scope, { projection: { data: 0, dataKey: 0, blocks: 0 } }).sort({ createdAt: -1 }).toArray();
    }

    async existing(ids: string[]) {
        if (!ids.length) return new Set<string>();
        const found = await this.snapshots.find({ _id: { $in: ids } }, { projection: { _id: 1 } }).toArray();
        return new Set(found.map(({ _id }) => _id));
    }

    async read(scope: SnapshotScope, id: string) {
        const doc = await this.snapshots.findOne({ ...scope, _id: id });
        if (!doc) return null;
        let encoded: Buffer;
        if (doc.data) encoded = Buffer.from(doc.data, 'base64');
        else {
            const blocks = await this.chunks.find({ ...scope, dataKey: doc.dataKey }).sort({ sequence: 1 }).toArray();
            if (blocks.length !== doc.blocks || blocks.some((block, idx) => block.sequence !== idx)) throw new Error('成绩快照数据不完整');
            encoded = Buffer.concat(blocks.map((block) => Buffer.from(block.data, 'base64')));
        }
        return JSON.parse((await decompress(encoded)).toString()) as ResultsData;
    }

    /** Upload overflow blocks first. The metadata insert publishes one immutable generation. */
    async save(scope: SnapshotScope, meta: Omit<SnapshotMeta, 'createdAt' | 'final'>, read: () => Promise<ResultsData>) {
        if ((await this.existing([meta._id])).size) return;
        const source = await read();
        const createdAt = new Date(source.at);
        const doc: SnapshotDoc = { ...scope, ...meta, createdAt, final: settled(source) };
        const encoded = await compress(JSON.stringify(source));
        if (encoded.length <= inlineBytes) doc.data = encoded.toString('base64');
        else {
            doc.dataKey = randomUUID();
            doc.blocks = Math.ceil(encoded.length / blockBytes);
        }
        try {
            if (doc.dataKey) {
                for (let sequence = 0; sequence < doc.blocks!; sequence++) {
                    const data = encoded.subarray(sequence * blockBytes, (sequence + 1) * blockBytes).toString('base64');
                    await this.chunks.insertOne({ ...scope, _id: `${doc.dataKey}/${sequence}`, dataKey: doc.dataKey, sequence, data, createdAt });
                }
            }
            await this.snapshots.insertOne(doc);
        } catch (error) {
            const saved = doc.dataKey && await this.snapshots.findOne({ _id: doc._id, dataKey: doc.dataKey }, { projection: { _id: 1 } });
            if (saved) return; // The insert may have succeeded before its connection was interrupted.
            if (doc.dataKey) await this.chunks.deleteMany({ dataKey: doc.dataKey });
            if ((error as { code?: number }).code !== 11000) throw error;
        }
    }

    async remove(scope: Partial<SnapshotScope> & { domainId: string }) {
        await this.snapshots.deleteMany(scope);
        await this.chunks.deleteMany(scope);
    }

    /** Recover temporary chunk uploads abandoned by a process crash. */
    async pruneOrphans(before: Date) {
        const dataKeys = await this.chunks.distinct('dataKey', { createdAt: { $lt: before } });
        if (!dataKeys.length) return;
        const linked = await this.snapshots.distinct('dataKey', { dataKey: { $in: dataKeys } });
        const keep = new Set(linked);
        await this.chunks.deleteMany({ dataKey: { $in: dataKeys.filter((key) => !keep.has(key)) } });
    }
}
