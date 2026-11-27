import { BlockList, isIP } from 'node:net';
import { normalizeIp } from './onsite';
import { ManageError } from './manage/users';

export interface CollectSettings { enabled: boolean; networks: string[]; changedAt: Date }
export interface CollectedIp { _id: string; uid: number; xcpcioCollect?: { contest: string; uid: number } }

export const collectDeadline = (beginAt: Date) => beginAt.getTime() - 10 * 60_000;

function network(value: string) {
    const parts = value.split('/');
    const version = isIP(parts[0]);
    const max = version === 6 ? 128 : 32;
    const prefix = parts.length === 1 ? max : Number(parts[1]);
    if (!version || parts.length > 2 || (parts.length === 2 && !/^\d{1,3}$/.test(parts[1])) || !Number.isInteger(prefix) || prefix < 1 || prefix > max) {
        throw new ManageError(`无效的允许网段：${value}`);
    }
    return { address: parts[0], prefix, kind: version === 6 ? 'ipv6' as const : 'ipv4' as const };
}

export function collectSettings(enabled: boolean, input: unknown, beginAt: Date, now = Date.now()): CollectSettings {
    if (typeof input !== 'string' || input.length > 4096) throw new ManageError('允许网段格式无效');
    const networks = [...new Set(input.trim().split(/[\s,，;；]+/).filter(Boolean))];
    if (networks.length > 64 || (enabled && !networks.length)) throw new ManageError('请填写 1 至 64 个允许网段');
    networks.forEach(network);
    if (enabled && now >= collectDeadline(beginAt)) throw new ManageError('IP 收集已截止，须在开赛前十分钟之前开启');
    return { enabled, networks, changedAt: new Date(now) };
}

export function collectOpen(settings: CollectSettings | null, beginAt: Date, now = Date.now()) {
    return !!settings?.enabled && !!settings.networks.length && now < collectDeadline(beginAt);
}

export function collectionAddress(settings: CollectSettings | null, beginAt: Date, remote: string, now = Date.now()) {
    if (!collectOpen(settings, beginAt, now)) throw new ManageError('本场 IP 收集已关闭', 403);
    const ip = normalizeIp(remote);
    const family = isIP(ip);
    const block = new BlockList();
    for (const item of settings!.networks) {
        const { address, prefix, kind } = network(item);
        block.addSubnet(address, prefix, kind);
    }
    if (!family || !block.check(ip, family === 6 ? 'ipv6' : 'ipv4')) throw new ManageError('本机 IP 不在允许的赛场网段内', 403);
    return ip;
}

export interface CollectBindings {
    findOne(filter: { _id: string }): Promise<CollectedIp | null>;
    insertOne(record: CollectedIp): Promise<unknown>;
    updateOne(filter: { _id: string; uid: number; 'xcpcioCollect.contest': string; 'xcpcioCollect.uid': number }, change: { $set: Pick<CollectedIp, 'uid' | 'xcpcioCollect'> }): Promise<{ matchedCount: number }>;
}

/** Insert a new address, or conditionally reassign one that this contest previously collected. */
export async function bindCollectedIp(bindings: CollectBindings, contest: string, ip: string, uid: number) {
    const fields = { uid, xcpcioCollect: { contest, uid } };
    for (let attempt = 0; attempt < 3; attempt++) {
        const old = await bindings.findOne({ _id: ip });
        if (!old) {
            try { await bindings.insertOne({ _id: ip, ...fields }); return; }
            catch (error) { if ((error as { code?: number }).code === 11000) continue; throw error; }
        }
        if (old.uid === uid) return;
        if (old.xcpcioCollect?.contest !== contest || old.xcpcioCollect.uid !== old.uid) throw new ManageError('本机已有其他绑定，请联系管理员', 409);
        const result = await bindings.updateOne({ _id: ip, uid: old.uid, 'xcpcioCollect.contest': contest, 'xcpcioCollect.uid': old.uid }, { $set: fields });
        if (result.matchedCount) return;
    }
    throw new ManageError('本机 IP 绑定已变化，请重试', 409);
}
