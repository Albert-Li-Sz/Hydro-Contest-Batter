import { describe, expect, it } from 'vitest';
import type { BoardData } from '../lib/board';
import { enhanceBoard, medalPool } from '../lib/board';
import { awardsFor, defaultSettings, medalCounts, normalizeSettings, type SpecialAward } from '../lib/settings';
import { honorsResults, specialAwardResults } from '../lib/special-awards';
import { defaultResolverConfig, prepareResolver, resolverBoards } from '../lib/resolver-data';
import { buildContestInfo, buildRuns, type LiveSource } from '../lib/live/model';
import { computeScoreboard, runsByTeam } from '../lib/live/scoreboard';
import { honorsPlaces, honorsWinners } from '../resolver/public/js/honors.js';

const minute = 60_000;

/** `solved` teams accept problem A at 10 + i minutes; `failed` teams only submit a wrong run; `absent` never submit. */
function field({ solved = 31, failed = 0, absent = 0, unofficial = 0 } = {}): BoardData {
    const teams: BoardData['teams'] = [];
    const submissions: BoardData['submissions'] = [];
    let serial = 0;
    const add = (kind: 'solved' | 'failed' | 'absent', official: boolean, index: number) => {
        const id = String(teams.length + 1);
        teams.push({ team_id: id, name: `队${id}`, organization: `学校${id}`, group: [official ? 'official' : 'unofficial'] });
        if (kind === 'absent') return;
        submissions.push({ submission_id: `s${++serial}`, team_id: id, problem_id: 0, timestamp: (10 + index) * minute, status: kind === 'solved' ? 'CORRECT' : 'WRONG_ANSWER' });
    };
    for (let i = 0; i < solved; i++) add('solved', true, i);
    for (let i = 0; i < failed; i++) add('failed', true, i);
    for (let i = 0; i < absent; i++) add('absent', true, i);
    for (let i = 0; i < unofficial; i++) add('solved', false, i);
    return {
        contest: { contest_name: '测试', start_time: 0, end_time: 5 * 3600, problem_quantity: 2, problem_id: ['A', 'B'],
            balloon_color: ['#f00', '#0f0'].map((background_color) => ({ background_color, color: '#fff' })) },
        teams, submissions,
    };
}

const board = (data: BoardData, input: Record<string, unknown>) => {
    const settings = normalizeSettings({ ...defaultSettings, ...input });
    const medal = enhanceBoard(data, settings).contest.medal as Record<string, { gold: number; silver: number; bronze: number }>;
    return [medal.all.gold, medal.all.silver, medal.all.bronze];
};

const ccpc = { medalBasis: 'ratio', medals: { gold: 10, silver: 20, bronze: 30 }, medalBase: 'submitted', medalRounding: 'cumulative' };
const hongKong = { medalBasis: 'ratio', medals: { gold: 10, silver: 20, bronze: 30 }, medalBase: 'solved', medalRounding: 'tier' };
const xian = { medalBasis: 'multiple', medals: { gold: 10, silver: 2, bronze: 3 }, medalBase: 'registered' };

describe('奖牌名额 v2', () => {
    it('counts the published examples of three contests on the same 31 teams', () => {
        const data = field();
        expect(board(data, ccpc)).toEqual([4, 6, 9]);
        expect(board(data, hongKong)).toEqual([4, 7, 10]);
        expect(board(data, xian)).toEqual([4, 8, 12]);
    });

    it('keeps the CCPC count when teams submit without solving, while the per-tier count follows the solved teams', () => {
        // 31 teams submitted, 27 solved: CCPC 附 1 still gives 4/6/9; per tier of the solved teams gives 3/6/9.
        const data = field({ solved: 27, failed: 4 });
        expect(medalPool(data, data.teams.map((team) => team.team_id))).toEqual({ registered: 31, submitted: 31, solved: 27 });
        expect(board(data, ccpc)).toEqual([4, 6, 9]);
        expect(board(data, hongKong)).toEqual([3, 6, 9]);
        // Registered teams that never submitted count only for the registered base.
        const absent = field({ solved: 27, failed: 4, absent: 9 });
        expect(board(absent, ccpc)).toEqual([4, 6, 9]);
        expect(board(absent, xian)).toEqual([4, 8, 12]);
    });

    it('rounds cumulatively and leaves unofficial teams out of every base', () => {
        const rules = awardsFor(normalizeSettings({ ...defaultSettings, ...ccpc }), 'all');
        expect(medalCounts(rules, { registered: 40, submitted: 31, solved: 20 })).toEqual({ gold: 4, silver: 6, bronze: 9 });
        expect(medalCounts({ ...rules, medalRounding: 'tier' }, { registered: 40, submitted: 31, solved: 20 })).toEqual({ gold: 4, silver: 7, bronze: 10 });
        const data = field({ solved: 31, unofficial: 5 });
        expect(medalPool(data, data.teams.map((team) => team.team_id))).toEqual({ registered: 31, submitted: 31, solved: 31 });
        // Medals stop at the teams that solved something.
        expect(board(field({ solved: 3, failed: 28 }), ccpc)).toEqual([3, 0, 0]);
    });

    it('reads settings saved before the new fields as before', () => {
        const legacy = normalizeSettings({ ...defaultSettings, medalBasis: 'ratio', medals: { gold: 10, silver: 20, bronze: 30 }, medalBase: undefined, medalRounding: undefined,
            boardAwards: { official: { medals: { gold: 1, silver: 1, bronze: 1 } } } });
        expect(awardsFor(legacy, 'all')).toMatchObject({ medalBase: 'solved', medalRounding: 'tier' });
        expect(awardsFor(legacy, 'official')).toMatchObject({ medalBasis: 'count', medalBase: 'solved', medalRounding: 'tier' });
        expect(() => normalizeSettings({ ...defaultSettings, medalBasis: 'multiple', medals: { gold: 10, silver: 30, bronze: 3 } })).toThrow('倍');
        expect(() => normalizeSettings({ ...defaultSettings, medalBase: 'all' })).toThrow('分母');
        expect(() => normalizeSettings({ ...defaultSettings, honors: { enabled: true, highest: 50, high: 25, standard: 100 } })).toThrow('Honors');
    });

    it('shows the same counts in the resolver and on Live', () => {
        const data = field({ solved: 27, failed: 4 });
        const settings = normalizeSettings({ ...defaultSettings, ...ccpc });
        const boards = resolverBoards(data, settings, true);
        expect(boards[0].medalCounts).toEqual({ gold: 4, silver: 6, bronze: 9 });
        const payload = prepareResolver(data, boards, { ...defaultResolverConfig(settings, true), freezeMode: 'custom', freezeAtSeconds: 3600 },
            { contestId: 'c', ended: true, capturedAt: new Date(0), logoNames: {} });
        expect([payload.config.goldCount, payload.config.silverCount, payload.config.bronzeCount]).toEqual([4, 6, 9]);
        const live = liveSource(data, settings);
        const info = buildContestInfo(live);
        expect(info.awardsSettings[0].awards.map((award) => award.chainLimit)).toEqual([4, 10, 19]);
    });
});

function liveSource(data: BoardData, settings: ReturnType<typeof normalizeSettings>): LiveSource {
    const enhanced = enhanceBoard(data, settings);
    return { contest: { title: '测试', beginAt: new Date(0), endAt: new Date(5 * 3600_000), lockAt: null, unlocked: false },
        data: enhanced, boards: [], settings, identity: true, logoNames: {}, now: 6 * 3600_000 };
}

describe('ICPC World Finals Honors', () => {
    it('shares the place of teams below Highest Honors that solved as many problems', () => {
        const rows = [
            { teamId: 'a', rank: 1, solved: 9 }, { teamId: 'b', rank: 2, solved: 8 }, { teamId: 'c', rank: 3, solved: 8 },
            { teamId: 'd', rank: 4, solved: 7 }, { teamId: 'e', rank: 5, solved: 7 }, { teamId: 'f', rank: 6, solved: 0 },
        ];
        expect([...honorsPlaces(rows, 2)]).toEqual([['a', 1], ['b', 2], ['c', 3], ['d', 4], ['e', 4], ['f', 6]]);
        expect(honorsWinners(rows, { highest: 2, high: 3, standard: 6 }).map((award) => award.teamIds))
            .toEqual([['a', 'b'], ['c'], ['d', 'e']]);
    });

    it('gives the same Honors on Live, in the results, the resolver and the board list', () => {
        // 31 teams, one solve each in a different minute; the last 11 also solve B, so they rank first.
        const data = field();
        for (let i = 0; i < 11; i++) data.submissions.push({ submission_id: `b${i}`, team_id: String(31 - i), problem_id: 1, timestamp: 200 * minute, status: 'CORRECT' });
        const settings = normalizeSettings({ ...defaultSettings, medals: { gold: 4, silver: 6, bronze: 10 }, honors: { enabled: true, highest: 25, high: 28, standard: 31 } });
        const live = liveSource(data, settings);
        const info = buildContestInfo(live);
        const { ranking } = computeScoreboard(info, runsByTeam(buildRuns(live, info)), 'normal');
        const byId = Object.fromEntries(ranking.awards.map((award) => [award.id, award.teams]));
        expect(byId['gold-medal']).toHaveLength(4);
        expect(byId['highest-honors']).toHaveLength(25);
        // Ranks 26–31 all solved one problem: they share place 26, inside High Honors (28), so Honors stays empty.
        expect(byId['high-honors']).toHaveLength(6);
        expect(byId.honors).toEqual([]);
        const list = Object.fromEntries(honorsResults(enhanceBoard(data, settings), settings).map((award) => [award.id, award.teamIds]));
        expect(new Set(list['highest-honors'])).toEqual(new Set(byId['highest-honors']));
        expect(new Set(list['high-honors'])).toEqual(new Set(byId['high-honors']));
        const boards = resolverBoards(data, settings, true);
        const payload = prepareResolver(data, boards, { ...defaultResolverConfig(settings, true), freezeMode: 'custom', freezeAtSeconds: 3600 },
            { contestId: 'c', ended: true, capturedAt: new Date(0), logoNames: {} });
        const gameAwards = (payload.game as unknown as { contest: { awards: { id: string; teamIds: string[]; awardType: string }[] } }).contest.awards;
        const resolverHonors = Object.fromEntries(gameAwards.filter((award) => award.awardType === 'honors').map((award) => [award.id, award.teamIds]));
        expect(new Set(resolverHonors['high-honors'])).toEqual(new Set(byId['high-honors']));
    });
});

describe('带条件的特别奖', () => {
    // 10 official teams solving 10 down to 1 problems... simplified: team i solves A at minute 10 + i; 女队 are 3, 6, 9 and 打星 11.
    const contest = () => {
        const data = field({ solved: 10, unofficial: 1 });
        data.teams.push({ team_id: '12', name: '零', organization: '学校12', group: ['official'] });
        return data;
    };
    const award = (input: Partial<SpecialAward>): SpecialAward => ({ id: 'a', name: '奖', kind: 'rank', board: 'all', rank: 1, teamIds: [], unofficial: false, ties: true,
        count: 1, minTeams: 0, floor: 'none', excludeMedalists: false, ...input });
    const results = (awards: Partial<SpecialAward>[], extra: Record<string, unknown> = {}, data = contest()) => {
        const settings = normalizeSettings({ ...defaultSettings, medals: { gold: 1, silver: 2, bronze: 3 }, ...extra,
            specialAwards: awards.map((item, index) => award({ id: `a${index}`, ...item })) });
        return specialAwardResults(enhanceBoard(data, settings), settings).map((item) => item.teamIds);
    };

    it('gives 最佳女队 only with three teams and not below the last bronze', () => {
        const girls = (teamIds: string[]) => ({ manualBoards: [{ id: 'g', name: '女队榜', teamIds }] });
        const best = { board: 'manual-g', unofficial: true, minTeams: 3, floor: 'bronze' as const };
        // Medals go to teams 1–6; 女队 3 is the best.
        expect(results([best], girls(['3', '6', '9']))).toEqual([['3']]);
        // Two teams: no award.
        expect(results([best], girls(['3', '6']))).toEqual([[]]);
        // The best 女队 ranks 7th, below the last bronze (6th): no award.
        expect(results([best], girls(['7', '8', '9']))).toEqual([[]]);
        // An unofficial 女队 counts and may win when it is above the line.
        const data = contest();
        data.submissions.push({ submission_id: 'x', team_id: '11', problem_id: 1, timestamp: 100 * minute, status: 'CORRECT' });
        expect(results([best], girls(['8', '9', '11']), data)).toEqual([['11']]);
    });

    it('gives 顽强拼搏奖 to the latest solvers without a medal, unofficial teams included', () => {
        const persist = { kind: 'lastAccept' as const, unofficial: true, excludeMedalists: true, count: 2 };
        // 打星 11 accepted at 10 minutes; the latest official accepts are 10 (19 min) and 9 (18 min).
        expect(results([persist])).toEqual([['10', '9']]);
        const data = contest();
        data.submissions.push({ submission_id: 'late', team_id: '11', problem_id: 1, timestamp: 280 * minute, status: 'CORRECT' });
        expect(results([persist], {}, data)).toEqual([['11', '10']]);
        // Without excluding medalists, a medalist's late accept could win.
        data.submissions.push({ submission_id: 'gold', team_id: '1', problem_id: 1, timestamp: 290 * minute, status: 'CORRECT' });
        expect(results([{ ...persist, excludeMedalists: false, count: 1 }, persist], {}, data)).toEqual([['1'], ['11', '10']]);
    });

    it('finds the First Solution Award and 优胜奖', () => {
        expect(results([{ kind: 'firstSolution' }, { kind: 'firstSolution', unofficial: true }])).toEqual([['1'], ['1', '11']]);
        // 优胜奖: every official team that solved something without a medal (7–10), not the zero-solve team 12.
        expect(results([{ kind: 'honorable' }])).toEqual([['7', '8', '9', '10']]);
        expect(results([{ kind: 'lastSolver', count: 2 }])).toEqual([['9', '10']]);
    });
});
