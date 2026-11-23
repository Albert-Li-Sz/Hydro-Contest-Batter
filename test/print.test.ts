import { describe, expect, it } from 'vitest';
import {
    connectionCode, defaultPrintSettings, hashToken, languageOf, languageOfFile, lineCount, newPrintToken, normalizePrinterPreference, normalizePrintSettings,
    normalizeServerInput, parseConnectionCode, seatOf, serverTakes, tokenMatches,
} from '../lib/print';
import { tokenize } from '../lib/print-highlight';
import { printJob } from '../lib/print-render';

describe('打印设置与座位表', () => {
    it('校验设置，未知页眉项被忽略', () => {
        const settings = normalizePrintSettings({ fontSize: '11.3', header: ['team', 'seat', 'bogus', 'team'], highlight: false });
        expect(settings).toMatchObject({ fontSize: 11.5, header: ['team', 'seat'], highlight: false, lineNumbers: true });
        expect(() => normalizePrintSettings({ fontSize: 30 })).toThrow('字号');
        expect(normalizePrintSettings(null)).toEqual(defaultPrintSettings());
    });

    it('座位号取自 onsite-toolkit 导入到账号上的 seat；Hydro 5.1 队伍没有时取第一位有座位的队员', () => {
        const seats = new Map<number, string>([[7, ' A-01 '], [8, ''], [9, 'B-12'], [-1001, 'C-3']]);
        expect(seatOf(seats, 7)).toBe('A-01');
        expect(seatOf(seats, -1001, [9])).toBe('C-3');
        expect(seatOf(seats, -1002, [8, 9, 7])).toBe('B-12');
        expect(seatOf(seats, -1003, [10])).toBe('');
        expect(seatOf(seats, 10)).toBe('');
    });

    it('按 Hydro 语言与文件名识别高亮语言', () => {
        expect(['cc.cc17o2', 'c', 'py.py3', 'pypy3', 'java', 'kt', 'go', 'rs', 'js', 'bf'].map(languageOf))
            .toEqual(['cpp', 'c', 'python', 'python', 'java', 'kotlin', 'go', 'rust', 'javascript', 'plain']);
        expect(['a.cpp', 'Main.java', 'x.PY', 'notes.txt', 'noext'].map(languageOfFile)).toEqual(['cpp', 'java', 'python', 'plain', 'plain']);
        expect([lineCount(''), lineCount('a'), lineCount('a\nb\n')]).toEqual([0, 1, 2]);
    });
});

describe('代码高亮与排版数据', () => {
    const kinds = (code: string, language: string) => tokenize(code, language).map((line) => line.map((token) => `${token.type || '-'}:${token.text}`));

    it('C++：预处理、关键字、多行注释、转义字符串与数字', () => {
        expect(kinds('#include <cstdio>\nint x = 0x1F; /* a\nb */ char c = \'\\n\';\n', 'cpp')).toEqual([
            ['preprocessor:#include <cstdio>'],
            ['keyword:int', '-: x = ', 'number:0x1F', '-:; ', 'comment:/* a'],
            ['comment:b */', '-: ', 'keyword:char', '-: c = ', "string:'\\n'", '-:;'],
        ]);
    });

    it('Python：三引号字符串跨行、# 注释；未闭合的引号不吞掉后续行', () => {
        expect(kinds('def f():\n    """x\ny"""  # c\n', 'python')).toEqual([
            ['keyword:def', '-: f():'], ['-:    ', 'string:"""x'], ['string:y"""', '-:  ', 'comment:# c'],
        ]);
        expect(kinds('s = "abc\nint y;', 'cpp')[1]).toEqual(['keyword:int', '-: y;']);
    });

    it('打印任务：页眉含队伍、座位等信息，代码为带样式的行，制表符展开', () => {
        const job = printJob({
            id: 't1', team: '星火队', school: '东南大学', members: ['甲', '乙'], account: 'team1', seat: 'A-01', unofficial: true,
            problem: 'a.cpp', language: 'cpp', time: '2026-11-18T02:00:00Z', lines: 2, code: 'int a;\n\tif (a < 1) {}\n',
        }, { ...defaultPrintSettings(), header: ['team', 'seat', 'school', 'members', 'problem', 'language'] }, '校赛');
        expect(job.header).toEqual({ team: '星火队（打星）', seat: 'A-01', rows: [['学校', '东南大学'], ['队员', '甲、乙'], ['文件', 'a.cpp'], ['语言', 'C++'], ['行数', '2']] });
        expect(job.title).toBe('星火队（打星） · 座位 A-01 · a.cpp');
        expect(job.lines).toEqual([[['k', 'int'], ['', ' a;']], [['', '    '], ['k', 'if'], ['', ' (a < '], ['n', '1'], ['', ') {}']]]);
        const plain = printJob({ id: 't', team: 'T', problem: 'x.txt', language: 'plain', time: '', lines: 1, code: null }, { ...defaultPrintSettings(), highlight: false }, 'C');
        expect(plain.lines).toBeNull();
        expect(plain.message).toContain('256 KB');
    });
});

describe('打印服务器', () => {
    it('连接信息包含地址、编号和密钥；只保存密钥的哈希', () => {
        const token = newPrintToken();
        const code = connectionCode('https://oj.example.com/', '6742b0000000000000000001', token);
        expect(code.startsWith('hydro-print:')).toBe(true);
        expect(parseConnectionCode(code)).toEqual({ v: 1, url: 'https://oj.example.com', id: '6742b0000000000000000001', token });
        expect(tokenMatches(token, hashToken(token))).toBe(true);
        expect(tokenMatches(`${token}x`, hashToken(token))).toBe(false);
        expect(() => parseConnectionCode('hello')).toThrow('格式无效');
    });

    it('设置校验：名称、绑定的比赛、座位前缀与打印机权重', () => {
        expect(normalizeServerInput({ name: ' 1 号机 ', contests: ['system/6740a0000000000000000001'], seatPrefixes: 'A, B，A' }))
            .toEqual({ name: '1 号机', note: '', enabled: true, contests: ['system/6740a0000000000000000001'], seatPrefixes: ['A', 'B'] });
        expect(() => normalizeServerInput({ name: '' })).toThrow('名称');
        expect(() => normalizeServerInput({ name: 'x', contests: ['bad'] })).toThrow('比赛无效');
        expect(normalizePrinterPreference({ weight: 3 })).toEqual({ enabled: true, weight: 3, kind: 'document', receipt: { width: 80, mode: 'escpos', cut: true } });
        expect(() => normalizePrinterPreference({ weight: 11 })).toThrow('权重');
    });

    it('按比赛与座位前缀分工：没有前缀的打印服务器接收其他服务器未认领的座位', () => {
        const contest = 'system/6740a0000000000000000001';
        const a = { id: 'a', contests: [], seatPrefixes: ['A'] };
        const b = { id: 'b', contests: [], seatPrefixes: ['b-'] };
        const rest = { id: 'r', contests: [], seatPrefixes: [] };
        const others = [a, b, rest];
        expect(serverTakes(a, { contest, seat: 'A-01' }, others)).toBe(true);
        expect(serverTakes(b, { contest, seat: 'B-07' }, others)).toBe(true);
        expect(serverTakes(rest, { contest, seat: 'A-01' }, others)).toBe(false);
        expect(serverTakes(rest, { contest, seat: 'C-01' }, others)).toBe(true);
        expect(serverTakes(rest, { contest, seat: '' }, others)).toBe(true);
        expect(serverTakes(a, { contest, seat: '' }, others)).toBe(false);
        // Bound to another contest: neither takes it nor keeps it from the catch-all.
        const other = { id: 'o', contests: ['system/6740a0000000000000000002'], seatPrefixes: ['C'] };
        expect(serverTakes(other, { contest, seat: 'C-01' }, [...others, other])).toBe(false);
        expect(serverTakes(rest, { contest, seat: 'C-01' }, [...others, other])).toBe(true);
    });

    it('所有打印服务器都设了座位范围时，没有座位或不在任何范围内的请求由任意一台打印', () => {
        const contest = 'system/6740a0000000000000000001';
        const a = { id: 'a', contests: [], seatPrefixes: ['A'] };
        const b = { id: 'b', contests: [], seatPrefixes: ['B'] };
        const active = [a, b];
        for (const seat of ['', 'C-01']) {
            expect(serverTakes(a, { contest, seat }, active)).toBe(true);
            expect(serverTakes(b, { contest, seat }, active)).toBe(true);
        }
        // A covered seat still goes only to its own range.
        expect(serverTakes(b, { contest, seat: 'A-01' }, active)).toBe(false);
        // With a catch-all server online, the orphans are its alone.
        const rest = { id: 'r', contests: [], seatPrefixes: [] };
        expect(serverTakes(a, { contest, seat: 'C-01' }, [...active, rest])).toBe(false);
        expect(serverTakes(rest, { contest, seat: 'C-01' }, [...active, rest])).toBe(true);
        // A catch-all bound to another contest does not count.
        const elsewhere = { id: 'e', contests: ['system/6740a0000000000000000002'], seatPrefixes: [] };
        expect(serverTakes(a, { contest, seat: '' }, [...active, elsewhere])).toBe(true);
    });
});
