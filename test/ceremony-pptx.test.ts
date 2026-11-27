import { posix } from 'node:path';
import { expect, it } from 'vitest';
import { ceremonyKey, ceremonyPptx, parseCeremonyLayout } from '../lib/ceremony-pptx';
import { ceremonyDefaults, type ceremonySlides } from '../lib/ceremony-slides';
import { readZip } from '../lib/ccs/zip';
import { defaultResolverConfig, parseResolverConfig, prepareResolver, resolverBoards } from '../lib/resolver-data';
import { buildGame } from '../resolver/server/lib/engine.js';
import { defaultSettings } from '../lib/settings';
import { demoData } from './fixture';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64');
const row = { name: 'A & <B>', school: '学校', members: ['成员甲'], rank: 1, logo: '/hydro-resolver/logos/012345abcdef.webp' };
const deck: ReturnType<typeof ceremonySlides> = { title: '比赛', date: 86400000, boards: [], slides: [{ kind: 'cover' },
    { kind: 'award', award: '金奖', tier: 'gold', subtitle: 'GOLD MEDAL', board: '主榜', part: 1, parts: 1, columns: 1, teams: [row, row] }] };
function measured() {
    const b = [10, 20, 300, 60, 24];
    const fit = { cols: 1, size: 2.5, wrap: true, slots: Object.fromEntries(['cover','ceremony','name1','rank1','award','subtitle','name0','school0','members0','rank0','logo0','logo1'].map(k => [k,b])) };
    return { key: ceremonyKey(deck), layouts: [fit,fit], backgroundAt: 13, backgroundAspect: 2, ink: '#ffffff', timeZone: 'Asia/Shanghai' };
}

it('packages editable PowerPoint text, a 16:9 master, shared PNG crests and a cropped embedded background', async () => {
    const fit = parseCeremonyLayout(JSON.stringify(measured()), deck, 13);
    const file = await ceremonyPptx(deck, ceremonyDefaults, fit, { data: png, mime: 'image/png' }, async () => png);
    const parts = new Map(readZip(file, { maxFiles: 40, maxBytes: 80000 }).map(e => [e.name, e.data]));
    expect(parts.get('ppt/media/background.png')).toEqual(png);
    expect(parts.get('ppt/media/012345abcdef.png')).toEqual(png);
    expect([...parts.keys()].filter(k => k.startsWith('ppt/media/'))).toHaveLength(2);
    const slide = parts.get('ppt/slides/slide2.xml')!.toString();
    expect(slide).toContain('A &amp; &lt;B&gt;');
    expect(slide).toContain('<p:txBody>'); expect(slide).toContain('GOLD MEDAL');
    expect(slide).toMatch(/<a:srcRect l="[1-9]\d*" r="[1-9]\d*"/);
    expect(parts.get('ppt/presentation.xml')!.toString()).toContain('type="screen16x9"');
    for (const [file, data] of parts) {
        if (!file.endsWith('.rels')) continue;
        const folder = file === '_rels/.rels' ? '' : posix.dirname(posix.dirname(file));
        for (const [, target] of data.toString().matchAll(/Target="([^"]+)"/g)) expect(parts.has(posix.join(folder, target))).toBe(true);
    }
});

it('requires a current deck and background and finite, measured positions', () => {
    const fit = measured();
    expect(() => parseCeremonyLayout(JSON.stringify(fit), deck, 14)).toThrow('背景已更新');
    expect(() => parseCeremonyLayout(JSON.stringify(fit), { ...deck, title: '另一场' }, 13)).toThrow('成绩');
    fit.layouts[0].slots.award[2] = -10;
    expect(() => parseCeremonyLayout(JSON.stringify(fit), deck, 13)).toThrow('排版');
});

it('preserves the default original renderer, validates the new option and limits replay to public events', () => {
    const settings = { ...defaultSettings, podiumEnabled: true };
    const data = demoData();
    const defaults = defaultResolverConfig(settings, true);
    expect(defaults.renderer).toBe('2d');
    expect(() => parseResolverConfig({ renderer: 'other' }, defaults)).toThrow();
    const config = parseResolverConfig({ renderer: '3d', freezeMode: 'custom', freezeAtSeconds: 3600 }, defaults);
    const { game, snapshot } = prepareResolver(data, resolverBoards(data, settings, true), config, { contestId: 'c', ended: true, capturedAt: new Date(), logoNames: {} });
    expect(() => buildGame(snapshot, { renderer: 'other' })).toThrow('滚榜样式');
    expect(game.options.renderer).toBe('3d');
    const replay = game.initialState.replay as number[][];
    expect(replay).toHaveLength(data.submissions.filter(r => r.timestamp <= 3600000).length);
    expect(replay.every(([ms,t,p]) => ms <= 3600000 && !!game.contest.teams[t] && !!game.contest.problems[p])).toBe(true);
    expect(game.steps.filter(s => s.podium)).toHaveLength(1);
    expect(game.steps.at(-2)).toMatchObject({ role: 'finale', podium: expect.arrayContaining([expect.objectContaining({ place: 0 })]) });
});
