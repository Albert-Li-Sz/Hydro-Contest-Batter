import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Environment } from 'nunjucks';
import type { BoardData } from '../lib/board';
import type { BalloonSettings } from '../lib/balloons';
import { contestPhase, medalTemplateOf, medalTemplates, patchBoard, presetIds, presetOf, presets, type PresetId } from '../lib/control';
import type { CaptureSettings } from '../lib/live/capture';
import { filterChanges, impactOf, lastChange, reviewChanges, verdictName, type ReviewChange, type ReviewItem } from '../lib/rejudge-review';
import { resolverCodeBase } from '../lib/resolver-data';
import type { ResultsData } from '../lib/results';
import { type BoardSettings, toScriptJson } from '../lib/settings';

const statusNames: Record<number, string> = { 1: 'CORRECT', 2: 'WRONG_ANSWER', 3: 'TIME_LIMIT_EXCEEDED' };

/**
 * Local preview of 赛事中控 and 重测复核. The control page edits the preview's board settings (saved like the
 * settings page) and its own balloon and capture settings; `?phase=before|running|frozen|sealed|ended` sets the
 * contest's clock. The review shows three rejudged submissions of the demo contest, one already restored.
 */
export function createControlPreview(env: Environment, version: string, demo: () => BoardData,
    board: { get: () => BoardSettings; set: (settings: BoardSettings) => Promise<void> },
    modules: { balloons: { get(): BalloonSettings; save(patch: object): void }; capture: { get(): CaptureSettings; save(patch: object): void } },
    reactions?: ReturnType<typeof import('./reactions').createReactionsPreview>) {
    const codeBase = resolverCodeBase(version);
    const base = '/contest/demo';
    let allowPrint = true;
    let unlocked = false;

    function times(phase: string) {
        const now = Date.now();
        const hour = 3600_000;
        const at = { before: now + hour, running: now - 2 * hour, frozen: now - 4.5 * hour, sealed: now - 6 * hour, ended: now - 6 * hour }[phase] ?? now - 2 * hour;
        return { beginAt: new Date(at), endAt: new Date(at + 5 * hour), lockAt: new Date(at + 4 * hour), unlocked: phase === 'ended' || unlocked };
    }

    // 重测复核: s-2 (林澈, C) and s-13 (沈星, C) lost their accept; s-5 (陈言, A) was restored by the jury.
    const items: ReviewItem[] = [
        { rid: 's-2', job: 'job-1', jobAt: Date.now() - 20 * 60_000, pid: 102, before: 1, beforeScore: 100, after: 2, afterScore: 0, judgedAt: Date.now() - 19 * 60_000 },
        { rid: 's-13', job: 'job-1', jobAt: Date.now() - 20 * 60_000, pid: 102, before: 1, beforeScore: 100, after: 2, afterScore: 0, judgedAt: Date.now() - 19 * 60_000 },
        { rid: 's-5', job: 'job-1', jobAt: Date.now() - 20 * 60_000, pid: 100, before: 1, beforeScore: 100, after: 3, afterScore: 0, judgedAt: Date.now() - 19 * 60_000,
            restored: { at: Date.now() - 5 * 60_000, by: 2 } },
        { rid: 's-7', job: 'job-1', jobAt: Date.now() - 20 * 60_000, pid: 101, before: 1, beforeScore: 100, after: null, afterScore: null, judgedAt: null },
    ];
    const current = new Map([['s-2', 2], ['s-13', 2], ['s-5', 1], ['s-7', 1]]);
    const sessions = [
        { id: 'session-old', createdAt: new Date(Date.now() - 40 * 60_000), board: 'all', rehearsal: false, owner: 'admin', own: true },
        { id: 'session-new', createdAt: new Date(Date.now() - 60_000), board: 'all', rehearsal: true, owner: 'host', own: false },
    ];

    function review(url: URL) {
        const data = demo();
        const status = new Map([...current].map(([rid, code]) => [rid, statusNames[code]]));
        const results: ResultsData = {
            data: { ...data, submissions: data.submissions.map((run) => (status.has(run.submission_id) ? { ...run, status: status.get(run.submission_id)! } : run)) },
            settings: board.get(), at: data.contest.end_time * 1000 + 60_000, beginAt: data.contest.start_time * 1000, endAt: data.contest.end_time * 1000,
            lockAt: null, unlocked: true, problemIds: [100, 101, 102], coaches: {},
        };
        const { changes, pending } = reviewChanges(items, current);
        const impact = impactOf(results, changes, (code) => statusNames[code] || 'WRONG_ANSWER');
        const teamOf = (rid: string) => data.submissions.find((run) => run.submission_id === rid)?.team_id || '';
        const list = (key: string) => (url.searchParams.get(key) || '').split(',').filter(Boolean);
        const filtered = filterChanges(changes, {
            pids: list('pids').map(Number), kinds: list('kinds') as ReviewChange['kind'][], states: list('states') as ReviewChange['state'][],
            affecting: url.searchParams.get('affecting') === 'true',
        }, (change) => !!impact.get(teamOf(change.rid))?.changed);
        const changedAt = lastChange(changes);
        return {
            pending, changedAt, total: changes.length,
            problems: [100, 101, 102].map((pid, index) => ({ pid, label: 'ABC'[index] })),
            jobs: [{ id: 'job-1', createdAt: new Date(items[0].jobAt), finishedAt: null, total: items.length, pending, changed: 3 }],
            changes: filtered.map((change) => {
                const run = data.submissions.find((item) => item.submission_id === change.rid)!;
                return {
                    ...change, team: run.team_id, teamName: impact.get(run.team_id)?.name || run.team_id, label: 'ABC'[run.problem_id],
                    time: Math.floor(run.timestamp / 1000), originalName: verdictName(change.original), rejudgedName: verdictName(change.rejudged),
                    currentName: verdictName(change.current), impact: impact.get(run.team_id) || null,
                };
            }),
            sessions: sessions.map((session) => ({ ...session, stale: changedAt !== null && session.createdAt.getTime() < changedAt })),
        };
    }

    function state(phase: string) {
        const settings = board.get();
        const balloons = modules.balloons.get(), capture = modules.capture.get();
        const contest = times(phase);
        const summary = review(new URL('http://preview/'));
        return {
            contest: { title: demo().contest.contest_name, ...contest, phase: contestPhase(contest, Date.now()), allowPrint },
            preset: presetOf(settings, balloons), presets: presetIds.map((id) => ({ id, name: presets[id].name })),
            medalTemplate: medalTemplateOf(settings), medalTemplates,
            board: {
                tieBreak: settings.tieBreak, ccpcBoard: settings.ccpcBoard, ignoreAfterAccept: settings.ignoreAfterAccept,
                medals: settings.medals, medalBasis: settings.medalBasis, medalBase: settings.medalBase, medalRounding: settings.medalRounding, honors: settings.honors,
                medalRanking: settings.medalRanking, medalSameScore: settings.medalSameScore,
                podiumEnabled: settings.podiumEnabled, podiumBasis: settings.podiumBasis, podiumTie: settings.podiumTie, podiumNames: settings.podiumNames,
                firstSolve: settings.firstSolve, unofficialFirstSolve: settings.unofficialFirstSolve,
                schoolBoards: settings.schoolBoards, participationBoards: settings.participationBoards, manualBoards: settings.manualBoards.length,
                specialAwards: settings.specialAwards.length, publicAccess: settings.publicAccess, showIdentity: settings.showIdentity, ccsApi: settings.ccsApi,
            },
            balloons: { enabled: balloons.enabled, afterFreeze: balloons.afterFreeze, encourageCount: balloons.encourageCount, first: balloons.first, teamColors: balloons.teamColors, tickets: balloons.tickets.enabled },
            reactions: reactions?.summary(),
            capture: { clips:capture.recording.clips.enabled, archive:capture.recording.archive.enabled, enabled: capture.enabled, screenDuringContest: capture.screenDuringContest, webcam: capture.webcam },
            review: { changes: summary.total, pending: summary.pending, stale: summary.sessions.filter((session) => session.stale).length },
            links: {
                settings: `${base}/xcpcio-settings`, board: `${base}/scoreboard/xcpcio-plus`, publicBoard: settings.publicAccess ? `${base}/xcpcio-public` : null,
                results: `${base}/results`, ceremony: `${base}/ceremony`, certificates: `${base}/certificates`, jury: `${base}/jury`, integrity: `${base}/integrity`, review: `${base}/rejudge-review`, resolver: `${base}/resolver`, screens: `${base}/screens`, balloons: `${base}/balloons`,
                reactions: `${base}/reactions/manage`, live: `${base}/live`, capture: `${base}/live/capture`, presence: `${base}/presence`, monitor: `${base}/monitor`, overview: `${base}/overview`,
                desk: `${base}/clarification-desk`, seats: '/manage/xcpcio-users#seats', judges: '/manage/xcpcio-judges', printers: '/manage/xcpcio-printers', rejudge: '/manage/xcpcio-rejudge', edit: `${base}/edit`,
            },
        };
    }

    const json = (response: ServerResponse, body: unknown, status = 200) => {
        response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
        return true;
    };

    async function operate(request: IncomingMessage) {
        let body = '';
        for await (const chunk of request) { body += chunk; if (body.length > 100000) throw new Error('请求过大'); }
        const { operation, payload: raw } = JSON.parse(body || '{}');
        return { operation: String(operation), payload: JSON.parse(raw || '{}') as Record<string, unknown> };
    }

    return async (request: IncomingMessage, response: ServerResponse, url: URL) => {
        const phase = url.searchParams.get('phase') || 'running';
        const query = url.searchParams.get('phase') ? `?phase=${phase}` : '';
        for (const [page, template] of [['control', 'xcpcio_control.html'], ['rejudge-review', 'xcpcio_rejudge_review.html']] as const) {
            if (url.pathname === `${base}/${page}` && request.method === 'GET') {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(env.render(template, {
                    codeBase, tdoc: { title: demo().contest.contest_name },
                    runtimeJson: toScriptJson({ base: `${base}/${page}${query}`, dataUrl: `${base}/${page}/data${query}`, domainId: 'system', contestUrl: base, canRestore: true }),
                }));
                return true;
            }
        }
        if (url.pathname === `${base}/control/data`) return json(response, state(phase));
        if (url.pathname === `${base}/rejudge-review/data`) return json(response, review(url));
        if (request.method !== 'POST' || (url.pathname !== `${base}/control` && url.pathname !== `${base}/rejudge-review`)) return false;
        try {
            const { operation, payload } = await operate(request);
            if (operation === 'board') await board.set(patchBoard(board.get(), payload));
            else if (operation === 'balloons') modules.balloons.save(payload);
            else if (operation === 'reactions') reactions?.setPublic(payload.enabled===true);
            else if (operation === 'capture') modules.capture.save(payload);
            else if (operation === 'print') allowPrint = payload.allowPrint === true;
            else if (operation === 'unlock') unlocked = true;
            else if (operation === 'preset') {
                const id = payload.id as PresetId;
                if (!presetIds.includes(id)) throw new Error('未知的赛制');
                await board.set(patchBoard(board.get(), presets[id].board as Record<string, unknown>));
                modules.balloons.save(presets[id].balloons);
            } else if (operation === 'restore') {
                const restore = payload.restore !== false;
                for (const rid of (payload.rids as string[]) || []) {
                    const item = items.filter((entry) => entry.rid === rid).at(-1);
                    if (!item || item.after === null) continue;
                    current.set(rid, restore ? item.before : item.after);
                    if (restore) { item.restored = { at: Date.now(), by: 1 }; item.reapplied = null; } else { item.restored = null; item.reapplied = { at: Date.now(), by: 1 }; }
                }
                return json(response, { updated: ((payload.rids as string[]) || []).length });
            } else if (operation === 'rebuild') {
                const created = sessions.filter((session) => (payload.ids as string[]).includes(session.id)).map((session) => ({ from: session.id, id: `${session.id}-new`, url: '#' }));
                sessions.unshift(...created.map((item) => ({ id: item.id, createdAt: new Date(), board: 'all', rehearsal: false, owner: 'admin', own: true })));
                return json(response, { created });
            } else throw new Error('未知操作');
            return json(response, { ok: true });
        } catch (error) {
            return json(response, { error: error instanceof Error ? error.message : '请求无效' }, 400);
        }
    };
}
