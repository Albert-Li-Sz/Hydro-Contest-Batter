/**
 * The OBS overlays that are open right now. Each overlay page (shell() in lib/live/api.ts) opens a
 * control socket, says who it is (a per-tab id kept in sessionStorage, its size and URL options),
 * answers status requests, and runs the commands staff send from the live settings page (reload,
 * identify) with a receipt. Registrations live in MongoDB so that every Hydro process can list
 * them; a command goes to the process holding the overlay's socket.
 */
import { createHash, randomBytes } from 'node:crypto';
import type { Context } from 'hydrooj';

export const overlayCommandKinds = ['reload', 'identify'] as const;
export type OverlayCommandKind = typeof overlayCommandKinds[number];

export interface OverlayClientInfo {
    width: number;
    height: number;
    dpr: number;
    /** `location.search` options of the overlay link. */
    scene: string;
    onlyWidgets: string;
    noStatus: boolean;
    version: string;
    ua: string;
}
export interface OverlayCommand { id: string; kind: OverlayCommandKind; at: number }
export interface OverlayAck { id: string; kind: OverlayCommandKind; ok: boolean; message: string; at: number }
export interface OverlayRegistration {
    _id: string;
    contestKey: string;
    /** Per browser tab; a reload keeps it, so the row stays the same. */
    clientId: string;
    /** Shown on the overlay when identified, and in the list. */
    number: number;
    /** The process and socket holding the overlay, null when it is not connected. */
    connection: string | null;
    /** Which overlay link the overlay was opened with, to drop it when that link is revoked. */
    tokenHash: string;
    firstSeen: Date;
    lastSeen: Date;
    client: OverlayClientInfo;
    ip: string;
    commands: OverlayCommand[];
    ack: OverlayAck | null;
}
declare module 'hydrooj' {
    interface Collections { 'xcpcio.live.overlays': OverlayRegistration }
}

export class OverlayError extends Error {
    constructor(message: string, public status = 400) {
        super(message);
        this.name = 'OverlayError';
    }
}

/** Status is requested every 15 seconds; a socket not heard from for 45 seconds is offline, also when its process died. */
export const OVERLAY_STATUS_MS = 15_000;
export const OVERLAY_ONLINE_MS = 45_000;
/** Disconnected overlays stay listed for a while, then their registration is dropped. */
export const OVERLAY_KEEP_MS = 10 * 60_000;
export const isOverlayOnline = (doc: Pick<OverlayRegistration, 'connection' | 'lastSeen'>, now: number) => !!doc.connection
    && now - new Date(doc.lastSeen).getTime() < OVERLAY_ONLINE_MS;

export const overlayTokenHash = (token: string) => createHash('sha256').update(`xcpcio-live-overlay\n${token}`).digest('hex').slice(0, 32);
const validClientId = (value: unknown): value is string => typeof value === 'string' && /^[\w-]{8,64}$/.test(value);

export function overlayClientInfo(raw: unknown): OverlayClientInfo {
    const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
    const px = (n: unknown) => Math.min(65535, Math.max(0, Math.round(Number(n) || 0)));
    const textOf = (value: unknown, max: number) => (typeof value === 'string' ? value : '').slice(0, max);
    return {
        width: px(input.width), height: px(input.height), dpr: Math.max(0.1, Math.min(16, Number(input.dpr) || 1)),
        scene: textOf(input.scene, 64), onlyWidgets: textOf(input.onlyWidgets, 200), noStatus: input.noStatus === true,
        version: textOf(input.version, 64), ua: textOf(input.ua, 512),
    };
}

/** A socket holding an overlay in this process. */
export interface OverlayEndpoint {
    contestKey: string;
    connection: string;
    tokenHash: string;
    ip: string;
    send: (message: unknown) => void;
    /** Set once the overlay said hello. */
    clientId?: string;
    lastReport?: number;
}

/** What one process sends another: a command for the overlay on `connection`. */
export interface OverlayDelivery { contestKey: string; connection: string; message: unknown }

const registrationId = (contestKey: string, tokenHash: string, clientId: string) => `${contestKey}/${tokenHash}/${clientId}`;

export class OverlayClients {
    private docs;
    private live;
    /** Sockets held by this process, by connection. */
    private local = new Map<string, OverlayEndpoint>();

    constructor(db: Context['db'], private forward: (delivery: OverlayDelivery) => void) {
        this.docs = db.collection('xcpcio.live.overlays');
        // The per-contest counter for overlay numbers is kept on the contest's live document.
        this.live = db.collection('xcpcio.live');
    }

    async ensureIndexes() {
        await Promise.all([
            this.docs.createIndex({ contestKey: 1, number: 1 }),
            this.docs.createIndex({ lastSeen: 1 }, { expireAfterSeconds: OVERLAY_KEEP_MS / 1000 }),
        ]);
    }

    private async currentHash(contestKey: string) {
        const doc = await this.live.findOne({ _id: contestKey }, { projection: { token: 1 } });
        return doc ? overlayTokenHash(doc.token) : null;
    }

    attach(endpoint: OverlayEndpoint) {
        this.local.set(endpoint.connection, endpoint);
    }

    /** The overlay says who it is (also after reconnecting). */
    async hello(endpoint: OverlayEndpoint, raw: unknown, now = Date.now()) {
        const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        if (!validClientId(input.clientId)) throw new OverlayError('画面编号无效');
        if (endpoint.clientId) {
            if (endpoint.clientId !== input.clientId) throw new OverlayError('画面编号不能更改');
            return;
        }
        if (this.local.get(endpoint.connection) !== endpoint) return;
        endpoint.clientId = input.clientId;
        const { contestKey, connection, tokenHash, clientId } = endpoint;
        const _id = registrationId(contestKey, tokenHash, clientId);
        const existing = await this.docs.findOne({ _id }, { projection: { number: 1 } });
        let number = existing?.number;
        if (!number) {
            const counter = await this.live.findOneAndUpdate({ _id: contestKey }, { $inc: { overlaySeq: 1 } },
                { returnDocument: 'after', projection: { overlaySeq: 1 } });
            if (!counter?.overlaySeq) throw new OverlayError('直播链接已作废', 404);
            number = counter.overlaySeq;
        }
        const fields = { connection, lastSeen: new Date(now), client: overlayClientInfo(input.client), ip: endpoint.ip.slice(0, 128) };
        await this.docs.updateOne({ _id }, {
            $set: fields,
            $setOnInsert: { contestKey, tokenHash, clientId, number, firstSeen: new Date(now), commands: [], ack: null },
        }, { upsert: true });
        // Either a reset deletes our existing row, or this check removes a late old-token hello.
        if (await this.currentHash(contestKey) !== tokenHash) {
            await this.docs.deleteOne({ _id });
            throw new OverlayError('直播链接已作废', 404);
        }
        if (this.local.get(connection) !== endpoint) await this.detach(endpoint);
    }

    /** Status replies and browser resize notifications share a per-connection write limit. */
    async status(endpoint: OverlayEndpoint, raw: unknown, now = Date.now()) {
        if (!endpoint.clientId || now - (endpoint.lastReport ?? -Infinity) < 500) return;
        endpoint.lastReport = now;
        const client = overlayClientInfo((raw as { client?: unknown } | null)?.client);
        const _id = registrationId(endpoint.contestKey, endpoint.tokenHash, endpoint.clientId);
        await this.docs.updateOne({ _id, connection: endpoint.connection }, { $set: { lastSeen: new Date(now), client } });
    }

    /** The overlay ran (or could not run) a command; the receipt replaces the last one on the row. */
    async acknowledge(endpoint: OverlayEndpoint, raw: unknown, now = Date.now()) {
        if (!endpoint.clientId) return null;
        const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
        const _id = registrationId(endpoint.contestKey, endpoint.tokenHash, endpoint.clientId);
        const doc = await this.docs.findOne({ _id, connection: endpoint.connection });
        const command = doc?.commands.find((item) => item.id === input.id);
        if (!command || typeof input.ok !== 'boolean') return null;
        const ack: OverlayAck = { id: command.id, kind: command.kind, ok: input.ok, message: String(input.message ?? '').slice(0, 120), at: now };
        await this.docs.updateOne({ _id, connection: endpoint.connection }, { $pull: { commands: { id: command.id } }, $set: { ack, lastSeen: new Date(now) } });
        return ack;
    }

    /** The socket closed: the overlay is offline unless it already reconnected elsewhere. */
    async detach(endpoint: OverlayEndpoint) {
        if (this.local.get(endpoint.connection) === endpoint) this.local.delete(endpoint.connection);
        if (!endpoint.clientId) return;
        const _id = registrationId(endpoint.contestKey, endpoint.tokenHash, endpoint.clientId);
        await this.docs.updateOne({ _id, connection: endpoint.connection }, { $set: { connection: null } });
    }

    /** Staff send a command; it reaches the overlay through the process holding its socket. */
    async command(contestKey: string, clientId: unknown, kind: unknown, now = Date.now()) {
        if (!validClientId(clientId)) throw new OverlayError('画面编号无效');
        if (!overlayCommandKinds.includes(kind as OverlayCommandKind)) throw new OverlayError('未知操作');
        const tokenHash = await this.currentHash(contestKey);
        if (!tokenHash) throw new OverlayError('画面不存在', 404);
        const _id = registrationId(contestKey, tokenHash, clientId);
        const doc = await this.docs.findOne({ _id, contestKey });
        if (!doc) throw new OverlayError('画面不存在', 404);
        if (!isOverlayOnline(doc, now)) throw new OverlayError('画面已离线', 409);
        const command: OverlayCommand = { id: randomBytes(6).toString('hex'), kind: kind as OverlayCommandKind, at: now };
        const result = await this.docs.updateOne({ _id, connection: doc.connection }, { $push: { commands: { $each: [command], $slice: -10 } } });
        if (!result.matchedCount) throw new OverlayError('画面已离线', 409);
        const delivery = { contestKey, connection: doc.connection!, message: { type: 'command', id: command.id, kind: command.kind, number: doc.number } };
        if (!this.receive(delivery)) this.forward(delivery);
        return { command };
    }

    /** A delivery announced by another process; ignored unless this process holds the socket. */
    receive(delivery: unknown) {
        const input = delivery as OverlayDelivery | null;
        if (!input || typeof input.connection !== 'string') return false;
        const local = this.local.get(input.connection);
        if (!local || local.contestKey !== input.contestKey) return false;
        local.send(input.message);
        return true;
    }

    async list(contestKey: string, now = Date.now()) {
        const tokenHash = await this.currentHash(contestKey);
        if (!tokenHash) return [];
        const docs = await this.docs.find({ contestKey, tokenHash, lastSeen: { $gte: new Date(now - OVERLAY_KEEP_MS) } }).sort({ number: 1 }).toArray();
        return docs.map((doc) => ({
            id: doc.clientId, number: doc.number, online: isOverlayOnline(doc, now), lastSeen: doc.lastSeen, firstSeen: doc.firstSeen,
            client: doc.client, ip: doc.ip, ack: doc.ack ?? null, pending: (doc.commands || []).map(({ id, kind, at }) => ({ id, kind, at })),
        }));
    }

    /** Remove this generation only, including when two staff members reset in quick succession. */
    async revoke(contestKey: string, revokedToken: string) {
        await this.docs.deleteMany({ contestKey, tokenHash: overlayTokenHash(revokedToken) });
    }

    async remove(contestKey: string | RegExp) {
        await this.docs.deleteMany({ contestKey });
    }
}
