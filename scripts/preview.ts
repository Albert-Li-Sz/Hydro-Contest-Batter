import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import nunjucks from 'nunjucks';
import { automaticBoards, enhanceBoard, reservedBoardNames } from '../lib/board';
import { checkBoardNames, defaultSettings, normalizeSettings, pruneMembers, toScriptJson } from '../lib/settings';
import { displaySpecialAwards } from '../lib/special-awards';
import { demoData, demoRoster } from '../test/fixture';
import { defaultProfileFields, rosterFields } from '../lib/roster';
import { teamData, wideData } from '../preview/fixtures';
import { createResolverPreview } from '../preview/resolver';
import { createScreensPreview } from '../preview/screens';
import { createLivePreview } from '../preview/live';
import { createMonitorPreview } from '../preview/monitor';
import { createPresencePreview } from '../preview/presence';
import { createOverviewPreview } from '../preview/overview';
import { createResultsPreview } from '../preview/results';
import { createCertificatesPreview } from '../preview/certificates';
import { createJuryPreview } from '../preview/jury';
import { createIntegrityPreview } from '../preview/integrity';
import { applyJury } from '../lib/jury';
import { createCcsPreview, previewCcsId } from '../preview/ccs';
import { createManagePreview } from '../preview/manage';
import { createPrintersPreview } from '../preview/printers';
import { createBalloonsPreview } from '../preview/balloons';
import { createClarificationPreview } from '../preview/clarification-desk';
import { previewDatabase } from '../preview/resolver-memory-db';
import { createReactionsPreview } from '../preview/reactions';
import { createControlPreview } from '../preview/control';
import { dropAfterAccept, hideProblemLabels } from '../lib/ccpc-board';

async function main() {
const root = path.resolve(__dirname, '..');
// XCPCIO_PREVIEW_STATE lets the UI smoke test keep its saves out of the developer's own preview state.
const statePath = process.env.XCPCIO_PREVIEW_STATE || path.join(root, 'preview-state.json');
let settings = normalizeSettings({ ...defaultSettings, publicAccess: true, showIdentity: true, manualBoards: [] });
try { settings = normalizeSettings(JSON.parse(await fs.readFile(statePath, 'utf8'))); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}
const env = new nunjucks.Environment(new nunjucks.FileSystemLoader([path.join(root, 'templates'), path.join(root, 'preview/templates')]), { autoescape: true });
const logoNames = JSON.parse(await fs.readFile(path.join(root, 'logos/index.json'), 'utf8')).names;
const pluginVersion = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8')).version;
// Resolver and screen previews share one in-memory store so the audience screen can follow a session.
const previewDb = previewDatabase().db;
const resolverPreview = createResolverPreview(env, logoNames, pluginVersion, previewDb);
const reactionsPreview = createReactionsPreview(env, pluginVersion);
const screensPreview = createScreensPreview(env, logoNames, pluginVersion, previewDb, () => clarificationPreview.announcements().map((item) => ({
    subject: item.subject, text: item.content, at: item.docId.getTimestamp().getTime(),
})), reactionsPreview.visible, reactionsPreview.layouts);
const monitorPreview = createMonitorPreview(env, pluginVersion, demoData);
const presencePreview = createPresencePreview(env, pluginVersion, demoData);
const overviewPreview = createOverviewPreview(env, pluginVersion);
const resultsPreview = createResultsPreview(env, pluginVersion, previewDb);
const managePreview = createManagePreview(env, pluginVersion);
// 气球配送 tickets print on the receipt printers of the print servers preview, which takes them from it.
const balloonsPreview = createBalloonsPreview(env, pluginVersion, demoData, () => printersPreview.receiptPrinters());
const printersPreview = createPrintersPreview(env, pluginVersion, demoData, () => balloonsPreview.receipts);
const livePreview = createLivePreview(env, logoNames, pluginVersion, demoData, () => settings, reactionsPreview);
const clarificationPreview = createClarificationPreview(env, pluginVersion, (text) => {
    livePreview.hub.tickerMessage.createTemporaryFromInput({ type: 'text', part: 'long', periodMs: 30_000, text }, 5 * 60_000);
});
const saveState = async (next: typeof settings) => {
    await fs.writeFile(`${statePath}.tmp`, JSON.stringify(next, null, 2));
    await fs.rename(`${statePath}.tmp`, statePath);
    settings = next;
};
const controlPreview = createControlPreview(env, pluginVersion, demoData, { get: () => settings, set: saveState },
    { balloons: balloonsPreview.settings, capture: livePreview.captureSettings }, reactionsPreview);
const base = '/contest/demo';
let unlocked = false;
const certificatesPreview = createCertificatesPreview(env, pluginVersion, previewDb, {
    snapshot: (label) => resultsPreview.snapshot(demoData(), settings, label), showIdentity: () => settings.showIdentity, title: () => demoData().contest.contest_name,
});
const boardUrl = `${base}/scoreboard/xcpcio-plus`;
const settingsUrl = `${base}/xcpcio-settings`;
const publicUrl = `${base}/xcpcio-public`;
const data = demoData();
const teams = demoRoster();
const juryPreview = createJuryPreview(env, pluginVersion, data);
const ccsPreview = createCcsPreview(data, () => settings, juryPreview.state);
const integrityPreview = createIntegrityPreview(env, pluginVersion, () => data);
const manifest = JSON.parse(await fs.readFile(path.join(root, 'public/hydro-xcpcio/manifest.json'), 'utf8'));
const defaults = { process: { env: {} }, UiContext: { cdn_prefix: '/' }, assetBase: manifest.base, tdoc: { title: data.contest.contest_name } };
const contentTypes: Record<string, string> = { '.webp': 'image/webp', '.ttf': 'font/ttf', '.woff2': 'font/woff2', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.gif': 'image/gif', '.html': 'text/html', '.json': 'application/json', '.txt': 'text/plain' };
const server = http.createServer(async (request, response) => {
    try {
        const url = new URL(request.url || '/', 'http://localhost');
        // ?fixture=team: a team contest (Hydro 5.1), teams with members.
        const displayData = url.searchParams.get('fixture') === 'wide' ? wideData() : url.searchParams.get('fixture') === 'team' ? teamData() : data;
        const displayDefaults = { ...defaults, hideSubmissions: url.searchParams.get('running') === '1',  tdoc: { title: displayData.contest.contest_name } };
        const boardResponse = () => {
            // As index.ts applyBoardRules: ?running=1 is before the freeze, where the CCPC board hides labels.
            // 裁判操作 apply to the demo contest's board as in Hydro (realtime is the staff view).
            const judged = displayData === data ? applyJury(displayData, juryPreview.state(), juryPreview.pids, url.searchParams.get('realtime') !== 'true') : displayData;
            let shown = settings.ignoreAfterAccept ? dropAfterAccept(judged) : judged;
            if (settings.ccpcBoard.enabled && url.searchParams.get('running') === '1' && url.searchParams.get('frozen') !== '1') shown = hideProblemLabels(shown, settings.ccpcBoard);
            const board = enhanceBoard(shown, settings, { identity: settings.showIdentity });
            return displaySpecialAwards(board, settings, url.searchParams.get('running') !== '1', url.searchParams.get('frozen') === '1');
        };
        const fixtureQuery = ['wide', 'team'].includes(url.searchParams.get('fixture') || '') ? `&fixture=${url.searchParams.get('fixture')}` : '';
        const boardQuery = fixtureQuery + ['running', 'frozen'].filter((key) => url.searchParams.get(key) === '1').map((key) => `&${key}=1`).join('');
        if (await reactionsPreview.handle(request, response, url)) return;
        if (await ccsPreview.handle(request, response, url)) return;
        if (await resolverPreview(request, response, url, displayData, settings)) return;
        if (await screensPreview(request, response, url, displayData, settings)) return;
        if (await livePreview.handle(request, response, url)) return;
        if (await monitorPreview(request, response, url)) return;
        if (await presencePreview(request, response, url)) return;
        if (await overviewPreview(request, response, url)) return;
        if (await resultsPreview.handle(request, response, url, displayData, settings)) return;
        if (await certificatesPreview.handle(request, response, url)) return;
        if (await juryPreview.handle(request, response, url)) return;
        if (await integrityPreview.handle(request, response, url)) return;
        if (await printersPreview(request, response, url)) return;
        if (await balloonsPreview.handle(request, response, url)) return;
        if (await clarificationPreview.handle(request, response, url)) return;
        if (await managePreview(request, response, url)) return;
        if (await controlPreview(request, response, url)) return;
        if (request.method === 'POST' && url.pathname === settingsUrl) {
            let body = '';
            for await (const chunk of request) { body += chunk; if (body.length > 1000000) throw new Error('设置内容过大'); }
            const next = pruneMembers(normalizeSettings(JSON.parse(new URLSearchParams(body).get('config') || 'null')), new Set(data.teams.map((team) => team.team_id)));
            checkBoardNames(next, reservedBoardNames(data.teams, next));
            await saveState(next);
            await ccsPreview.sync();
            ccsPreview.app.writer.touch(`system/${previewCcsId}`);
            response.writeHead(303, { Location: `${settingsUrl}?saved=1` }).end(); return;
        }
        // Hydro's 解除封榜 (operation=unlock on the native scoreboard route), back to the board like this.back().
        if (request.method === 'POST' && url.pathname === `${base}/scoreboard`) {
            unlocked = true;
            await resultsPreview.unlock(displayData, settings);
            response.writeHead(303, { Location: request.headers.referer || boardUrl }).end(); return;
        }
        if (request.method !== 'GET') { response.writeHead(405).end(); return; }
        if (url.pathname === '/api/board') {
            response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(boardResponse())); return;
        }
        if (url.pathname === settingsUrl) {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(env.render('xcpcio_plus_settings.html', {
                ...defaults, boardUrl, publicUrl, controlUrl: `${base}/control`, ccsUrl: `/d/system/ccsapi/contests/${previewCcsId}`, replacementEnabled: true,
                resolverUrl: `${base}/resolver`, screensUrl: `${base}/screens`,
                settingsJson: toScriptJson({ settings, teams, automaticBoards: automaticBoards(teams), filterFields: rosterFields(teams, defaultProfileFields) }),
            })); return;
        }
        if (url.pathname === `${base}/scoreboard` && settings.replaceNative) {
            response.writeHead(302, { Location: `${settings.publicAccess ? publicUrl : boardUrl}${url.search}` }).end(); return;
        }
        if (url.pathname === boardUrl && settings.publicAccess && url.searchParams.get('realtime') !== 'true') {
            response.writeHead(302, { Location: `${publicUrl}${url.search}` }).end(); return;
        }
        if (url.pathname === publicUrl) {
            if (!settings.publicAccess) { response.writeHead(404).end('Public scoreboard is disabled'); return; }
            if (['true', '1', 'on'].includes(url.searchParams.get('realtime') || '')) { response.writeHead(403).end('Realtime results require authorization'); return; }
            if (url.searchParams.get('json') === 'true' || request.headers.accept?.includes('application/json')) {
                response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(boardResponse())); return;
            }
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(env.render('xcpcio_plus_board.html', {
                ...displayDefaults, ...manifest, settingsUrl: null,
                runtimeJson: toScriptJson({ dataSource: `${publicUrl}?json=true${boardQuery}#allInOne=true`, refreshInterval: 5000 }),
            })); return;
        }
        if (url.pathname === boardUrl) {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(env.render('xcpcio_plus_board.html', {
                ...displayDefaults, ...manifest, settingsUrl, unlock: unlocked ? null : { url: `${base}/scoreboard`, ready: true },
                runtimeJson: toScriptJson({ dataSource: `/api/board?json=true${boardQuery}#allInOne=true`, refreshInterval: 5000 }),
            })); return;
        }
        if (url.pathname.startsWith('/hydro-xcpcio/') || url.pathname.startsWith('/hydro-resolver/') || url.pathname.startsWith('/hydro-live/')) {
            const publicRoot = path.join(root, 'public');
            const file = path.resolve(publicRoot, `.${decodeURIComponent(url.pathname)}`);
            if (!file.startsWith(`${publicRoot}${path.sep}`)) { response.writeHead(403).end(); return; }
            const body = await fs.readFile(file);
            response.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream' }).end(body); return;
        }
        if (url.pathname.startsWith('/preview-hydro/')) {
            const previewRoot = path.join(root, 'preview/hydro');
            const file = path.resolve(previewRoot, `.${decodeURIComponent(url.pathname.slice('/preview-hydro'.length))}`);
            if (!file.startsWith(`${previewRoot}${path.sep}`)) { response.writeHead(403).end(); return; }
            response.writeHead(200, { 'Content-Type': contentTypes[path.extname(file)] || 'application/octet-stream' }).end(await fs.readFile(file)); return;
        }
        if (url.pathname === '/') { response.writeHead(302, { Location: boardUrl }).end(); return; }
        response.writeHead(404).end('Not found');
    } catch (error) {
        response.writeHead((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 400, { 'Content-Type': 'text/plain; charset=utf-8' }).end(error instanceof Error ? error.message : 'Invalid request');
    }
});
livePreview.attach(server, [printersPreview.upgrade]);
server.on('close', () => { void ccsPreview.close(); });
const port = Number(process.env.XCPCIO_PREVIEW_PORT || 18900);
server.listen(port, '127.0.0.1', () => console.log(`Preview: http://127.0.0.1:${port}${boardUrl}\nSettings: http://127.0.0.1:${port}${settingsUrl}\nLive: http://127.0.0.1:${port}${base}/live`));
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
