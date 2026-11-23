/**
 * The HTTP side of ICPC Live's /api/admin and /api/overlay (backend admin/*.kt, overlay/Routing.kt,
 * server-shared ConfigurationRouting.kt, MIT), independent of the web framework serving it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { toScriptJson } from '../settings';
import type { LiveHub } from './hub';
import { ApiActionError } from './widgets';
import { teamViewPositions, type TeamViewPosition } from './widget-settings';

export const pluginRoot = path.join(__dirname, '../..');
const liveAssets = path.join(pluginRoot, 'public/hydro-live');
const builtinMedia = path.join(pluginRoot, 'live/media');

export const mediaTypes: Record<string, string> = {
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.webp': 'image/webp', '.mp4': 'video/mp4', '.webm': 'video/webm', '.json': 'application/json', '.txt': 'text/plain; charset=utf-8',
};
export const maxMediaBytes = 12 * 1024 * 1024;
/**
 * PartData.FileItem.storeName, keeping letters and digits of any script so that Chinese file
 * names stay distinct ("校徽.png" and "队徽.png" must not both become "__.png").
 */
export const storeName = (name: string) => [...name.normalize('NFC').replace(/[^\p{L}\p{N}_.-]/gu, '_').replace(/^[.-]+/, '_')]
    .slice(0, 120).join('');

/** Visual config keys that would move the overlay's backend elsewhere. */
const reservedVisualKeys = /^BASE_URL/;
export function publicVisualConfig(text: string): Record<string, unknown> {
    let config: unknown = {};
    try { config = JSON.parse(text || '{}'); } catch { /* rejected on save */ }
    if (!config || typeof config !== 'object' || Array.isArray(config)) return {};
    return Object.fromEntries(Object.entries(config).filter(([key]) => !reservedVisualKeys.test(key)));
}

/** Chinese captions; the queue column is too narrow for the contest name next to its title. */
export function defaultVisualConfig(title: string) {
    return `${JSON.stringify({
        CONTEST_CAPTION: title, QUEUE_TITLE: '评测队列', QUEUE_CAPTION: '', STATISTICS_TITLE: '题目统计',
        SCOREBOARD_HEADER_NAME_TITLE: '队伍', SCOREBOARD_HEADER_PENALTY_TITLE: '罚时',
        // The header reads "<level name> <standings name>".
        SCOREBOARD_NORMAL_NAME: '实时排名', SCOREBOARD_OPTIMISTIC_NAME: '乐观排名', SCOREBOARD_PESSIMISTIC_NAME: '悲观排名', SCOREBOARD_STANDINGS_NAME: '',
    }, null, 2)}\n`;
}

export async function builtinMediaNames() {
    try { return (await fs.promises.readdir(builtinMedia)).filter((name) => !name.startsWith('.')).sort(); } catch { return []; }
}

export async function readBuiltinMedia(name: string) {
    if (!(await builtinMediaNames()).includes(name)) return null;
    return { data: await fs.promises.readFile(path.join(builtinMedia, name)), mime: mediaTypes[path.extname(name).toLowerCase()] || 'application/octet-stream' };
}

export interface LiveUrls {
    root: string;
    adminBase: string;
    adminApi: string;
    /** Path only; the page prefixes its own ws:// or wss:// origin. */
    adminWs: string;
    overlay: string;
    overlayApi: string;
    overlayWs: string;
    media: string;
    /** The overlay for the director's own preview, behind the Hydro login instead of the token. */
    preview: string;
    previewApi: string;
    previewWs: string;
    /** 画面采集 for the overlay (path only, like overlayWs). */
    captureWs: string;
    previewCaptureWs: string;
}

export function liveUrls(contestBase: string, token: string, mediaKey: string): LiveUrls {
    return {
        root: `${contestBase}/live`,
        adminBase: `${contestBase}/live/admin`,
        adminApi: `${contestBase}/live/api/admin`,
        adminWs: `${contestBase}/live/ws/admin`,
        overlay: `${contestBase}/live-overlay/${token}`,
        overlayApi: `${contestBase}/live-overlay/${token}/api/overlay`,
        overlayWs: `${contestBase}/live-overlay/${token}/ws/overlay`,
        media: `${contestBase}/live-media/${mediaKey}`,
        preview: `${contestBase}/live/preview`,
        previewApi: `${contestBase}/live/api/overlay`,
        previewWs: `${contestBase}/live/ws/overlay`,
        captureWs: `${contestBase}/live-overlay/${token}/ws/capture`,
        previewCaptureWs: `${contestBase}/live/ws/capture`,
    };
}

/** The console previews the overlay through its own login, so a token reset never breaks it. */
export const adminRuntime = (urls: LiveUrls): LiveUrls => ({ ...urls, overlay: urls.preview });
export const previewRuntime = (urls: LiveUrls): LiveUrls => ({ ...urls, overlayApi: urls.previewApi, overlayWs: urls.previewWs, captureWs: urls.previewCaptureWs });

/** Admin websocket path -> hub channel. The console's contest info is the director's (full) view. */
export function adminChannel(name: string) {
    if (!adminChannels.includes(name)) return null;
    return name === 'contestInfo' ? 'admin:contestInfo' : name;
}

/** A built ICPC Live page, told where its backend lives. */
export function shell(app: 'overlay' | 'admin', runtime: LiveUrls, title: string, serverNow = Date.now()) {
    const html = fs.readFileSync(path.join(liveAssets, app, 'index.html'), 'utf8');
    const injected = '<meta name="referrer" content="no-referrer"><meta name="robots" content="noindex">'
        // WebSocket addresses follow the page's own scheme and host (also behind an HTTPS proxy).
        + `<script>window.__HYDRO_LIVE__=${toScriptJson(runtime)};(function(c){var o=(location.protocol==='https:'?'wss://':'ws://')+location.host;`
        + 'c.adminWs=o+c.adminWs;c.overlayWs=o+c.overlayWs;c.captureWs=o+c.captureWs;'
        // Clocks follow the Hydro server, not the (possibly unsynchronised) OBS computer: offset
        // from the render time, then measured against /serverTime every minute.
        + `c.clockOffset=${serverNow}-Date.now();function s(){var t=Date.now();fetch(c.overlayApi+'/serverTime',{cache:'no-store'})`
        + '.then(function(r){return r.json();}).then(function(v){var e=Date.now();if(typeof v.now==="number"&&e-t<5000)c.clockOffset=v.now+(e-t)/2-e;}).catch(function(){});}'
        + 's();setInterval(s,60000);})(window.__HYDRO_LIVE__);'
        // Hydro's websocket layer sends a text "ping" to quiet clients and closes them after 80 s
        // without a reply. ICPC Live clients never send anything, so answer here and keep the
        // ping away from their JSON handlers (this listener runs before any added later).
        + '(function(){var N=window.WebSocket;function W(u,p){var s=p===undefined?new N(u):new N(u,p);'
        + "s.addEventListener('message',function(e){if(e.data==='ping'){e.stopImmediatePropagation();try{s.send('pong');}catch(x){}}});return s;}"
        + 'W.prototype=N.prototype;W.CONNECTING=0;W.OPEN=1;W.CLOSING=2;W.CLOSED=3;window.WebSocket=W;})();</script>';
    return html
        .replace(/<link rel="manifest"[^>]*>/g, '')
        .replace(/<link\s+rel="icon"[^>]*>/gs, '')
        .replace(/<title>[^<]*<\/title>/, `<title>${title.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`)}</title>`)
        .replace('<head>', `<head>${injected}`);
}

export interface LiveStore {
    visualConfig(): Promise<string>;
    saveVisualConfig(text: string): Promise<void>;
    /** Uploaded and built-in media file names. */
    mediaNames(): Promise<string[]>;
    saveMedia(name: string, data: Buffer, mime: string): Promise<void>;
    /** Where the overlay and the console load a media file from. */
    mediaUrl(name: string): Promise<string>;
}

export interface UploadedFile {
    name: string;
    size: number;
    read: () => Promise<Buffer>;
}

export interface ApiRequest {
    method: string;
    /** Path below /api/admin, without the leading slash. */
    subpath: string;
    query: Record<string, unknown>;
    querystring: string;
    body: unknown;
    files: UploadedFile[];
    user: string;
}

export interface ApiResponse {
    status: number;
    type: string;
    body: string;
}

const json = (value: unknown, status = 200): ApiResponse => ({ status, type: 'application/json', body: JSON.stringify(value) });
const text = (value: string): ApiResponse => ({ status: 200, type: 'text/plain; charset=utf-8', body: value || ' ' });

export const adminChannels = ['analytics', 'teamSpotlight', 'social', 'contestInfo', 'backendLog', 'adminActions'];

const teamViewGroups: Record<string, readonly TeamViewPosition[]> = {
    teamView: ['SINGLE'], teamPVP: ['PVP_TOP', 'PVP_BOTTOM'], splitScreen: ['TOP_LEFT', 'TOP_RIGHT', 'BOTTOM_LEFT', 'BOTTOM_RIGHT'],
};

/** /api/admin/* — `null` when nothing matches (404). */
export async function adminApi(hub: LiveHub, store: LiveStore, request: ApiRequest): Promise<ApiResponse | null> {
    const parts = request.subpath.split('/').filter(Boolean).map(decodeURIComponent);
    const method = request.method.toUpperCase();
    const { body } = request;
    const action = async (run: () => unknown): Promise<ApiResponse> => {
        try {
            const result = await run();
            // adminApiAction: tell every open console which state to reload.
            hub.adminAction(`/api/admin/${request.subpath}${request.querystring ? `?${request.querystring}` : ''}`, request.user);
            return json({ status: 'ok', response: result ?? null });
        } catch (error) {
            if (!(error instanceof ApiActionError)) throw error;
            return json({ status: 'error', message: error.message }, 400);
        }
    };
    const ttl = () => {
        const value = Number(request.query.ttl);
        if (!Number.isFinite(value) || value <= 0) throw new ApiActionError('ttl should be set');
        return value;
    };
    const single = (controller: (typeof hub.controllers)[string], tail: string[]) => {
        const [op, ...more] = tail;
        if (more.length) return null;
        if (method === 'GET' && !op) return json(controller.status());
        if (method === 'GET' && op === 'preview') return action(() => controller.preview());
        if (method !== 'POST') return null;
        if (!op) return action(() => controller.setSettings(body));
        if (op === 'show') return action(() => controller.show());
        if (op === 'hide') return action(() => controller.hide());
        if (op === 'show_with_settings') return action(() => { controller.setSettings(body); controller.show(); });
        if (op === 'preview') return action(() => controller.preview(body));
        return null;
    };
    type Presets = typeof hub.advertisement | typeof hub.picture | typeof hub.title | typeof hub.tickerMessage;
    interface PresetHooks {
        /** Runs before a preset is saved; returns the input to save. `strict` when it goes on air right away. */
        save?: (input: unknown, strict: boolean) => Promise<unknown>;
        /** Runs before a saved preset goes on air (or is previewed). */
        show?: (settings: unknown) => Promise<void>;
    }
    const presets = (controller: Presets, tail: string[], hooks: PresetHooks = {}) => {
        const [idText, op, ...more] = tail;
        if (more.length) return null;
        const save = (input: unknown, strict = false) => (hooks.save ? hooks.save(input, strict) : Promise.resolve(input));
        if (!idText) {
            if (method === 'GET') return json(controller.status());
            if (method === 'POST') return action(async () => controller.createWidget(await save(body)));
            return null;
        }
        if (idText === 'create_and_show_with_ttl') {
            if (method !== 'POST' || op) return null;
            return action(async () => {
                const ms = ttl();
                return controller.createTemporaryFromInput(await save(body, true), ms);
            });
        }
        const id = /^\d+$/.test(idText) ? Number(idText) : idText;
        if (!/^[\w-]+$/.test(idText) || (typeof id === 'number' && !Number.isSafeInteger(id))) return action(() => { throw new ApiActionError('Error load preset by id'); });
        const settingsOf = () => (controller.status() as { id: unknown; settings: unknown }[]).find((item) => item.id === id)?.settings;
        if (!op && method === 'POST') return action(async () => { controller.edit(id, await save(body)); });
        if (!op && method === 'DELETE') return action(() => controller.delete(id));
        if (op === 'show' && method === 'POST') return action(async () => { await hooks.show?.(settingsOf()); controller.show(id); });
        if (op === 'hide' && method === 'POST') return action(() => controller.hide(id));
        if (op === 'preview' && method === 'GET') return action(async () => { await hooks.show?.(settingsOf()); return controller.preview(id); });
        return null;
    };
    const loadTitle = async (preset: unknown) => {
        if (typeof preset !== 'string') throw new ApiActionError('Failed to deserialize data: preset');
        if (!preset.trim()) throw new ApiActionError('请先为这条字幕选择 SVG 模板（可在“媒体文件”上传）');
        hub.forgetTemplate(preset); // pick up a re-uploaded template
        await hub.loadTemplate(preset).catch(() => { throw new ApiActionError(`找不到 SVG 模板 ${preset}，请在“媒体文件”上传或改选模板`); });
    };
    /**
     * The console creates a title with an empty template and lets the director pick one after
     * (ICPC Live checks the template only when the title is drawn), so an empty one is saved as is.
     */
    const titleHooks: PresetHooks = {
        save: async (input, strict) => {
            const preset = (input as { preset?: unknown } | null)?.preset;
            if (strict || (typeof preset === 'string' && preset.trim())) await loadTitle(preset);
            else if (preset !== undefined && preset !== null && typeof preset !== 'string') throw new ApiActionError('Failed to deserialize data: preset');
            return input;
        },
        show: async (settings) => loadTitle((settings as { preset?: unknown } | undefined)?.preset ?? ''),
    };
    /**
     * An image address: http(s), a data: image or a path on this site as is, or the name of an uploaded
     * (or built-in) media file, which becomes that file's address. Empty stays empty (not shown yet).
     */
    const imageAddress = async (value: string) => {
        const address = value.trim();
        if (!address || /^(?:https?:\/\/|data:image\/|\/)/i.test(address)) return address;
        if (/^[a-z][a-z\d+.-]*:/i.test(address)) throw new ApiActionError('图片地址只能是 http(s)、data:image 或本站路径');
        const names = await store.mediaNames();
        const name = names.includes(address) ? address : names.includes(storeName(address)) ? storeName(address) : null;
        if (!name) throw new ApiActionError(`图片地址需以 http(s):// 或 / 开头，或填写“媒体文件”中已上传的文件名（找不到 ${address}）`);
        return store.mediaUrl(name);
    };
    const pictureHooks: PresetHooks = {
        save: async (input, strict) => {
            const settings = input as { url?: unknown } | null;
            if (!settings || typeof settings !== 'object' || typeof settings.url !== 'string') return input;
            const url = await imageAddress(settings.url);
            if (strict && !url) throw new ApiActionError('请先填写图片地址或“媒体文件”中的文件名');
            return { ...settings, url };
        },
        show: async (settings) => {
            if (!(settings as { url?: unknown } | undefined)?.url) throw new ApiActionError('请先填写图片地址或“媒体文件”中的文件名');
        },
    };
    /** A ticker image (shown as a CSS background) names its picture the same way. */
    const tickerHooks: PresetHooks = {
        save: async (input, strict) => {
            const settings = input as { type?: unknown; path?: unknown } | null;
            if (!settings || typeof settings !== 'object' || settings.type !== 'image' || typeof settings.path !== 'string') return input;
            const path = await imageAddress(settings.path);
            if (strict && !path) throw new ApiActionError('请先填写图片地址或“媒体文件”中的文件名');
            return { ...settings, path };
        },
        show: async (settings) => {
            const message = settings as { type?: unknown; path?: unknown } | undefined;
            if (message?.type === 'image' && !message.path) throw new ApiActionError('请先填写图片地址或“媒体文件”中的文件名');
        },
    };

    const [head, ...rest] = parts;
    if (['queue', 'statistics', 'ticker', 'fullScreenClock', 'teamLocator', 'overview'].includes(head)) return single(hub.controllers[head], rest);
    if (head === 'scoreboard') {
        if (rest[0] === 'regions' && rest.length === 1 && method === 'GET') return json(hub.regions());
        return single(hub.controllers.scoreboard, rest);
    }
    if (teamViewGroups[head]) {
        const positions = teamViewGroups[head];
        const [op] = rest;
        if (positions.includes(op as TeamViewPosition)) return single(hub.teamViews[op as TeamViewPosition], rest.slice(1));
        if (rest.length > 1) return null;
        if (method === 'GET' && !op) return json(Object.fromEntries(positions.map((position) => [position, hub.teamViews[position].status()])));
        if (method === 'GET' && op === 'teams') return json(hub.teams());
        if (method === 'GET' && op === 'usage_stats') return json(hub.usageStatistics().entries.teamView || { type: 'per_team', byTeam: {} });
        if (method === 'POST' && op === 'show') return action(() => positions.forEach((position) => hub.teamViews[position].show()));
        if (method === 'POST' && op === 'hide') return action(() => positions.forEach((position) => hub.teamViews[position].hide()));
        return null;
    }
    if (head === 'advertisement') return presets(hub.advertisement, rest);
    if (head === 'picture') return presets(hub.picture, rest, pictureHooks);
    if (head === 'tickerMessage') return presets(hub.tickerMessage, rest, tickerHooks);
    if (head === 'title') {
        if (rest[0] === 'templates' && rest.length === 1 && method === 'GET') return json((await store.mediaNames()).filter((name) => name.endsWith('.svg')));
        return presets(hub.title, rest, titleHooks);
    }
    if (head === 'analytics') {
        if (!rest.length && method === 'GET') return json(hub.analytics.list());
        if (rest[0] === 'contestInfo' && rest.length === 1 && method === 'GET') return json(hub.adminInfo);
        const [messageId, second, third] = rest;
        if (second === 'featuredRun' && rest.length === 2) {
            // The body names a TeamMediaType; Hydro teams carry no camera or screen media.
            if (method === 'POST') return action(() => hub.analytics.makeFeatured(messageId, typeof body === 'string' ? body : (body as { mediaType?: string })?.mediaType || 'camera'));
            if (method === 'DELETE') return action(() => hub.analytics.makeNotFeatured(messageId));
        }
        if ((third === 'advertisement' || third === 'tickerMessage') && rest.length === 3) {
            if (method === 'POST') {
                return action(() => {
                    const ms = ttl();
                    if (third === 'advertisement') hub.analytics.showAdvertisement(messageId, second, ms);
                    else hub.analytics.showTicker(messageId, second, ms);
                });
            }
            if (method === 'DELETE') {
                return action(() => (third === 'advertisement' ? hub.analytics.hideAdvertisement(messageId, second) : hub.analytics.hideTicker(messageId, second)));
            }
        }
        return null;
    }
    if (head === 'teamSpotlight' && rest[0] === 'addScore' && rest.length === 1 && method === 'POST') {
        return action(() => {
            if (!Array.isArray(body)) throw new ApiActionError('Failed to deserialize data: expected a list');
            const requests = body.map((item: { teamId?: unknown; score?: unknown }) => {
                if (typeof item?.teamId !== 'string' || typeof item.score !== 'number' || !Number.isFinite(item.score)) {
                    throw new ApiActionError('Failed to deserialize data: teamId and score');
                }
                return { teamId: item.teamId, score: item.score };
            });
            hub.addScores(requests);
        });
    }
    if (head === 'social' && !rest.length && method === 'POST') {
        return action(() => {
            const input = body as { chatmessage?: unknown; chatname?: unknown; type?: unknown; teamIds?: unknown } | null;
            if (typeof input?.chatmessage !== 'string' || typeof input.chatname !== 'string') throw new ApiActionError('Failed to deserialize data: chat message');
            const teamIds = Array.isArray(input.teamIds) ? input.teamIds.filter((id): id is string => typeof id === 'string') : [];
            hub.social({ chatmessage: input.chatmessage, chatname: input.chatname, type: typeof input.type === 'string' ? input.type : 'unknown', teamIds });
        });
    }
    if (rest.length === 0 && method === 'GET') {
        if (head === 'users') return json([]);
        if (head === 'usage_stats') return json(hub.usageStatistics());
        if (head === 'contestInfo') return json(hub.adminInfo);
        if (head === 'advancedJsonPreview') return json([]);
    }
    if (head === 'visualConfig') {
        if (rest[0] === 'schema' || rest[0] === 'examples') return method === 'GET' ? json({}) : null;
        if (rest.length) return null;
        if (method === 'GET') return text(await store.visualConfig() || '{}');
        if (method === 'POST') {
            return action(async () => {
                const wrapped = (body as { visualConfig?: unknown })?.visualConfig;
                const value = typeof wrapped === 'string' ? wrapped : typeof body === 'string' ? body : JSON.stringify(body);
                if (Buffer.byteLength(value, 'utf8') > 200_000) throw new ApiActionError('画面配置不能超过 200 KB（UTF-8 编码）');
                let parsed: unknown;
                try {
                    parsed = JSON.parse(value);
                    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('expected an object');
                } catch (error) {
                    throw new ApiActionError(`Failed to parse visual config: ${(error as Error).message}`);
                }
                const reserved = Object.keys(parsed as object).filter((key) => reservedVisualKeys.test(key));
                if (reserved.length) throw new ApiActionError(`${reserved.join(', ')}: backend addresses are set by Hydro and cannot be changed`);
                await store.saveVisualConfig(value);
            });
        }
        return null;
    }
    if (head === 'media') {
        if (!rest.length && method === 'GET') return json(await store.mediaNames());
        if (rest[0] === 'upload' && rest.length === 1 && method === 'POST') {
            return action(async () => {
                const names: string[] = [];
                for (const file of request.files) {
                    const name = storeName(file.name);
                    if (file.size > maxMediaBytes) throw new ApiActionError(`${name} 超过 12 MB`);
                    const mime = mediaTypes[path.extname(name).toLowerCase()];
                    if (!mime) throw new ApiActionError(`${name}：仅支持图片、视频、SVG 与 JSON 文件`);
                    await store.saveMedia(name, await file.read(), mime);
                    await hub.templateChanged(name);
                    names.push(name);
                }
                return names;
            });
        }
        return null;
    }
    // Settings, tuning and custom fields belong to the Java server; Hydro is the data source here.
    if (['settings', 'advancedJson', 'customFields', 'orgCustomFields'].includes(head) && method === 'GET') {
        if (rest.length) return json({});
        return text(head === 'advancedJson' ? '[]' : head === 'settings' ? '{"type":"hydro"}' : '');
    }
    return null;
}

/** Websocket and HTTP flow endpoints of /api/overlay. */
export function overlayChannel(subpath: string) {
    const parts = subpath.split('/').filter(Boolean).map(decodeURIComponent);
    if (parts.length === 1 && ['mainScreen', 'contestInfo', 'runs', 'queue', 'statistics', 'ticker', 'overview'].includes(parts[0])) return parts[0];
    if (parts.length === 2 && parts[0] === 'scoreboard' && ['normal', 'optimistic', 'pessimistic'].includes(parts[1])) return `scoreboard:${parts[1]}`;
    if (parts.length === 2 && parts[0] === 'teamRuns' && /^[\w-]{1,64}$/.test(parts[1])) return `teamRuns:${parts[1]}`;
    return null;
}

/** /api/overlay/* over plain HTTP: the first value of each flow, and the visual config. */
export async function overlayApi(hub: LiveHub, subpath: string, visualConfig: string): Promise<ApiResponse | null> {
    if (subpath === 'visualConfig.json') return json(publicVisualConfig(visualConfig));
    if (subpath === 'serverTime') return json({ now: Date.now() });
    const channel = overlayChannel(subpath);
    if (!channel) return null;
    hub.touch();
    if (!hub.info) await hub.refresh();
    let first: unknown = null;
    hub.subscribe(channel, (payload) => { first ??= payload; })();
    return json(first);
}

export { teamViewPositions };
