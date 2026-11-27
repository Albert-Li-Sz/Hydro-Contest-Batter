import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { previewDatabase } from '../preview/resolver-memory-db';
import { resultsPage } from '../lib/results-page';
import { ResultsStore, resultKey } from '../lib/results-store';
import { awardsCsv, compareResults, resultBoard, restoreRejudge, settled, standingsCsv, type ResultsData } from '../lib/results';
import { defaultSettings, type SpecialAward } from '../lib/settings';
import { demoData } from './fixture';

function fixture(): ResultsData {
    const data = demoData();
    const award: SpecialAward = { id: 'end', name: '顽强拼搏奖', kind: 'lastAccept', board: 'all', rank: 1, teamIds: [], unofficial: false, ties: true, count: 1, minTeams: 0, minSolved: 1, floor: 'none', excludeMedalists: false };
    return {
        data,
        settings: { ...defaultSettings, firstSolve: true, specialAwards: [award], participationBoards: true },
        problemIds: [101, 102, 103], beginAt: data.contest.start_time * 1000, endAt: data.contest.end_time * 1000,
        at: data.contest.end_time * 1000 + 1000, lockAt: null, unlocked: true, coaches: { '1': ['周老师'] },
    };
}

describe('contest results and exports', () => {
    it('uses the same ranks and awards, preserves last-minute runs and omits after-contest submissions', () => {
        const source = fixture();
        const duration = source.endAt - source.beginAt;
        source.data.submissions.push(
            { submission_id: 'before-end', team_id: '7', problem_id: 0, timestamp: duration - 1000, status: 'CORRECT' },
            { submission_id: 'at-end', team_id: '8', problem_id: 0, timestamp: duration, status: 'CORRECT' },
        );
        const result = resultBoard(source, 'all');
        expect(result.rows.slice(0, 2).map(({ id, rank, solved, penalty }) => [id, rank, solved, penalty]))
            .toEqual([['1', 1, 3, 6600], ['3', 2, 3, 7800]]);
        expect(result.rows.find(({ id }) => id === '4')).toMatchObject({ rank: 0, medals: [] });
        expect(result.rows.find(({ id }) => id === '7')).toMatchObject({
            solved: 2, cells: { 101: { time: Math.floor(duration / 1000) - 1 } }, specials: ['顽强拼搏奖'],
        });
        expect(result.runs.map(({ submission_id }) => submission_id)).not.toContain('at-end');
    });

    it('applies the selected sub-board rules and recomputes first solves within that board', () => {
        const source = fixture();
        source.settings.manualBoards = [{ id: 'sub', name: '校内榜', teamIds: ['2', '3', '6'] }];
        source.settings.boardAwards = { 'manual-sub': { ...defaultSettings, firstSolve: true, goldCitation: '校内金奖', medals: { gold: 1, silver: 0, bronze: 0 } } };
        const result = resultBoard(source, 'manual-sub');
        expect(result.rows.map(({ id, rank }) => [id, rank])).toEqual([['3', 1], ['2', 2], ['6', 0]]);
        expect(result.rows[0]).toMatchObject({ medals: ['校内金奖'], firsts: ['A 题一血', 'B 题一血', 'C 题一血'] });
        expect(resultBoard(source, 'unofficial').rows.every((row) => row.rank === 0 && !row.medals.length)).toBe(true);
    });

    it('withholds an unsettled first solve when a same-second submission is pending', () => {
        const source = fixture();
        source.data.submissions.push({ submission_id: 'zz-pending', team_id: '2', problem_id: 0, timestamp: 600_000, status: 'PENDING' });
        expect(settled(source)).toBe(false);
        expect(resultBoard(source, 'all').awards.some((award) => award.id === 'first-101')).toBe(false);
    });

    it('compares changed ranks, awards, status and score independently of contest problem order', () => {
        const old = fixture();
        const changed = fixture();
        const target = changed.data.submissions.find(({ submission_id }) => submission_id === 's-7')!;
        target.status = 'WRONG_ANSWER';
        target.score = 0;
        changed.problemIds = [102, 101, 103];
        changed.data.contest.problem_id = ['A', 'B', 'C'];
        for (const run of changed.data.submissions) if (run.problem_id < 2) run.problem_id = 1 - run.problem_id;
        const diff = compareResults(resultBoard(old, 'all'), resultBoard(changed, 'all'));
        expect(diff.submissions).toEqual([expect.objectContaining({ id: 's-7', before: 'AC', after: 'WA', beforeScore: null, afterScore: 0 })]);
        expect(diff.rows.find(({ id }) => id === '3')).toMatchObject({ changed: true, before: { solved: 3 }, after: { solved: 2 } });
        expect(diff.rows.find(({ id }) => id === '8')?.changed).toBe(false);
    });

    it('rewinds rejudge results and removes submissions made after the reconstructed baseline', () => {
        const source = fixture();
        const original = new Map([['s-1', { status: 'WRONG_ANSWER', score: 0 }]]);
        const reconstructed = restoreRejudge(source, source.beginAt + 1810_000, original);
        expect(reconstructed.data.submissions.find(({ submission_id }) => submission_id === 's-1')).toMatchObject({ status: 'WRONG_ANSWER', score: 0 });
        expect(reconstructed.data.submissions.every((run) => run.timestamp <= 1810_000)).toBe(true);
        expect(source.data.submissions.find(({ submission_id }) => submission_id === 's-1')?.status).toBe('CORRECT');
    });

    it('exports UTF-8 BOM CSVs with team, coach, special awards, problem results and safe text', () => {
        const source = fixture();
        source.data.teams[0].name = ' =HYPERLINK("恶意")';
        const result = resultBoard(source, 'all');
        const standings = standingsCsv(result);
        const awards = awardsCsv(result);
        expect(Buffer.from(standings).subarray(0, 3).toString('hex')).toBe('efbbbf');
        expect(standings).toContain('"A 尝试次数","A 计罚次数","A 时间（秒）"');
        expect(standings).toContain('"\' =HYPERLINK(""恶意"")"');
        expect(standings).toContain('"通过",1,0,600');
        expect(awards).toContain('"顽强拼搏奖",3,"陈言","南京邮电大学","陈言",""');
        expect(awards).toContain('"周老师"');
    });

    it('keeps removed sub-boards available for compare and marks reconstructed exports as provisional', () => {
        const before = fixture();
        const after = fixture();
        after.settings.participationBoards = false;
        const result = resultsPage({
            tdoc: { title: '测试比赛' }, codeBase: '', contestUrl: '/d/system/contest/id', submissionsUrl: '/record/',
            before, after, beforeId: 'stored', afterId: 'history:legacy', selectedBoard: 'official', options: [],
            allRows: false, saved: false,
        });
        expect(result).toMatchObject({ selectedBoard: 'official', isFinal: false, approximate: true, exportable: false, nativeCode: '/d/system/contest/id/code?all=true' });
        expect(result.changes).toHaveLength(6);
    });
});

describe('results snapshot storage', () => {
    const scope = { domainId: 'system', contestId: 'contest' };
    it('compresses a preserved snapshot, deduplicates concurrent automatic captures and scopes access', async () => {
        const db = previewDatabase();
        const store = new ResultsStore(db.db);
        const source = fixture();
        const _id = resultKey(scope, 'end-test');
        const meta = { _id, reason: 'end' as const, eventAt: new Date(source.endAt) };
        await Promise.all([store.save(scope, meta, async () => source), store.save(scope, meta, async () => source)]);
        expect(await store.list(scope)).toHaveLength(1);
        const saved = await store.read(scope, _id);
        expect(saved).toEqual(source);
        source.settings.goldCitation = '另设金奖';
        expect((await store.read(scope, _id))?.settings.goldCitation).toBe('金奖');
        expect(await store.read({ ...scope, domainId: 'elsewhere' }, _id)).toBeNull();
    });

    it('uses ordered chunks for a payload exceeding the inline document budget', async () => {
        const db = previewDatabase();
        const store = new ResultsStore(db.db);
        const source = fixture();
        source.data.teams[0].random = randomBytes(10 * 1024 * 1024).toString('base64');
        const _id = resultKey(scope, 'large');
        await store.save(scope, { _id, reason: 'manual', eventAt: new Date(source.at) }, async () => source);
        const chunks = [...db.tables.get('xcpcio.results.chunks')!.values()];
        expect(chunks.length).toBeGreaterThan(1);
        expect(chunks.every((chunk) => chunk.data.length <= 4 * 1024 * 1024)).toBe(true);
        expect((await store.read(scope, _id))?.data.teams[0].random === source.data.teams[0].random).toBe(true);
    });
});
