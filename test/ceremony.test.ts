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

import { awardSubtitle, awardTier, ceremonyConfig, ceremonyDefaults, ceremonySlides, ceremonyThemes, paginate, type CeremonyAwardSlide, type CeremonySlide } from '../lib/ceremony-slides';
import { resultBoard, type ResultsData } from '../lib/results';

describe('颁奖幻灯片', () => {
    it('balances pages within tolerance and bounds unavoidable remainders', () => {
        for (let n = 1; n <= 150; n++) {
            const items = Array.from({ length: n }, (_, i) => i);
            for (const [target, tol] of [[6, 2], [4, 0], [1, 4], [16, 1]]) {
                const pages = paginate(items, target, tol);
                expect(pages.flat()).toEqual(items);
                const sizes = pages.map(p => p.length);
                expect(Math.max(...sizes) - Math.min(...sizes)).toBeLessThanOrEqual(1);
                if (Math.ceil(n / (target + tol)) <= Math.floor(n / Math.max(1, target - tol))) {
                    expect(Math.min(...sizes)).toBeGreaterThanOrEqual(target - tol);
                    expect(Math.max(...sizes)).toBeLessThanOrEqual(target + tol);
                }
            }
        }
        expect(paginate([], 6, 2)).toEqual([]);
    });
    const sourceOf = (overrides = {}) => {
        const data = demoData();
        data.teams[0].members = ['成员甲', '成员乙'];
        const settings = normalizeSettings({ ...defaultSettings, medals: { gold: 1, silver: 1, bronze: 2 }, firstSolve: true, podiumEnabled: true,
            manualBoards: [{ id: 'local', name: '校内', teamIds: ['1', '2', '3'] }],
            specialAwards: [{ id: 'extra', name: '特别贡献奖', kind: 'manual', teamIds: ['1'] }], ...overrides });
        const source: ResultsData = { data, settings, at: data.contest.end_time * 1000, beginAt: data.contest.start_time * 1000, endAt: data.contest.end_time * 1000, unlocked: true, lockAt: null, coaches: {}, problemIds: [11, 12, 13] };
        return source;
    };
    const awards = (slides: CeremonySlide[]) => slides.filter((s): s is CeremonyAwardSlide => s.kind === 'award');
    it('keeps each board together, includes first solves, reverses awards, and applies identity visibility', () => {
        const source = sourceOf();
        const config = ceremonyConfig({ boards: ['all', 'manual-local'], showMembers: true });
        const deck = ceremonySlides(source, config, { 南京晓庄学院: 'abcdef012345' });
        expect(deck.slides[0]).toEqual({ kind: 'cover' });
        expect(deck.date).toBe(source.beginAt);
        const main = awards(deck.slides).filter(s => s.board === '所有队伍');
        expect(main.map(s => s.award)).toContain('特别贡献奖');
        expect(main.some(s => s.award.includes('一血'))).toBe(true);
        expect(main.findIndex(s => s.award === '铜奖')).toBeLessThan(main.findIndex(s => s.award === '金奖'));
        expect(main.at(-1)?.award).toMatch(/冠军|亚军|季军/);
        expect(awards(deck.slides).slice(main.length).every(s => s.board === '校内')).toBe(true);
        expect(awards(deck.slides).flatMap(s => s.teams)).toContainEqual({ name: '林澈', school: '南京晓庄学院', members: ['成员甲', '成员乙'], logo: '/hydro-resolver/logos/abcdef012345.webp', rank: 1 });
        const reverse = ceremonySlides(source, { ...ceremonyDefaults, reverse: true, showSchool: false, cover: false }, {});
        expect(reverse.slides.every(s => s.kind === 'award')).toBe(true);
        expect(awards(reverse.slides).map(s => s.award)).toEqual(main.map(s => s.award).reverse());
        expect(awards(reverse.slides).flatMap(s => s.teams).every(t => !t.school && !t.members.length && !t.logo)).toBe(true);
    });
    it('marks tiers with English titles, orders teams within an award and passes fixed columns', () => {
        const source = sourceOf({ medals: { gold: 1, silver: 1, bronze: 3 } });
        const slides = awards(ceremonySlides(source, ceremonyConfig({ cover: false, columns: 3 }), {}).slides);
        const tier = (name: string) => slides.find(s => s.award === name)!;
        expect([tier('金奖').tier, tier('金奖').subtitle]).toEqual(['gold', 'GOLD MEDAL']);
        expect([tier('银奖').tier, tier('铜奖').tier]).toEqual(['silver', 'bronze']);
        expect([tier('冠军').tier, tier('冠军').subtitle, tier('亚军').subtitle, tier('季军').subtitle]).toEqual(['trophy', 'CHAMPION', 'RUNNER-UP', 'THIRD PLACE']);
        expect(slides.find(s => s.tier === 'first')?.subtitle).toBe('FIRST TO SOLVE');
        expect(tier('特别贡献奖')).toMatchObject({ tier: 'special', subtitle: 'SPECIAL AWARD' });
        expect(slides.every(s => s.columns === 3)).toBe(true);
        const bronze = tier('铜奖').teams.map(t => t.rank);
        expect(bronze).toEqual([...bronze].sort((a, b) => a - b));
        const reversed = awards(ceremonySlides(source, ceremonyConfig({ cover: false, withinOrder: 'reverse' }), {}).slides).find(s => s.award === '铜奖')!;
        expect(reversed.teams.map(t => t.rank)).toEqual([...bronze].reverse());
        expect(awardTier({ id: 'highest-honors', kind: 'special' })).toBe('honors');
        expect(awardSubtitle({ id: 'podium-x', kind: 'trophy' }, 4)).toBe('5TH PLACE');
    });
    it('leads school trophies with the school and its school rank', () => {
        const source = sourceOf({ podiumBasis: 'school' });
        const slides = awards(ceremonySlides(source, ceremonyConfig({ cover: false, showSchool: false }), {}).slides);
        const champion = slides.find(s => s.tier === 'trophy')!;
        const row = resultBoard(source, 'all').rows.find(r => r.school === champion.teams[0].name)!;
        expect(champion.teams[0]).toMatchObject({ name: row.school, school: row.name, rank: row.schoolRank });
        expect(slides.filter(s => s.tier === 'gold').flatMap(s => s.teams).every(t => !t.school)).toBe(true);
    });
    it('accepts a v2.0.0 configuration and rejects malformed band zones', () => {
        const old = { source: 'current', boards: ['all'], reverse: false, target: 6, tolerance: 2, showSchool: true, showMembers: false, showTitle: true, theme: 'gala', header: 4, footer: 4 };
        expect(ceremonyConfig(old as never)).toMatchObject({ ...old, cover: true, columns: 0, withinOrder: 'rank', headerZones: [false, false, false] });
        expect(() => ceremonyConfig({ headerZones: [true, false] as never })).toThrow();
        expect(() => ceremonyConfig({ columns: 5 })).toThrow();
        expect(() => ceremonyConfig({ theme: 'neon' as never })).toThrow();
        expect(Object.keys(ceremonyThemes)).toHaveLength(8);
    });
});
