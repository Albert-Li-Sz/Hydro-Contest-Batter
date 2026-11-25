import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Environment } from 'nunjucks';
import type { BoardData } from '../lib/board';
import { writeZip } from '../lib/ccs/zip';
import { casePairs, caseStatuses, defaultSimilarity, IntegrityError, readCase, similarityGroups, similarPairs, type CaseStatus, type CodeSample } from '../lib/integrity';
import { resultsCsv } from '../lib/results';
import { resolverCodeBase } from '../lib/resolver-data';
import { toScriptJson } from '../lib/settings';

// Programs for the demo submissions: 林澈 and 沈星 (same school) wrote the same C, the others their own.
const shared = (names: [string, string, string]) => `#include <bits/stdc++.h>
using namespace std;
// ${names[0]}
int main() {
    int ${names[1]};
    cin >> ${names[1]};
    vector<long long> ${names[2]}(${names[1]});
    for (auto &x : ${names[2]}) cin >> x;
    sort(${names[2]}.begin(), ${names[2]}.end());
    long long total = 0, best = 0;
    for (int i = 0; i < ${names[1]}; i++) {
        if (i % 2 == 0) total += ${names[2]}[i];
        else total -= ${names[2]}[i];
        best = max(best, total);
    }
    for (int i = ${names[1]} - 1; i >= 0; i--) {
        if (${names[2]}[i] > best) best = ${names[2]}[i] - best;
    }
    cout << total << " " << best << endl;
    return 0;
}`;
// Programs of other teams differ in structure, not only in their constants.
const bodies = [
    (k: number) => `#include <cstdio>\nint f[${k}][2];\nint main() {\n    int n, k;\n    scanf("%d %d", &n, &k);\n    for (int i = 1; i <= n; i++) {\n        f[i][0] = f[i - 1][1] + 1;\n        f[i][1] = (f[i - 1][0] * k + i) % 1000007;\n    }\n    printf("%d\\n", f[n][0] > f[n][1] ? f[n][0] : f[n][1]);\n}`,
    (k: number) => `import sys\ndef solve(data):\n    n = int(data[0])\n    seen = set()\n    queue = [0]\n    while queue:\n        u = queue.pop()\n        if u in seen or u > n:\n            continue\n        seen.add(u)\n        queue.append(u * 2 + ${k % 3})\n        queue.append(u + 3)\n    return len(seen)\nprint(solve(sys.stdin.read().split()))`,
    (k: number) => `import java.util.*;\npublic class Main {\n    public static void main(String[] args) {\n        Scanner in = new Scanner(System.in);\n        int n = in.nextInt();\n        TreeMap<Integer, Integer> count = new TreeMap<>();\n        for (int i = 0; i < n; i++) count.merge(in.nextInt(), 1, Integer::sum);\n        long answer = ${k};\n        for (Map.Entry<Integer, Integer> e : count.entrySet()) answer = Math.max(answer, (long) e.getKey() * e.getValue());\n        System.out.println(answer);\n    }\n}`,
    (k: number) => `#include <iostream>\n#include <string>\nusing namespace std;\nstring s;\nbool check(int l, int r) {\n    while (l < r) if (s[l++] != s[r--]) return false;\n    return true;\n}\nint main() {\n    cin >> s;\n    int best = 0;\n    for (int i = 0; i < (int)s.size(); i++)\n        for (int j = i; j < (int)s.size(); j++)\n            if (check(i, j) && j - i + 1 > best) best = j - i + 1;\n    cout << best + ${k % 2} << endl;\n}`,
    (k: number) => `n = int(input())\nprimes = []\nmark = [False] * (n + 1)\nfor i in range(2, n + 1):\n    if not mark[i]:\n        primes.append(i)\n        for j in range(i * i, n + 1, i):\n            mark[j] = True\nprint(sum(primes) % ${k + 97}, len(primes))`,
    (k: number) => `#include <bits/stdc++.h>\nusing namespace std;\nint parent[200005];\nint find(int x) { return parent[x] == x ? x : parent[x] = find(parent[x]); }\nint main() {\n    int n, m; cin >> n >> m;\n    iota(parent, parent + n + 1, 0);\n    int parts = n;\n    while (m--) {\n        int u, v; cin >> u >> v;\n        u = find(u); v = find(v);\n        if (u != v) { parent[u] = v; parts--; }\n    }\n    cout << parts * ${k % 3 + 1} << '\\n';\n}`,
];
// Unique per problem among the demo teams that solved it.
const own = (team: number, problem: number) => bodies[(team + problem) % bodies.length](team * 13 + problem);

export function createIntegrityPreview(env: Environment, version: string, data: () => BoardData) {
    const base = '/contest/demo/integrity';
    const pids = [100, 101, 102];
    let run: { at: Date; by: string; options: { threshold: number; includeRejected: boolean; pids: number[] }; samples: number; pairs: ReturnType<typeof similarPairs> } | null = null;
    const cases: { id: string; pairs: ReturnType<typeof similarPairs>; teams: string[]; title: string; detail: string; assignee: string; due: Date | null; status: CaseStatus; conclusion: string; snapshot: string | null;
        createdAt: Date; history: { at: Date; status: CaseStatus; note: string }[] }[] = [];
    const json = (response: ServerResponse, body: unknown, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
    const codeOf = (rid: string, teamId: string, problem: number) => (problem === 2 && (teamId === '1' || teamId === '7') ? shared(teamId === '1' ? ['题解', 'n', 'a'] : ['my solution', 'cnt', 'arr']) : own(Number(teamId), problem));
    const samples = (): CodeSample[] => data().submissions.filter((item) => item.status === 'CORRECT')
        .map((item) => ({ rid: item.submission_id, teamId: item.team_id, pid: pids[item.problem_id], code: codeOf(item.submission_id, item.team_id, item.problem_id) }));
    const timeline = (teamId: string) => {
        const board = data();
        const duration = (board.contest.end_time - board.contest.start_time) * 1000;
        const gap = teamId === '1' ? { from: 95 * 60_000, to: 101 * 60_000, reason: '采集页断开' } : null;
        const covered = gap ? [{ from: 0, to: gap.from }, { from: gap.to, to: duration }] : [{ from: 0, to: duration }];
        return {
            teamId, duration,
            submissions: board.submissions.filter((item) => item.team_id === teamId).map((item) => ({ rid: item.submission_id, at: item.timestamp, label: 'ABC'[item.problem_id], verdict: item.status === 'CORRECT' ? 'AC' : 'WA' })),
            streams: ['screen', 'webcam'].map((stream) => ({ stream, covered, uncovered: [], segments: covered.map((part, index) => ({ id: `demo-${stream}-${index}`, ...part })),
                reported: gap && stream === 'screen' ? [gap] : [] })),
            signals: teamId === '1' ? [{ at: 130 * 60_000, kind: 'extended', value: true, device: 'A-01' }, { at: 134 * 60_000, kind: 'extended', value: false, device: 'A-01' }] : [],
            credits: [], mediaBase: '#recording-',
        };
    };

    async function handle(request: IncomingMessage, response: ServerResponse, url: URL) {
        if (!url.pathname.startsWith(base)) return false;
        const board = data();
        const teams = new Map(board.teams.map((team) => [team.team_id, team]));
        try {
            if (request.method === 'POST' && url.pathname === base) {
                let body = '';
                for await (const chunk of request) body += chunk;
                const { operation, payload: raw } = JSON.parse(body) as { operation: string; payload: string };
                const payload = JSON.parse(raw || '{}') as Record<string, unknown>;
                if (operation === 'analyze') {
                    const threshold = Number(payload.threshold ?? 0.7);
                    const chosen = Array.isArray(payload.pids) && payload.pids.length ? payload.pids.map(Number) : pids;
                    const list = samples().filter((item) => chosen.includes(item.pid));
                    run = { at: new Date(), by: 'admin', options: { threshold, includeRejected: payload.includeRejected === true, pids: chosen }, samples: list.length,
                        pairs: similarPairs(list, { ...defaultSimilarity, threshold }) };
                    json(response, { samples: list.length, pairs: run.pairs.length });
                } else if (operation === 'case') {
                    const fields = readCase(payload, new Set(teams.keys()));
                    if (payload.analysisAt && payload.analysisAt !== run?.at.toISOString()) throw new IntegrityError('分析结果已更新，请重新选择要复核的记录');
                    const id = Math.random().toString(16).slice(2).padEnd(24, '0').slice(0, 24);
                    cases.unshift({ id, ...fields, pairs: casePairs(run?.pairs || [], fields.teams, typeof payload.pid === 'number' ? payload.pid : undefined), due: fields.due ?? new Date(Date.now() + 168 * 3600_000), status: 'open', conclusion: '', snapshot: null, createdAt: new Date(),
                        history: [{ at: new Date(), status: 'open', note: '建立复核' }] });
                    json(response, { id });
                } else if (operation === 'caseUpdate') {
                    const item = cases.find((candidate) => candidate.id === payload.id);
                    if (!item) throw new IntegrityError('复核任务不存在', 404);
                    const status = payload.status as CaseStatus;
                    if (!Object.hasOwn(caseStatuses, status)) throw new IntegrityError('复核结论无效');
                    const conclusion = String(payload.conclusion || '').trim();
                    if (status !== 'open' && !conclusion) throw new IntegrityError('请填写复核结论');
                    Object.assign(item, { status, conclusion, assignee: String(payload.assignee || ''), due: payload.due ? new Date(String(payload.due)) : item.due,
                        snapshot: status === 'violation' ? item.snapshot || 'demo-snapshot' : item.snapshot });
                    item.history.push({ at: new Date(), status, note: caseStatuses[status] });
                    json(response, { ok: true, snapshot: item.snapshot });
                } else throw new IntegrityError('未知的操作');
                return true;
            }
            if (url.pathname === base) {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(env.render('xcpcio_integrity.html', {
                    tdoc: { title: board.contest.contest_name }, codeBase: resolverCodeBase(version),
                    runtimeJson: toScriptJson({ base, dataUrl: `${base}/data`, recordBase: '/record/', statuses: caseStatuses, reviewHours: 168, resultsUrl: '/contest/demo/results', juryUrl: '/contest/demo/jury' }),
                }));
                return true;
            }
            const schoolOf = (id: string) => teams.get(id)?.organization || '未填写学校';
            if (url.pathname === `${base}/data`) {
                json(response, {
                    duration: (board.contest.end_time - board.contest.start_time) * 1000, endAt: new Date(board.contest.end_time * 1000),
                    problems: pids.map((pid, index) => ({ pid, label: 'ABC'[index] })),
                    teams: board.teams.map((team) => ({ id: team.team_id, name: team.name, school: team.organization || '', official: !team.group.includes('unofficial') })),
                    run: run && { ...run, pairs: run.pairs.map((pair) => ({ ...pair, label: 'ABC'[pids.indexOf(pair.pid)], sameSchool: schoolOf(pair.a.teamId) === schoolOf(pair.b.teamId) })),
                        groups: similarityGroups(run.pairs, schoolOf) },
                    cases: cases.map((item) => ({ ...item, creator: 'admin', overdue: item.status === 'open' && !!item.due && item.due.getTime() < Date.now() })),
                });
                return true;
            }
            if (url.pathname === `${base}/code`) {
                const item = board.submissions.find((candidate) => candidate.submission_id === url.searchParams.get('rid'));
                if (!item) throw new IntegrityError('提交不存在', 404);
                json(response, { code: codeOf(item.submission_id, item.team_id, item.problem_id), lang: 'cc' });
                return true;
            }
            if (url.pathname === `${base}/timeline`) { json(response, timeline(url.searchParams.get('team') || '')); return true; }
            if (url.pathname === `${base}/export`) {
                const item = cases.find((candidate) => candidate.id === url.searchParams.get('case'));
                if (!item) throw new IntegrityError('复核任务不存在', 404);
                const submissions = new Map(item.pairs.flatMap((pair) => [pair.a, pair.b]).map((side) => [side.rid, side]));
                const zip = writeZip([{ name: 'case.json', data: Buffer.from(JSON.stringify(item, null, 2)) },
                    { name: 'similarity.csv', data: Buffer.from(resultsCsv([['题目', '提交 A', '提交 B', '相似度'], ...item.pairs.map((pair) => ['ABC'[pids.indexOf(pair.pid)], pair.a.rid, pair.b.rid, pair.score])])) },
                    ...[...submissions.values()].map((side) => {
                        const submission = board.submissions.find((entry) => entry.submission_id === side.rid)!;
                        return { name: `code/${side.rid}.txt`, data: Buffer.from(codeOf(side.rid, side.teamId, submission.problem_id)) };
                    }),
                    ...item.teams.map((teamId) => ({ name: `timeline/${teamId}.json`, data: Buffer.from(JSON.stringify(timeline(teamId), null, 2)) }))]);
                response.writeHead(200, { 'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="evidence.zip"' }).end(zip);
                return true;
            }
            response.writeHead(404).end('Not found');
        } catch (error) {
            if (!(error instanceof IntegrityError)) throw error;
            json(response, { error: { message: error.message } }, error.status);
        }
        return true;
    }
    return { handle };
}
