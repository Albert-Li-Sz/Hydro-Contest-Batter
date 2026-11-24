import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { Environment } from 'nunjucks';
import { defaultLayouts, defaultReactionPublic, layoutWarnings, normalizeLayout, publicSettings } from '../lib/reactions';
import { resolverCodeBase } from '../lib/resolver-data';
import { toScriptJson } from '../lib/settings';
import { readRange } from '../lib/recording';
import { issueWorkerCode, workerName, workerOrigin } from '../lib/reactions-connection';

export function createReactionsPreview(env: Environment, version: string) {
    const base = '/contest/demo/reactions',
        title = '春季程序设计竞赛';
    const layouts = defaultLayouts();
    let config = { ...defaultReactionPublic, enabled: true };
    const connections = new Map<string, { id: string; name: string; revision: number; issuedAt: Date }>();
    const at = Date.now();
    const url = base + '/sample.mp4';
    const videos = [
        { rid: 's-2', teamUid: 102, team: '橙子队', school: '示例大学', problem: 'A', firstSolve: true, offset: 0 },
        { rid: 's-5', teamUid: 105, team: '飞鸟队', school: '工程学院', problem: 'C', firstSolve: false, offset: 5000 },
    ].map((v) => ({
        ...v,
        id: v.rid + '~portrait',
        layoutId: 'portrait',
        layoutName: layouts[0].name,
        state: 'ready',
        accepted: true,
        hidden: false,
        verdict: 'AC',
        submittedAt: at - v.offset,
        readyAt: at,
        updatedAt: at,
        priority: v.firstSolve ? 0 : 1,
        durationMs: 3000,
        bytes: 35000,
        error: '',
        worker: 'preview',
        url,
    }));
    const clips = videos.map((v) => ({
        rid: v.rid,
        teamUid: v.teamUid,
        pid: 100,
        streams: { screen: [url], webcam: [url] },
    }));
    const visible = (layoutId = config.layoutId) =>
        videos.filter(
            (v) =>
                config.enabled && !v.hidden && v.state === 'ready' && layoutId === v.layoutId && (config.scope !== 'first' || v.firstSolve),
        );
    const summary = () => ({
        ready: videos.filter((v) => v.state === 'ready').length,
        waiting: videos.filter((v) => v.state === 'waiting').length,
        failed: 0,
        publicEnabled: config.enabled,
    });
    function pageRows(rows: typeof videos, query: URLSearchParams, staff: boolean) {
        const queue = staff && query.get('tab') === 'queue';
        const base = queue ? rows.filter((v) => ['waiting', 'rendering', 'stale', 'failed'].includes(v.state)) : rows;
        const filterFields = (
            staff || config.school === 'hide' ? ['team', 'problem', 'verdict'] : ['school', 'team', 'problem', 'verdict']
        ) as ('team' | 'problem' | 'verdict' | 'school')[];
        const options = Object.fromEntries(filterFields.map((k) => [k, [...new Set(base.map((v) => v[k]).filter(Boolean))].sort()]));
        const selected = base
            .filter(
                (v) =>
                    filterFields.every((k) => !query.get(k) || v[k] === query.get(k)) &&
                    (!staff ||
                        ((!query.get('layoutId') || v.layoutId === query.get('layoutId')) &&
                            (!query.get('state') || (query.get('state') === 'hidden' ? v.hidden : v.state === query.get('state'))))),
            )
            .sort(
                (a, b) =>
                    (!staff ? Number(b.firstSolve) - Number(a.firstSolve) : 0) ||
                    (query.get('sort') === 'problem' ? a.problem.localeCompare(b.problem) : 0) ||
                    b.submittedAt - a.submittedAt,
            );
        const pages = Math.max(1, Math.ceil(selected.length / 40)),
            page = Math.min(pages, Math.max(1, Math.floor(Number(query.get('page'))) || 1));
        return { videos: selected.slice((page - 1) * 40, page * 40), paging: { total: selected.length, page, pages, options } };
    }
    async function handle(request: IncomingMessage, response: ServerResponse, target: URL) {
        if (!target.pathname.startsWith(base) || target.pathname.startsWith(base + '-')) return false;
        const route = target.pathname.slice(base.length);
        const json = (data: unknown, status = 200) =>
            response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(data));
        try {
            if (route === '/sample.mp4') {
                const data = await readFile(path.join(__dirname, 'media/reaction-demo.mp4')),
                    range = readRange(request.headers.range, data.length);
                response
                    .writeHead(range ? 206 : 200, {
                        'Accept-Ranges': 'bytes',
                        'Content-Type': 'video/mp4',
                        ...(range ? { 'Content-Range': `bytes ${range.start}-${range.end}/${data.length}` } : {}),
                    })
                    .end(range ? data.subarray(range.start, range.end + 1) : data);
            } else if (route === '/manage/data') {
                const list = target.searchParams.has('page') ? pageRows(videos, target.searchParams, true) : { videos };
                json({
                    config,
                    layouts,
                    ...list,
                    clips,
                    workers: [],
                    connections: [...connections.values()],
                    legacyEnabled: false,
                    ccpc: false,
                    stats: {
                        done: videos.filter((v) => v.state === 'ready').length,
                        fail: 0,
                        waiting: videos.filter((v) => v.state === 'waiting').length,
                        rendering: 0,
                    },
                });
            } else if (route === '/data') {
                if (!config.enabled) {
                    json({ error: '公开页已关闭' }, 404);
                    return true;
                }
                const rows = visible().map((v) => ({ ...v, school: config.school === 'hide' ? '' : v.school }));
                const list = target.searchParams.has('page') ? pageRows(rows, target.searchParams, false) : { videos: rows };
                json({ ...list, shared: rows.find((v) => v.id === target.searchParams.get('video')) || null, download: config.download });
            } else if (route === '/manage' && request.method === 'POST') {
                let raw = '';
                for await (const part of request) {
                    raw += part;
                    if (raw.length > 256000) throw new Error('请求过大');
                }
                const b = JSON.parse(raw);
                if (b.action === 'public') config = publicSettings(b.settings, config);
                if (b.action === 'createConnection' || b.action === 'rotateConnection') {
                    const create = b.action === 'createConnection',
                        id = create ? randomBytes(12).toString('hex') : String(b.id);
                    const old = connections.get(id);
                    if (!create && (!old || old.revision !== b.revision)) {
                        json({ error: '连接已经变更' }, 409);
                        return true;
                    }
                    const revision = create ? 1 : old!.revision + 1,
                        name = create ? workerName(b.name) : old!.name;
                    const origin = workerOrigin(b.origin, null, request.headers.host || target.host, 'http');
                    const { code } = issueWorkerCode(origin, base, id);
                    connections.set(id, { id, name, revision, issuedAt: new Date() });
                    json({ id, code, revision });
                    return true;
                }
                if (b.action === 'revokeConnection') {
                    if (connections.get(b.id)?.revision !== b.revision) {
                        json({ error: '连接已经变更' }, 409);
                        return true;
                    }
                    connections.delete(b.id);
                }
                if (b.action === 'layout') {
                    const id = b.layout.id || randomBytes(8).toString('hex'),
                        idx = layouts.findIndex((v) => v.id === id);
                    const layout = normalizeLayout(b.layout, id, (layouts[idx]?.revision || 0) + 1),
                        warnings = layoutWarnings(layout, b.encoder === 'nvidia_full');
                    if (warnings.length && !b.confirmWarnings) {
                        json({ warnings });
                        return true;
                    }
                    if (idx < 0) layouts.push(layout);
                    else layouts[idx] = layout;
                }
                for (const v of videos.filter((v) => v.id === b.id || b.ids?.includes(v.id))) {
                    if (b.action === 'hide' || b.action === 'restore') v.hidden = b.action === 'hide';
                    if (b.action === 'retry' || b.action === 'sample') v.state = 'waiting';
                }
                json({ ok: true });
            } else if (route === '' || route === '/manage' || route === '/manage/layouts') {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(
                    env.render(route === '' ? 'xcpcio_reactions_public.html' : 'xcpcio_reactions.html', {
                        title,
                        tdoc: { title },
                        codeBase: resolverCodeBase(version),
                        runtimeJson: toScriptJson({
                            base,
                            title,
                            tab: route.endsWith('/layouts') ? 'layouts' : 'videos',
                        }),
                    }),
                );
            } else json({ error: '链接不存在' }, 404);
        } catch (e) {
            json({ error: (e as Error).message }, 400);
        }
        return true;
    }
    return {
        handle,
        visible,
        layouts: () => layouts.map(({ id, name }) => ({ id, name })),
        summary,
        setPublic: (enabled: boolean) => {
            config = { ...config, enabled };
        },
        replay: (filter: URLSearchParams) =>
            videos
                .filter((v) => v.rid === filter.get('rid') || String(v.teamUid) === filter.get('teamUid'))
                .map((v) => ({
                    rid: v.rid,
                    team: v.team,
                    problem: v.problem,
                    videos: v.state === 'ready' ? [{ label: v.layoutName, url }] : [],
                    streams: [{ stream: 'screen', segments: [{ url, startMs: at }] }],
                })),
    };
}
