import { describe, expect, it } from 'vitest';
import { enhanceBoard } from '../lib/board';
import { applyJury, creditedTime, emptyJury, heldProblems, readCredit, readHold, type JuryState } from '../lib/jury';
import { balloonKey, dueBalloons, normalizeBalloonSettings, reconcile, STATUS_ACCEPTED } from '../lib/balloons';
import { clarificationReplyPresets } from '../lib/clarification-desk';
import { resultBoard } from '../lib/results';
import { defaultSettings } from '../lib/settings';
import { demoData } from './fixture';

const minute = 60_000;
const pids = [100, 101, 102];

describe('计时补偿', () => {
    it('takes the downtime out of later submissions only', () => {
        const credit = { id: 'c', teamId: '1', from: 600, minutes: 5, reason: '断网', by: 1, at: 0 };
        expect(creditedTime(5 * minute, [credit])).toBe(5 * minute);
        // Two minutes into the downtime: back to its start.
        expect(creditedTime(12 * minute, [credit])).toBe(10 * minute);
        expect(creditedTime(30 * minute, [credit])).toBe(25 * minute);
        const twice = [credit, { ...credit, id: 'd', from: 3600, minutes: 10 }];
        expect(creditedTime(90 * minute, twice)).toBe(75 * minute);
    });

    it('counts overlapping downtime once regardless of the order it was recorded', () => {
        const intervals = [{ from: 720, minutes: 6 }, { from: 600, minutes: 5 }, { from: 660, minutes: 2 }];
        expect(creditedTime(9 * minute, intervals)).toBe(9 * minute);
        expect(creditedTime(13 * minute, intervals)).toBe(10 * minute);
        expect(creditedTime(20 * minute, intervals)).toBe(12 * minute);
    });

    it('lowers the team’s penalty on the board and in the results, for every view', () => {
        const data = demoData();
        const jury: JuryState = { holds: [], credits: [{ id: 'c', teamId: '3', from: 0, minutes: 10, reason: '换机', by: 1, at: 0 }] };
        const before = resultBoard({ data, settings: defaultSettings, problemIds: pids, beginAt: 0, endAt: 18_000_000, at: 18_000_001, lockAt: null, unlocked: true, coaches: {} }, 'all');
        const credited = applyJury(data, jury, pids, false);
        const after = resultBoard({ data: credited, settings: defaultSettings, problemIds: pids, beginAt: 0, endAt: 18_000_000, at: 18_000_001, lockAt: null, unlocked: true, coaches: {} }, 'all');
        const penalty = (board: typeof before) => board.rows.find((row) => row.id === '3')!.penalty;
        // Three accepted problems, each ten minutes earlier.
        expect(penalty(before) - penalty(after)).toBe(3 * 600);
        expect(applyJury(data, jury, pids, true).submissions.filter((run) => run.team_id === '3').map((run) => run.timestamp))
            .toEqual(credited.submissions.filter((run) => run.team_id === '3').map((run) => run.timestamp));
    });
});

describe('暂缓公布', () => {
    it('shows a held problem as judging to the public only, and keeps frozen results frozen', () => {
        const data = demoData();
        data.submissions.push({ submission_id: 'frozen', team_id: '2', problem_id: 2, timestamp: 17_000_000, status: 'FROZEN' });
        const jury: JuryState = { holds: [{ id: 'h', pid: 101, since: 1200, reason: '数据有误', by: 1, at: 0 }], credits: [] };
        const shown = applyJury(data, jury, pids, true);
        const status = (id: string, board = shown) => board.submissions.find((run) => run.submission_id === id)!.status;
        // B (101): 林澈 at 1800 s is held, 许青 at 600 s is before the hold and stays.
        const held = data.submissions.filter((run) => run.problem_id === 1 && run.timestamp >= 1_200_000).map((run) => run.submission_id);
        expect(held.length).toBeGreaterThan(0);
        expect(held.every((id) => status(id) === 'PENDING')).toBe(true);
        expect(data.submissions.filter((run) => run.problem_id === 1 && run.timestamp < 1_200_000).every((run) => status(run.submission_id) === 'CORRECT')).toBe(true);
        expect(status('frozen')).toBe('FROZEN');
        expect(applyJury(data, jury, pids, false)).toBe(data);
        // The public board ranks without the held accepts.
        const board = enhanceBoard(shown, defaultSettings);
        expect(board.submissions.filter((run) => run.status === 'PENDING')).toHaveLength(held.length);
        expect(applyJury(data, emptyJury(), pids, true)).toBe(data);
    });

    it('checks what the jury enters', () => {
        expect(readHold({ pid: 101, since: 0, reason: ' 数据 ' }, pids, 18_000)).toEqual({ pid: 101, since: 0, reason: '数据' });
        expect(() => readHold({ pid: 999, reason: 'x' }, pids, 18_000)).toThrow('题目');
        expect(() => readHold({ pid: 101, reason: '' }, pids, 18_000)).toThrow('原因');
        expect(() => readCredit({ teamId: '1', from: 60, minutes: 0, reason: 'x' }, new Set(['1']), 18_000)).toThrow('补偿时长');
        expect(() => readCredit({ teamId: '9', from: 60, minutes: 5, reason: 'x' }, new Set(['1']), 18_000)).toThrow('队伍');
        expect(heldProblems({ holds: [{ id: 'h', pid: 101, since: 60, reason: 'x', by: 1, at: 0 }], credits: [] }, 1000)).toEqual(new Map([[101, 61_000]]));
    });
});

describe('封榜后的气球', () => {
    const begin = new Date('2026-11-23T01:00:00Z');
    const tdoc = { pids: [1001, 1002, 1003], beginAt: begin, endAt: new Date(begin.getTime() + 5 * 3600_000) };
    const lockAt = begin.getTime() + 4 * 3600_000;
    const contest = 'system/6740a0000000000000000001';
    const rid = (minutes: number, n = 0) => `${Math.floor((begin.getTime() + minutes * 60_000) / 1000).toString(16)}${String(n).padStart(16, '0')}`;
    const due = dueBalloons(contest, tdoc, [
        { uid: 1, journal: [{ rid: rid(250), pid: 1001, status: STATUS_ACCEPTED }, { rid: rid(260), pid: 1002, status: STATUS_ACCEPTED }] },
        { uid: 2, journal: [{ rid: rid(30), pid: 1001, status: STATUS_ACCEPTED }, { rid: rid(60), pid: 1002, status: STATUS_ACCEPTED }, { rid: rid(270), pid: 1003, status: STATUS_ACCEPTED }] },
    ]);
    const context = { now: Date.now(), lockAt, locked: true, hold: true, tickets: false, hydroSent: new Set<string>() };

    it('still sends a team its first balloons after the freeze with 鼓励气球', () => {
        const held = (extra = {}) => Object.fromEntries(reconcile([], due, { ...context, ...extra }).inserts.map((balloon) => [balloon.key, balloon.held]));
        expect(Object.values(held()).filter(Boolean)).toHaveLength(3);
        const encouraged = held({ encourage: 2 });
        // Team 1 had no balloon before the freeze: both of its first two go out. Team 2's third waits.
        expect(encouraged[balloonKey(contest, 1, 1001)]).toBe(false);
        expect(encouraged[balloonKey(contest, 1, 1002)]).toBe(false);
        expect(encouraged[balloonKey(contest, 2, 1003)]).toBe(true);
        expect(normalizeBalloonSettings({ afterFreeze: 'encourage', encourageCount: 2 }, tdoc.pids)).toMatchObject({ afterFreeze: 'encourage', encourageCount: 2 });
        expect(() => normalizeBalloonSettings({ encourageCount: 0 }, tdoc.pids)).toThrow('鼓励气球');
    });

    it('holds balloons of a problem the jury holds, also before the freeze', () => {
        const inserts = reconcile([], due, { ...context, locked: false, heldProblems: new Map([[1002, begin.getTime() + 50 * minute]]) }).inserts;
        expect(inserts.filter((balloon) => balloon.held).map((balloon) => balloon.key)).toEqual([balloonKey(contest, 2, 1002), balloonKey(contest, 1, 1002)]);
    });
});

it('offers the CCS answer for questions answered at the questions session', () => {
    expect(clarificationReplyPresets).toContain('将在答疑环节统一回答');
});
