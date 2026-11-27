import { timeZone } from '../lib/time-zone';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Environment } from 'nunjucks';
import type { BoardData } from '../lib/board';
import { hostPressure, judgePressure } from '../lib/host';
import { contestOverview } from '../lib/overview';
import { resolverCodeBase } from '../lib/resolver-data';
import { toScriptJson } from '../lib/settings';

const schools = ['南京晓庄学院', '东南大学', '南京大学', '南京邮电大学', '河海大学', '南京理工大学', '南京航空航天大学', '苏州大学', '江南大学', '扬州大学', '南京师范大学', '中国矿业大学'];
const surnames = '林周陈苏许江沈陆顾吴孙赵钱郑王冯韩杨朱秦何吕施张孔曹严华金魏陶姜';
const given = ['澈', '宁', '言', '禾', '青', '屿', '星', '川', '一帆', '思远', '子墨', '若溪', '景行', '知夏', '亦辰', '书瑶'];
const colors = ['#e8794c', '#3b82f6', '#a855f7', '#22c55e', '#f43f5e', '#eab308', '#14b8a6', '#f8fafc', '#6366f1', '#ec4899', '#84cc16'];

/** A contest 100 minutes in: 48 teams from 12 schools on 11 problems, deterministic. */
function contest(beginAt: number): BoardData {
    let seed = 20261116;
    const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    const teams = Array.from({ length: 48 }, (_, index) => ({
        team_id: String(index + 1),
        name: `${surnames[index % surnames.length]}${given[(index * 7) % given.length]}`,
        organization: index === 47 ? '' : schools[index % schools.length],
        group: [index % 8 === 5 ? 'unofficial' : 'official'],
    }));
    const elapsed = Date.now() - beginAt;
    const problems = 11;
    const verdicts = ['WRONG_ANSWER', 'WRONG_ANSWER', 'TIME_LIMIT_EXCEEDED', 'RUNTIME_ERROR', 'COMPILATION_ERROR', 'MEMORY_LIMIT_EXCEEDED'];
    const submissions: BoardData['submissions'] = [];
    for (const [index, team] of teams.entries()) {
        const strength = 1 - index / 60 + random() * 0.25;
        for (let problem = 0; problem < problems; problem++) {
            const difficulty = problem < 2 ? 0.15 : problem < 5 ? 0.45 : problem < 8 ? 0.7 : 0.9;
            if (random() > strength - difficulty + 0.35) continue; // never tried
            let time = (difficulty * 80 + random() * 60) * 60_000;
            const tries = Math.floor(random() * 3);
            // The whole contest is drawn up front, so every poll shows the same runs up to the clock.
            for (let attempt = 0; attempt <= tries; attempt++) {
                const solved = attempt === tries && random() < strength - difficulty / 2 + 0.3;
                const verdict = verdicts[Math.floor(random() * verdicts.length)];
                const waiting = random() < 0.4;
                if (time < elapsed) {
                    submissions.push({
                        submission_id: `p${team.team_id}-${problem}-${attempt}`, team_id: team.team_id, problem_id: problem, timestamp: Math.floor(time),
                        status: waiting && elapsed - time < 2 * 60_000 ? 'PENDING' : solved ? 'CORRECT' : verdict,
                    });
                }
                if (solved) break;
                time += (4 + random() * 14) * 60_000;
            }
        }
    }
    return {
        contest: {
            contest_name: '2026 年校程序设计竞赛', start_time: Math.floor(beginAt / 1000), end_time: Math.floor(beginAt / 1000) + 300 * 60,
            problem_quantity: problems, problem_id: Array.from({ length: problems }, (_, index) => String.fromCharCode(65 + index)),
            balloon_color: colors.map((color) => ({ color: '#000', background_color: color })),
        },
        teams,
        submissions,
    };
}

/** Local preview of the inspection screen (lib/overview-routes.ts). */
export function createOverviewPreview(env: Environment, version: string) {
    const codeBase = resolverCodeBase(version);
    const base = '/contest/demo';
    const beginAt = Date.now() - 100 * 60_000;
    return async (_request: IncomingMessage, response: ServerResponse, url: URL) => {
        if (url.pathname === `${base}/overview`) {
            response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }).end(env.render('xcpcio_overview.html', {
                codeBase, title: '2026 年校程序设计竞赛 · 赛况总览',
                runtimeJson: toScriptJson({ timeZone: timeZone(), dataUrl: `${base}/overview/data`, contestUrl: base, refreshMs: 3000 }),
            }));
            return true;
        }
        if (url.pathname !== `${base}/overview/data`) return false;
        const data = contest(beginAt);
        const overview = contestOverview({
            title: data.contest.contest_name, beginAt, endAt: beginAt + 300 * 60_000, lockAt: beginAt + 240 * 60_000, now: Date.now(), data,
        });
        // This machine sampled live, as the server does; two sample judge reports beside the built-in judge.
        const host = hostPressure();
        const gb = 1024 ** 3;
        const judges = judgePressure([
            { mid: 'judge-a', type: 'judge', updateAt: new Date(Date.now() - 4 * 60_000), memory: { total: 16 * gb, active: 6.2 * gb }, load: { currentLoad: 63.4 } },
            { mid: 'judge-b', type: 'judge', updateAt: new Date(Date.now() - 12 * 60_000), memory: { total: 8 * gb, active: 7.4 * gb }, load: { currentLoad: 92.1 } },
        ], Date.now(), host);
        const body = { ...overview, system: { host, judges, queue: overview.pending } };
        response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));
        return true;
    };
}
