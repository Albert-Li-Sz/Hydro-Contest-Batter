/**
 * 画面采集 in Hydro: the management page, the capture page each contestant computer opens, and
 * the websockets that carry the WebRTC handshake (lib/live/capture.ts) for devices and viewers.
 */
import { randomUUID } from 'node:crypto';
import {
    ConnectionHandler, ContestModel, Context, Handler, NotFoundError, ObjectId, param, PERM, Tdoc, Types, UserModel,
} from 'hydrooj';
import type { BoardData } from '../board';
import { applyRecording } from '../recording-routes';
import { seatOf } from '../print';
import { toScriptJson } from '../settings';
import { isTeamEntry, loadSeats, memberIds, type TeamEntry } from '../teams';
import {
    CaptureError, type CaptureDevice, type CaptureEnvelope, captureMedias, captureProfile, CaptureRelay, captureSecretMatches, type CaptureSettings,
    type CaptureStream, captureStreams, defaultCaptureSettings, isCaptureOnline, newCaptureSecret, normalizeCaptureSettings, normalizeDeviceInput,
    participantDeviceId, readCaptureSettings, streamAllowed, boardSealed,
} from './capture';
import { startStunServer } from './stun';
import type { MediaType } from './types';

interface CaptureConfigDoc {
    _id: string;
    settings: CaptureSettings;
    updatedAt: Date;
    updatedBy: number;
}

export interface CaptureHelpers {
    codeBase: string;
    key: (tdoc: Tdoc) => string;
    contestBase: (tdoc: Tdoc) => string;
    checkAdmin: (handler: Handler | ConnectionHandler, tid: ObjectId) => Promise<Tdoc>;
    /** The OBS overlay's token check (the overlay link's capability). */
    checkToken: (domainId: string, tid: ObjectId, token: string) => Promise<{ tdoc: Tdoc; doc: { token: string } }>;
    sameSecret: (given: string, stored: string) => boolean;
    /** The overlay token currently in force, to close viewers whose link was revoked. */
    currentToken: (contestKey: string) => Promise<string | null>;
    /** Hydro's own STUN server (UDP), 0 for none; pages use it on the host they were loaded from. */
    stunPort: number;
}

const MAX_DEVICES = 1000;

export function applyCapture(ctx: Context, helpers: CaptureHelpers) {
    const raw = (name: string): any => ctx.db.collection(name as never);
    const devices = raw('xcpcio.live.capture');
    // 诚信复核 (lib/integrity.ts): when a capture machine starts or stops having more than one screen.
    const signals = raw('xcpcio.integrity.signals');
    const configs = raw('xcpcio.live.capture.config');
    const on = ctx.on.bind(ctx) as unknown as (name: string, listener: (...args: any[]) => unknown) => () => void;
    on('app/started', async () => {
        await Promise.all([
            devices.createIndex({ contestKey: 1, seat: 1 }),
            devices.createIndex({ contestKey: 1, teamUid: 1 }),
        ]).catch(() => null);
    });
    on('contest/del', (domainId: string, tid: ObjectId) => {
        const contestKey = `${domainId}/${tid}`;
        mediaCache.delete(contestKey);
        promptCache.delete(contestKey);
        void Promise.all([devices.deleteMany({ contestKey }), configs.deleteOne({ _id: contestKey })]).catch(() => null);
    });
    on('domain/delete', (domainId: string) => {
        const prefix = `${domainId}/`;
        for (const k of mediaCache.keys()) if (k.startsWith(prefix)) mediaCache.delete(k);
        for (const k of promptCache.keys()) if (k.startsWith(prefix)) promptCache.delete(k);
        const pattern = new RegExp(`^${domainId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/`);
        void Promise.all([devices.deleteMany({ contestKey: pattern }), configs.deleteMany({ _id: pattern })]).catch(() => null);
    });
    const broadcast = (envelope: CaptureEnvelope) => (ctx as unknown as { broadcast: (event: string, ...args: unknown[]) => void })
        .broadcast('xcpcio/live-capture', envelope);
    const relay = new CaptureRelay(broadcast);
    if (helpers.stunPort) ctx.effect(() => startStunServer(helpers.stunPort, (message) => console.warn(`[xcpcio capture] ${message}`)));
    const stunPort = helpers.stunPort;
    on('xcpcio/live-capture', (envelope: CaptureEnvelope) => {
        if (envelope && typeof envelope === 'object' && typeof envelope.id === 'string') relay.receive(envelope);
    });

    function savedSettings(doc: CaptureConfigDoc | null): CaptureSettings {
        try { return readCaptureSettings(doc?.settings); } catch { return defaultCaptureSettings(); }
    }

    async function loadSettings(contestKey: string) {
        return savedSettings(await configs.findOne({ _id: contestKey }));
    }

    /** Each participant's seat (onsite-toolkit), a team without one sitting where its first seated member does. */
    async function teamSeats(tdoc: Tdoc) {
        const entries = await ContestModel.getMultiStatus(tdoc.domainId, { docId: tdoc.docId })
            .project<TeamEntry>({ uid: 1, members: 1 }).toArray();
        const seats = await loadSeats(ctx.db, [...entries.map((entry) => entry.uid), ...memberIds(tdoc, entries)]);
        return new Map(entries.map((entry) => [entry.uid, seatOf(seats, entry.uid, isTeamEntry(entry) ? entry.members : [])]));
    }

    // The live backend asks for the medias every refresh (2 to 5 seconds); share a short window.
    const mediaCache = new Map<string, { expires: number; value: Promise<Record<string, Record<string, MediaType[]>>> }>();
    async function mediasFor(tdoc: Tdoc, data: BoardData) {
        const contestKey = helpers.key(tdoc);
        const now = Date.now();
        const cached = mediaCache.get(contestKey);
        if (cached && cached.expires > now) return cached.value;
        const value = (async () => {
            const settings = await loadSettings(contestKey);
            if (!settings.enabled) return {};
            const list: CaptureDevice[] = await devices.find({ contestKey }).project({ _id: 1, seat: 1, teamUid: 1 }).toArray();
            if (!list.length) return {};
            const seats = await teamSeats(tdoc);
            const teams = data.teams.map((team) => ({ teamId: team.team_id, uid: Number(team.team_id), seat: seats.get(Number(team.team_id)) || '' }));
            return captureMedias(teams, list, streamAllowed('screen', 'overlay', settings, tdoc, now), settings.webcam);
        })();
        value.catch(() => mediaCache.delete(contestKey));
        mediaCache.set(contestKey, { expires: now + 3000, value });
        for (const [name, entry] of mediaCache) if (entry.expires <= now) mediaCache.delete(name);
        return value;
    }

    async function device(contestKey: string, id: unknown): Promise<CaptureDevice> {
        if (typeof id !== 'string' || !/^[a-f\d]{24}$/i.test(id)) throw new CaptureError('设备编号无效');
        const doc = await devices.findOne({ _id: id, contestKey });
        if (!doc) throw new CaptureError('设备不存在', 404);
        return doc;
    }

    // Both configuration screens patch this document. Retry a racing update against the latest
    // stored fields, including pre-upgrade documents that have no revision or only partial settings.
    async function updateSettings(contestKey: string, input: unknown, uid: number) {
        for (let attempt = 0; attempt < 6; attempt++) {
            const doc: CaptureConfigDoc | null = await configs.findOne({ _id: contestKey });
            const previous = savedSettings(doc);
            const settings = normalizeCaptureSettings(input, previous);
            const fields = { settings, updatedAt: new Date(), updatedBy: uid };
            if (doc) {
                const result = await configs.updateOne({ _id: contestKey, settings: doc.settings ?? null }, { $set: fields });
                if (result.matchedCount) return { previous, settings };
            } else {
                try {
                    await configs.insertOne({ _id: contestKey, ...fields });
                    return { previous, settings };
                } catch (error) {
                    if ((error as { code?: number }).code !== 11000) throw error;
                }
            }
        }
        throw new CaptureError('其他管理员正在修改采集设置，请重新保存', 409);
    }

    async function saveSettings(tdoc: Tdoc, input: unknown, uid: number) {
        const contestKey = helpers.key(tdoc);
        const { previous, settings } = await updateSettings(contestKey, input, uid);
        const now = Date.now();
        if (!settings.enabled) {
            for (const doc of await devices.find({ contestKey }).project({ _id: 1 }).toArray()) relay.kickDevice(doc._id, '本场比赛已停用画面采集，重新启用后会自动连接', 4005, contestKey);
        } else {
            // Capture pages already open take the new quality settings at once.
            if (JSON.stringify(captureProfile(settings)) !== JSON.stringify(captureProfile(previous))) relay.configureDevices(contestKey, { ...captureProfile(settings), stunPort });
            // Screens the overlay is showing stop when they are no longer allowed.
            if (streamAllowed('screen', 'overlay', previous, tdoc, now) && !streamAllowed('screen', 'overlay', settings, tdoc, now)) relay.endOverlayScreens(contestKey);
        }
        mediaCache.delete(contestKey);
        promptCache.delete(contestKey);
        return settings;
    }

    const captureUrl = (tdoc: Tdoc, doc: Pick<CaptureDevice, '_id' | 'secret'>) => `${helpers.contestBase(tdoc)}/live-capture/${doc._id}/${doc.secret}`;

    /** Who may watch: the viewer's kind decides about screens; the device must be of this contest and online. */
    function allowFor(tdoc: Tdoc, viewer: 'staff' | 'overlay') {
        const contestKey = helpers.key(tdoc);
        return async (id: string, stream: CaptureStream): Promise<boolean | string> => {
            const [doc, settings, current] = await Promise.all([
                devices.findOne({ _id: id, contestKey }) as Promise<CaptureDevice | null>, loadSettings(contestKey), ContestModel.get(tdoc.domainId, tdoc.docId),
            ]);
            if (!doc || !current) return '设备不存在';
            if (!settings.enabled) return '本场比赛未启用画面采集';
            if (!streamAllowed(stream, viewer, settings, current, Date.now())) return boardSealed(current) ? '解除封榜前不提供屏幕画面' : '比赛结束前不提供屏幕画面';
            if (!isCaptureOnline(doc, Date.now())) return '设备未在线';
            if (!doc.streams.includes(stream)) return stream === 'screen' ? '该设备没有在采集屏幕' : '该设备没有在采集摄像头';
            return true;
        };
    }

    // ---------------------------------------------------------------- Management page

    class CaptureAdminHandler extends Handler {
        tdoc!: Tdoc;

        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            this.tdoc = await helpers.checkAdmin(this, tid);
        }

        payload(input: string) {
            if (input.length > 200000) throw new CaptureError('请求内容过大');
            try { return JSON.parse(input); } catch { throw new CaptureError('请求格式无效'); }
        }

        async onerror(error: Parameters<Handler['onerror']>[0] | CaptureError) {
            if (error instanceof CaptureError) {
                this.response.status = error.status;
                this.response.body = { error: error.message };
                return;
            }
            return super.onerror(error);
        }
    }

    class CaptureManageHandler extends CaptureAdminHandler {
        async get() {
            const base = helpers.contestBase(this.tdoc);
            this.response.template = 'xcpcio_live_capture.html';
            this.response.body = {
                tdoc: this.tdoc, codeBase: helpers.codeBase,
                runtimeJson: toScriptJson({
                    base: `${base}/live/capture`, dataUrl: `${base}/live/capture/data`, contestUrl: base,
                    viewerWs: `${base}/live/ws/capture`, title: this.tdoc.title,
                }),
            };
        }

        async create(input: { seat: string; name: string; teamUid: number | null }[]) {
            const contestKey = helpers.key(this.tdoc);
            if (await devices.countDocuments({ contestKey }) + input.length > MAX_DEVICES) throw new CaptureError(`每场比赛最多 ${MAX_DEVICES} 台采集设备`);
            const docs: CaptureDevice[] = input.map((item) => ({
                _id: String(new ObjectId()), contestKey, ...item, secret: newCaptureSecret(), createdAt: new Date(),
                lastSeen: null, connection: null, streams: [], client: null,
            }));
            if (docs.length) await devices.insertMany(docs);
            return docs.length;
        }

        @param('payload', Types.String)
        async postCreate(_domainId: string, input: string) {
            const item = normalizeDeviceInput(this.payload(input));
            const contestKey = helpers.key(this.tdoc);
            if (item.seat && await devices.findOne({ contestKey, seat: new RegExp(`^${item.seat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') })) {
                throw new CaptureError(`座位 ${item.seat} 已有采集设备`);
            }
            this.response.body = { created: await this.create([item]) };
        }

        /** One device for every seat a participant of the contest has and no device covers yet. */
        async postCreateFromSeats() {
            const contestKey = helpers.key(this.tdoc);
            const seats = [...new Set([...(await teamSeats(this.tdoc)).values()].filter(Boolean))];
            const existing = new Set((await devices.find({ contestKey }).project({ seat: 1 }).toArray()).map((doc: { seat: string }) => doc.seat.toLowerCase()));
            const missing = seats.filter((seat) => !existing.has(seat.toLowerCase())).sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
            if (!seats.length) throw new CaptureError('参赛队伍都没有座位号。请先用 onsite-toolkit 导入座位，或逐台添加设备');
            this.response.body = { created: await this.create(missing.map((seat) => ({ seat, name: seat, teamUid: null }))), seats: seats.length };
        }

        @param('payload', Types.String)
        async postUpdate(_domainId: string, input: string) {
            const body = this.payload(input);
            const doc = await device(helpers.key(this.tdoc), body.id);
            const item = normalizeDeviceInput(body.device, doc);
            if (item.seat && item.seat.toLowerCase() !== doc.seat.toLowerCase()
                && await devices.findOne({ contestKey: doc.contestKey, seat: new RegExp(`^${item.seat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i'), _id: { $ne: doc._id } })) {
                throw new CaptureError(`座位 ${item.seat} 已有采集设备`);
            }
            await devices.updateOne({ _id: doc._id }, { $set: item });
            if (doc.teamUid !== item.teamUid || doc.seat !== item.seat) relay.kickDevice(doc._id, '机位绑定已更改，重新连接后生效', 4005, doc.contestKey);
            mediaCache.delete(doc.contestKey);
            this.response.body = { ok: true };
        }

        @param('payload', Types.String)
        async postDelete(_domainId: string, input: string) {
            const ids = (this.payload(input).ids || []).map(String).filter((id: string) => /^[a-f\d]{24}$/i.test(id));
            if (!ids.length) throw new CaptureError('请选择采集设备');
            const contestKey = helpers.key(this.tdoc);
            const owned = await devices.find({ contestKey, _id: { $in: ids } }).project({ _id: 1 }).toArray() as { _id: string }[];
            const ownedIds = owned.map((item) => item._id);
            const result = ownedIds.length ? await devices.deleteMany({ contestKey, _id: { $in: ownedIds } }) : { deletedCount: 0 };
            for (const id of ownedIds) relay.kickDevice(id, '采集设备已被删除', 4004, contestKey);
            mediaCache.delete(contestKey);
            this.response.body = { deleted: result.deletedCount };
        }

        /** A new link: the computer's current capture page stops until it opens the new one. */
        @param('payload', Types.String)
        async postRegenerate(_domainId: string, input: string) {
            const doc = await device(helpers.key(this.tdoc), this.payload(input).id);
            const secret = newCaptureSecret();
            await devices.updateOne({ _id: doc._id }, { $set: { secret, secretAt: new Date() } });
            relay.kickDevice(doc._id, '采集链接已重新生成', 4004, doc.contestKey);
            this.response.body = { url: captureUrl(this.tdoc, { _id: doc._id, secret }) };
        }

        @param('payload', Types.String)
        async postSettings(_domainId: string, input: string) {
            this.response.body = { settings: await saveSettings(this.tdoc, this.payload(input).settings, this.user._id) };
        }
    }

    class CaptureDataHandler extends CaptureAdminHandler {
        notUsage = true;

        async get() {
            const contestKey = helpers.key(this.tdoc);
            const now = Date.now();
            const [list, settings, seats] = await Promise.all([
                devices.find({ contestKey }).toArray() as Promise<CaptureDevice[]>, loadSettings(contestKey), teamSeats(this.tdoc),
            ]);
            const uids = [...seats.keys()];
            const users = await UserModel.getList(this.tdoc.domainId, uids);
            const statuses = await ContestModel.getMultiStatus(this.tdoc.domainId, { docId: this.tdoc.docId }).project({ uid: 1, displayName: 1, unrank: 1 }).toArray() as unknown as { uid: number; displayName?: string; unrank?: boolean }[];
            const names = new Map(statuses.map((entry) => [entry.uid, entry.displayName]));
            const teamName = (uid: number) => names.get(uid) || users[uid]?.displayName || users[uid]?.uname || `UID ${uid}`;
            const teams = uids.map((uid) => ({ uid, name: teamName(uid), seat: seats.get(uid) || '' }))
                .sort((a, b) => a.seat.localeCompare(b.seat, 'zh-CN', { numeric: true }) || a.name.localeCompare(b.name, 'zh-CN'));
            const bySeat = new Map(teams.filter((team) => team.seat).map((team) => [team.seat.toLowerCase(), team]));
            this.response.body = {
                settings, screenNow: streamAllowed('screen', 'overlay', settings, this.tdoc, now),
                contest: { beginAt: this.tdoc.beginAt, endAt: this.tdoc.endAt },
                teams,
                devices: list.sort((a, b) => a.seat.localeCompare(b.seat, 'zh-CN', { numeric: true }) || a.name.localeCompare(b.name, 'zh-CN')).map((doc) => {
                    const team = doc.teamUid !== null ? teams.find((item) => item.uid === doc.teamUid) ?? { uid: doc.teamUid, name: teamName(doc.teamUid), seat: '' }
                        : bySeat.get(doc.seat.toLowerCase()) ?? null;
                    return {
                        id: doc._id, name: doc.name, seat: doc.seat, teamUid: doc.teamUid, team, url: captureUrl(this.tdoc, doc),
                        online: isCaptureOnline(doc, now), streams: isCaptureOnline(doc, now) ? doc.streams : [], lastSeen: doc.lastSeen, client: doc.client, recordingStatus: doc.recordingStatus,
                    };
                }),
            };
        }
    }

    // ---------------------------------------------------------------- Capture page and device connection

    class CapturePageHandler extends Handler {
        noCheckPermView = true;

        @param('tid', Types.ObjectId)
        @param('device', Types.String)
        @param('secret', Types.String)
        async get(_domainId: string, tid: ObjectId, id: string, secret: string) {
            this.response.addHeader('Cache-Control', 'no-store');
            const tdoc = await ContestModel.get(this.domain._id, tid);
            const doc = tdoc && /^[a-f\d]{24}$/i.test(id) ? await devices.findOne({ _id: id, contestKey: helpers.key(tdoc) }) as CaptureDevice | null : null;
            if (!tdoc || !doc || !captureSecretMatches(secret, doc.secret)) throw new NotFoundError('采集链接无效或已重新生成');
            this.response.template = 'xcpcio_live_capture_device.html';
            this.response.body = {
                codeBase: helpers.codeBase, title: `${doc.name} · 画面采集`,
                runtimeJson: toScriptJson({ ws: `${captureUrl(tdoc, doc)}/ws`, name: doc.name, seat: doc.seat, contest: tdoc.title }),
            };
        }
    }

    /** A capture page's socket: by its link (secret) or by the signed-in contestant. */
    abstract class DeviceConnectionHandler extends ConnectionHandler {
        deviceId = '';
        recordingContest?: Tdoc;
        recordingTeam: number | null = null;
        closingReason = 'offline';
        lastMetrics = 0;
        lastStatusWrite = 0;
        lastSignalWrite = 0;
        closed = false;
        endpoint?: Parameters<CaptureRelay['attachDevice']>[1];
        recheck?: NodeJS.Timeout;
        statusTimer?: NodeJS.Timeout;
        /** The last status report's streams and screen size, to tell staff only about changes. */
        reported = '';

        /** Still allowed to capture (checked every minute; the bus usually ends it sooner). */
        abstract stillValid(doc: CaptureDevice | null): Promise<boolean>;

        async start(tdoc: Tdoc, doc: CaptureDevice) {
            const contestKey = helpers.key(tdoc);
            const settings = await loadSettings(contestKey);
            if (this.closed) return;
            // The capture page shows the reason (the socket closes with it) and tries again later.
            if (!settings.enabled) throw new CaptureError('本场比赛尚未启用画面采集，启用后会自动连接', 403);
            this.deviceId = doc._id;
            this.recordingContest = tdoc;
            this.recordingTeam = await recording.teamFor(tdoc, doc);
            if (this.closed) return;
            const connection = `${relay.instance}/${randomUUID()}`;
            this.endpoint = {
                contestKey, connection,
                send: (message) => this.send(message),
                close: (code, reason) => this.close(code, reason),
            };
            relay.attachDevice(doc._id, this.endpoint);
            const agent = String(this.request.headers['user-agent'] || '').slice(0, 200);
            await devices.updateOne({ _id: doc._id }, { $set: { connection, lastSeen: new Date(), recordingTeam: this.recordingTeam, streams: [], client: { agent, ip: String(this.request.ip || ''), screen: '' } } });
            if (this.closed) { await this.cleanup(); return; }
            relay.devicesChanged(contestKey);
            this.send({ type: 'config', name: doc.name, seat: doc.seat, ...captureProfile(settings), stunPort, serverTime: Date.now(), beginAt: +tdoc.beginAt, endAt: +tdoc.endAt, deviceId: doc._id, teamUid: this.recordingTeam });
            if (this.recordingTeam !== null) await recording.resume(tdoc, doc, this.recordingTeam, settings);
            if (this.closed) { await this.cleanup(); return; }
            // An incoming socket event also works while the browser throttles background timers.
            this.statusTimer = setInterval(() => this.send({ type: 'requestStatus' }), 15_000);
            this.statusTimer.unref?.();
            // Also for deployments whose processes do not share Hydro's broadcast bus.
            this.recheck = setInterval(async () => {
                const current = await devices.findOne({ _id: doc._id }).catch(() => null) as CaptureDevice | null;
                const enabled = (await loadSettings(contestKey).catch(() => settings)).enabled;
                if (!enabled) this.close(4005, '本场比赛已停用画面采集，重新启用后会自动连接');
                else if (!await this.stillValid(current).catch(() => true)) this.close(4004, '采集链接已失效');
            }, 60_000);
            this.recheck.unref?.();
        }

        async message(input: unknown) {
            const message = input as Record<string, unknown> | null;
            if (message?.type === 'clock') {
                this.send({ type: 'clock', clientTime: message.clientTime, serverTime: Date.now() });
                return;
            }
            if (['record-status', 'test-report', 'test-request'].includes(String(message?.type)) && message && this.recordingContest && this.endpoint) {
                if (message.closed === true) this.closingReason = 'closed';
                if (message.type === 'record-status' && !message.rid && !message.gap && !message.closed && Date.now() - this.lastMetrics < 1000) return;
                this.lastMetrics = Date.now();
                const current = await devices.findOne({ _id: this.deviceId, connection: this.endpoint.connection });
                if (!current || !await this.stillValid(current)) return;
                try { await recording.message(this.recordingContest, current, this.recordingTeam, message); }
                catch (e) { this.send({ type: 'record-error', message: String((e as Error).message || e) }); }
                return;
            }
            if (message?.type === 'status') {
                const now = Date.now();
                const streams = (Array.isArray(message.streams) ? message.streams : []).filter((stream): stream is CaptureStream => captureStreams.includes(stream as CaptureStream));
                const screen = typeof message.screen === 'string' ? message.screen.slice(0, 40) : '';
                const current = [...new Set(streams)].sort();
                const extended = typeof message.extended === 'boolean' ? message.extended : undefined;
                const key = `${current.join(',')}|${screen}`;
                const changed = key !== this.reported;
                // Throttle unchanged periodic heartbeats to at most once every 2s per device.
                if (!changed && extended === undefined && now - this.lastStatusWrite < 2000) return;
                this.lastStatusWrite = now;
                const before = extended === undefined ? null : await devices.findOne({ _id: this.deviceId }, { projection: { 'client.extended': 1, name: 1 } }) as { client?: { extended?: boolean }; name?: string } | null;
                await devices.updateOne({ _id: this.deviceId, connection: this.endpoint?.connection },
                    { $set: { lastSeen: new Date(), streams: current, 'client.screen': screen, ...extended === undefined ? {} : { 'client.extended': extended } } });
                if (extended !== undefined && before && before.client?.extended !== extended && this.endpoint && now - this.lastSignalWrite >= 2000) {
                    this.lastSignalWrite = now;
                    await signals.insertOne({ _id: String(new ObjectId()), contestKey: this.endpoint.contestKey, teamUid: this.recordingTeam, device: this.deviceId,
                        deviceName: before.name || '', kind: 'extended', value: extended, at: now });
                }
                // Reports come every few seconds; staff hear only about a change.
                if (changed && this.endpoint) relay.devicesChanged(this.endpoint.contestKey);
                this.reported = key;
                return;
            }
            relay.fromDevice(this.deviceId, message);
        }

        async cleanup() {
            this.closed = true;
            if (this.recheck) { clearInterval(this.recheck); this.recheck = undefined; }
            if (this.statusTimer) { clearInterval(this.statusTimer); this.statusTimer = undefined; }
            if (!this.endpoint) return;
            const ep = this.endpoint;
            this.endpoint = undefined;
            relay.detachDevice(this.deviceId, ep);
            const left = await devices.updateOne({ _id: this.deviceId, connection: ep.connection }, { $set: { connection: null, streams: [], offlineReason: this.closingReason, offlineAt: Date.now(), offlineTeam: this.recordingTeam } }).catch(() => null);
            if (left?.matchedCount && this.recordingContest && this.recordingTeam !== null) await recording.disconnect(this.recordingContest, this.deviceId, this.recordingTeam, this.closingReason);
            relay.devicesChanged(ep.contestKey);
        }
    }

    /** By the device's capture link (unattended computers, started with the browser flags). */
    class CaptureDeviceConnectionHandler extends DeviceConnectionHandler {
        noCheckPermView = true;
        secret = '';

        @param('tid', Types.ObjectId)
        @param('device', Types.String)
        @param('secret', Types.String)
        async prepare(_domainId: string, tid: ObjectId, id: string, secret: string) {
            const tdoc = await ContestModel.get(this.domain._id, tid);
            const doc = tdoc && /^[a-f\d]{24}$/i.test(id) ? await devices.findOne({ _id: id, contestKey: helpers.key(tdoc) }) as CaptureDevice | null : null;
            if (!tdoc || !doc || !captureSecretMatches(secret, doc.secret)) throw new CaptureError('采集链接无效或已重新生成，请向管理员获取新的链接', 404);
            this.secret = secret;
            await this.start(tdoc, doc);
        }

        async stillValid(doc: CaptureDevice | null) {
            return !!doc && doc.secret === this.secret;
        }
    }

    // ---------------------------------------------------------------- Contestants' own capture window

    /** The team a signed-in user takes part as (the team's uid in team contests), if they joined the contest. */
    async function participation(tdoc: Tdoc, uid: number) {
        if (!uid || uid <= 1) return null;
        const entries = await ContestModel.getMultiStatus(tdoc.domainId, { docId: tdoc.docId, $or: [{ uid }, { members: uid }] })
            .project<TeamEntry & { attend?: number }>({ uid: 1, members: 1, attend: 1 }).toArray();
        return entries.find((entry) => !!entry.attend)?.uid ?? null;
    }

    /** The device for a contestant's team: one covering its seat or bound to it, else one made for it. */
    async function participantDevice(tdoc: Tdoc, teamUid: number): Promise<CaptureDevice> {
        const contestKey = helpers.key(tdoc);
        const bound = await devices.findOne({ contestKey, teamUid }) as CaptureDevice | null;
        if (bound) return bound;
        // Load only this single team's seat instead of scanning every participant in the contest.
        const entry = await ContestModel.getStatus(tdoc.domainId, tdoc.docId, teamUid) as TeamEntry | null;
        const memberUids = entry && isTeamEntry(entry) ? entry.members : [];
        const seatMap = await loadSeats(ctx.db, [teamUid, ...memberUids]);
        const seat = seatOf(seatMap, teamUid, memberUids);
        if (seat) {
            const bySeat = await devices.findOne({ contestKey, teamUid: null, seat: new RegExp(`^${seat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }) as CaptureDevice | null;
            if (bySeat) return bySeat;
        }
        const _id = participantDeviceId(contestKey, teamUid);
        const users = await UserModel.getList(tdoc.domainId, [teamUid]);
        const doc: CaptureDevice = {
            _id, contestKey, seat, name: seat || users[teamUid]?.uname || `UID ${teamUid}`, teamUid: seat ? null : teamUid,
            secret: newCaptureSecret(), createdAt: new Date(), lastSeen: null, connection: null, streams: [], client: null,
        };
        await devices.updateOne({ _id }, { $setOnInsert: doc }, { upsert: true });
        mediaCache.delete(contestKey);
        return (await devices.findOne({ _id }))!;
    }

    async function contestantContext(handler: Handler | ConnectionHandler, tid: ObjectId) {
        const tdoc = await ContestModel.get(handler.domain._id, tid);
        if (!tdoc || tdoc.rule !== 'acm') throw new CaptureError('比赛不存在', 404);
        const teamUid = await participation(tdoc, handler.user._id);
        if (teamUid === null) throw new CaptureError('只有本场比赛的参赛选手可以开启画面采集，请先登录并报名比赛', 403);
        return { tdoc, teamUid };
    }

    /** The capture window a contestant opens from the contest's prompt (signed in, no link needed). */
    class CaptureOwnPageHandler extends Handler {
        noCheckPermView = true;

        @param('tid', Types.ObjectId)
        async get(_domainId: string, tid: ObjectId) {
            this.response.addHeader('Cache-Control', 'no-store');
            if (!this.user._id || this.user._id <= 1) throw new CaptureError('请先登录参赛账号', 403);
            const { tdoc, teamUid } = await contestantContext(this, tid);
            const doc = await participantDevice(tdoc, teamUid);
            const base = helpers.contestBase(tdoc);
            this.response.template = 'xcpcio_live_capture_device.html';
            this.response.body = {
                codeBase: helpers.codeBase, title: `画面采集 · ${tdoc.title}`,
                runtimeJson: toScriptJson({
                    ws: `${base}/live-capture/me/ws`, name: doc.name, seat: doc.seat, contest: tdoc.title,
                    // Tells the contest pages (BroadcastChannel) that this window is capturing.
                    channel: `xcpcio-capture-${tdoc.docId}`, window: true,
                }),
            };
        }

        async onerror(error: Parameters<Handler['onerror']>[0] | CaptureError) {
            if (error instanceof CaptureError) {
                this.response.status = error.status;
                this.response.type = 'text/plain';
                this.response.body = error.message;
                return;
            }
            return super.onerror(error);
        }
    }

    class CaptureOwnConnectionHandler extends DeviceConnectionHandler {
        noCheckPermView = true;
        teamUid = 0;
        tdoc!: Tdoc;

        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            const { tdoc, teamUid } = await contestantContext(this, tid);
            this.tdoc = tdoc;
            this.teamUid = teamUid;
            await this.start(tdoc, await participantDevice(tdoc, teamUid));
        }

        async stillValid(doc: CaptureDevice | null) {
            return !!doc && await participation(this.tdoc, this.user._id) === this.teamUid;
        }
    }

    /** Contest pages of a contestant whose contest captures: the prompt that opens the capture window. */
    const promptCache = new Map<string, { expires: number; value: Promise<CaptureSettings> }>();
    on('handler/after', async (handler: Handler) => {
        const tdoc = (handler.response?.body as { tdoc?: Tdoc } | undefined)?.tdoc;
        // 选手视角 (lib/perspective.ts): a manager looking through a team's eyes is not that team.
        if ((handler as { xcpcioPerspective?: unknown }).xcpcioPerspective) return;
        if (!tdoc || tdoc.rule !== 'acm' || !tdoc.docId || !handler.user?._id || handler.user._id <= 1 || !handler.UiContext) return;
        if (handler.response.template === 'xcpcio_live_capture_device.html' || Date.now() >= new Date(tdoc.endAt).getTime()) return;
        // Contest staff manage capture; they are not asked to capture themselves.
        if (handler.user.own(tdoc) || handler.user.hasPerm(PERM.PERM_EDIT_CONTEST)) return;
        try {
            const contestKey = helpers.key(tdoc);
            const now = Date.now();
            for (const [k, entry] of promptCache) if (entry.expires <= now) promptCache.delete(k);
            let cached = promptCache.get(contestKey);
            if (!cached || cached.expires <= now) {
                const value = loadSettings(contestKey);
                value.catch(() => { if (promptCache.get(contestKey)?.value === value) promptCache.delete(contestKey); });
                promptCache.set(contestKey, cached = { expires: now + 5000, value });
            }
            const settings = await cached.value;
            if (!settings.enabled || !settings.prompt) return;
            if (await participation(tdoc, handler.user._id) === null) return;
            handler.UiContext.xcpcioCapture = {
                url: `${helpers.contestBase(tdoc)}/live-capture/me`, channel: `xcpcio-capture-${tdoc.docId}`, contest: tdoc.title,
                screenPublic: settings.screenDuringContest, webcam: settings.webcam, ...(settings.recording.clips.enabled || settings.recording.archive.enabled ? { recording: true } : {}),
            };
        } catch { /* the contest page works without the prompt */ }
    });

    const recording = applyRecording(ctx, { ...helpers, loadSettings, devices, teamSeats, participantDevice, contestantContext,
        send: (id, message) => relay.toDevice(id, message) });

    // ---------------------------------------------------------------- Viewers

    abstract class ViewerConnectionHandler extends ConnectionHandler {
        viewerId = '';
        recheck?: NodeJS.Timeout;
        closed = false;

        async start(tdoc: Tdoc, viewer: 'staff' | 'overlay', token = '') {
            const settings = await loadSettings(helpers.key(tdoc));
            if (this.closed) return;
            this.viewerId = relay.attachViewer({
                contestKey: helpers.key(tdoc), allow: allowFor(tdoc, viewer), kind: viewer, token,
                send: (message) => this.send(message),
                close: (code, reason) => this.close(code, reason),
            });
            this.send({ type: 'config', iceServers: settings.iceServers, stunPort });
        }

        async message(input: unknown) {
            await relay.fromViewer(this.viewerId, input);
        }

        async cleanup() {
            this.closed = true;
            if (this.recheck) { clearInterval(this.recheck); this.recheck = undefined; }
            if (this.viewerId) { relay.detachViewer(this.viewerId); this.viewerId = ''; }
        }
    }

    /** The OBS overlay: the overlay link's token, no Hydro login. */
    class CaptureOverlayViewerHandler extends ViewerConnectionHandler {
        noCheckPermView = true;

        @param('tid', Types.ObjectId)
        @param('token', Types.String)
        async prepare(_domainId: string, tid: ObjectId, token: string) {
            const { tdoc } = await helpers.checkToken(this.domain._id, tid, token);
            if (this.closed) return;
            await this.start(tdoc, 'overlay', token);
            if (this.closed) { await this.cleanup(); return; }
            const contestKey = helpers.key(tdoc);
            this.recheck = setInterval(async () => {
                const current = await helpers.currentToken(contestKey).catch(() => null);
                if (!current || !helpers.sameSecret(token, current)) this.close(4004, '直播链接已作废');
            }, 60_000);
            this.recheck.unref?.();
        }
    }

    /** Contest staff: the director's preview and the management page. */
    class CaptureStaffViewerHandler extends ViewerConnectionHandler {
        @param('tid', Types.ObjectId)
        async prepare(_domainId: string, tid: ObjectId) {
            const tdoc = await helpers.checkAdmin(this, tid);
            if (this.closed) return;
            await this.start(tdoc, 'staff');
            if (this.closed) { await this.cleanup(); return; }
            const { domainId, docId } = tdoc;
            const uid = this.user._id;
            this.recheck = setInterval(async () => {
                const [user, current] = await Promise.all([UserModel.getById(domainId, uid), ContestModel.get(domainId, docId)]).catch(() => [null, null]);
                if (!user || !current || !(user.own(current) || user.hasPerm(PERM.PERM_EDIT_CONTEST))) this.close(4003, '比赛管理权限已撤销');
            }, 60_000);
            this.recheck.unref?.();
        }
    }

    ctx.Route('contest_xcpcio_live_capture', '/contest/:tid/live/capture', CaptureManageHandler);
    ctx.Route('contest_xcpcio_live_capture_data', '/contest/:tid/live/capture/data', CaptureDataHandler);
    ctx.Route('contest_xcpcio_live_capture_page', '/contest/:tid/live-capture/:device/:secret', CapturePageHandler);
    ctx.Connection('contest_xcpcio_live_capture_device_ws', '/contest/:tid/live-capture/:device/:secret/ws', CaptureDeviceConnectionHandler);
    ctx.Route('contest_xcpcio_live_capture_own', '/contest/:tid/live-capture/me', CaptureOwnPageHandler);
    ctx.Connection('contest_xcpcio_live_capture_own_ws', '/contest/:tid/live-capture/me/ws', CaptureOwnConnectionHandler);
    ctx.Connection('contest_xcpcio_live_capture_overlay_ws', '/contest/:tid/live-overlay/:token/ws/capture', CaptureOverlayViewerHandler);
    ctx.Connection('contest_xcpcio_live_capture_staff_ws', '/contest/:tid/live/ws/capture', CaptureStaffViewerHandler);
    ctx.i18n.load('zh', { contest_xcpcio_live_capture: '采集设备与录像' });

    /** The director console's 画面采集 page: each device, the team it shows and whether it may go on air. */
    async function directorStatus(tdoc: Tdoc) {
        const contestKey = helpers.key(tdoc);
        const now = Date.now();
        const [settings, list, seats] = await Promise.all([loadSettings(contestKey), devices.find({ contestKey }).toArray() as Promise<CaptureDevice[]>, teamSeats(tdoc)]);
        const users = await UserModel.getList(tdoc.domainId, [...seats.keys()]);
        const statuses = await ContestModel.getMultiStatus(tdoc.domainId, { docId: tdoc.docId }).project({ uid: 1, displayName: 1 }).toArray() as unknown as { uid: number; displayName?: string }[];
        const names = new Map(statuses.map((entry) => [entry.uid, entry.displayName]));
        const teamName = (uid: number) => names.get(uid) || users[uid]?.displayName || users[uid]?.uname || `UID ${uid}`;
        const bySeat = new Map([...seats].filter(([, seat]) => seat).map(([uid, seat]) => [seat.toLowerCase(), uid]));
        return {
            available: true, enabled: settings.enabled, webcam: settings.webcam,
            screenOnAir: streamAllowed('screen', 'overlay', settings, tdoc, now),
            devices: list.sort((a, b) => a.seat.localeCompare(b.seat, 'zh-CN', { numeric: true }) || a.name.localeCompare(b.name, 'zh-CN')).map((doc) => {
                const uid = doc.teamUid ?? bySeat.get(doc.seat.toLowerCase()) ?? null;
                const online = isCaptureOnline(doc, now);
                return {
                    id: doc._id, name: doc.name, seat: doc.seat, teamId: uid === null ? null : String(uid), teamName: uid === null ? '' : teamName(uid),
                    online, streams: online ? doc.streams : [],
                };
            }),
        };
    }

    return {
        mediasFor,
        directorStatus,
        settings: { get: (tdoc: Tdoc) => loadSettings(helpers.key(tdoc)), save: saveSettings },
        /** The contest's capture links (lib/links.ts): one per device. */
        async linkStatus(tdoc: Tdoc) {
            const [row] = await devices.aggregate([
                { $match: { contestKey: helpers.key(tdoc) } },
                { $group: { _id: null, count: { $sum: 1 }, issuedAt: { $max: { $ifNull: ['$secretAt', '$createdAt'] } } } },
            ]).toArray();
            return { count: row?.count || 0, issuedAt: row?.issuedAt || null };
        },
        /** New links for every device of the contest; capture pages open with the old ones stop. */
        async revokeDevices(tdoc: Tdoc) {
            const contestKey = helpers.key(tdoc);
            const list: { _id: string }[] = await devices.find({ contestKey }).project({ _id: 1 }).toArray();
            for (const doc of list) {
                await devices.updateOne({ _id: doc._id }, { $set: { secret: newCaptureSecret(), secretAt: new Date() } });
                relay.kickDevice(doc._id, '采集链接已作废', 4004, contestKey);
            }
            return list.length;
        },
        /** The overlay token was reset: its capture viewers stop at once in this process. */
        revoke(contestKey: string, token: string) {
            relay.closeViewers(contestKey, 4004, '直播链接已作废', (endpoint) => endpoint.kind !== 'overlay' || helpers.sameSecret(endpoint.token, token));
        },
    };
}
