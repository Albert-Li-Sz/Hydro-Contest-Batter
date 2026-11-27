import { describe, expect, it } from 'vitest';
import { defaultSettings } from '../lib/settings';
import { resolverBoards } from '../lib/resolver-data';
import { broadcastRows, decodePoster, defaultScreenConfig, hiddenBeforeStart, normalizeScreenConfig, presentationItem, saveScreenConfig,
    reactionPlaylist, screenCategories, screenData, screenProjection, screenTypes } from '../lib/screens-data';
import { hideProblemLabels } from '../lib/ccpc-board';
import { ScreenDevices, pairingAlphabet, pairingCode, deviceItem, deviceState, remoteAcks, screenClient, screenOnline, screenThumb, writeHeartbeat } from '../lib/screen-devices';
import { scalableTypes } from '../lib/screens-data';
import { PortHost } from '../resolver/public/js/render/presentation-ports.js';
import { previewDatabase } from '../preview/resolver-memory-db';
import { demoData } from './fixture';

const settings = { ...defaultSettings, showIdentity: true, manualBoards: [{ id: 'mixed', name: '混合榜', teamIds: ['1', '4', '7'] }] };
const env = { logoNames: { 南京晓庄学院: '0123456789ab' }, locked: true, firstSolve: true, unofficialFirstSolve: false };
const highlighted = (result: ReturnType<typeof screenData>) => Object.entries(result.results)
    .flatMap(([id, cells]) => cells.map((cell: any, index: number) => (cell.firstToSolve ? `${id}:${index}` : null))).filter(Boolean);

describe('big-screen configuration', () => {
    it('starts from usable defaults and keeps earlier values for omitted fields', () => {
        const base = defaultScreenConfig();
        expect(base.items.tiles.variant).toBe('standings');
        expect(base.items.queue).toMatchObject({ variant: 'queue', boardId: 'all' });
        expect(normalizeScreenConfig({ items: { queue: { variant: 'teams' } } }).items.queue.variant).toBe('teams');
        // Settings saved before the queue screen existed still load, with its defaults.
        const { queue: _queue, ...older } = base.items;
        expect(normalizeScreenConfig({ locale: 'zh-CN', items: older }).items.queue.variant).toBe('queue');
        expect(base.items.countdown).toMatchObject({ variant: 'digital', target: 'end' });
        const next = normalizeScreenConfig({ locale: 'en', items: { tiles: { variant: 'rank' }, message: { text: '午餐时间' } } }, base);
        expect(next.locale).toBe('en');
        expect(next.items.tiles).toMatchObject({ variant: 'rank', boardId: 'all' });
        expect(normalizeScreenConfig({ items: { scoreboard: { boardId: 'manual-mixed' } } }, next).items.message.text).toBe('午餐时间');
    });
    it('rejects invalid values', () => {
        for (const bad of [null, [], { locale: 'fr' }, { items: { tiles: { variant: 'map' } } }, { items: { scoreboard: { boardId: '../x' } } },
            { items: { message: { text: 'x'.repeat(2001) } } }, { items: { resolver: { sessionId: 'abc' } } },
            { items: { countdown: { target: 'custom' } } }, { items: { countdown: { targetTime: 'soon' } } }]) {
            expect(() => normalizeScreenConfig(bad)).toThrow();
        }
    });
    it('resolves the countdown target from the contest or the chosen time', () => {
        const data = demoData();
        const config = defaultScreenConfig();
        expect(presentationItem('countdown', config.items.countdown, data).targetTime).toBe(data.contest.end_time * 1000);
        const custom = normalizeScreenConfig({ items: { countdown: { target: 'custom', targetTime: '2026-10-27T03:00:00Z' } } });
        expect(presentationItem('countdown', custom.items.countdown, data)).toMatchObject({ type: 'countdown', variant: 'digital', targetTime: Date.parse('2026-10-27T03:00:00Z') });
        expect(presentationItem('scoreboard', config.items.scoreboard, data)).toEqual({ type: 'scoreboard' });
        expect(presentationItem('queue', config.items.queue, data)).toEqual({ type: 'queue', variant: 'queue' });
    });
});

describe('additional screens', () => {
    it('limits reaction playback to the chosen board, layout and verdict', () => {
        const item = { ...defaultScreenConfig().items.reactions, layoutId: 'portrait' };
        const v = { teamUid: 1, team: 'Alpha', problem: 'A', accepted: true, firstSolve: true, layoutId: 'portrait', url: '/public/run' };
        const feed = [v, { ...v, firstSolve: false }, { ...v, teamUid: 2 }, { ...v, layoutId: 'landscape' }];
        expect(reactionPlaylist(feed, item, new Set(['1']))).toEqual([{ url: v.url, team: 'Alpha', problem: 'A' }]);
        expect(reactionPlaylist(feed, { ...item, variant: 'accepted' }, null)).toHaveLength(3);
        expect(reactionPlaylist([], item, null)).toEqual([]);
    });
    it('lists every screen once, loads legacy settings and keeps uploads through settings saves', () => {
        expect(screenCategories.flatMap(([, types]) => types)).toEqual([...screenTypes]);
        const id = 'a'.repeat(24);
        const config = normalizeScreenConfig({ items: { poster: { images: [id] } } });
        expect(saveScreenConfig({ items: { poster: { images: [], interval: 3 } } }, config).items.poster).toMatchObject({ images: [id], interval: 3 });
        expect(() => normalizeScreenConfig({ items: { poster: { interval: 1 } } })).toThrow();
        expect(() => normalizeScreenConfig({ items: { groups: { source: 'all' } } })).toThrow();
        expect(['outcomes', 'rank-trend', 'floor', 'balloons', 'announce', 'problem-list'].every((type) => hiddenBeforeStart.has(type as never))).toBe(true);
    });

    it('uses only freeze-visible results for rank history, outcome buckets, broadcasts and balloons', () => {
        const data = demoData();
        const freezeMs = 3600 * 1000;
        data.contest.frozen_time = 4 * 3600;
        data.submissions.push({ submission_id: 'edge', team_id: '8', problem_id: 1, status: 'CORRECT', timestamp: freezeMs });
        data.submissions.push({ submission_id: 'late', team_id: '8', problem_id: 2, status: 'CORRECT', timestamp: freezeMs + 1000 });
        data.submissions.push({ submission_id: 'late', team_id: '8', problem_id: 2, status: 'CORRECT', timestamp: freezeMs + 1000 });
        const view = screenData(data, null, { ...env, seats: new Map([['8', 'A-08']]), trend: true });
        const config = defaultScreenConfig();
        const projection = (type: 'announce' | 'balloons' | 'floor' | 'outcomes' | 'rank-trend') => screenProjection(type, config.items[type], view, [
            { teamId: '8', problemId: '1', submissionId: 'edge' }, { teamId: '8', problemId: '2', submissionId: 'late' },
        ]);
        expect(view.outcomes.filter((record) => record.submission_id === 'late')).toMatchObject([{ status: 'FROZEN' }]);
        expect(projection('rank-trend')).toMatchObject({ times: expect.arrayContaining([0, 4800000]), teams: expect.arrayContaining([expect.objectContaining({ ranks: expect.any(Array) })]) });
        expect(projection('outcomes')).toContainEqual(expect.objectContaining({ label: '60–90 min', counts: { CORRECT: 2, PENDING: 3 } }));
        expect(projection('announce')).toContainEqual(expect.objectContaining({ id: 'edge' }));
        expect(projection('announce')).not.toContainEqual(expect.objectContaining({ id: 'late' }));
        expect(projection('balloons')).toMatchObject({ seats: [expect.objectContaining({ seat: 'A-08', balloons: ['1'] })] });
        // Balloons are drawn in their problem's colour (the engine calls it `rgb`).
        expect((projection('balloons') as { problems: { color: string }[] }).problems.map((problem) => problem.color)).toEqual(['#e8794c', '#3b82f6', '#a855f7']);
        expect(projection('floor')).toMatchObject({ seats: [expect.objectContaining({ seat: 'A-08', latest: 'PENDING' })] });
    });

    it('supports overlapping groups and gives each group an independent official ranking', () => {
        const data = demoData();
        const item = defaultScreenConfig().items.groups;
        const view = screenData(data, null, { ...env, groups: [
            { id: 'g1', name: '甲', teamIds: ['1', '4', '5'] }, { id: 'g2', name: '乙', teamIds: ['4', '5'] },
        ] });
        expect(screenProjection('groups', item, view)).toMatchObject([
            { name: '甲', rows: [expect.objectContaining({ name: '林澈', rank: 1 }), expect.objectContaining({ name: '许青', rank: 2 }), expect.objectContaining({ name: '苏禾', rank: '*' })] },
            { name: '乙', rows: [expect.objectContaining({ name: '许青', rank: 1 }), expect.objectContaining({ name: '苏禾', rank: '*' })] },
        ]);
        expect(screenProjection('scoreboard', item, view)).not.toHaveProperty('seats');
    });

    it('shows no groups, instead of failing, when the contest has no boards to group by', () => {
        const item = defaultScreenConfig().items.groups;
        expect(screenProjection('groups', item, screenData(demoData(), null, { ...env, groups: [] }))).toEqual([]);
    });

    it('exposes only jury broadcasts and rejects non-image uploads', () => {
        const docId = { getTimestamp: () => new Date(4000) };
        expect(broadcastRows([{ owner: 7, content: '私人提问', docId }, { owner: 0, subject: 6, content: '全场公告', docId }], [6], ['A']))
            .toEqual([{ subject: 'A', text: '全场公告', at: 4000 }]);
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO29l/8AAAAASUVORK5CYII=';
        expect(decodePoster(png).mime).toBe('image/png');
        expect(() => decodePoster(Buffer.from('<svg/>').toString('base64'))).toThrow('PNG');
    });
});

describe('big-screen data', () => {
    it('follows the board first-solve rules for highlights and the first-solves list', () => {
        const data = demoData();
        expect(highlighted(screenData(data, null, env))).toEqual(['1:0', '5:1', '7:2']);
        expect(highlighted(screenData(data, null, { ...env, firstSolve: false }))).toEqual([]);
        // Starred 苏禾 (4) solves A first: only listed and highlighted when starred participants may win it.
        const early = demoData();
        early.submissions.push({ submission_id: 'early', team_id: '4', problem_id: 0, timestamp: 60000, status: 'CORRECT' });
        expect(screenData(early, null, env).firstSolves.map((row: any) => row.teamId)).toEqual(['1', '5', '7']);
        expect(highlighted(screenData(early, null, env))).toContain('1:0');
        const allowed = screenData(early, null, { ...env, unofficialFirstSolve: true });
        expect(allowed.firstSolves.map((row: any) => row.teamId)).toEqual(['4', '5', '7']);
        expect(highlighted(allowed)).toContain('4:0');
    });
    it('limits a board to its members and shows starred participants with a star rank', () => {
        const data = demoData();
        const board = resolverBoards(data, settings, true).find((item) => item.id === 'manual-mixed')!;
        const result = screenData(data, new Set(board.teamIds), env);
        expect(result.contest.teams.map((team: { id: string }) => team.id).sort()).toEqual(['1', '4', '7']);
        expect(result.standings.find((row) => row.teamId === '4')?.rank).toBe('*');
        expect(result.standings.find((row) => row.teamId === '1')?.rank).toBe(1);
        expect(result.contest.teams.find((team: { id: string }) => team.id === '1').logo).toBe('/hydro-resolver/logos/0123456789ab.webp');
        expect(result.contest.teams.every((team: { logo: string }) => team.logo.startsWith('/hydro-resolver/'))).toBe(true);
    });
    it('keeps frozen results pending and computes first solves from visible results only', () => {
        const data = demoData();
        data.contest.frozen_time = 3600;
        data.submissions.push({ submission_id: 'late', team_id: '8', problem_id: 0, timestamp: 4 * 3600 * 1000 + 60000, status: 'FROZEN' });
        const result = screenData(data, null, env);
        expect(result.frozen).toBe(true);
        expect(result.results['8'][0]).toMatchObject({ status: 'pending' });
        expect(result.firstSolves.map((row: any) => row.teamId)).not.toContain('8');
        expect(result.stats.submissions.length % 7).toBe(0);
        // The queue reads these: a judging or frozen submission is code 2, never its hidden verdict.
        expect(result.stats.submissions.slice(-7)[3]).toBe(2);
        expect(result.contest.submissions.at(-1)).toMatchObject({ id: 'late', status: 'pending' });
        expect(result.clock.startTime).toBe(new Date(data.contest.start_time * 1000).toISOString());
    });
    it('treats unlabelled columns of the CCPC 新榜单模式 as positions, not problems', async () => {
        // A is solved by three teams (shown); B, C and D first by teams 1, 2 and 3, each in its own row's column 1.
        const run = (id: string, team: string, problem: number, minute: number) =>
            ({ submission_id: id, team_id: team, problem_id: problem, timestamp: minute * 60_000, status: 'CORRECT' });
        const data = demoData();
        data.contest = { ...data.contest, problem_quantity: 4, problem_id: ['A', 'B', 'C', 'D'], frozen_time: 3600,
            balloon_color: ['#e53935', '#1e88e5', '#43a047', '#fdd835'].map((background_color) => ({ color: '#000', background_color })) };
        data.submissions = [run('1', '1', 0, 3), run('2', '2', 0, 4), run('3', '3', 0, 6), run('4', '2', 2, 5),
            run('5', '1', 1, 10), run('6', '3', 3, 20), run('7', '5', 1, 30)];
        const hidden = hideProblemLabels(data, { enabled: true, reveal: 3, revealBasis: 'count' });
        expect(hidden.hiddenFrom).toBe(1);
        const view = screenData(hidden, null, { ...env, locked: false, tieBreak: 'ccpc' });
        const config = defaultScreenConfig();
        expect(highlighted(view)).toEqual(['1:0']);
        expect(view.firstSolves.map((row: any) => `${row.teamId}:${row.problemId}`)).toEqual(['1:0']);
        expect((screenProjection('announce', config.items.announce, view) as any[]).map((row) => [row.name, row.problem?.label ?? null, row.first]))
            .toEqual([['许青', null, false], ['陈言', null, false], ['林澈', null, false], ['陈言', 'A', false], ['周宁', null, false], ['周宁', 'A', false], ['林澈', 'A', true]]);
        expect(screenProjection('outcomes', { ...config.items.outcomes, variant: 'problem' }, view)).toEqual([{ label: 'A', counts: { CORRECT: 3 } }]);
        const stats = screenProjection('problem-stats', config.items['problem-stats'], view) as any;
        expect(stats.contest.problems.map((problem: { label: string }) => problem.label)).toEqual(['A']);
        expect(stats.stats.submissions.length).toBe(3 * 7);
        expect(Object.values(stats.results).every((cells: any) => cells.length === 1)).toBe(true);
        // The scoreboard keeps every column; the queue and the other ICPC Tools views find no first solve past them.
        expect((screenProjection('scoreboard', config.items.scoreboard, view) as any).contest.problems).toHaveLength(4);
        const { ContestView } = await import('../resolver/public/js/render/java-contest.js');
        const fts = new ContestView(screenProjection('queue', config.items.queue, view)).getAllSubmissions()
            .filter((row: { firstToSolve: boolean }) => row.firstToSolve).map((row: { teamId: string; problemIndex: number }) => `${row.teamId}:${row.problemIndex}`);
        expect(fts).toEqual(['1:0']);
        const board = new ContestView(screenProjection('scoreboard', config.items.scoreboard, view));
        expect([0, 1, 2, 3].map((index) => board.getProblemSummary(index).numSolved)).toEqual([3, 0, 0, 0]);
        // Before any problem is shown there is no problem to count.
        const none = screenData(hideProblemLabels(data, { enabled: true, reveal: 10, revealBasis: 'count' }), null, env);
        expect(() => screenProjection('problem-stats', config.items['problem-stats'], none)).toThrow('题号公开前不显示各题统计');
        expect(() => screenProjection('outcomes', { ...config.items.outcomes, variant: 'problem' }, none)).toThrow('题号公开前不显示各题统计');
        expect(screenProjection('outcomes', config.items.outcomes, none)).not.toHaveLength(0);
    });
});

describe('big-screen clocks', () => {
    it('keep the full hour count for multi-day contests instead of wrapping at 48 hours', async () => {
        const { formatTime } = await import('../resolver/public/js/render/java-contest.js');
        expect(formatTime((95 * 3600 + 59 * 60 + 59) * 1000, true)).toBe('95:59:59');
        expect(formatTime(-((50 * 3600) * 1000), true)).toBe('-50:00:00');
        expect(formatTime(-59000, true)).toBe('-0:00:59');
    });
});

describe('配对大屏', () => {
    const now = Date.UTC(2026, 10, 27);
    const claim = (code: string, name = '舞台屏') => ({ action: 'claim', code, name, type: 'scoreboard', boardId: 'official' });
    async function fresh(store: ScreenDevices, ip = 'venue', at = now) {
        const pair = await store.pair(undefined, ip, at);
        if (!('cookie' in pair) || !pair.cookie || !pair.code) throw new Error('missing pairing');
        return { code: pair.code, cookie: pair.cookie, expiresAt: pair.expiresAt };
    }
    it('formats unambiguous codes, reuses a pending cookie for ten minutes and expires it at the boundary', async () => {
        const store = new ScreenDevices(previewDatabase().db);
        expect(new Set(pairingAlphabet).size).toBe(30);
        for (let i = 0; i < 100; i++) expect(pairingCode()).toMatch(new RegExp('^[' + pairingAlphabet + ']{6}$'));
        const pair = await fresh(store);
        expect(pair.code).toMatch(/^[A-Z2-9]{3}-[A-Z2-9]{3}$/);
        expect(pair.expiresAt?.getTime()).toBe(now + 600000);
        expect(await store.pair(pair.cookie, 'venue', now + 599999)).toEqual({ code: pair.code, expiresAt: pair.expiresAt });
        await expect(store.action('a', claim(pair.code), ['official'], now + 600000)).rejects.toThrow('过期');
        expect(await store.pair(pair.cookie, 'venue', now + 600000)).toHaveProperty('cookie');
    });
    it('enforces concurrent per-IP, global pending and per-contest device limits across workers', async () => {
        const { db, tables } = previewDatabase();
        const workers = [new ScreenDevices(db), new ScreenDevices(db)];
        await workers[0].ensureIndexes();
        const results = await Promise.allSettled(Array.from({ length: 16 }, (_, i) => fresh(workers[i % 2])));
        expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(10);
        await expect(fresh(workers[0])).rejects.toThrow('10');
        const pending = tables.get('xcpcio.screens.pairings')!;
        const used = new Set([...pending.values()].map(p => p.globalSlot));
        for (let slot = 0; slot < 500; slot++) if (!used.has(slot)) pending.set('pair' + slot, {
            _id: 'pair' + slot, globalSlot: slot, ip: 'other' + slot, ipSlot: 0, expiresAt: new Date(now + 600000),
        });
        await expect(fresh(workers[1], 'new')).rejects.toThrow('500');
        const next = await fresh(workers[0], 'new', now + 600001);
        const devices = tables.get('xcpcio.screens.devices')!;
        for (let slot = 0; slot < 50; slot++) devices.set('screen' + slot, { _id: 'screen' + slot, contestKey: 'full', slot });
        await expect(workers[1].action('full', claim(next.code), ['official'], now + 600001)).rejects.toThrow('50');
        await workers[0].action('other', claim(next.code), ['official'], now + 600001);
        expect(await workers[1].list('other')).toHaveLength(1);
    });
    it('claims a code once, reissues kiosk credentials and repairs an existing screen without losing its settings', async () => {
        const { db } = previewDatabase();
        const first = new ScreenDevices(db), second = new ScreenDevices(db);
        await first.ensureIndexes();
        const pair = await fresh(first);
        const claims = await Promise.allSettled([first, second].map(store => store.action('a', claim(pair.code.toLowerCase()), ['official'], now)));
        expect(claims.filter(r => r.status === 'fulfilled')).toHaveLength(1);
        const doc = (await first.authenticate(pair.cookie))!;
        expect(doc.secretHash).not.toBe(pair.cookie);
        expect(await second.pair(pair.cookie, 'new')).toEqual({ paired: true });
        const edit = (action: string, fields = {}) => first.action('a', { id: doc._id, action, ...fields }, ['official'], now);
        await edit('edit', { type: 'tiles', scale: 1.5 });
        await expect(edit('edit', { scale: 2.1 })).rejects.toThrow('缩放');
        const token = async () => (await edit('link')).link!.split('/').pop()!;
        const original = await token(), originalCookie = (await second.redeem(original))!;
        expect((await second.authenticate(originalCookie))?._id).toBe(doc._id);
        expect(await second.authenticate(original)).toBeNull();
        const replacement = await token();
        expect(await first.redeem(original)).toBeNull();
        expect(await first.authenticate(originalCookie)).toBeNull();
        expect(await first.authenticate(pair.cookie)).toBeTruthy();
        const repaired = await fresh(second);
        await edit('repair', { code: repaired.code });
        expect(await first.redeem(replacement)).toBeNull();
        expect(await second.authenticate(pair.cookie)).toBeNull();
        expect(await second.authenticate(repaired.cookie)).toMatchObject({ name: '舞台屏', type: 'tiles', boardId: 'official', scale: 1.5 });
        await edit('identify'); await edit('reload');
        expect(await first.authenticate(repaired.cookie)).toMatchObject({ identifyUntil: now + 5000, reloadAt: now });
        expect(await second.revoke('a')).toBe(1);
        expect(await first.authenticate(repaired.cookie)).toBeNull();
        expect(await first.list('a')).toMatchObject([{ paired: false, online: false, name: '舞台屏' }]);
        await edit('delete');
        expect(await first.list('a')).toEqual([]);
    });
    it('overrides only standings boards, writes changed telemetry immediately and expires online status after 15s', async () => {
        const item = defaultScreenConfig().items.scoreboard;
        expect(deviceItem('scoreboard', item, 'official').boardId).toBe('official');
        expect(deviceItem('scoreboard', item, null)).toBe(item);
        expect(deviceItem('message', item, 'official')).toBe(item);
        const store = new ScreenDevices(previewDatabase().db);
        const pair = await fresh(store);
        await store.action('a', claim(pair.code), ['official'], now);
        const client = screenClient({ width: 1920, height: 1080, fullscreen: true, dpr: 2 }, 'ip', 'browser');
        await store.heartbeat((await store.authenticate(pair.cookie))!, client, now);
        const doc = (await store.authenticate(pair.cookie))!;
        expect(doc.client).toEqual(client);
        expect(writeHeartbeat(doc, client, now + 9999)).toBe(false);
        expect(writeHeartbeat(doc, client, now + 10000)).toBe(true);
        expect(writeHeartbeat(doc, { ...client, fullscreen: false }, now + 1)).toBe(true);
        expect(screenOnline(doc.lastSeen, now + 15000)).toBe(true);
        expect((await store.list('a', now + 15001))[0].online).toBe(false);
    });
    it('queues remote keys, retires them with receipts and keeps thumbnails only while watched', async () => {
        const store = new ScreenDevices(previewDatabase().db);
        const pair = await fresh(store);
        await store.action('a', claim(pair.code), ['official'], now);
        const device = (await store.authenticate(pair.cookie))!;
        await expect(store.action('a', { id: device._id, action: 'edit' }, ['official'], now)).rejects.toThrow('设备设置无效');
        await expect(store.action('a', { id: device._id, action: 'key', key: 'reboot' }, ['official'], now)).rejects.toThrow('未知按键');
        const sent = [];
        for (let i = 0; i < 12; i++) sent.push((await store.action('a', { id: device._id, action: 'key', key: i % 2 ? 'next' : 'pause' }, ['official'], now + i)).command!);
        let doc = (await store.authenticate(pair.cookie))!;
        expect(doc.commands!.map(c => c.id)).toEqual(sent.slice(-10).map(c => c.id));
        expect(deviceState(doc, now).commands).toHaveLength(10);
        // Unknown ids are ignored; the screen's receipt state is trimmed to known fields.
        expect(remoteAcks([{ id: 'nope', ok: true }], doc.commands!, now)).toEqual([]);
        const last = sent.at(-1)!;
        await store.acknowledge(doc, [{ id: last.id, ok: true, message: 'x'.repeat(500), state: { page: 2, pages: 5, paused: false, evil: 1 } }], now + 50);
        expect(doc.commands).toHaveLength(9);
        doc = (await store.authenticate(pair.cookie))!;
        expect(doc.commands).toHaveLength(9);
        expect(doc.ack).toMatchObject({ id: last.id, key: 'next', ok: true, state: { page: 2, pages: 5, paused: false } });
        expect(doc.ack!.message).toHaveLength(120);
        expect((await store.list('a', now))[0]).toMatchObject({ ack: { id: last.id }, pending: expect.any(Array) });
        const image = { kind: 'image', data: 'data:image/webp;base64,AAAA', width: 1920, height: 1080, type: 'scoreboard' };
        expect(await store.saveThumb(doc, image, now)).toBe(false);
        await store.watch('a', now);
        expect(deviceState((await store.authenticate(pair.cookie))!, now + 14999).watch).toBe(true);
        expect(deviceState((await store.authenticate(pair.cookie))!, now + 15000).watch).toBe(false);
        doc = (await store.authenticate(pair.cookie))!;
        expect(await store.saveThumb(doc, image, now + 1)).toBe(true);
        expect(await store.saveThumb(doc, image, now + 2000)).toBe(false);
        expect(await store.thumb('a', doc._id)).toMatchObject({ kind: 'image', at: now + 1 });
        expect(await store.thumb('other', doc._id)).toBeNull();
        expect((await store.list('a', now))[0].thumb).toEqual({ at: now + 1, type: 'scoreboard', kind: 'image' });
        expect(await store.revoke('a')).toBe(1);
        expect(await store.thumb('a', doc._id)).toBeNull();
    });
    it('accepts screen markup without scripts and frames only as images', () => {
        const html = (data: string) => ({ kind: 'html', data, width: 1280, height: 720, type: 'judges' });
        expect(screenThumb(html('<main id="screen-content" data-type="judges"><p>评测机</p></main>'), now)).toMatchObject({ kind: 'html', at: now });
        for (const bad of ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '<a href="javascript:x">', '<meta http-equiv=refresh content=0>',
            '<iframe srcdoc=x>', '<LINK rel=stylesheet>', '< / base href=//evil>', '<form action=//evil>']) {
            expect(() => screenThumb(html(bad), now), bad).toThrow('缩略图无效');
        }
        expect(() => screenThumb({ kind: 'image', data: 'data:image/svg+xml;base64,AAAA', width: 10, height: 10, type: 'clock' }, now)).toThrow();
        expect(() => screenThumb({ kind: 'image', data: 'data:image/png;base64,' + 'A'.repeat(100 * 1024), width: 10, height: 10, type: 'clock' }, now)).toThrow();
        expect(() => screenThumb({ ...html('<p>x</p>'), type: 'nope' }, now)).toThrow();
        expect(() => screenThumb({ ...html('<p>x</p>'), width: 0 }, now)).toThrow();
    });
    it('zooms the ICPC scoreboard family by showing fewer rows and leaves other canvas screens alone', () => {
        expect([...scalableTypes].every(type => screenTypes.includes(type))).toBe(true);
        for (const type of ['clock', 'countdown', 'tiles', 'message', 'logo-wall']) expect(scalableTypes.has(type as never)).toBe(false);
        const ctx = new Proxy({}, { get: (_target, key) => key === 'canvas' ? {} : () => ({ width: 0 }) }) as unknown as CanvasRenderingContext2D;
        const host = new PortHost(() => null);
        const draw = (scale: number) => {
            try { host.render(ctx, { contest: { problems: [], teams: [] }, standings: [] }, { type: 'scoreboard' }, '', { width: 1920, height: 1080, now: 0, elapsed: 0, words: {}, scale }); } catch { /* the stub cannot paint */ }
            return (host as unknown as { instance: { teamsPerScreen: number } }).instance.teamsPerScreen;
        };
        expect(draw(1)).toBe(12);
        expect(draw(1.5)).toBe(8);
        expect(draw(0.6)).toBe(20);
        expect(draw(2)).toBe(6);
    });
});
