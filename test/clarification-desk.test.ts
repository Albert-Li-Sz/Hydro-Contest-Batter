import { describe, expect, it } from 'vitest';
import {
    activeDeskClaim, clarificationReplyPresets, deskSettings, deskView, freezeNotice, isDeskWrite,
    readDeskSettings, readDeskSubject, readDeskText, type DeskActor, type DeskClarification,
} from '../lib/clarification-desk';
import { broadcastRows } from '../lib/screens-data';

function id(text: string, at: number) { return { toString: () => text, getTimestamp: () => new Date(at) }; }
function question(name: string, subject: number, at: number, replyAt?: number): DeskClarification {
    return {
        docId: id(name, at), subject, owner: 1, content: name,
        reply: replyAt === undefined ? [] : [{ _id: id(`r-${name}`, replyAt), owner: 0, content: '裁判回复' }],
    };
}
const actors: Record<string, DeskActor> = {
    manager: { id: 'user:10', label: '管理员', pid: null },
    problemA: { id: 'link:1', label: 'A 题答疑员', pid: 101 },
};
const subjects = [{ pid: -1, label: '技术问题' }, { pid: 0, label: '通用' }, { pid: 101, label: 'A' }, { pid: 102, label: 'B' }];
const people = new Map([[1, { name: '队伍甲', seat: 'A-03' }]]);

describe('Clarification desk', () => {
    it('accepts its own browser fetch and rejects cross-origin writes and navigation forms', () => {
        const xhr = { 'x-requested-with': 'XMLHttpRequest' };
        expect(isDeskWrite('localhost:8080', { ...xhr, origin: 'http://localhost:8080' })).toBe(true);
        expect(isDeskWrite('localhost:8080', { ...xhr, origin: 'http://elsewhere:8080' })).toBe(false);
        expect(isDeskWrite('localhost:8080', { ...xhr, origin: 'null' })).toBe(false);
        // Not a URL at all: rejected, not thrown (no URL.parse, which Node 22.0 lacks).
        expect(isDeskWrite('localhost:8080', { ...xhr, origin: '%%' })).toBe(false);
        expect(isDeskWrite('localhost:8080', { origin: 'http://localhost:8080' })).toBe(false);
    });

    it('retains distinct standard replies and validates customizable templates, problem scope and text', () => {
        expect(deskSettings().replies).toEqual(clarificationReplyPresets);
        expect(new Set(deskSettings().replies).size).toBe(5);
        expect(readDeskSettings({ replies: [' 是 ', '否', '是'], freezeMinutes: 5 })).toEqual({ replies: ['是', '否'], freezeMinutes: 5 });
        expect(() => readDeskSettings({ replies: [' '], freezeMinutes: 5 })).toThrow(/回复模板/);
        expect(() => readDeskSettings({ replies: [], freezeMinutes: 121 })).toThrow(/120/);
        expect(() => readDeskSubject(0, [101])).toThrow();
        expect(() => readDeskSubject('101', [101])).toThrow();
        expect(readDeskSubject(-1, [101], true)).toBe(-1);
        expect(readDeskText('  更新内容 ')).toBe('更新内容');
        expect(() => readDeskText(' ', '公开公告内容')).toThrow(/公开公告内容/);
    });

    it('shows only the delegate’s assigned problem and reports manager-wide round times and pending claims', () => {
        const docs = [question('技术问题', -1, 400), question('A 等待', 101, 270), question('B 已回复', 102, 210, 810),
            question('A 已回复', 101, 150, 190), question('B 等待', 102, 110)];
        const claims = new Map([['A 等待', { actor: 'link:1', name: 'A 题答疑员', at: 550, until: 1000 }]]);
        const manager = deskView(docs, subjects, people, claims, actors.manager, 900);
        const scoped = deskView(docs, subjects, people, claims, actors.problemA, 900);
        expect(manager.pending.map(({ id: name }) => name)).toEqual(['B 等待', 'A 等待', '技术问题']);
        expect(manager.stats).toMatchObject({ pending: 3, answered: 2, averageResponseMs: 320 });
        expect(manager.pending[1]).toMatchObject({ team: { name: '队伍甲', seat: 'A-03' }, claim: { mine: false, name: 'A 题答疑员' } });
        expect(scoped.pending.map(({ id: name }) => name)).toEqual(['A 等待']);
        expect(scoped.pending[0].claim).toMatchObject({ mine: true });
        expect(scoped.subjects).toEqual([{ pid: 101, label: 'A' }]);
        expect(scoped.stats).toMatchObject({ pending: 1, answered: 1, averageResponseMs: 40 });
        expect(activeDeskClaim(claims.get('A 等待'), 1000)).toBeNull();
    });

    it('keeps a team’s own replies private and only exposes native public announcements on the screen', () => {
        const doc = question('私密的题目内容', 101, 110);
        doc.reply = [{ _id: id('team-followup', 130), owner: 1, content: '选手自己的补充' }];
        const publicDoc = { docId: id('broadcast', 500), subject: 101, owner: 0, content: '公开版答复' };
        const otherDoc = { docId: id('other', 520), subject: 102, owner: 0, content: 'B 题公开公告' };
        const docs = [otherDoc, publicDoc, doc];
        const scoped = deskView(docs, subjects, people, new Map(), actors.problemA, 600);
        expect(scoped.pending.map((row) => row.text)).toEqual(['私密的题目内容']);
        expect(scoped.announcements.map((row) => row.text)).toEqual(['公开版答复']);
        expect(broadcastRows(docs, [101, 102], ['A', 'B'])).toEqual([
            { at: 520, subject: 'B', text: 'B 题公开公告' }, { at: 500, subject: 'A', text: '公开版答复' },
        ]);
    });

    it('makes the automatic reminder due only during the configured interval before the freeze', () => {
        const start = 0;
        const freeze = 35 * 60_000;
        const end = 60 * 60_000;
        expect(freezeNotice(start, freeze, end, 10, 25 * 60_000 - 1, false)).toBeNull();
        expect(freezeNotice(start, freeze, end, 10, 25 * 60_000, false)).toBe(freeze);
        expect(freezeNotice(start, freeze, end, 10, freeze, false)).toBeNull();
        expect(freezeNotice(start, freeze, end, 10, 26 * 60_000, true)).toBeNull();
        expect(freezeNotice(start, freeze, end, 0, 26 * 60_000, false)).toBeNull();
        expect(freezeNotice(start, end, end, 10, 55 * 60_000, false)).toBeNull();
    });
});
