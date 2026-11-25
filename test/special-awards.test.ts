import { describe, expect, it } from 'vitest';
import type { BoardData } from '../lib/board';
import { enhanceBoard } from '../lib/board';
import { defaultSettings, normalizeSettings, type SpecialAward } from '../lib/settings';
import { displaySpecialAwards, resultsFinal, specialAwardResults } from '../lib/special-awards';
import { defaultResolverConfig, prepareResolver, resolverBoards } from '../lib/resolver-data';

const minute = 60_000;
function contest(): BoardData {
    const team = (id: string, name: string, unofficial = false) => ({ team_id: id, name, organization: '学校', group: [unofficial ? 'unofficial' : 'official'] });
    let serial = 0;
    const run = (teamId: string, problem: number, minutes: number, status = 'CORRECT') => ({ submission_id: `s${++serial}`, team_id: teamId, problem_id: problem, timestamp: minutes * minute, status });
    return {
        contest: { contest_name: '测试', start_time: 0, end_time: 5 * 3600, problem_quantity: 3, problem_id: ['A', 'B', 'C'],
            balloon_color: ['#f00', '#0f0', '#00f'].map((background_color) => ({ background_color, color: '#fff' })) },
        teams: [team('1', '甲'), team('2', '乙'), team('3', '丙'), team('4', '丁'), team('5', '星', true), team('6', '零')],
        submissions: [
            run('1', 0, 10), run('1', 1, 20),
            run('2', 0, 15), run('2', 1, 15),
            // 丙 and 丁 tie on 1 problem and 30 minutes (丁: 10 minutes and one rejected run); 丙's accept is later.
            run('3', 0, 30), run('4', 0, 5, 'WRONG_ANSWER'), run('4', 0, 10),
            run('5', 2, 290),
            run('6', 0, 50, 'WRONG_ANSWER'),
        ],
    };
}
const award = (input: Partial<SpecialAward>): SpecialAward => ({ id: 'a', name: '奖', kind: 'rank', board: 'all', rank: 1, teamIds: [], unofficial: false, ties: true, count: 1, minTeams: 0, floor: 'none', excludeMedalists: false, ...input });
const results = (awards: Partial<SpecialAward>[], extra: Record<string, unknown> = {}) => {
    const settings = { ...defaultSettings, ...extra, specialAwards: awards.map((item, index) => award({ id: `a${index}`, ...item })) };
    // Teams sharing an award are listed in board order; compare them as sets.
    return specialAwardResults(enhanceBoard(contest(), settings), settings).map((item) => [...item.teamIds].sort());
};

describe('特别奖', () => {
    it('gives a board rank by the board ranking rule, ties sharing it', () => {
        // 甲 and 乙 both solve 2 in 30 minutes and share rank 1; without ties the board's name order decides (乙 first).
        expect(results([{ rank: 1 }, { rank: 2 }, { rank: 3 }, { rank: 1, ties: false }, { rank: 2, ties: false }])).toEqual([['1', '2'], [], ['3', '4'], ['2'], ['1']]);
        // Under the ICPC rule 乙's last accept (15) is earlier than 甲's (20).
        expect(results([{ rank: 1 }], { tieBreak: 'icpc' })).toEqual([['2']]);
    });

    it('finds the last accept and the last team that solved, without starred or zero-solve teams', () => {
        expect(results([{ kind: 'lastAccept' }, { kind: 'lastSolver' }])).toEqual([['3'], ['3', '4']]);
        // 打星队伍可获 now applies to every rule (CCPC 顽强拼搏奖 includes unofficial teams): 星 accepted last.
        expect(results([{ kind: 'lastAccept', unofficial: true }, { kind: 'lastSolver', unofficial: true }])).toEqual([['5'], ['5']]);
        expect(results([{ board: 'unofficial', unofficial: true }], { participationBoards: true })).toEqual([['5']]);
        expect(results([{ board: 'unofficial', unofficial: true }])).toEqual([[]]);
        expect(results([{ kind: 'lastSolver', ties: false }])).toEqual([['3']]);
        // Under the ICPC rule 丁's earlier last accept puts it ahead: 丙 alone is last.
        expect(results([{ kind: 'lastSolver' }], { tieBreak: 'icpc' })).toEqual([['3']]);
    });

    it('limits rule-based awards to the board, and keeps hand-picked teams that exist', () => {
        const manualBoards = [{ id: 'girls', name: '女队榜', teamIds: ['3', '4', '6'] }];
        expect(results([{ board: 'manual-girls' }, { kind: 'manual', teamIds: ['6', '99'] }], { manualBoards })).toEqual([['3', '4'], ['6']]);
    });

    it('can share the last-accept award for simultaneous first accepts', () => {
        const data = contest();
        data.submissions.push(
            { submission_id: 'a', team_id: '1', problem_id: 2, timestamp: 100 * minute, status: 'CORRECT' },
            { submission_id: 'b', team_id: '2', problem_id: 2, timestamp: 100 * minute + 999, status: 'CORRECT' },
            { submission_id: 'c', team_id: '3', problem_id: 0, timestamp: 105 * minute, status: 'CORRECT' },
        );
        const settings = { ...defaultSettings, specialAwards: [
            award({ kind: 'lastAccept' }), award({ id: 'single', kind: 'lastAccept', ties: false }),
        ] };
        expect(specialAwardResults(enhanceBoard(data, settings), settings).map((item) => item.teamIds)).toEqual([['1', '2'], ['2']]);
    });

    it('waits for final results', () => {
        const data = contest();
        expect(resultsFinal(data, true)).toBe(true);
        expect(resultsFinal(data, false)).toBe(false);
        data.submissions.push({ submission_id: 'f', team_id: '1', problem_id: 2, timestamp: 280 * minute, status: 'FROZEN' });
        expect(resultsFinal(data, true)).toBe(false);
    });

    it('only sends winners for final and visible results with the same board response', () => {
        const settings = { ...defaultSettings, specialAwards: [award({ kind: 'manual', teamIds: ['1'] })] };
        const data = enhanceBoard(contest(), settings);
        expect(displaySpecialAwards(data, settings, false, false)).toBe(data);
        expect(displaySpecialAwards(data, settings, true, true)).toBe(data);
        expect(displaySpecialAwards(data, settings, true, false).contest.medal).toMatchObject({
            all: { hydroSpecialAwards: [{ name: '奖', teams: '甲' }] },
        });
    });

    it('are presented by the resolver after the medals, for the teams it shows', () => {
        const data = contest();
        const settings = { ...defaultSettings, specialAwards: [award({ id: 'grit', name: '顽强拼搏奖', kind: 'lastAccept' }), award({ id: 'pick', name: '风采', kind: 'manual', teamIds: ['6'] })] };
        const payload = prepareResolver(data, resolverBoards(data, settings, true), { ...defaultResolverConfig(settings, true), freezeMode: 'custom', freezeAtSeconds: 3600 },
            { contestId: 'x', ended: true, capturedAt: new Date(), logoNames: {}, special: specialAwardResults(enhanceBoard(data, settings), settings) });
        const awards = (payload.game.contest.awards as { id: string; citation: string; teamIds: string[]; awardType: string }[]).filter((item) => item.id.startsWith('special-'));
        expect(awards.map((item) => [item.citation, item.teamIds, item.awardType])).toEqual([['顽强拼搏奖', ['3'], 'honors'], ['风采', ['6'], 'honors']]);
    });

    it('checks what is saved', () => {
        const save = (specialAwards: unknown[], manualBoards: unknown[] = []) => normalizeSettings({ ...defaultSettings, manualBoards, specialAwards }).specialAwards;
        expect(save([{ id: 'girls', name: ' 最佳女队 ', kind: 'rank', board: 'manual-g', rank: 1 }], [{ id: 'g', name: '女队榜', teamIds: [] }]))
            .toEqual([{ id: 'girls', name: '最佳女队', kind: 'rank', board: 'manual-g', rank: 1, teamIds: [], unofficial: false, ties: true,
                count: 1, minTeams: 0, floor: 'none', excludeMedalists: false }]);
        // A deleted manual board takes its award along; manual awards need teams and ignore the board.
        expect(save([{ id: 'x', name: '奖', kind: 'rank', board: 'manual-gone' }])).toEqual([]);
        expect(save([{ id: 'm', name: '风采', kind: 'manual', board: 'official', teamIds: ['-1001', '-1001', '7'] }])[0]).toMatchObject({ board: 'all', teamIds: ['-1001', '7'] });
        expect(() => save([{ id: 'm', name: '风采', kind: 'manual', teamIds: [] }])).toThrow('需要指定获奖队伍');
        expect(() => save([{ id: 'a', name: '奖', kind: 'other' }])).toThrow('类型无效');
        expect(() => save([{ id: 'a', name: '奖', kind: 'rank', rank: 0 }])).toThrow('名次');
        expect(() => save([{ id: 'a', name: '', kind: 'rank' }])).toThrow('名称');
        expect(() => save([{ id: 'a', name: '一', kind: 'rank' }, { id: 'a', name: '二', kind: 'rank' }])).toThrow('重复');
        expect(normalizeSettings({ ...defaultSettings, manualBoards: [] }).specialAwards).toEqual([]);
    });
});
