import { describe, expect, it } from 'vitest';
import { fingerprints, mergeIntervals, readCase, casePairs, similarityGroups, similarPairs, tokenize, uncovered, type CodeSample } from '../lib/integrity';

const solution = (n: string, a: string, comment: string) => `#include <bits/stdc++.h>
using namespace std;
// ${comment}
int main() {
    int ${n}; cin >> ${n};
    vector<long long> ${a}(${n});
    for (auto &x : ${a}) cin >> x;
    sort(${a}.begin(), ${a}.end());
    long long total = 0, best = 0;
    for (int i = 0; i < ${n}; i++) {
        if (i % 2 == 0) total += ${a}[i]; else total -= ${a}[i];
        best = max(best, total);
    }
    for (int i = ${n} - 1; i >= 0; i--) if (${a}[i] > best) best = ${a}[i] - best;
    cout << total << " " << best << endl;
    return 0;
}`;
const different = (seed: number) => `#include <cstdio>
int f[${seed}][2];
int main() {
    int n, k; scanf("%d %d", &n, &k);
    for (int i = 1; i <= n; i++) {
        f[i][0] = f[i - 1][1] + ${seed};
        f[i][1] = (f[i - 1][0] * k + i) % ${seed + 7};
        while (f[i][1] > ${seed}) f[i][1] /= ${seed % 5 + 2};
        if (f[i][0] < f[i][1]) { int t = f[i][0]; f[i][0] = f[i][1]; f[i][1] = t; }
    }
    printf("%d\\n", f[n][0]);
}`;

describe('代码相似度', () => {
    it('sees the same structure through renamed variables, comments and spacing', () => {
        expect(tokenize(solution('n', 'a', '题解'))).toEqual(tokenize(solution('cnt', 'arr', 'mine')));
        expect(tokenize('int x = 10; // note\nprint("hi")')).toEqual(['int', 'V', '=', 'N', ';', 'print', '(', 'S', ')']);
        expect(fingerprints(tokenize(solution('n', 'a', 'x')))).toEqual(fingerprints(tokenize(solution('m', 'b', 'y'))));
    });

    it('reports a renamed copy between two teams, not programs of one team, nor different programs', () => {
        const samples: CodeSample[] = [
            { rid: 'r1', teamId: '1', pid: 7, code: solution('n', 'a', 'A') },
            { rid: 'r2', teamId: '2', pid: 7, code: solution('cnt', 'arr', 'B') },
            { rid: 'r3', teamId: '1', pid: 8, code: solution('n', 'a', 'again') },
            { rid: 'r4', teamId: '1', pid: 8, code: solution('q', 'w', 'same team') },
            ...[3, 4, 5, 6].map((team) => ({ rid: `d${team}`, teamId: String(team), pid: 7, code: different(team * 31) })),
        ];
        const pairs = similarPairs(samples);
        expect(pairs.map((pair) => [pair.pid, pair.a.teamId, pair.b.teamId])).toEqual([[7, '1', '2']]);
        expect(pairs[0].score).toBe(1);
    });

    it('leaves out code that most teams share', () => {
        // Six teams submit the same template: it is common code, not a reason to compare.
        const samples = [1, 2, 3, 4, 5, 6].map((team) => ({ rid: `r${team}`, teamId: String(team), pid: 1, code: solution('n', 'a', String(team)) }));
        expect(similarPairs(samples)).toEqual([]);
    });

    it('groups linked teams with their schools', () => {
        const pair = (a: string, b: string, score: number) => ({ pid: 1, a: { teamId: a, rid: `${a}` }, b: { teamId: b, rid: `${b}` }, score, shared: 20 });
        const groups = similarityGroups([pair('1', '2', 0.9), pair('2', '3', 0.8), pair('5', '6', 0.75)], (id) => (id === '6' ? '乙校' : '甲校'));
        expect(groups).toEqual([
            { teams: ['1', '2', '3'], schools: ['甲校'], pairs: 2, top: 0.9 },
            { teams: ['5', '6'], schools: ['甲校', '乙校'], pairs: 1, top: 0.75 },
        ]);
    });
});

it('keeps case evidence on the selected problem and teams', () => {
    const pair = (pid: number, a: string, b: string) => ({
        pid, a: { teamId: a, rid: a }, b: { teamId: b, rid: b }, score: 1, shared: 20,
    });
    const pairs = [pair(100, '1', '2'), pair(100, '2', '3'), pair(101, '1', '2')];
    expect(casePairs(pairs, ['1', '2'], 100)).toEqual([pairs[0]]);
    expect(casePairs(pairs, ['2'])).toEqual(pairs);
});

describe('录像覆盖', () => {
    it('joins touching recordings and finds what none covers', () => {
        const parts = [{ from: 0, to: 60_000 }, { from: 60_500, to: 120_000 }, { from: 180_000, to: 240_000 }];
        expect(mergeIntervals(parts)).toEqual([{ from: 0, to: 120_000 }, { from: 180_000, to: 240_000 }]);
        expect(uncovered(0, 300_000, parts)).toEqual([{ from: 120_000, to: 180_000 }, { from: 240_000, to: 300_000 }]);
        expect(uncovered(0, 100, [])).toEqual([{ from: 0, to: 100 }]);
    });

    it('checks a new case', () => {
        expect(readCase({ teams: ['1', '1', '2'], title: ' C 题相似 ', assignee: '张老师' }, new Set(['1', '2']))).toMatchObject({ teams: ['1', '2'], title: 'C 题相似', due: null });
        expect(() => readCase({ teams: ['9'], title: 'x' }, new Set(['1']))).toThrow('队伍');
        expect(() => readCase({ teams: ['1'], title: '' }, new Set(['1']))).toThrow('标题');
    });
});
