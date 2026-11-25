import { deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { previewDatabase } from '../preview/resolver-memory-db';
import {
    certificateEntries, defaultConfig, fillText, missingFields, normalizeConfig, overridesFromCsv, parseCsv, planIssue, fingerprint, sheetOf, sheetRows,
} from '../lib/certificates/model';
import { buildPdf, parseImage, textWidth } from '../lib/certificates/pdf';
import { qrMatrix } from '../lib/certificates/qr';
import { certificatePage } from '../lib/certificates/render';
import { certificateService } from '../lib/certificates/service';
import { ResultsStore } from '../lib/results-store';
import { resultBoard, resultsCsv, type ResultsData } from '../lib/results';
import { defaultSettings, normalizeSettings } from '../lib/settings';
import { demoData } from './fixture';

function source(): ResultsData {
    const data = demoData();
    const settings = normalizeSettings({ ...defaultSettings, medals: { gold: 1, silver: 1, bronze: 1 }, firstSolve: true, unofficialFirstSolve: true });
    return {
        data, settings, problemIds: [101, 102, 103], beginAt: data.contest.start_time * 1000, endAt: data.contest.end_time * 1000,
        at: data.contest.end_time * 1000 + 1000, lockAt: null, unlocked: true, coaches: { '1': ['周老师'] },
    };
}

describe('证书清单', () => {
    it('gives certificates by the awards: medals to official teams, first solves also to unofficial ones', () => {
        const result = resultBoard(source(), 'all');
        const config = { ...defaultConfig('测试赛'), kinds: { team: true, member: true, coach: true, participation: true } };
        const entries = certificateEntries(result, config);
        const of = (teamId: string) => entries.filter((entry) => entry.teamId === teamId).map((entry) => `${entry.kind}:${entry.values.award}`);
        expect(of('1')).toEqual(expect.arrayContaining(['team:金奖', 'member:金奖', 'coach:金奖', 'participation:']));
        // 苏禾 (unofficial) solved A first among nobody… 林澈 was first on A; 苏禾 gets no medal and no 参赛证明.
        expect(of('4').some((item) => item.includes('奖') && !item.includes('一血'))).toBe(false);
        expect(of('4').some((item) => item.startsWith('participation'))).toBe(false);
        // Keys stay the same when names change.
        expect(entries.every((entry) => entry.key.split(':').length >= 3)).toBe(true);
        expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);
    });

    it('leaves out lines whose placeholders are empty and lists what a template misses', () => {
        expect(fillText('{nameEn}', { nameEn: '' })).toBe('');
        expect(fillText('教练：{coach}', { coach: '' })).toBe('');
        expect(fillText('{school} · {team}', { school: '东大', team: '' })).toBe('东大 ·');
        expect(fillText('获奖证书', {})).toBe('获奖证书');
        const config = defaultConfig('测试赛');
        const [entry] = certificateEntries(resultBoard(source(), 'all'), config);
        expect(missingFields(config.templates.award, entry)).toEqual(expect.arrayContaining(['nameEn', 'issuer', 'date']));
        expect(missingFields(config.templates.award, entry)).not.toContain('number');
    });

    it('reads the sheet back from its CSV, keeping only what differs from the results', () => {
        const result = resultBoard(source(), 'all');
        const sheet = sheetOf(result, {});
        const rows = sheetRows(sheet);
        const csv = resultsCsv(rows.map((row, index) => (index === 1 ? [row[0], row[1], row[2], row[3], 'Lin Che', row[5], 'Team Lin', row[7], 'Nanjing Xiaozhuang University'] : row)));
        expect(parseCsv(csv)[1].slice(0, 5)).toEqual(["'1".replace("'", ''), '队员', '1', '林澈', 'Lin Che']);
        const { overrides, updated, unknown } = overridesFromCsv(`${csv}"999",队员,1,无名,,,,,\r\n`, result, {});
        expect(updated).toBe(rows.length - 1);
        expect(unknown).toEqual(['999']);
        expect(overrides['1']).toEqual({ teamEn: 'Team Lin', schoolEn: 'Nanjing Xiaozhuang University', members: [{ nameEn: 'Lin Che' }] });
        expect(sheetOf(result, overrides)[0]).toMatchObject({ teamEn: 'Team Lin', members: [{ name: '林澈', nameEn: 'Lin Che' }] });
    });

    it('plans an issue that keeps unchanged certificates, replaces changed ones and revokes the rest', () => {
        const result = resultBoard(source(), 'all');
        const config = defaultConfig('测试赛');
        const entries = certificateEntries(result, config);
        const issued = entries.map((entry, index) => ({ code: `C${index}`, key: entry.key, fingerprint: fingerprint(entry) }));
        const renamed = certificateEntries(result, { ...config, sheet: { '1': { members: [{ name: '林澈', nameEn: 'Lin Che' }] } } });
        const plan = planIssue(renamed, [...issued, { code: 'GONE', key: 'member:x:9:0', fingerprint: 'x' }]);
        expect(plan.create).toEqual([]);
        expect(plan.correct.map((item) => item.entry.teamId)).toEqual(renamed.filter((entry) => entry.teamId === '1').map(() => '1'));
        expect(plan.revoke).toEqual(['GONE']);
        expect(plan.unchanged).toBe(entries.length - plan.correct.length);
    });

    it('checks templates and settings on save', () => {
        const config = defaultConfig('测试赛');
        expect(() => normalizeConfig({ templates: { award: { ...config.templates.award, fields: [{ id: 'a', type: 'text', text: 'x', x: 999, y: 10, size: 10 }] } } }, config)).toThrow('横向');
        const portrait = normalizeConfig({ templates: { award: { orientation: 'portrait', fields: [{ id: 'a', text: '{name}', x: 100, y: 280, size: 20, kinds: ['team', 'other'] }] } } }, config);
        expect(portrait.templates.award).toMatchObject({ orientation: 'portrait', background: null, fields: [{ kinds: ['team'], align: 'center', color: '#2b2118' }] });
        expect(normalizeConfig({ kinds: { participation: true } }, config).kinds).toEqual({ ...config.kinds, participation: true });
    });
});

describe('PDF 与二维码', () => {
    it('writes a PDF whose cross-reference table points at its objects', () => {
        const config = defaultConfig('测试赛');
        const values = { name: '林澈', nameEn: 'Lin Che', award: '金奖', contest: '测试赛', number: 'ABCDEFGHJK' };
        const page = certificatePage(config.templates.award, 'member', values, 'https://oj.example/d/system/certificate/ABCDEFGHJK', null);
        const pdf = buildPdf([page, page], '测试');
        const text = pdf.toString('latin1');
        expect(text.startsWith('%PDF-1.7')).toBe(true);
        expect(text).toContain('/UniGB-UTF16-H');
        expect(text).toContain('/Count 2');
        const start = Number(/startxref\n(\d+)/.exec(text)![1]);
        expect(text.slice(start, start + 4)).toBe('xref');
        const offsets = [...text.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((match) => Number(match[1]));
        offsets.forEach((offset, index) => expect(text.slice(offset, offset + 12)).toMatch(new RegExp(`^${index + 1} 0 obj`)));
        // The name is set in the CJK font as UTF-16; the content stream is compressed.
        const stream = /stream\n([\s\S]*?)\nendstream/.exec(text.slice(text.indexOf('/FlateDecode')))![1];
        expect(inflateSync(Buffer.from(stream, 'latin1')).toString('latin1')).toContain('<67976f88>');
    });

    it('measures mixed text and shrinks lines to their width', () => {
        expect(textWidth('林澈', 10, 'serif')).toBe(20);
        expect(textWidth('AB', 10, 'sans')).toBeCloseTo(13.34);
        const page = certificatePage({ ...defaultConfig('x').templates.award, fields: [{ id: 'a', type: 'text', text: '{name}', x: 10, y: 10, size: 100, align: 'left', width: 20, color: '#000000', kinds: [] }] },
            'member', { name: '很长很长的名字' }, '', null);
        expect(page.texts[0].size).toBe(100);
        expect(page.qr).toBeNull();
    });

    it('reads JPEG and PNG backgrounds, compositing transparency over white', () => {
        const chunk = (name: string, body: Buffer) => {
            const length = Buffer.alloc(4); length.writeUInt32BE(body.length);
            return Buffer.concat([length, Buffer.from(name, 'latin1'), body, Buffer.alloc(4)]);
        };
        const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(1, 4); header[8] = 8; header[9] = 6;
        // Row filter 0, then a red opaque pixel and a black transparent one.
        const raw = Buffer.from([0, 255, 0, 0, 255, 0, 0, 0, 0]);
        const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
        const image = parseImage(png);
        expect(image).toMatchObject({ width: 2, height: 1, colors: 3, filter: 'FlateDecode' });
        expect([...inflateSync(image.data)]).toEqual([255, 0, 0, 255, 255, 255]);
        const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 0, 0, 0xff, 0xc0, 0, 11, 8, 0, 20, 0, 30, 3, 0, 0, 0, 0]);
        expect(parseImage(jpeg)).toMatchObject({ width: 30, height: 20, colors: 3, filter: 'DCTDecode' });
        expect(() => parseImage(Buffer.from('GIF89a'))).toThrow('JPEG 或 PNG');
    });

    it('draws QR symbols of the right version with their finder patterns', () => {
        const small = qrMatrix('A');
        expect(small).toHaveLength(21);
        const link = qrMatrix('https://oj.example.edu.cn/d/system/certificate/7KQ2M9XW4P');
        expect(link).toHaveLength(33);
        for (const [x, y] of [[0, 0], [26, 0], [0, 26]]) {
            expect(link[y].slice(x, x + 7).map(Number).join('')).toBe('1111111');
            expect(link[y + 1].slice(x, x + 7).map(Number).join('')).toBe('1000001');
        }
        expect(() => qrMatrix('x'.repeat(300))).toThrow('过长');
    });
});

describe('证书出具与核验', () => {
    async function setup() {
        const { db } = previewDatabase();
        const scope = { domainId: 'system', contestId: 'c1' };
        const store = new ResultsStore(db);
        const data = source();
        await store.save(scope, { _id: 'snap', reason: 'manual', eventAt: new Date() }, async () => data);
        let identity = false;
        const service = certificateService(db, {
            snapshot: async () => 'snap',
            accounts: async () => new Map([['1', [1]], ['3', [3, 30]]]),
            showIdentity: async () => identity,
        });
        const request = { scope, title: '测试赛', uid: 9, site: 'https://oj.example/' };
        await service.operate(request, 'config', { source: 'snap', issuer: '组委会', date: '2026 年 11 月 8 日' });
        return { db, service, request, store, scope, data, show: () => { identity = true; } };
    }

    it('issues from a locked sheet only, then corrects and revokes what changed', async () => {
        const { service, request, store, scope, data } = await setup();
        await expect(service.operate(request, 'issue', {})).rejects.toThrow('锁定');
        await service.operate(request, 'config', { locked: true });
        const first = await service.operate(request, 'issue', {}) as { created: number };
        expect(first.created).toBeGreaterThan(0);
        await expect(service.operate(request, 'team', { teamId: '1', override: {} })).rejects.toThrow('已锁定');
        await service.operate(request, 'config', { locked: false });
        await service.operate(request, 'team', { teamId: '1', override: { members: [{ nameEn: 'Lin Che' }] } });
        await service.operate(request, 'config', { locked: true });
        const second = await service.operate(request, 'issue', {}) as { created: number; corrected: number; unchanged: number };
        expect(second).toMatchObject({ created: 0, corrected: 2 });
        // A rejudge moves the bronze: the snapshot of the new results revokes one certificate and issues another.
        const changed = structuredClone(data);
        changed.data.submissions = changed.data.submissions.filter((run) => run.team_id !== '2');
        await store.save(scope, { _id: 'snap2', reason: 'manual', eventAt: new Date() }, async () => changed);
        await service.operate(request, 'config', { source: 'snap2' });
        await service.operate(request, 'config', { locked: true });
        const third = await service.operate(request, 'issue', {}) as { revoked: number };
        expect(third.revoked).toBeGreaterThan(0);
        const view = await service.data(request);
        expect(view.issued.filter((item) => item.status === 'corrected').every((item) => item.replacedBy)).toBe(true);
        expect(view.issued.filter((item) => item.status === 'revoked').every((item) => item.reason === '获奖情况已变化')).toBe(true);
    });

    it.each([false, true])('recovers an interrupted correction when the old number was already retired: %s', async (retired) => {
        const { db, service, request } = await setup();
        await service.operate(request, 'config', { locked: true });
        await service.operate(request, 'issue', {});
        const collection = db.collection('xcpcio.certificates.issued');
        const old = (await collection.findOne({ ...request.scope, status: 'valid' }))!;
        const next = 'ABCD234567';
        await collection.insertOne({ ...old, _id: next, previous: old._id, version: old.version + 1,
            status: 'pending', values: { ...old.values, number: next } });
        if (retired) await collection.updateOne({ _id: old._id }, { $set: { status: 'corrected', replacedBy: next } });
        expect(await service.operate(request, 'issue', {})).toMatchObject({ created: 0, corrected: 0, revoked: 0 });
        expect((await service.verify(request.scope.domainId, old._id)).certificate).toMatchObject({ status: 'corrected', replacedBy: next });
        expect((await service.verify(request.scope.domainId, next)).certificate).toMatchObject({ status: 'valid', version: 2 });
        expect(await collection.countDocuments({ ...request.scope, key: old.key, status: 'valid' })).toBe(1);
    });

    it('refuses results that are not final, and serves files, participants and the verification page', async () => {
        const { service, request, store, scope, data, show } = await setup();
        const pending = structuredClone(data);
        pending.data.submissions.push({ submission_id: 'p', team_id: '2', problem_id: 2, timestamp: 1000, status: 'PENDING' });
        await store.save(scope, { _id: 'pending', reason: 'manual', eventAt: new Date() }, async () => pending);
        await service.operate(request, 'config', { source: 'pending' });
        await service.operate(request, 'config', { locked: true });
        await expect(service.operate(request, 'issue', {})).rejects.toThrow('不是最终成绩');
        await service.operate(request, 'config', { source: 'snap' });
        await service.operate(request, 'config', { locked: true });
        await service.operate(request, 'issue', {});
        const zip = await service.file(request, 'zip', {});
        expect(zip.data.subarray(0, 2).toString('latin1')).toBe('PK');
        expect(zip.data.toString('utf8')).toContain('南京晓庄学院/');
        const sheet = await service.file(request, 'sheet', {});
        expect(sheet.data.toString('utf8')).toContain('队伍 ID');
        const mine = await service.mine({ ...request, uid: 30 });
        expect(mine.list!.every((item) => item.team === '陈言')).toBe(true);
        await expect(service.mine({ ...request, uid: 30 }, 'NOTMINE000')).rejects.toThrow('不是你的证书');
        const code = mine.list![0].code;
        expect((await service.mine({ ...request, uid: 30 }, code)).file!.type).toBe('application/pdf');
        const checked = await service.verify('system', code.toLowerCase());
        expect(checked).toMatchObject({ found: true, certificate: { status: 'valid', name: '陈言', school: '' } });
        show();
        expect((await service.verify('system', code)).certificate!.school).toBe('南京邮电大学');
        expect((await service.verify('other', code)).found).toBe(false);
        expect((await service.verify('system', 'not a code')).found).toBe(false);
    });
});
