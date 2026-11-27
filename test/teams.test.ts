import { describe, expect, it } from 'vitest';
import { previewDatabase } from '../preview/resolver-memory-db';
import { describeTeam, isTeamEntry, loadBoardProfiles, memberIds } from '../lib/teams';

const users = {
    [-1001]: { _id: -1001, uname: 'team:7:ab12cd', displayName: '星火队' },
    [-1002]: { _id: -1002, uname: 'team:9:zz00yy' },
    7: { _id: 7, uname: 'lin', displayName: '林澈', school: '南京晓庄学院' },
    8: { _id: 8, uname: 'zhou', displayName: '周宁', school: '南京邮电大学' },
    9: { _id: 9, uname: 'chen', displayName: '陈言', school: '南京晓庄学院' },
    10: { _id: 10, uname: 'solo', displayName: '许青', school: '东南大学' },
};

describe('Hydro team contests', () => {
    it('reads the three onsite girl aliases from the registered account or virtual team', async () => {
        const { db } = previewDatabase();
        await db.collection('user').insertMany([
            { _id: 10, girl: true, coaches: ['李教练'], seat: 9 }, { _id: 11, isGirl: ' Yes ' },
            { _id: 12, 女队: '否' }, { _id: 13, girl: 'false' }, { _id: 14, girl: 0 }, { _id: 99, girl: true },
        ] as never);
        await db.collection('vuser').insertMany([
            { _id: -1, 女队: '是', coach: '唐教练', seat: ' B08 ' }, { _id: -2, isGirl: 1 }, { _id: -3, members: [99] },
        ] as never);
        const profiles = await loadBoardProfiles(db, [10, 11, 12, 13, 14, -1, -2, -3, -1]);
        expect(Object.fromEntries(profiles)).toEqual({
            10: { girl: true, coaches: ['李教练'], location: '9' }, 11: { girl: true }, 12: {}, 13: {}, 14: {},
            '-1': { girl: true, coaches: ['唐教练'], location: 'B08' }, '-2': { girl: true }, '-3': {},
        });
    });

    it('loads members only for team contests', () => {
        const entries = [{ uid: -1001, members: [7, 8, 9] }, { uid: 10 }];
        expect(memberIds({ allowTeam: true }, entries)).toEqual([7, 8, 9]);
        expect(memberIds({}, entries)).toEqual([]);
        expect(isTeamEntry(entries[1])).toBe(false);
    });

    it('shows a team by its public name, members by their display names, school only with identity', () => {
        const entry = { uid: -1001, displayName: '旧队名', members: [7, 8, 9] };
        expect(describeTeam(entry, users, true)).toEqual({ name: '星火队', school: '南京晓庄学院', members: ['林澈', '周宁', '陈言'] });
        expect(describeTeam(entry, users, false)).toEqual({ name: '星火队', school: undefined, members: ['林澈', '周宁', '陈言'] });
        // A member without a display name shows the account name.
        expect(describeTeam({ uid: -1001, members: [7, 11] }, { ...users, 11: { _id: 11, uname: 'wang', displayName: '  ' } }, false)!.members).toEqual(['林澈', 'wang']);
        // No display name on the team user: the name it attended with, never the generated login name.
        expect(describeTeam({ uid: -1002, displayName: '无名队', members: [9] }, users, false)!.name).toBe('无名队');
        // Members who no longer exist are left out.
        expect(describeTeam({ uid: -1001, members: [7, 404] }, users, true)!.members).toEqual(['林澈']);
    });

    it('keeps a participant who attends alone a one-person team', () => {
        expect(describeTeam({ uid: 10 }, users, true)).toEqual({ name: '许青', school: '东南大学', members: undefined });
        expect(describeTeam({ uid: 10 }, users, false)).toEqual({ name: '许青', school: undefined, members: undefined });
        expect(describeTeam({ uid: 11 }, { 11: { _id: 11, uname: 'wang' } }, false)!.name).toBe('wang');
    });

    it('takes the school most members share, the earlier member on a tie', () => {
        expect(describeTeam({ uid: -1001, members: [8, 7] }, users, true)!.school).toBe('南京邮电大学');
        expect(describeTeam({ uid: -1001, members: [8, 7, 9] }, users, true)!.school).toBe('南京晓庄学院');
    });
});

describe('team members in the resolver', () => {
    it('keep their names through the snapshot into the game the award page draws', async () => {
        const { teamData } = await import('../preview/fixtures');
        const { defaultSettings } = await import('../lib/settings');
        const { defaultResolverConfig, prepareResolver, resolverBoards } = await import('../lib/resolver-data');
        const data = teamData();
        const settings = { ...defaultSettings, showIdentity: true };
        const payload = prepareResolver(data, resolverBoards(data, settings, true),
            { ...defaultResolverConfig(settings, true), rehearsal: true, freezeMode: 'custom', freezeAtSeconds: 3000 },
            { contestId: 't', ended: true, capturedAt: new Date(), logoNames: {} });
        expect(payload.snapshot.teams[0]).toMatchObject({ name: '星火队', members: ['林澈', '周宁', '陈言'] });
        const game = payload.game as unknown as { contest: { teams: { id: string; members?: string[] }[] } };
        expect(game.contest.teams.find((team) => team.id === '1')?.members).toEqual(['林澈', '周宁', '陈言']);
    });
});
