import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Context } from 'hydrooj';
import type { ResolverConfig, ResolverOverview, ResolverPayload } from './resolver-types';
import { ResolverError } from './resolver-data';
import { actionIndicesFor, startIndexFor } from '../resolver/public/js/playback-model.js';

export interface ResolverScope {
    domainId: string;
    contestId: string;
    ownerId: number;
}

export interface ResolverSession extends ResolverScope {
    _id: string;
    ready: boolean;
    deleting?: boolean;
    controlToken: string;
    createdAt: Date;
    updatedAt: Date;
    config: ResolverConfig;
    overview: ResolverOverview;
    index: number;
    revision: number;
    actions: number[];
    chunks: number;
    previousIndex?: number;
}

interface ResolverChunk {
    _id: string;
    sessionId: string;
    sequence: number;
    data: string;
}

declare module 'hydrooj' {
    interface Collections {
        'xcpcio.resolver.sessions': ResolverSession;
        'xcpcio.resolver.chunks': ResolverChunk;
    }
}

// Base64 encodes 3 MiB of UTF-8 bytes into a block of at most 4 MiB.
export const resolverChunkBytes = 3 * 1024 * 1024;

export class ResolverSessions {
    private sessions;
    private chunks;
    // Immutable game only. Every public request still rechecks the link, binding and session.
    private games = new Map<string, Promise<ResolverPayload['game']>>();
    private game(session: ResolverSession) {
        let game = this.games.get(session._id);
        if (game) return game;
        game = this.read(session).then((payload) => payload.game);
        if (session.chunks <= 4) {
            this.games.set(session._id, game);
            while (this.games.size > 4) this.games.delete(this.games.keys().next().value!);
            game.catch(() => { if (this.games.get(session._id) === game) this.games.delete(session._id); });
        }
        return game;
    }

    constructor(db: Context['db']) {
        this.sessions = db.collection('xcpcio.resolver.sessions');
        this.chunks = db.collection('xcpcio.resolver.chunks');
    }

    async ensureIndexes() {
        await this.sessions.createIndex({ domainId: 1, contestId: 1, ownerId: 1, createdAt: -1 });
        await this.sessions.createIndex({ updatedAt: 1 });
        await this.chunks.createIndex({ sessionId: 1, sequence: 1 }, { unique: true });
    }

    async create(scope: ResolverScope, payload: ResolverPayload) {
        const id = randomUUID();
        const game = { ...payload.game, id };
        const buffer = Buffer.from(JSON.stringify({ ...payload, game }));
        const session: ResolverSession = {
            ...scope, _id: id, ready: false, controlToken: randomBytes(32).toString('hex'),
            createdAt: new Date(), updatedAt: new Date(), config: payload.config, overview: payload.overview,
            index: startIndexFor(game), revision: 0, actions: actionIndicesFor(game.steps),
            chunks: Math.ceil(buffer.length / resolverChunkBytes),
        };
        await this.sessions.insertOne(session);
        try {
            for (let sequence = 0; sequence < session.chunks; sequence++) {
                const data = buffer.subarray(sequence * resolverChunkBytes, (sequence + 1) * resolverChunkBytes).toString('base64');
                await this.chunks.insertOne({ _id: `${id}/${sequence}`, sessionId: id, sequence, data });
            }
            await this.sessions.updateOne({ _id: id, ready: false }, { $set: { ready: true } });
            return { ...session, ready: true };
        } catch (error) {
            await this.chunks.deleteMany({ sessionId: id });
            await this.sessions.deleteOne({ _id: id });
            throw error;
        }
    }

    /** Delete sessions (and their snapshots) nobody has opened or advanced for `maxAgeMs`. */
    async prune(maxAgeMs: number, now = Date.now()) {
        if (!Number.isFinite(maxAgeMs) || maxAgeMs <= 0) return 0;
        const rows = await this.sessions.find({ updatedAt: { $lt: new Date(now - maxAgeMs) } }).toArray();
        let deleted = 0;
        for (const row of rows) {
            if (!row.ready && !row.deleting) continue;
            // Claim only the version scanned. A concurrent open/move refreshes updatedAt.
            const claim = await this.sessions.updateOne(
                { _id: row._id, ready: row.ready, updatedAt: row.updatedAt },
                { $set: { ready: false, deleting: true } },
            );
            if (!claim.matchedCount) continue;
            await this.remove(row);
            deleted++;
        }
        return deleted;
    }

    async list(scope: ResolverScope) {
        const rows = await this.sessions.find(scope, {
            projection: { _id: 1, ready: 1, deleting: 1, createdAt: 1, config: 1, overview: 1, index: 1, revision: 1 },
        }).sort({ createdAt: -1 }).toArray();
        return rows.filter((row) => row.ready || row.deleting).map((row) => ({
            id: row._id, createdAt: row.createdAt, config: row.config, overview: row.overview,
            index: row.index, revision: row.revision,
        }));
    }

    async get(scope: ResolverScope, id: string, forDeletion = false) {
        const session = await this.sessions.findOne({ domainId: scope.domainId, contestId: scope.contestId, ownerId: scope.ownerId, _id: id });
        // Opening a session counts as use, so one being presented without moves is not pruned.
        // (At most hourly: the player polls this every two seconds.)
        if (session?.ready && Date.now() - new Date(session.updatedAt).getTime() > 3600_000) {
            const updatedAt = new Date();
            const result = await this.sessions.updateOne({ _id: id, ready: true }, { $set: { updatedAt } });
            if (!result.matchedCount) throw new ResolverError('滚榜会话正在删除', 404);
            session.updatedAt = updatedAt;
        }
        if (session && !session.ready && !(forDeletion && session.deleting)) throw new ResolverError('滚榜会话正在写入或删除', 404);
        if (!session) throw new ResolverError('滚榜会话不存在或不属于当前账号', 404);
        return session;
    }

    checkToken(session: ResolverSession, token: unknown) {
        if (typeof token !== 'string' || !/^[a-f\d]{64}$/.test(token)
            || !timingSafeEqual(Buffer.from(session.controlToken, 'hex'), Buffer.from(token, 'hex'))) {
            throw new ResolverError('滚榜控制令牌无效，请返回配置页重新打开会话', 403);
        }
    }

    async read(session: ResolverSession): Promise<ResolverPayload> {
        const blocks = await this.chunks.find({ sessionId: session._id }).sort({ sequence: 1 }).toArray();
        if (blocks.length !== session.chunks || blocks.some((block, index) => block.sequence !== index)) {
            throw new ResolverError('滚榜数据已删除或不完整，请重新开启滚榜', 404);
        }
        return JSON.parse(Buffer.concat(blocks.map((block) => Buffer.from(block.data, 'base64'))).toString('utf8'));
    }

    playback(session: ResolverSession) {
        return {
            index: session.index, revision: session.revision,
            currentAction: session.actions.indexOf(session.index) + 1, totalActions: session.actions.length,
        };
    }

    async move(session: ResolverSession, index: number, revision: number) {
        if (!Number.isInteger(index) || !session.actions.includes(index) || !Number.isSafeInteger(revision) || revision < 0) {
            throw new ResolverError('无效的滚榜步骤或版本号');
        }
        const result = await this.sessions.updateOne(
            { _id: session._id, ready: true, revision },
            { $set: { index, previousIndex: session.index, updatedAt: new Date() }, $inc: { revision: 1 } },
        );
        if (result.matchedCount) return { status: 200, playback: this.playback({ ...session, index, revision: revision + 1 }) };
        const current = await this.get(session, session._id);
        return { status: 409, playback: this.playback(current), error: '进度已在另一个页面更新，已暂停并同步' };
    }

    /** A session of this contest, whichever administrator created it (read-only audience view). */
    async find(domainId: string, contestId: string, id: string) {
        const session = await this.sessions.findOne({ domainId, contestId, _id: id });
        return session?.ready ? session : null;
    }

    /**
     * What an audience may see: the steps up to the current one, with no future steps and no award
     * recipients beyond the team being shown. Follows Resolver-Web server/lib/sessions.js snapshot().
     */
    private revealed(game: ResolverPayload['game'], start: number, end: number) {
        return game.steps.slice(start, end + 1).map((step) => {
            if (!step.teamId || !Array.isArray(step.awards)) return step;
            return { ...step, awards: (step.awards as { teamIds: string[] }[]).map((award) => ({
                ...award, teamIds: award.teamIds.filter((teamId) => teamId === step.teamId),
            })) };
        });
    }

    async spectator(session: ResolverSession) {
        const game = await this.game(session);
        const { autoStopTeamId: _hidden, ...meta } = game.meta;
        return {
            game: { ...game, meta, contest: { ...game.contest, awards: [] }, steps: this.revealed(game, 0, session.index) },
            playback: this.playback(session),
        };
    }

    async audience(session: ResolverSession, known?: string, revision?: number, index?: number) {
        const playback = this.playback(session);
        if (known === session._id && revision === session.revision && (index === undefined || index === session.index)) return { playback };
        if (known === session._id && revision === session.revision - 1 && index !== undefined
            && index === session.previousIndex && index >= 0 && index < session.index) {
            const steps = this.revealed(await this.game(session), index + 1, session.index);
            return { playback, delta: { from: index, steps } };
        }
        return this.spectator(session);
    }

    async remove(session: ResolverSession) {
        this.games.delete(session._id);
        await this.sessions.updateOne({ _id: session._id }, { $set: { ready: false, deleting: true } });
        await this.chunks.deleteMany({ sessionId: session._id });
        await this.sessions.deleteOne({ _id: session._id });
    }
}
