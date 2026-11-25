import { describe, expect, it } from 'vitest';
import { ceremonyScript } from '../lib/ceremony';
import { defaultResolverConfig, prepareResolver, resolverBoards } from '../lib/resolver-data';
import { defaultSettings, normalizeSettings } from '../lib/settings';
import type { SpecialResult } from '../lib/special-awards';
import { demoData } from './fixture';

describe('颁奖台本', () => {
    it('lists the awards from the bottom up, medals as stage steps and specials where the team is resolved', () => {
        const data = demoData();
        const settings = normalizeSettings({ ...defaultSettings, medals: { gold: 1, silver: 1, bronze: 2 }, podiumEnabled: true, firstSolve: true });
        const special: SpecialResult[] = [{ id: 'girls', name: '最佳女队', teamIds: ['7'] }];
        const payload = prepareResolver(data, resolverBoards(data, settings, true), { ...defaultResolverConfig(settings, true), freezeMode: 'custom', freezeAtSeconds: 3600 },
            { contestId: 'c', ended: true, capturedAt: new Date(0), logoNames: {}, special });
        const script = ceremonyScript(payload);
        const steps = script.segments.map((segment) => [segment.kind, segment.citation, segment.teams.map((team) => team.name).join(',')]);
        // 沈星 (7th) has only the special award and C's first solve; the bronzes come next, then silver, gold and the trophies.
        expect(steps[0]).toEqual(['special', '最佳女队、C 题最快解题奖', '沈星']);
        expect(steps.filter(([kind]) => kind === 'stage').map(([, citation]) => citation)).toEqual(['铜奖', '季军', '亚军', '冠军']);
        const gold = script.segments.find((segment) => segment.citation === '冠军')!;
        expect(gold.teams[0]).toMatchObject({ name: '林澈', rank: 1 });
        expect(gold.teams[0].extras).toEqual(expect.arrayContaining(['金奖']));
        expect(script.rehearsal).toBe(false);
        expect(ceremonyScript({ ...payload, config: { ...payload.config, rehearsal: true } }).rehearsal).toBe(true);
    });
});
