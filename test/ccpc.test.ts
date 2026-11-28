import { describe, expect, it } from 'vitest';
import { balloonLook, defaultBalloonSettings, firstNumbers, normalizeBalloonSettings, teamPalette } from '../lib/balloons';
import { enhanceBoard, type BoardData } from '../lib/board';
import { createContest, createTeams, createSubmissions, MedalType, Rank } from './engine';
import { ccsFixture } from './ccs-fixture';
import { buildObjects } from '../lib/ccs/model';
import { ceremonyDefaults, ceremonySlides } from '../lib/ceremony-slides';
import { applyBoardRules, dropAfterAccept, hideProblemLabels, labelsHidden, revealThreshold } from '../lib/ccpc-board';
import { buildContestInfo, buildRuns } from '../lib/live/model';
import { computeScoreboard, runsByTeam, statistics } from '../lib/live/scoreboard';
import { FirstSolveBulletin, medalCutoff, problemFocus } from '../lib/live/broadcast';
import { contestPhase, patchBoard, presetOf, presets } from '../lib/control';
import { boardSealed, defaultCaptureSettings, streamAllowed } from '../lib/live/capture';
import { filterChanges, lastChange, reviewChanges, staleSessions, type ReviewItem } from '../lib/rejudge-review';
import { defaultSettings, normalizeSettings } from '../lib/settings';
import { defaultResolverConfig, prepareResolver, resolverBoards } from '../lib/resolver-data';
import { resultBoard, standingsCsv } from '../lib/results';
import { demoData } from './fixture';
import { compareStandings, sameStanding, scoreStandings } from '../resolver/public/js/standings.js';
import { schoolRanks, trophyWinners } from '../resolver/public/js/trophies.js';

const minute = 60;
const solved = (seconds: number) => ({ status: 'solved', time: Math.floor(seconds / minute), timeSeconds: seconds, penaltyCount: 0 });

describe('CCPC ranking', () => {
    // 甲 solves at 10:10 and 50:10, 乙 at 20:08 and 40:18: both 60 minutes under the minute rules.
    const teams = [{ id: 'a', name: '甲' }, { id: 'b', name: '乙' }];
    const results = { a: [solved(610), solved(3010)], b: [solved(1208), solved(2418)] };
    const rank = (tieBreak: 'hydro' | 'icpc' | 'ccpc') => scoreStandings({ scoringMode: 'hydro', tieBreak, teams }, results).map((row) => [row.teamId, row.rank]);

    it('ties teams equal in solved and minutes, listing the earlier last accept first', () => {
        expect(rank('hydro')).toEqual([['a', 1], ['b', 2]]);
        expect(rank('icpc')).toEqual([['b', 1], ['a', 2]]);
        expect(rank('ccpc')).toEqual([['b', 1], ['a', 1]]);
        const [first, second] = scoreStandings({ scoringMode: 'hydro', tieBreak: 'ccpc', teams }, results);
        expect(sameStanding({ scoringMode: 'hydro', tieBreak: 'ccpc' }, first, second)).toBe(true);
        expect(compareStandings({ scoringMode: 'hydro', tieBreak: 'ccpc' }, first, second)).toBeLessThan(0);
    });

    it('gives the trophy to the earlier last accept (附录二), or to both when shared', () => {
        const rows = [
            { teamId: 'b', official: true, solved: 2, school: '乙校', lastAcceptMs: 2418_000, time: 60 },
            { teamId: 'a', official: true, solved: 2, school: '甲校', lastAcceptMs: 3010_000, time: 60 },
            { teamId: 'c', official: true, solved: 1, school: '丙校', lastAcceptMs: 900_000, time: 15 },
        ];
        const same = (x: { solved: number; time: number }, y: { solved: number; time: number }) => x.solved === y.solved && x.time === y.time;
        expect(trophyWinners(rows, { basis: 'school', tie: 'lastAccept', names: ['冠军', '亚军', '季军'] }, same).map((trophy) => [trophy.name, trophy.teamIds]))
            .toEqual([['冠军', ['b']], ['亚军', ['a']], ['季军', ['c']]]);
        expect(trophyWinners(rows, { basis: 'school', tie: 'shared', names: ['冠军', '亚军', '季军'] }, same).map((trophy) => [trophy.name, trophy.teamIds]))
            .toEqual([['冠军', ['b', 'a']], ['季军', ['c']]]);
    });
});

describe('school ranks and trophies', () => {
    // 甲1, 甲2, 乙1, 丙1 with different results; 星 is unofficial and leads.
    const rows = [
        { teamId: 'star', official: false, solved: 9, school: '星校', lastAcceptMs: 1 },
        { teamId: 'a1', official: true, solved: 8, school: '甲', lastAcceptMs: 1 },
        { teamId: 'a2', official: true, solved: 7, school: '甲', lastAcceptMs: 1 },
        { teamId: 'b1', official: true, solved: 6, school: '乙', lastAcceptMs: 1 },
        { teamId: 'c1', official: true, solved: 5, school: '丙', lastAcceptMs: 1 },
        { teamId: 'd1', official: true, solved: 0, school: '丁', lastAcceptMs: null },
    ];
    const same = (x: { solved: number }, y: { solved: number }) => x.solved === y.solved;

    it('ranks schools by their best official team; other teams share the next school rank', () => {
        expect(Object.fromEntries(schoolRanks(rows, same))).toEqual({ a1: 1, a2: 2, b1: 2, c1: 3, d1: 4 });
    });

    it('gives trophies to official teams that solved something, one per school when by school', () => {
        const names = ['冠军', '亚军', '季军'];
        expect(trophyWinners(rows, { basis: 'team', names }, same).flatMap((trophy) => trophy.teamIds)).toEqual(['a1', 'a2', 'b1']);
        expect(trophyWinners(rows, { basis: 'school', names }, same).flatMap((trophy) => trophy.teamIds)).toEqual(['a1', 'b1', 'c1']);
        expect(trophyWinners(rows.slice(0, 2), { basis: 'school', names }, same).map((trophy) => trophy.place)).toEqual([0]);
    });

    it('keeps the new settings, and settings saved before them still load', () => {
        const settings = normalizeSettings({ ...defaultSettings, tieBreak: 'ccpc', podiumBasis: 'school', podiumTie: 'shared', podiumNames: ['金杯', ' 银杯 '], medalRanking: 'school' });
        expect(settings).toMatchObject({ tieBreak: 'ccpc', podiumBasis: 'school', podiumTie: 'shared', podiumNames: ['金杯', '银杯'], medalRanking: 'school' });
        const legacy = normalizeSettings({ manualBoards: [], medals: { gold: 1, silver: 1, bronze: 1 } });
        expect(legacy).toMatchObject({ tieBreak: 'hydro', podiumBasis: 'team', podiumTie: 'lastAccept', podiumNames: ['冠军', '亚军', '季军'], medalRanking: 'team' });
        expect(legacy.ccpcBoard).toEqual({ enabled: false, revealBasis: 'count', reveal: 50, revealPercent: 20 });
        expect(() => normalizeSettings({ manualBoards: [], podiumNames: [] })).toThrow('奖杯应有 1 至 10 个');
        expect(() => normalizeSettings({ manualBoards: [], ccpcBoard: { enabled: true, revealBasis: 'percent', reveal: 120 } })).toThrow('1% 至 100%');
        expect(normalizeSettings({ manualBoards: [], ccpcBoard: { enabled: true, revealBasis: 'percent' } }).ccpcBoard.reveal).toBe(20);
        expect(normalizeSettings({ manualBoards: [], ccpcBoard: { enabled: true, revealBasis: 'min', reveal: 30, revealPercent: 15 } }).ccpcBoard)
            .toEqual({ enabled: true, revealBasis: 'min', reveal: 30, revealPercent: 15 });
        expect(() => normalizeSettings({ manualBoards: [], ccpcBoard: { enabled: true, revealBasis: 'min', revealPercent: 0 } })).toThrow('比例应为 1% 至 100%');
    });
});

describe('CCPC 新榜单模式', () => {
    const run = (id: string, team: string, problem: number, minutes: number, status = 'CORRECT') => ({ submission_id: id, team_id: team, problem_id: problem, timestamp: minutes * 60_000, status });
    const data: BoardData = {
        contest: { contest_name: 'C', start_time: 0, end_time: 18000, problem_quantity: 4, problem_id: ['A', 'B', 'C', 'D'],
            balloon_color: ['#a00', '#0a0', '#00a', '#aa0'].map((background) => ({ color: '#fff', background_color: background })) },
        teams: ['1', '2', '3'].map((id) => ({ team_id: id, name: `队 ${id}`, group: ['official'] })),
        submissions: [
            run('a1', '1', 0, 10), run('a2', '2', 0, 12),
            // Team 1: D accepted at 30, then B tried at 40 and C at 20.
            run('d1', '1', 3, 30), run('b1', '1', 1, 40, 'WRONG_ANSWER'), run('c1', '1', 2, 20, 'WRONG_ANSWER'),
            // Team 2 submits A again after its accept.
            run('a3', '2', 0, 50, 'WRONG_ANSWER'),
        ],
    };

    it('shows a label once enough teams solved it, and orders each row on its own', () => {
        expect(revealThreshold({ revealBasis: 'count', reveal: 2 }, 300)).toBe(2);
        expect(revealThreshold({ revealBasis: 'percent', reveal: 20 }, 259)).toBe(51);
        expect(revealThreshold({ revealBasis: 'percent', reveal: 20 }, 3)).toBe(1);
        // The smaller of 30 teams and 15% of the teams: 15% of 259 is 38, of 100 is 15.
        expect(revealThreshold({ revealBasis: 'min', reveal: 30, revealPercent: 15 }, 259)).toBe(30);
        expect(revealThreshold({ revealBasis: 'min', reveal: 30, revealPercent: 15 }, 100)).toBe(15);
        expect(revealThreshold({ revealBasis: 'min', reveal: 30, revealPercent: 15 }, 4)).toBe(1);
        const hidden = hideProblemLabels(data, { enabled: true, revealBasis: 'count', reveal: 2 });
        expect(hidden.hiddenFrom).toBe(1);
        expect(hidden.contest.problem_id).toEqual(['A', '', '', '']);
        expect((hidden.contest.balloon_color as { background_color: string }[]).map((color) => color.background_color)).toEqual(['#a00', '#e2e8f0', '#e2e8f0', '#e2e8f0']);
        const slots = (team: string) => Object.fromEntries(hidden.submissions.filter((item) => item.team_id === team).map((item) => [item.submission_id, item.problem_id]));
        // A shown; then D (accepted); then C (last tried at 20) before B (at 40).
        expect(slots('1')).toEqual({ a1: 0, d1: 1, c1: 2, b1: 3 });
        // Team 3 tried nothing: its row keeps the problems by number.
        expect(hidden.submissions.length).toBe(data.submissions.length);
    });

    it('applies until the freeze, to public views only; submissions after an accept are left out everywhere', () => {
        const board = { enabled: true, revealBasis: 'count' as const, reveal: 2, revealPercent: 20 };
        const contest = { beginAt: new Date(0), endAt: new Date(18000_000), lockAt: new Date(14400_000) };
        expect(labelsHidden(board, contest, 3600_000)).toBe(true);
        expect(labelsHidden(board, contest, 14400_000)).toBe(true);
        expect(labelsHidden(board, contest, 14400_001)).toBe(false);
        expect(labelsHidden(board, { ...contest, lockAt: null }, 17000_000)).toBe(true);
        expect(labelsHidden({ ...board, enabled: false }, contest, 3600_000)).toBe(false);
        expect(dropAfterAccept(data).submissions.map((item) => item.submission_id)).not.toContain('a3');
        const settings = { ccpcBoard: board, ignoreAfterAccept: true };
        expect(applyBoardRules(data, settings, contest, 3600_000, true).hiddenFrom).toBeUndefined();
        expect(applyBoardRules(data, settings, contest, 3600_000, false).hiddenFrom).toBe(1);
        expect(applyBoardRules(data, { ...settings, ignoreAfterAccept: false }, contest, 3600_000, true)).toBe(data);
    });

    it('supports CCPC hidden-label board mode in ICPC Live without leaking hidden problem identities or fake FTS', () => {
        const hidden = hideProblemLabels(data, { enabled: true, revealBasis: 'count', reveal: 2 });
        const settings = normalizeSettings({ ...defaultSettings, firstSolve: true, ccpcBoard: { enabled: true, revealBasis: 'count', reveal: 2 } });
        const liveSource = {
            contest: { title: 'C', beginAt: new Date(0), endAt: new Date(18000_000), lockAt: new Date(14400_000) },
            data: hidden, settings, identity: true, logoNames: {}, now: 3600_000, boards: resolverBoards(hidden, settings, true),
        };
        const info = buildContestInfo(liveSource);
        // Column 0 (A) is revealed; columns 1..3 remain visible with blank labels and hidden FTS mode.
        expect(info.problems.map((p) => p.letter)).toEqual(['A', '', '', '']);
        expect(info.problems.every((p) => !p.isHidden)).toBe(true);
        expect(info.problems[1].ftsMode).toEqual({ type: 'hidden' });
        expect(info.customFields?.hydroHiddenFrom).toBe('1');
        const runs = buildRuns(liveSource, info);
        // Solved count & penalty still include Team 1's anonymous slot solve (2 solved total).
        const boardState = computeScoreboard(info, runsByTeam(runs), 'normal');
        expect(boardState.rows.get('1')?.totalScore).toBe(2);
        // FTS is only marked for revealed column A, never for anonymous slot 1.
        const fts = runs.filter((r) => r.result.type === 'ICPC' && r.result.isFirstToSolveRun);
        expect(fts.map((r) => r.problemId)).toEqual(['0']);
        // Statistics zero out anonymous columns instead of aggregating unrelated problems across teams.
        const stats = statistics(info, boardState, runs);
        expect(stats.stats[0].success).toBe(2);
        expect(stats.stats.slice(1)).toEqual([{ success: 0, wrong: 0, pending: 0 }, { success: 0, wrong: 0, pending: 0 }, { success: 0, wrong: 0, pending: 0 }]);
        // ProblemFocus ignores hidden slots and works on revealed column A.
        expect(problemFocus(info, runs, '1', 'all')).toBeNull();
        expect(problemFocus(info, runs, '0', 'all')?.solved).toBe(2);
        // FirstSolveBulletin only announces revealed columns and clears stale FTS when rejudged away.
        const bulletin = new FirstSolveBulletin();
        bulletin.update(info, new Map(), true, false, 3500_000);
        const winners = new Map<string, typeof runs>([['0', [runs[0]]], ['1', [runs[2]]]]);
        bulletin.update(info, winners, true, false, 3600_000);
        expect(bulletin.items(3600_000).map((item) => item.problem)).toEqual(['A']);
        bulletin.update(info, new Map(), true, false, 3601_000);
        expect(bulletin.items(3601_000)).toEqual([]);
    });
});

describe('balloons in CCPC style', () => {
    const colors = ['红', '绿', '蓝', '黄'].map((name, index) => ({ name, hex: `#00000${index}` }));
    const pids = [1, 2, 3, 4];

    it('holds balloons after the freeze by default and reads the CCPC options', () => {
        expect(defaultBalloonSettings().afterFreeze).toBe('hold');
        const settings = normalizeBalloonSettings({ first: { style: 'sequence', labels: 'letter', color: { hex: '#d4af37', name: '' } }, teamColors: true }, pids);
        expect(settings.first).toEqual({ style: 'sequence', labels: 'letter', color: { hex: '#d4af37', name: '金' } });
        expect(settings.teamColors).toBe(true);
        expect(() => normalizeBalloonSettings({ first: { style: 'random' } }, pids)).toThrow('一血气球的方式无效');
    });

    it('gives each team its own colours, the same every time, from a secret seed', () => {
        const palette = teamPalette(colors, 'seed', 7);
        expect(palette).toEqual(teamPalette(colors, 'seed', 7));
        expect(new Set(palette.map((color) => color?.name))).toEqual(new Set(colors.map((color) => color.name)));
        const others = Array.from({ length: 20 }, (_, uid) => teamPalette(colors, 'seed', uid).map((color) => color?.name).join());
        expect(new Set(others).size).toBeGreaterThan(5);
        expect(teamPalette(colors, 'other', 7).map((color) => color?.name).join()).not.toBe(palette.map((color) => color?.name).join());
    });

    it('marks first solves by the contest-wide order, not the problem', () => {
        const balloons = [
            { key: 'k/1/3', uid: 1, pid: 3, submittedAt: 5000, seq: 2 }, { key: 'k/2/1', uid: 2, pid: 1, submittedAt: 3000, seq: 1 },
            { key: 'k/3/3', uid: 3, pid: 3, submittedAt: 9000, seq: 3 },
        ];
        const first = new Set(['k/1/3', 'k/2/1']);
        const numbers = firstNumbers(balloons, first);
        expect(Object.fromEntries(numbers)).toEqual({ 'k/2/1': 1, 'k/1/3': 2 });
        const look = (settings: Parameters<typeof balloonLook>[1]['settings'], balloon = balloons[0]) => balloonLook(balloon, { settings, pids, colors, seed: 's', first, numbers });
        const base = defaultBalloonSettings();
        expect(look(base)).toMatchObject({ color: colors[2], firstLabel: '本题一血' });
        expect(look({ ...base, first: { ...base.first, style: 'uniform' } })).toMatchObject({ color: base.first.color, firstLabel: '一血' });
        expect(look({ ...base, first: { ...base.first, style: 'sequence', labels: 'letter' } })).toMatchObject({ firstLabel: '一血 B' });
        expect(look({ ...base, teamColors: true }, balloons[2])).toMatchObject({ color: teamPalette(colors, 's', 3)[2], firstLabel: '' });
    });
});

describe('public screens after the end', () => {
    it('stay sealed until the board is unlocked', () => {
        const settings = { ...defaultCaptureSettings(), enabled: true, screenDuringContest: false };
        const contest = { endAt: new Date(10_000), lockAt: new Date(8_000), unlocked: false };
        expect(boardSealed(contest)).toBe(true);
        expect(streamAllowed('screen', 'overlay', settings, contest, 20_000)).toBe(false);
        expect(streamAllowed('screen', 'staff', settings, contest, 20_000)).toBe(true);
        expect(streamAllowed('screen', 'overlay', settings, { ...contest, unlocked: true }, 20_000)).toBe(true);
        expect(streamAllowed('screen', 'overlay', settings, { endAt: new Date(10_000) }, 20_000)).toBe(true);
    });
});

describe('重测复核', () => {
    const item = (rid: string, job: string, jobAt: number, before: number, after: number | null, extra: Partial<ReviewItem> = {}): ReviewItem => ({
        rid, job, jobAt, pid: 100, before, beforeScore: before === 1 ? 100 : 0, after, afterScore: after === 1 ? 100 : 0, judgedAt: after === null ? null : jobAt + 1000, ...extra,
    });

    it('lists each moved result once, from the first rejudge to the latest', () => {
        const items = [
            item('r1', 'j1', 1000, 1, 2), item('r1', 'j2', 5000, 2, 3),
            item('r2', 'j1', 1000, 2, 1),
            item('r3', 'j1', 1000, 2, 2),
            item('r4', 'j1', 1000, 1, null),
            item('r5', 'j1', 1000, 1, 2, { restored: { at: 9000, by: 1 } }),
        ];
        const { changes, pending } = reviewChanges(items, new Map([['r1', 3], ['r2', 1], ['r3', 2], ['r4', 1], ['r5', 1]]));
        expect(pending).toBe(1);
        expect(changes.map((change) => [change.rid, change.original, change.rejudged, change.kind, change.state])).toEqual([
            ['r1', 1, 3, 'lostAccept', 'kept'], ['r2', 2, 1, 'gainedAccept', 'kept'], ['r5', 1, 2, 'lostAccept', 'restored'],
        ]);
        expect(changes[0].jobs).toEqual(['j1', 'j2']);
        expect(lastChange(changes)).toBe(9000);
        expect(filterChanges(changes, { kinds: ['lostAccept'], states: ['kept'] }, () => true).map((change) => change.rid)).toEqual(['r1']);
        expect(filterChanges(changes, { affecting: true }, (change) => change.rid === 'r2').map((change) => change.rid)).toEqual(['r2']);
        const moved = reviewChanges(items, new Map([['r1', 1]])).changes.find((change) => change.rid === 'r1');
        expect(moved?.state).toBe('moved');
    });

    it('flags resolver sessions built before the latest change', () => {
        const sessions = [{ id: 'old', createdAt: new Date(2000) }, { id: 'new', createdAt: new Date(10_000) }];
        expect(staleSessions(sessions, 9000).map((session) => session.id)).toEqual(['old']);
        expect(staleSessions(sessions, null)).toEqual([]);
    });
});

describe('赛事中控', () => {
    it('applies a 赛制 and recognises it again', () => {
        const ccpc = patchBoard(normalizeSettings({ ...defaultSettings, medals: { gold: 4, silver: 6, bronze: 9 } }), presets.ccpc.board as Record<string, unknown>);
        expect(ccpc).toMatchObject({ tieBreak: 'ccpc', ignoreAfterAccept: true, podiumBasis: 'school', medals: { gold: 4, silver: 6, bronze: 9 } });
        expect(ccpc.ccpcBoard).toEqual({ enabled: true, revealBasis: 'count', reveal: 50, revealPercent: 20 });
        const balloons = normalizeBalloonSettings({ enabled: true, ...presets.ccpc.balloons }, []);
        expect(presetOf(ccpc, balloons)).toBe('ccpc');
        expect(presetOf(ccpc, { ...balloons, teamColors: false })).toBeNull();
        expect(presetOf(patchBoard(ccpc, { tieBreak: 'icpc' }), null)).toBeNull();
        expect(presetOf(normalizeSettings(defaultSettings), null)).toBe('hydro');
        expect(() => patchBoard(ccpc, { tieBreak: 'other' })).toThrow('同分规则无效');
    });

    it('tells the contest phase, the freeze continuing after the end until unlocked', () => {
        const contest = { beginAt: new Date(1000), endAt: new Date(5000), lockAt: new Date(4000), unlocked: false };
        expect([0, 2000, 4500, 6000].map((now) => contestPhase(contest, now))).toEqual(['before', 'running', 'frozen', 'sealed']);
        expect(contestPhase({ ...contest, unlocked: true }, 6000)).toBe('ended');
        expect(contestPhase({ ...contest, lockAt: null }, 4500)).toBe('running');
    });
});

describe('every channel names the same winners', () => {
    it.each([
        { ranking: 'team', sameScore: true, second: 20, gold: ['1', '4'], silver: ['2', '3', '5'], bronze: ['6', '7'] },
        { ranking: 'team', sameScore: false, second: 20, gold: ['1', '4'], silver: ['2', '5'], bronze: ['3', '6', '7'] },
        { ranking: 'team', sameScore: true, second: 15, gold: ['1', '4'], silver: ['2'], bronze: ['3', '5', '6', '7'] },
        { ranking: 'school', sameScore: true, second: 15, gold: ['1', '4'], silver: ['2', '3', '5'], bronze: ['6', '7'] },
    ] as const)('agrees on starred medals with $ranking ranking, shared medals $sameScore and team 2 at minute $second', (scenario) => {
        const source = ccsFixture();
        const data = source.full;
        // Teams 1 and 2 share a school. 4 leads outright, 5 ties team 3, 6 sits between 3 and 7, 8 has no solves.
        const times = [10, scenario.second, 20, 5, 20, 25, 30];
        const starred = new Set(['4', '5', '6', '8']);
        data.teams = data.teams.map((team, index) => ({
            ...team, name: 'T' + team.team_id, organization: ['A', 'A', 'B', 'X', 'Y', 'Z', 'C', 'X'][index],
            group: [starred.has(team.team_id) ? 'unofficial' : 'official'],
        }));
        data.submissions = times.map((time, index) => ({
            team_id: String(index + 1), submission_id: 's' + index, problem_id: 0, timestamp: time * 60_000, status: 'CORRECT',
        }));
        const settings = normalizeSettings({ ...defaultSettings, showIdentity: true, medals: { gold: 1, silver: 1, bronze: 2 },
            unofficialMedals: true, medalSameScore: scenario.sameScore, medalRanking: scenario.ranking });
        const boards = resolverBoards(data, settings, true);
        const enhanced = enhanceBoard(data, settings);
        const contest = createContest(enhanced.contest as never);
        const rank = new Rank(contest, createTeams(enhanced.teams), createSubmissions(enhanced.submissions, contest));
        rank.buildRank();
        const resultsSource = { data, settings, ...source.contest, at: source.now, problemIds: [100, 101, 102], coaches: {} };
        const result = resultBoard(resultsSource, 'all');
        // The team names and other text fields in this fixture contain no commas.
        const csv = standingsCsv(result).trimEnd().split('\r\n').slice(1).map(line => line.split(','));
        const presentation = ceremonySlides(resultsSource, ceremonyDefaults, {}).slides;
        const game = prepareResolver(data, boards, { ...defaultResolverConfig(settings, true), freezeMode: 'custom', freezeAtSeconds: 900 },
            { contestId: 'c', ended: true, capturedAt: new Date(source.now), logoNames: {} }).game;
        const resolverAwards = game.contest.awards as { id: string; teamIds: string[] }[];
        const ccs = buildObjects({ ...source, settings, full: data, public: data, boards, publicBoards: boards }, 'public');
        const live = { data, boards, settings, identity: true, logoNames: {}, now: source.now, contest: {
            title: 'C', beginAt: new Date(source.contest.beginAt), endAt: new Date(source.contest.endAt), lockAt: null,
        } };
        const info = buildContestInfo(live);
        const state = computeScoreboard(info, runsByTeam(buildRuns(live, info)), 'normal');

        for (const [tier, kind, label] of [['gold', MedalType.GOLD, '金奖'], ['silver', MedalType.SILVER, '银奖'], ['bronze', MedalType.BRONZE, '铜奖']] as const) {
            const expected = scenario[tier];
            const awardId = tier + '-medal';
            expect(rank.teams.filter(team => team.awards.includes(kind)).map(team => team.id).sort(), 'XCPCIO ' + label).toEqual(expected);
            expect(resolverAwards.find(award => award.id === 'medal-' + tier)?.teamIds.slice().sort(), '滚榜 ' + label).toEqual(expected);
            expect(state.ranking.awards.find(award => award.id === awardId)?.teams.slice().sort(), 'Live ' + label).toEqual(expected);
            expect(ccs.awards.find(award => award.id === awardId)?.team_ids?.slice().sort(), 'CCS ' + label).toEqual(expected);
            expect(result.rows.filter(row => row.medals.includes(label)).map(row => row.id).sort(), '成绩 ' + label).toEqual(expected);
            expect(csv.filter(row => row[9] === `"${label}"`).map(row => row[2]).sort(), '成绩 CSV ' + label).toEqual(expected);
            expect(presentation.flatMap(slide => slide.kind === 'award' && slide.tier === tier ? slide.teams.map(team => team.name.slice(1)) : []).sort(), '颁奖 ' + label).toEqual(expected);
        }
        expect(result.rows.filter(row => starred.has(row.id)).every(row => row.rank === 0 && row.schoolRank === 0)).toBe(true);
        expect(csv.filter(row => starred.has(row[2])).every(row => row[0] === '"*"' && row[1] === '"*"')).toBe(true);
        expect(medalCutoff(info, state, 'all', 'gold')).toMatchObject({ inside: { name: 'T1', rank: 1 }, outside: { name: 'T2', rank: 2 } });
    });

    // demo: 林澈 (南京晓庄) 3 solved, 陈言 (南京邮电) 3, 周宁 (南京晓庄) 2, 许青 (东南) 2; 苏禾 and 江屿 are unofficial.
    const settings = normalizeSettings({ ...defaultSettings, tieBreak: 'ccpc', podiumEnabled: true, podiumBasis: 'school', medals: { gold: 1, silver: 1, bronze: 1 }, medalRanking: 'school' });
    const data = demoData();
    const ended = { beginAt: data.contest.start_time * 1000, endAt: data.contest.end_time * 1000 };

    it('in the results export (as Live and the CCS API) and in the resolver', () => {
        const result = resultBoard({ data, settings, at: ended.endAt + 1000, ...ended, lockAt: null, unlocked: true, problemIds: [1, 2, 3], coaches: {} }, 'all');
        const byName = Object.fromEntries(result.rows.map((row) => [row.name, row]));
        expect(['林澈', '陈言', '周宁', '许青'].map((name) => [byName[name].rank, byName[name].schoolRank])).toEqual([[1, 1], [2, 2], [3, 3], [4, 3]]);
        expect(result.awards.filter((award) => award.kind === 'trophy').map((award) => [award.name, award.teamIds.map((id) => byName[result.rows.find((row) => row.id === id)!.name].name)]))
            .toEqual([['冠军', ['林澈']], ['亚军', ['陈言']], ['季军', ['许青']]]);
        // Medals by school rank: 周宁 shares school rank 3 with 许青, so both get bronze.
        expect(['林澈', '陈言', '周宁', '许青'].map((name) => byName[name].medals.join())).toEqual(['金奖', '银奖', '铜奖', '铜奖']);
        expect(standingsCsv(result).split('\r\n')[0]).toContain('"学校名次"');

        const boards = resolverBoards(data, settings, true);
        const config = { ...defaultResolverConfig(settings, true), freezeMode: 'custom' as const, freezeAtSeconds: 2000 };
        const payload = prepareResolver(data, boards, config, { contestId: 'c', ended: true, capturedAt: new Date(), logoNames: {} });
        const awards = payload.game.contest.awards as { id: string; citation: string; teamIds: string[] }[];
        const name = (id: string) => data.teams.find((team) => team.team_id === id)!.name;
        expect(awards.filter((award) => award.id.startsWith('podium-')).map((award) => [award.citation, award.teamIds.map(name)]))
            .toEqual([['冠军', ['林澈']], ['亚军', ['陈言']], ['季军', ['许青']]]);
        expect(awards.filter((award) => award.id.startsWith('medal-')).map((award) => [award.citation, award.teamIds.map(name).sort()]))
            .toEqual([['金奖', ['林澈']], ['银奖', ['陈言']], ['铜奖', ['周宁', '许青'].sort()]]);
    });
});
