import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Environment } from 'nunjucks';
import type { BoardData } from '../lib/board';
import { emptyJury, JuryError, readCredit, readHold, readReason, verdictChoices, type JuryState } from '../lib/jury';
import { resolverCodeBase } from '../lib/resolver-data';
import { toScriptJson } from '../lib/settings';

const verdictNames: Record<number, string> = { 1: 'CORRECT', 2: 'WRONG_ANSWER', 3: 'TIME_LIMIT_EXCEEDED', 4: 'MEMORY_LIMIT_EXCEEDED', 5: 'OUTPUT_LIMIT_EXCEEDED',
    6: 'RUNTIME_ERROR', 7: 'COMPILATION_ERROR', 8: 'JUDGEMENT_FAILED', 10: 'JUDGEMENT_FAILED', 30: 'REJECTED', 31: 'PRESENTATION_ERROR' };

/** 裁判操作 in the preview: the demo contest's problems are 100, 101 and 102; the demo password is `preview`. */
export function createJuryPreview(env: Environment, version: string, data: BoardData) {
    const base = '/contest/demo/jury';
    const pids = Array.from({ length: data.contest.problem_quantity }, (_, index) => 100 + index);
    const duration = data.contest.end_time - data.contest.start_time;
    const state: JuryState = emptyJury();
    const log: { action: string; text: string; reason: string; operator: string; at: Date; rid: string | null }[] = [];
    const label = (pid: number) => String.fromCharCode(65 + pids.indexOf(pid));
    const clock = (seconds: number) => `${Math.floor(seconds / 3600)}:${String(Math.floor(seconds / 60) % 60).padStart(2, '0')}`;
    const json = (response: ServerResponse, body: unknown, status = 200) => response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(body));

    async function handle(request: IncomingMessage, response: ServerResponse, url: URL) {
        if (url.pathname !== base && url.pathname !== `${base}/data`) return false;
        try {
            if (request.method === 'POST') {
                let body = '';
                for await (const chunk of request) body += chunk;
                const { operation, payload: raw } = JSON.parse(body) as { operation: string; payload: string };
                const payload = JSON.parse(raw || '{}') as Record<string, unknown>;
                const note = (action: string, text: string, reason: string, rid: string | null = null) => log.unshift({ action, text, reason, operator: 'admin', at: new Date(), rid });
                if (operation === 'hold') {
                    const hold = readHold(payload, pids, duration);
                    state.holds.push({ id: randomUUID(), ...hold, by: 1, at: Date.now() });
                    note('hold', `${label(hold.pid)} 题自 ${clock(hold.since)} 起暂缓公布`, hold.reason);
                } else if (operation === 'release' || operation === 'uncredit') {
                    const reason = readReason(payload.reason);
                    const list = operation === 'release' ? state.holds : state.credits;
                    const index = list.findIndex((item) => item.id === payload.id);
                    if (index < 0) throw new JuryError('已经处理过了');
                    list.splice(index, 1);
                    note(operation, operation === 'release' ? '恢复公布' : '撤销补偿', reason);
                } else if (operation === 'credit') {
                    const credit = readCredit(payload, new Set(data.teams.map((team) => team.team_id)), duration);
                    state.credits.push({ id: randomUUID(), ...credit, by: 1, at: Date.now() });
                    note('credit', `队伍 ${credit.teamId} 自 ${clock(credit.from)} 起补偿 ${credit.minutes} 分钟`, credit.reason);
                } else if (operation === 'verdict') {
                    if (payload.password !== 'preview') throw new JuryError('密码错误', 403);
                    const reason = readReason(payload.reason);
                    const run = data.submissions.find((item) => item.submission_id === payload.rid);
                    const status = Number(payload.status);
                    if (!run || !verdictChoices.some(([code]) => code === status)) throw new JuryError('提交或结果无效');
                    const before = run.status;
                    run.status = verdictNames[status];
                    note('verdict', `${String.fromCharCode(65 + run.problem_id)} 题提交 ${run.submission_id}：${before} → ${run.status}`, reason, run.submission_id);
                } else throw new JuryError('未知的操作');
                json(response, { ok: true });
                return true;
            }
            if (url.pathname === base) {
                response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }).end(env.render('xcpcio_jury.html', {
                    tdoc: { title: data.contest.contest_name }, codeBase: resolverCodeBase(version),
                    runtimeJson: toScriptJson({ base, dataUrl: `${base}/data`, recordBase: '/record/', reviewUrl: '/contest/demo/rejudge-review', verdicts: verdictChoices, canVerdict: true }),
                }));
                return true;
            }
            const names = new Map(data.teams.map((team) => [team.team_id, team.name]));
            json(response, {
                duration, problems: pids.map((pid) => ({ pid, label: label(pid) })),
                teams: data.teams.map((team) => ({ id: team.team_id, name: team.name, school: team.organization || '' })),
                holds: state.holds.map((hold) => ({ ...hold, label: label(hold.pid), operator: 'admin' })),
                credits: state.credits.map((credit) => ({ ...credit, team: names.get(credit.teamId), operator: 'admin' })),
                submissions: [...data.submissions].sort((a, b) => b.timestamp - a.timestamp).map((run) => ({
                    rid: run.submission_id, team: names.get(run.team_id), teamId: run.team_id, label: String.fromCharCode(65 + run.problem_id), time: Math.floor(run.timestamp / 1000), status: run.status,
                })),
                log,
            });
        } catch (error) {
            if (!(error instanceof JuryError)) throw error;
            json(response, { error: { message: error.message } }, error.status);
        }
        return true;
    }

    return { handle, state: () => state, pids };
}
