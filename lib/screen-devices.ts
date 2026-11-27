import { createHash, randomBytes, randomInt } from 'node:crypto';
import type { Context } from 'hydrooj';
import { ScreenError, screenTypes, standingsTypes, type ScreenItem, type ScreenType } from './screens-data';

export const pairingAlphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const secret = () => randomBytes(32).toString('hex');
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
const kioskCookie = (v: string) => hash('xcpcio-screen/k/' + v);
const isSecret = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const pairingCode = () => Array.from({ length: 6 }, () => pairingAlphabet[randomInt(pairingAlphabet.length)]).join('');
const format = (code: string) => code.slice(0, 3) + '-' + code.slice(3);
const unavailable = () => new ScreenError('配对码无效、已使用或已过期', 409);

interface Pairing {
    _id: string; secretHash: string; expiresAt: Date; ip: string; globalSlot: number; ipSlot: number;
    claim?: string; claimUntil?: Date;
}
export interface ScreenClient {
    width: number; height: number; screenWidth: number; screenHeight: number; dpr: number; fullscreen: boolean; version: string; ip: string; ua: string;
}
export interface ScreenDevice {
    _id: string; contestKey: string; slot: number; name: string; secretHash?: string; linkHash?: string;
    type: ScreenType; boardId: string | null; scale: number; identifyUntil: number; reloadAt: number;
    issuedAt: Date; lastSeen: Date | null; client: ScreenClient | null;
}
declare module 'hydrooj' {
    interface Collections { 'xcpcio.screens.pairings': Pairing; 'xcpcio.screens.devices': ScreenDevice }
}
export const screenOnline = (last: Date | null, now: number) => !!last && now - last.getTime() <= 15000;
export const writeHeartbeat = (device: Pick<ScreenDevice, 'lastSeen' | 'client'>, client: ScreenClient, now: number) =>
    !device.lastSeen || now - device.lastSeen.getTime() >= 10000 || JSON.stringify(client) !== JSON.stringify(device.client);
export const deviceItem = (type: ScreenType, item: ScreenItem, boardId?: string | null) =>
    boardId && standingsTypes.has(type) ? { ...item, boardId } : item;
export function screenClient(raw: any, ip: string, ua: string): ScreenClient {
    const px = (n: unknown) => Math.min(65535, Math.max(0, Math.round(Number(n) || 0)));
    return { width: px(raw?.width), height: px(raw?.height), screenWidth: px(raw?.screenWidth), screenHeight: px(raw?.screenHeight),
        dpr: Math.max(.1, Math.min(16, Number(raw?.dpr) || 1)), fullscreen: raw?.fullscreen === true,
        version: String(raw?.version || '').slice(0, 64), ip: ip.slice(0, 128), ua: ua.slice(0, 512) };
}
type Settings = Pick<ScreenDevice, 'type' | 'name' | 'scale' | 'boardId'>;
function settings(input: Partial<Settings>, boards: string[]) {
    const patch: Partial<Settings> = {};
    if ('name' in input) {
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 80) throw new ScreenError('设备名称须为 1 到 80 个字');
        patch.name = input.name.trim();
    }
    if ('type' in input) {
        if (!screenTypes.includes(input.type!)) throw new ScreenError('未知的画面');
        patch.type = input.type;
    }
    if ('boardId' in input) {
        if (input.boardId !== null && !boards.includes(input.boardId!)) throw new ScreenError('分榜不存在');
        patch.boardId = input.boardId;
    }
    if ('scale' in input) {
        if (!Number.isFinite(input.scale) || input.scale! < .6 || input.scale! > 2) throw new ScreenError('缩放范围为 0.6 至 2.0');
        patch.scale = Math.round(input.scale! * 100) / 100;
    }
    return patch;
}
function freeSlot(taken: number[], limit: number, message: string) {
    const used = new Set(taken);
    const free = Array.from({ length: limit }, (_, i) => i).filter(i => !used.has(i));
    if (!free.length) throw new ScreenError(message, 429);
    return free[randomInt(free.length)];
}
// The unique slot indexes enforce limits even when different Hydro processes race.
async function insertSlot<T>(attempt: () => Promise<T>) {
    for (let i = 0; i < 12; i++) {
        try { return await attempt(); }
        catch (err) { if ((err as { code?: number }).code !== 11000) throw err; }
    }
    throw new ScreenError('设备正在同时连接，请重试', 409);
}

export class ScreenDevices {
    private pairs;
    private devices;
    private indexes?: Promise<void>;
    constructor(db: Context['db']) {
        this.pairs = db.collection('xcpcio.screens.pairings');
        this.devices = db.collection('xcpcio.screens.devices');
    }
    ensureIndexes() {
        return this.indexes ??= Promise.all([this.pairs.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }), this.pairs.createIndex({ secretHash: 1 }, { unique: true }),
            this.pairs.createIndex({ ip: 1, ipSlot: 1 }, { unique: true }), this.pairs.createIndex({ globalSlot: 1 }, { unique: true }),
            this.devices.createIndex({ contestKey: 1, slot: 1 }, { unique: true }),
            this.devices.createIndex({ secretHash: 1 }, { unique: true, sparse: true }), this.devices.createIndex({ linkHash: 1 }, { unique: true, sparse: true })])
            .then(() => undefined).catch(error => { this.indexes = undefined; throw error; });
    }
    async authenticate(cookie?: string) {
        if (!isSecret(cookie)) return null;
        const digest = hash(cookie);
        return this.devices.findOne({ $or: [{ secretHash: digest }, { linkHash: digest }] });
    }
    async pair(cookie: string | undefined, ip: string, now = Date.now()) {
        await this.ensureIndexes();
        if (await this.authenticate(cookie)) return { paired: true };
        if (isSecret(cookie)) {
            const active = await this.pairs.findOne({ secretHash: hash(cookie), expiresAt: { $gt: new Date(now) } });
            if (active) return { code: format(active._id), expiresAt: active.expiresAt };
        }
        await this.pairs.deleteMany({ expiresAt: { $lte: new Date(now) } });
        const newCookie = secret();
        return insertSlot(async () => {
            const taken = await this.pairs.find({}, { projection: { globalSlot: 1, ip: 1, ipSlot: 1 } }).toArray();
            const ipSlot = freeSlot(taken.filter(p => p.ip === ip).map(p => p.ipSlot), 10, '这个 IP 已有 10 个待配对码');
            const globalSlot = freeSlot(taken.map(p => p.globalSlot), 500, '待配对设备已达 500 块');
            const code = pairingCode(), expiresAt = new Date(now + 600000);
            await this.pairs.insertOne({ _id: code, expiresAt, ip, ipSlot, globalSlot, secretHash: hash(newCookie) });
            return { cookie: newCookie, code: format(code), expiresAt };
        });
    }
    async action(contestKey: string, input: Record<string, any>, boards: string[], now = Date.now()) {
        await this.ensureIndexes();
        const id = String(input.id || '');
        const filter = { _id: id, contestKey };
        if (input.action === 'claim' || input.action === 'repair') {
            const patch = input.action === 'claim' ? settings({ name: input.name, type: input.type, boardId: input.boardId ?? null }, boards) : {};
            const code = String(input.code || '').trim().toUpperCase().replace('-', '');
            if (code.length !== 6 || ![...code].every(c => pairingAlphabet.includes(c))) throw unavailable();
            const claim = secret();
            const pair = await this.pairs.findOneAndUpdate({ _id: code, expiresAt: { $gt: new Date(now) },
                $or: [{ claimUntil: { $exists: false } }, { claimUntil: { $lte: new Date(now) } }] },
            { $set: { claim, claimUntil: new Date(now + 30000) } }, { returnDocument: 'after' });
            if (!pair) throw unavailable();
            try {
                if (await this.devices.findOne({ secretHash: pair.secretHash })) throw unavailable();
                if (input.action === 'repair') {
                    const result = await this.devices.updateOne(filter, { $set: { secretHash: pair.secretHash, issuedAt: new Date(now),
                        lastSeen: null, client: null, identifyUntil: 0, reloadAt: 0 }, $unset: { linkHash: '' } });
                    if (!result.matchedCount) throw new ScreenError('设备不存在', 404);
                } else {
                    const deviceId = randomBytes(12).toString('hex');
                    await insertSlot(async () => {
                        const rows = await this.devices.find({ contestKey }, { projection: { slot: 1 } }).toArray();
                        const slot = freeSlot(rows.map(d => d.slot), 50, '每场比赛最多 50 块大屏');
                        await this.devices.insertOne({ _id: deviceId, contestKey, slot, name: patch.name!, type: patch.type!,
                            boardId: patch.boardId ?? null, scale: 1, secretHash: pair.secretHash, issuedAt: new Date(now),
                            identifyUntil: 0, reloadAt: 0, lastSeen: null, client: null });
                    });
                }
                await this.pairs.deleteOne({ _id: code, claim });
            } catch (error) {
                await this.pairs.updateOne({ _id: code, claim }, { $unset: { claim: '', claimUntil: '' } });
                throw error;
            }
            return { ok: true };
        }
        if (input.action === 'delete') {
            await this.devices.deleteOne(filter);
            return { ok: true };
        }
        const token = input.action === 'link' ? secret() : '';
        let patch: Partial<ScreenDevice>;
        switch (input.action) {
        case 'edit': patch = settings(input, boards); break;
        case 'identify': patch = { identifyUntil: now + 5000 }; break;
        case 'reload': patch = { reloadAt: now }; break;
        case 'link': patch = { linkHash: hash(kioskCookie(token)) }; break;
        default: throw new ScreenError('未知设备操作');
        }
        const selected = token ? { ...filter, secretHash: { $exists: true } } : filter;
        const result = await this.devices.updateOne(selected, { $set: patch });
        if (!result.matchedCount) throw new ScreenError('设备不存在或需要重新配对', 404);
        return token ? { link: `/xcpcio-screen/k/${token}` } : { ok: true };
    }
    async redeem(token: string) {
        if (!isSecret(token)) return null;
        const cookie = kioskCookie(token);
        return await this.devices.findOne({ linkHash: hash(cookie) }, { projection: { _id: 1 } }) ? cookie : null;
    }
    async heartbeat(device: ScreenDevice, client: ScreenClient, now = Date.now()) {
        if (writeHeartbeat(device, client, now)) await this.devices.updateOne({ _id: device._id, secretHash: device.secretHash, lastSeen: device.lastSeen },
            { $set: { lastSeen: new Date(now), client } });
    }
    async list(contestKey: string, now = Date.now()) {
        const docs = await this.devices.find({ contestKey }).sort({ issuedAt: 1 }).toArray();
        return docs.map(({ _id: id, name, type, boardId, scale, lastSeen, client, secretHash }) => ({
            id, name, type, boardId, scale, lastSeen, client, online: !!secretHash && screenOnline(lastSeen, now), paired: !!secretHash,
        }));
    }
    async status(contestKey: string) {
        const rows = await this.list(contestKey);
        const last = await this.devices.findOne({ contestKey, secretHash: { $exists: true } }, { sort: { issuedAt: -1 }, projection: { issuedAt: 1 } });
        return { count: rows.filter(r => r.paired).length, issuedAt: last?.issuedAt || null };
    }
    async revoke(contestKey: string) {
        const result = await this.devices.updateMany({ contestKey, secretHash: { $exists: true } },
            { $unset: { secretHash: '', linkHash: '' }, $set: { lastSeen: null, client: null } });
        return result.modifiedCount;
    }
    remove(contestKey: string | RegExp) { return this.devices.deleteMany({ contestKey }); }
}
