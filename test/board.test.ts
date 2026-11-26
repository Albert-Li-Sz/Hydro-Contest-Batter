import { describe, expect, it } from 'vitest';
import { createContest, createSubmissions, createTeams, MedalType, Rank } from './engine';
import { patchBoardEngine, patchBoardInk } from '../lib/patch-engine.mjs';
import { inkOn } from '../resolver/public/js/ink.js';
import { colorPresets } from '../lib/balloons';
import { enhanceBoard, schoolGroup } from '../lib/board';
import { awardsFor, defaultSettings, medalCounts, normalizeSettings, pruneMembers, toScriptJson } from '../lib/settings';
import { demoData } from './fixture';
import { defaultResolverConfig, prepareResolver, resolverBoards } from '../lib/resolver-data';

const configuredSettings = { ...defaultSettings, schoolBoards: true, participationBoards: true, firstSolve: true };

function rankFor(group = 'all', settings = configuredSettings, data = demoData()) {
    const result = enhanceBoard(data, settings);
    const contest = createContest(result.contest as never);
    const rank = new Rank(contest, createTeams(result.teams), createSubmissions(result.submissions, contest));
    rank.options.setGroup(group); rank.buildRank(); return rank;
}

describe('分榜与奖项', () => {
    it('总榜显示金银铜，零过题不获奖', () => {
        const rank = rankFor();
        expect(rank.teams[0].id).toBe('1');
        expect(rank.teams[0].awards).toContain(MedalType.GOLD);
        expect(rank.teams.find((team) => team.id === '3')!.awards).toContain(MedalType.SILVER);
        expect(rank.teams.find((team) => team.id === '7')!.awards).toContain(MedalType.BRONZE);
        expect(rank.teams.find((team) => team.id === '4')!.awards).toEqual([]);
        expect(rank.teams.find((team) => team.id === '8')!.awards).not.toContain(MedalType.BRONZE);
    });
    it('学校榜在学校内独立排名、计算奖牌与一血', () => {
        const group = schoolGroup('南京邮电大学');
        const rank = rankFor(group);
        expect(rank.teams.map((team) => team.id)).toEqual(['3', '4']);
        expect(rank.teams[0].rank).toBe(1);
        expect(rank.teams[0].awards).toContain(MedalType.GOLD);
        expect(rank.teams[0].problemStatistics[0].isFirstSolved).toBe(true);
        expect(rankFor().teams.find((team) => team.id === '3')!.problemStatistics[0].isFirstSolved).toBe(false);
    });
    it('正式/非正式状态与学校及手动分组相互独立', () => {
        expect(rankFor('unofficial').teams.map((team) => team.id)).toEqual(['4', '6']);
        expect(rankFor('official').teams.some((team) => team.id === '4')).toBe(false);
        const settings = normalizeSettings({ ...defaultSettings, manualBoards: [{ id: 'one', name: '一组', teamIds: ['1', '4'] }, { id: 'two', name: '二组', teamIds: ['4'] }] });
        const team = enhanceBoard(demoData(), settings).teams.find((team) => team.team_id === '4')!;
        expect(team.group).toContain('unofficial');
        expect(team.group).toContain('manual-one');
        expect(team.group).toContain('manual-two');
    });
    it('手动榜可以覆盖奖牌数量，空榜不崩溃', () => {
        const settings = normalizeSettings({ ...defaultSettings, manualBoards: [{ id: 'test', name: '测试', teamIds: ['2', '3'], medals: { gold: 0, silver: 1, bronze: 1 } }, { id: 'empty', name: '空榜', teamIds: [] }] });
        expect(rankFor('manual-test', settings).teams[0].awards).toContain(MedalType.SILVER);
        expect(rankFor('manual-empty', settings).teams).toEqual([]);
    });
    it('罚时按秒比较：同一分钟内先通过者名次靠前，不并列', () => {
        const data = demoData();
        data.submissions = [
            { submission_id: 'a', team_id: '1', problem_id: 0, timestamp: 630000, status: 'CORRECT' },
            { submission_id: 'b', team_id: '2', problem_id: 0, timestamp: 605000, status: 'CORRECT' },
        ];
        const rank = rankFor('all', defaultSettings, data);
        expect(rank.teams.slice(0, 2).map((team) => [team.id, team.rank, team.penaltyToMinute])).toEqual([['2', 1, 10], ['1', 2, 10]]);
    });
    it('不显示身份时不生成学校榜，也不输出学校', () => {
        const hidden = enhanceBoard(demoData(), defaultSettings, { identity: false });
        expect(Object.keys(hidden.contest.group as object).some((id) => id.startsWith('school-'))).toBe(false);
        expect(hidden.teams.every((team) => team.organization === '')).toBe(true);
    });
    it('并列名次获得相同奖牌', () => {
        const data = demoData();
        data.submissions = [
            { submission_id: 'a', team_id: '1', problem_id: 0, timestamp: 600000, status: 'CORRECT' },
            { submission_id: 'b', team_id: '2', problem_id: 0, timestamp: 600000, status: 'CORRECT' },
        ];
        const rank = rankFor('all', defaultSettings, data);
        expect(rank.teams.slice(0, 2).map((team) => team.rank)).toEqual([1, 1]);
        expect(rank.teams.slice(0, 2).every((team) => team.awards.includes(MedalType.GOLD))).toBe(true);
    });
    it('学校名称空白归一化，未填写学校有单独分榜', () => {
        expect(schoolGroup(' 南京晓庄学院 ')).toBe(schoolGroup('南京晓庄学院'));
        expect(rankFor(schoolGroup('未填写学校')).teams.map((team) => team.id)).toEqual(['8']);
    });
    it('封榜后的结果不计入奖牌，重判后重新计算一血', () => {
        const data = demoData();
        data.submissions = data.submissions.map((submission) => ({ ...submission, status: 'FROZEN' }));
        const frozen = enhanceBoard(data, defaultSettings);
        expect(frozen.contest.medal).toMatchObject({ all: { gold: 0, silver: 0, bronze: 0 } });
        const rejudged = demoData();
        rejudged.submissions = rejudged.submissions.map((submission) => submission.team_id === '1' && submission.problem_id === 0 ? { ...submission, status: 'WRONG_ANSWER' } : submission);
        expect(rankFor('all', configuredSettings, rejudged).teams.find((team) => team.id === '3')!.problemStatistics[0].isFirstSolved).toBe(true);
    });
    it('重复使用数据不污染原始结果', () => {
        const data = demoData(); const before = JSON.stringify(data);
        enhanceBoard(data, defaultSettings); enhanceBoard(data, defaultSettings);
        expect(JSON.stringify(data)).toBe(before);
    });
    it('打星选手保留成绩，奖牌顺延，默认一血资格排除', () => {
        const data = demoData(); data.teams[0].group = ['unofficial'];
        const rank = rankFor('all', defaultSettings, data);
        const star = rank.teams.find((team) => team.id === '1')!;
        expect(star.rank).toBe(0);
        expect(star.solvedProblemNum).toBe(3);
        expect(star.awards).toEqual([]);
        expect(star.problemStatistics[0].isFirstSolved).toBe(false);
        expect(rank.teams.find((team) => team.id === '3')!.awards).toContain(MedalType.GOLD);
        expect(rank.teams.find((team) => team.id === '7')!.awards).toContain(MedalType.BRONZE);
    });
    it('允许打星获一血时保持打星身份且奖牌仍顺延', () => {
        const data = demoData(); data.teams[0].group = ['unofficial'];
        const rank = rankFor('all', { ...configuredSettings, unofficialFirstSolve: true }, data);
        const star = rank.teams.find((team) => team.id === '1')!;
        expect(star.isUnofficial).toBe(true);
        expect(star.rank).toBe(0);
        expect(rank.teams.find((team) => team.id === '3')!.rank).toBe(1);
        expect(star.awards).toEqual([]);
        expect(star.problemStatistics[0].isFirstSolved).toBe(true);
        expect(rank.teams.find((team) => team.id === '3')!.awards).toContain(MedalType.GOLD);
    });
    it('纯打星榜只可参与一血，开关不会授予奖牌', () => {
        const excluded = rankFor('unofficial');
        expect(excluded.teams).toHaveLength(2);
        expect(excluded.teams.every((team) => team.awards.length === 0)).toBe(true);
        expect(excluded.teams.every((team) => team.problemStatistics.every((cell) => !cell.isFirstSolved))).toBe(true);
        const allowed = rankFor('unofficial', { ...configuredSettings, unofficialFirstSolve: true });
        expect(allowed.teams.every((team) => !team.awards.length)).toBe(true);
        expect(allowed.teams[0].problemStatistics[0].isFirstSolved).toBe(true);
    });
    it('新配置默认仅主榜，其他榜需明确启用或创建', () => {
        expect(enhanceBoard(demoData(), defaultSettings).contest.group).toEqual({});
        expect(normalizeSettings({ medals: defaultSettings.medals, manualBoards: [] })).toMatchObject({ schoolBoards: false, participationBoards: false });
        expect(Object.keys(enhanceBoard(demoData(), { ...defaultSettings, participationBoards: true }).contest.group as object)).toEqual(['official', 'unofficial']);
    });
    it('主榜、学校榜、参赛类型榜和手动榜独立使用全部奖项规则', () => {
        const data = demoData(); data.teams[0].group = ['unofficial'];
        const rules = { ...awardsFor(configuredSettings, 'all'), medals: { gold: 0, silver: 1, bronze: 0 }, goldCitation: '特等奖', unofficialFirstSolve: true, medalSameScore: false, podiumEnabled: true };
        const settings = { ...configuredSettings, firstSolve: false, manualBoards: [{ id: 'mixed', name: '混合', teamIds: ['1', '2'] }],
            boardAwards: Object.fromEntries(['all', schoolGroup('南京晓庄学院'), 'unofficial', 'manual-mixed'].map((id) => [id, rules])) };
        for (const id of Object.keys(settings.boardAwards)) {
            const rank = rankFor(id, settings, data);
            expect(rank.teams.find((team) => team.id === '1')!.problemStatistics[0].isFirstSolved).toBe(true);
            expect(rank.teams.filter((team) => team.isUnofficial).every((team) => !team.awards.length)).toBe(true);
            expect(awardsFor(settings, id)).toEqual(rules);
        }
        expect(rankFor('official', settings, data).teams.every((team) => team.problemStatistics.every((cell) => !cell.isFirstSolved))).toBe(true);
        expect(rankFor('manual-mixed', settings, data).teams.find((team) => team.id === '2')!.awards).toEqual([MedalType.SILVER]);
    });
    it('榜单与滚榜在总罚时并列且最后通过时间不同的情况下授奖一致', () => {
        const data = demoData();
        data.teams = data.teams.slice(0, 3);
        data.teams[0].name = 'A'; data.teams[1].name = 'Z'; data.teams[2].group = ['unofficial'];
        data.submissions = [['1', 0, 100], ['1', 1, 300], ['2', 0, 190], ['2', 1, 210], ['3', 0, 1]].map(([team_id, problem_id, time], index) => ({
            submission_id: `tie-${index}`, team_id: String(team_id), problem_id: Number(problem_id), timestamp: Number(time) * 1000, status: 'CORRECT',
        }));
        const settings = { ...configuredSettings, medals: { gold: 1, silver: 1, bronze: 0 }, medalSameScore: false, unofficialFirstSolve: true, podiumEnabled: true };
        const rank = rankFor('all', settings, data);
        const payload = prepareResolver(data, resolverBoards(data, settings, true), { ...defaultResolverConfig(settings, true), freezeMode: 'custom', freezeAtSeconds: 200 },
            { contestId: 'tie', ended: true, capturedAt: new Date(), logoNames: {} });
        for (const [tier, type] of [['gold', MedalType.GOLD], ['silver', MedalType.SILVER]] as const) {
            const award = payload.game.contest.awards.find((award: any) => award.id === `medal-${tier}`) as any;
            expect(rank.teams.filter((team) => team.awards.includes(type)).map((team) => team.id)).toEqual(award.teamIds);
        }
        expect(rank.teams.filter((team) => !team.isUnofficial).map((team) => team.rank)).toEqual([1, 1]);
    });
    it('ICPC 区域赛同分规则：罚时按分钟，再比最后一题通过时间，榜单与滚榜一致', () => {
        const data = demoData();
        data.teams = data.teams.slice(0, 3);
        data.teams[0].name = 'A'; data.teams[1].name = 'Z'; data.teams[2].name = 'M';
        // 1: 1 + 5 = 6 分钟，最后 5 分；2: 3 + 3 = 6 分钟，最后 3 分；3: 10:05 通过一题。两种规则下 1、2 秒级罚时同为 400 秒。
        data.submissions = [['1', 0, 100], ['1', 1, 300], ['2', 0, 190], ['2', 1, 210], ['3', 0, 605]].map(([team_id, problem_id, time], index) => ({
            submission_id: `icpc-${index}`, team_id: String(team_id), problem_id: Number(problem_id), timestamp: Number(time) * 1000, status: 'CORRECT',
        }));
        const hydro = rankFor('all', { ...defaultSettings, medals: { gold: 1, silver: 1, bronze: 0 } }, data);
        expect(hydro.teams.map((team) => [team.id, team.rank])).toEqual([['1', 1], ['2', 1], ['3', 3]]);
        const settings = normalizeSettings({ ...defaultSettings, tieBreak: 'icpc', medals: { gold: 1, silver: 1, bronze: 0 } });
        const rank = rankFor('all', settings, data);
        expect(rank.teams.map((team) => [team.id, team.rank])).toEqual([['2', 1], ['1', 2], ['3', 3]]);
        expect(rank.teams.slice(0, 2).map((team) => team.awards)).toEqual([[MedalType.GOLD], [MedalType.SILVER]]);
        const payload = prepareResolver(data, resolverBoards(data, settings, true), { ...defaultResolverConfig(settings, true), freezeMode: 'custom', freezeAtSeconds: 200 },
            { contestId: 'icpc', ended: true, capturedAt: new Date(), logoNames: {} });
        expect(payload.snapshot.tieBreak).toBe('icpc');
        const award = (tier: string) => (payload.game.contest.awards.find((item: any) => item.id === `medal-${tier}`) as any)?.teamIds;
        expect([award('gold'), award('silver')]).toEqual([['2'], ['1']]);
        // Same minute and same last accepted minute: the ICPC rule cannot separate them, they share a rank.
        data.submissions = [
            { submission_id: 'x', team_id: '1', problem_id: 0, timestamp: 630000, status: 'CORRECT' },
            { submission_id: 'y', team_id: '2', problem_id: 0, timestamp: 605000, status: 'CORRECT' },
        ];
        expect(rankFor('all', settings, data).teams.slice(0, 2).map((team) => team.rank)).toEqual([1, 1]);
    });
    it('按有效队伍比例设奖：名额向上取整，榜单与滚榜一致', () => {
        const settings = normalizeSettings({ ...defaultSettings, medalBasis: 'ratio', medals: { gold: 10, silver: 20, bronze: 30 } });
        expect(medalCounts(awardsFor(settings, 'all'), 30)).toEqual({ gold: 3, silver: 6, bronze: 9 });
        expect(medalCounts(awardsFor(settings, 'all'), 11)).toEqual({ gold: 2, silver: 3, bronze: 4 });
        const data = demoData();
        const boards = resolverBoards(data, settings, true);
        const main = boards.find((board) => board.id === 'all')!;
        expect(main.eligible).toBe(enhanceBoard(data, settings).teams.filter((team) => !team.group.includes('unofficial')
            && data.submissions.some((record) => record.team_id === team.team_id && record.status === 'CORRECT')).length);
        const expected = medalCounts(awardsFor(settings, 'all'), main.eligible);
        const rank = rankFor('all', settings, data);
        const count = (type: (typeof MedalType)[keyof typeof MedalType]) => rank.teams.filter((team) => team.awards.includes(type)).length;
        expect([count(MedalType.GOLD), count(MedalType.SILVER), count(MedalType.BRONZE)]).toEqual([expected.gold, expected.silver, Math.min(expected.bronze, main.eligible - expected.gold - expected.silver)]);
        const payload = prepareResolver(data, boards, { ...defaultResolverConfig(settings, true), freezeMode: 'custom', freezeAtSeconds: 3600 },
            { contestId: 'ratio', ended: true, capturedAt: new Date(), logoNames: {} });
        expect([payload.config.goldCount, payload.config.silverCount]).toEqual([expected.gold, expected.silver]);
        expect(() => normalizeSettings({ ...defaultSettings, medalBasis: 'ratio', medals: { gold: 50, silver: 40, bronze: 30 } })).toThrow();
        // A board's own medals saved before 按比例设奖 existed stay numbers of teams under a ratio default.
        const legacy = normalizeSettings({ ...defaultSettings, medalBasis: 'ratio', medals: { gold: 10, silver: 20, bronze: 30 },
            participationBoards: true, boardAwards: { official: { medals: { gold: 1, silver: 2, bronze: 3 } }, unofficial: { firstSolve: true } } });
        expect(awardsFor(legacy, 'official')).toMatchObject({ medalBasis: 'count', medals: { gold: 1, silver: 2, bronze: 3 } });
        expect(awardsFor(legacy, 'unofficial')).toMatchObject({ medalBasis: 'ratio', medals: { gold: 10, silver: 20, bronze: 30 } });
        expect(() => normalizeSettings({ ...defaultSettings, tieBreak: 'cf' })).toThrow();
        expect(normalizeSettings({ ...defaultSettings }).tieBreak).toBe('hydro');
    });
    it('独立关闭并列同奖时严格按名额授奖', () => {
        const data = demoData();
        data.submissions = ['1', '2'].map((team_id) => ({ submission_id: team_id, team_id, problem_id: 0, timestamp: 600000, status: 'CORRECT' }));
        const settings = { ...defaultSettings, medals: { gold: 1, silver: 1, bronze: 0 }, medalSameScore: false };
        const rank = rankFor('all', settings, data);
        expect(rank.teams.slice(0, 2).map((team) => team.awards)).toEqual([[MedalType.GOLD], [MedalType.SILVER]]);
    });
    it('手动分榜自定义奖牌也跳过打星，切换后不会沿用其他分榜的奖项', () => {
        const settings = normalizeSettings({ ...defaultSettings, manualBoards: [{ id: 'mixed', name: '混合榜', teamIds: ['4', '7'], medals: { gold: 1, silver: 0, bronze: 0 } }] });
        const result = enhanceBoard(demoData(), settings);
        const contest = createContest(result.contest as never);
        const rank = new Rank(contest, createTeams(result.teams), createSubmissions(result.submissions, contest));
        for (const group of ['all', 'manual-mixed', 'unofficial', 'manual-mixed']) {
            rank.options.setGroup(group); rank.buildRank();
            expect(rank.teams.filter((team) => team.isUnofficial).every((team) => !team.awards.length)).toBe(true);
            if (group === 'manual-mixed') expect(rank.teams.find((team) => team.id === '7')!.awards).toContain(MedalType.GOLD);
        }
    });
    it('奖项边界并列时，打星不占名额且不影响符合条件选手并列同奖', () => {
        const data = demoData(); data.teams[2].group = ['unofficial'];
        data.submissions = ['1', '2', '3'].map((team_id) => ({ submission_id: `tie-${team_id}`, team_id, problem_id: 0, timestamp: 600000, status: 'CORRECT' }));
        const rank = rankFor('all', { ...defaultSettings, medals: { gold: 1, silver: 0, bronze: 0 } }, data);
        expect(rank.teams.find((team) => team.id === '3')!.awards).toEqual([]);
        expect(['1', '2'].every((id) => rank.teams.find((team) => team.id === id)!.awards.includes(MedalType.GOLD))).toBe(true);
        expect(rank.teams.find((team) => team.id === '8')!.awards).not.toContain(MedalType.GOLD);
    });
});

describe('设置验证', () => {
    it('拒绝非法奖牌数量和重复分榜标识', () => {
        expect(() => normalizeSettings({ ...defaultSettings, medals: { gold: -1, silver: 2, bronze: 3 } })).toThrow();
        expect(() => normalizeSettings({ ...defaultSettings, manualBoards: [{ id: 'x', name: '甲', teamIds: [] }, { id: 'x', name: '乙', teamIds: [] }] })).toThrow();
    });
    it('移除其他比赛成员，去重成员 ID', () => {
        const settings = normalizeSettings({ ...defaultSettings, manualBoards: [{ id: 'a', name: '甲', teamIds: ['1', '1', '999'] }] });
        expect(settings.manualBoards[0].teamIds).toEqual(['1', '999']);
        expect(pruneMembers(settings, new Set(['1'])).manualBoards[0].teamIds).toEqual(['1']);
    });
    it('删除手动分榜时一并删除它的单独奖项设置', () => {
        const rules = { medals: { gold: 2, silver: 0, bronze: 0 } };
        const settings = normalizeSettings({ ...defaultSettings, manualBoards: [{ id: 'kept', name: '保留', teamIds: [] }],
            boardAwards: { 'manual-kept': rules, 'manual-gone': rules, official: rules } });
        expect(Object.keys(settings.boardAwards).sort()).toEqual(['manual-kept', 'official']);
    });
    it('安全嵌入含 HTML 的名称', () => {
        const value = { name: '</script><script>alert(1)</script>\u2028' };
        const json = toScriptJson(value);
        expect(json).not.toContain('<'); expect(JSON.parse(json)).toEqual(value);
    });
    it('迁移旧授奖开关为一血资格，新字段优先并拒绝非法配置', () => {
        const { unofficialFirstSolve, ...legacy } = defaultSettings;
        expect(normalizeSettings(legacy).unofficialFirstSolve).toBe(false);
        expect(normalizeSettings({ ...legacy, unofficialAwards: true }).unofficialFirstSolve).toBe(true);
        expect(normalizeSettings({ ...defaultSettings, unofficialAwards: true }).unofficialFirstSolve).toBe(false);
        expect(() => normalizeSettings({ ...defaultSettings, unofficialAwards: 'false' })).toThrow('unofficialAwards');
        expect(() => normalizeSettings({ ...defaultSettings, boardAwards: { all: { firstSolve: 'yes' } } })).toThrow('firstSolve');
        expect(() => normalizeSettings({ ...defaultSettings, boardAwards: { all: { goldCitation: '' } } })).toThrow('goldCitation');
    });
    it('上游引擎入口不匹配时中断构建，避免静默授奖错误', () => {
        expect(() => patchBoardEngine('class Unsupported {}')).toThrow('无法扩展');
        expect(() => patchBoardEngine('buildRank(){} buildRank(){}')).toThrow('无法扩展');
    });
    it('XCPCIO 的气球文字颜色与插件其他页面使用同一对比度规则', () => {
        // The pinned 0.98 build's function, as shipped (query-*.js).
        const upstream = 'var er=(c)=>({rgb:()=>[1,3,5].map((i)=>parseInt(c.slice(i,i+2),16))});function tr(e){let[t,n,r]=er(e).rgb();return(t*299+n*587+r*114)/1e3<=148?`#fff`:`#000`}';
        const { source, count } = patchBoardInk(upstream);
        expect(count).toBe(1);
        const board = new Function(`${source};return tr;`)() as (hex: string) => string;
        for (const [, hex] of colorPresets) expect(board(hex), hex).toBe(inkOn(hex, '#000', '#fff'));
        expect(board('#00acc1')).toBe('#000');
        expect(patchBoardInk('function tr(e){return`#000`}').count).toBe(0);
    });
});
