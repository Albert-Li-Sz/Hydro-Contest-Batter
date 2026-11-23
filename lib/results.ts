import { enhanceBoard, type BoardData, type BoardSubmission } from './board';
import { buildContestInfo, buildRuns, type LiveSource } from './live/model';
import { computeScoreboard, runsByTeam } from './live/scoreboard';
import { awardsFor, type BoardSettings } from './settings';
import { resultsFinal, specialAwardResults } from './special-awards';

export interface ResultsData {
    data: BoardData;
    settings: BoardSettings;
    /** Use Hydro problem ids to follow a problem when the contest's problem order is edited. */
    problemIds: number[];
    beginAt: number;
    endAt: number;
    lockAt: number | null;
    unlocked: boolean;
    /** Time at which the journal was read, in milliseconds. */
    at: number;
    coaches: Record<string, string[]>;
}

export const boardOptions = (source: ResultsData) => [
    { id: 'all', name: '所有队伍' },
    ...Object.entries(enhanceBoard(source.data, source.settings).contest.group as Record<string, string>).map(([id, name]) => ({ id, name })),
];

export const settled = (source: ResultsData) => resultsFinal(source.data, source.at >= source.endAt)
    && (source.unlocked || source.lockAt === null || source.lockAt >= source.at);

interface ResultProblem { id: number; label: string }
interface ProblemCell { attempts: number; wrong: number; pending: number; solved: boolean; time: number | null }
type ResultAward = { id: string; name: string; kind: 'medal' | 'first' | 'special'; teamIds: string[] };
export interface ResultRow {
    id: string;
    name: string;
    school: string;
    members: string[];
    coaches: string[];
    rank: number;
    solved: number;
    penalty: number;
    cells: Record<number, ProblemCell>;
    medals: string[];
    firsts: string[];
    specials: string[];
}
export interface ResultBoard {
    problems: ResultProblem[];
    rows: ResultRow[];
    awards: ResultAward[];
    runs: BoardSubmission[];
}

const shortVerdict: Record<string, string> = {
    CORRECT: 'AC', WRONG_ANSWER: 'WA', TIME_LIMIT_EXCEEDED: 'TLE', MEMORY_LIMIT_EXCEEDED: 'MLE',
    RUNTIME_ERROR: 'RE', OUTPUT_LIMIT_EXCEEDED: 'OLE', COMPILATION_ERROR: 'CE', PRESENTATION_ERROR: 'PE',
    JUDGEMENT_FAILED: 'SE', HACKED: 'HK', REJECTED: 'IGN', CANCELED: '取消', PENDING: '评测中', FROZEN: '封榜',
};
export const verdictLabel = (status?: string) => status ? (shortVerdict[status] || status) : '—';

/** Score the chosen board as a standalone group, with the same calculations as Live and CCS. */
export function resultBoard(source: ResultsData, board: string): ResultBoard {
    const { data, settings } = source;
    const enhanced = enhanceBoard(data, settings);
    const teams = enhanced.teams.filter((team) => board === 'all'
        || (Object.hasOwn(enhanced.contest.group as object, board) && team.group.includes(board)));
    const rules = awardsFor(settings, board);
    const live: LiveSource = {
        contest: { title: data.contest.contest_name, beginAt: new Date(source.beginAt), endAt: new Date(source.endAt),
            lockAt: source.lockAt === null ? null : new Date(source.lockAt), unlocked: source.unlocked },
        data: { ...enhanced, teams }, boards: [], settings: { ...settings, ...rules, boardAwards: {} },
        identity: true, logoNames: {}, now: source.at,
    };
    const info = buildContestInfo(live);
    const runs = buildRuns(live, info);
    const byTeam = runsByTeam(runs);
    const { ranking, rows } = computeScoreboard(info, byTeam, 'normal');
    const problems = info.problems.map((problem, index) => ({ id: source.problemIds[index], label: problem.letter }));
    const teamIds = new Set(ranking.order);
    const teamInfo = new Map(teams.map((team) => [team.team_id, team]));
    const raw = new Map(enhanced.submissions.map((run) => [run.submission_id, run]));
    const resultAwards: ResultAward[] = ranking.awards.map((award) => ({
        id: award.id, name: award.citation, kind: 'medal', teamIds: award.teams,
    }));

    // Same eligibility as the selected board. An earlier eligible pending attempt can still take first solve.
    const eligible = new Set(info.teams.filter((team) => !team.isOutOfContest || rules.unofficialFirstSolve).map((team) => team.id));
    const earliestPending = new Map<string, number>();
    const first = new Map<string, { time: number; winners: Set<string> }>();
    for (const run of runs) {
        if (!eligible.has(run.teamId)) continue;
        if (run.result.type !== 'ICPC') {
            if (!earliestPending.has(run.problemId)) earliestPending.set(run.problemId, run.time);
        } else if (run.result.isFirstToSolveRun) {
            const record = first.get(run.problemId) || { time: run.time, winners: new Set<string>() };
            record.winners.add(run.teamId);
            first.set(run.problemId, record);
        }
    }
    // A pending run can sort after a first solve in the same second.
    for (const problem of info.problems) {
        const record = first.get(problem.id);
        if (!record || (earliestPending.get(problem.id) ?? Infinity) <= record.time) continue;
        resultAwards.push({ id: `first-${source.problemIds[problem.ordinal]}`, name: `${problem.letter} 题一血`, kind: 'first', teamIds: [...record.winners] });
    }
    resultAwards.push(...specialAwardResults(enhanced, settings).map((award): ResultAward => ({
        id: `special-${award.id}`, name: award.name, kind: 'special', teamIds: award.teamIds.filter((id) => teamIds.has(id)),
    })));

    const honors = new Map<string, Record<ResultAward['kind'], string[]>>();
    for (const award of resultAwards) {
        for (const id of award.teamIds) {
            const entry = honors.get(id) || { medal: [], first: [], special: [] };
            entry[award.kind].push(award.name);
            honors.set(id, entry);
        }
    }
    return {
        problems, awards: resultAwards, runs: runs.map((run) => {
            const record = raw.get(run.id)!;
            return { ...record, problem_id: source.problemIds[record.problem_id] };
        }),
        rows: ranking.order.map((id, index) => {
            const team = teamInfo.get(id)!;
            const score = rows.get(id)!;
            const awards = honors.get(id);
            const attempts = new Map<string, number>();
            const last = new Map<string, number>();
            for (const run of byTeam.get(id) || []) {
                if (run.result.isAfterFirstOk) continue;
                attempts.set(run.problemId, (attempts.get(run.problemId) || 0) + 1);
                last.set(run.problemId, Math.floor(run.time / 1000));
            }
            return {
                id, name: team.name, school: team.organization || '', members: team.members?.length ? team.members : [team.name],
                coaches: source.coaches[id] || [], rank: ranking.ranks[index], solved: score.totalScore, penalty: score.penalty,
                cells: Object.fromEntries(score.problemResults.map((cell, problem) => [problems[problem].id, {
                    attempts: attempts.get(String(problem)) || 0, wrong: cell.wrongAttempts, pending: cell.pendingAttempts,
                    solved: cell.isSolved, time: last.get(String(problem)) ?? null,
                }])),
                medals: awards?.medal || [], firsts: awards?.first || [], specials: awards?.special || [],
            };
        }),
    };
}

/** Compare team rows and submissions by ID even when the contest's problems or roster changed. */
export function compareResults(before: ResultBoard, after: ResultBoard) {
    const previous = new Map(before.rows.map((row) => [row.id, row]));
    const current = new Map(after.rows.map((row) => [row.id, row]));
    const oldRuns = new Map(before.runs.map((run) => [run.submission_id, run]));
    const newRuns = new Map(after.runs.map((run) => [run.submission_id, run]));
    const problems = new Map([...before.problems, ...after.problems].map((problem) => [problem.id, problem.label]));
    const submissions = [...new Set([...oldRuns.keys(), ...newRuns.keys()])].flatMap((id) => {
        const old = oldRuns.get(id);
        const next = newRuns.get(id);
        const run = (next || old)!;
        if (old && next && old.status === next.status && (old.score ?? null) === (next.score ?? null) && old.team_id === next.team_id
            && old.problem_id === next.problem_id && old.timestamp === next.timestamp) return [];
        return [{
            id, teamId: run.team_id, team: current.get(run.team_id)?.name || previous.get(run.team_id)?.name || run.team_id,
            problem: problems.get(run.problem_id), time: Math.floor(run.timestamp / 1000),
            before: verdictLabel(old?.status), after: verdictLabel(next?.status),
            beforeScore: old?.score ?? null, afterScore: next?.score ?? null,
        }];
    }).sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    const touched = new Set(submissions.map((submission) => submission.teamId));
    const rows = [...new Set([...current.keys(), ...previous.keys()])].map((id) => {
        const old = previous.get(id);
        const next = current.get(id);
        return { id, name: (next || old)!.name, before: old, after: next,
            changed: touched.has(id) || JSON.stringify(old) !== JSON.stringify(next) };
    });
    return { rows, submissions };
}

export function restoreRejudge(source: ResultsData, at: number, results: Map<string, { status: string; score: number | null }>): ResultsData {
    return {
        ...source, at,
        data: { ...source.data, submissions: source.data.submissions
            .filter((run) => source.beginAt + run.timestamp <= at)
            .map((run) => ({ ...run, ...results.get(run.submission_id) })) },
    };
}

type CsvValue = string | number | boolean | null;
export function resultsCsv(rows: CsvValue[][]) {
    // Quote cells for Excel, including commas and line breaks. Text must never become a formula.
    const cell = (value: CsvValue) => {
        if (value === null) return '';
        if (typeof value !== 'string') return String(value);
        const safe = /^[\t\r\n]|^[\s\uFEFF]*[=+\-@]/u.test(value) ? `'${value}` : value;
        return `"${safe.replace(/"/g, '""')}"`;
    };
    return `\uFEFF${rows.map((row) => row.map(cell).join(',')).join('\r\n')}\r\n`;
}

export function standingsCsv(result: ResultBoard) {
    return resultsCsv([
        ['名次', '队伍 ID', '队伍', '学校', '队员', '过题数', '罚时（秒）', '奖牌', '一血', '特别奖',
            ...result.problems.flatMap(({ label }) => [`${label} 状态`, `${label} 尝试次数`, `${label} 计罚次数`, `${label} 时间（秒）`])],
        ...result.rows.map((row) => [
            row.rank || '*', Number(row.id), row.name, row.school, row.members.join('、'), row.solved, row.penalty,
            row.medals.join('、'), row.firsts.join('、'), row.specials.join('、'),
            ...result.problems.flatMap(({ id }) => {
                const cell = row.cells[id];
                return [cell.solved ? '通过' : cell.pending ? '评测中' : cell.attempts ? '未通过' : '', cell.attempts, cell.wrong, cell.time];
            }),
        ]),
    ]);
}

export function awardsCsv(result: ResultBoard) {
    const teams = new Map(result.rows.map((row) => [row.id, row]));
    return resultsCsv([
        ['奖项', '队伍 ID', '队伍', '学校', '队员', '教练'],
        ...result.awards.flatMap((award) => award.teamIds.map((id) => {
            const row = teams.get(id)!;
            return [award.name, Number(id), row.name, row.school, row.members.join('、'), row.coaches.join('、')];
        })),
    ]);
}
