/**
 * Contest overview for the inspection screen: headline numbers, standings and breakdowns over the
 * contest's real-time data (managers only, see overview-routes.ts). Pure, so it is tested without Hydro.
 */
import type { BoardData } from './board';

export interface OverviewInput {
    title: string;
    beginAt: number;
    endAt: number;
    lockAt: number | null;
    now: number;
    data: BoardData;
    /** The board's first-solve eligibility: starred (打星) teams count only when allowed. */
    unofficialFirstSolve?: boolean;
    /**
     * Public data while the contest runs: Hydro shows rejected runs only as REJECTED, so the
     * verdict breakdown is 通过 / 未通过 / 编译错误 / 评测中 rather than WA, TLE and so on.
     */
    masked?: boolean;
    /** The contest's ranking rule (lib/settings.ts TieBreak), as on the board. */
    tieBreak?: 'hydro' | 'icpc';
}

const unsetSchool = (name: string) => !name.trim() || name.trim() === '未填写学校';
// Same scoring as the board, resolver and screens: 20 minutes per wrong run, these runs exempt.
const PENALTY_SECONDS = 20 * 60;
const exempt = new Set(['CORRECT', 'COMPILATION_ERROR', 'PRESENTATION_ERROR', 'CANCELED']);
const pendingStatuses = new Set(['PENDING', 'FROZEN']);
const verdictGroups: [string, string, string[]][] = [
    ['ok', '通过', ['CORRECT']],
    ['wa', '答案错误', ['WRONG_ANSWER']],
    ['rejected', '未通过', ['REJECTED']],
    ['tle', '超时', ['TIME_LIMIT_EXCEEDED']],
    ['mle', '内存超限', ['MEMORY_LIMIT_EXCEEDED']],
    ['ole', '输出超限', ['OUTPUT_LIMIT_EXCEEDED']],
    ['fe', '格式错误', ['PRESENTATION_ERROR']],
    ['se', '系统错误', ['JUDGEMENT_FAILED']],
    ['ignored', '已忽略', ['IGNORED']],
    ['canceled', '已取消', ['CANCELED']],
    ['unknown', '未知错误', ['UNKNOWN_ERROR']],
    ['hk', '被 Hack', ['HACKED']],
    ['hackOk', 'Hack 成功', ['HACK_SUCCESSFUL']],
    ['hackFail', 'Hack 失败', ['HACK_UNSUCCESSFUL']],
    ['re', '运行错误', ['RUNTIME_ERROR']],
    ['ce', '编译错误', ['COMPILATION_ERROR']],
    ['frozen', '封榜', ['FROZEN']],
    ['pending', '评测中', ['PENDING']],
];
export const overviewVerdictStatus = new Map(verdictGroups.map(([key, , [status]]) => [key, status]));

// What a masked (public, running) board can still tell apart.
const maskedVerdictGroups: [string, string, string[]][] = [
    ['ok', '通过', ['CORRECT']],
    ['rejected', '未通过', ['REJECTED', 'WRONG_ANSWER', 'TIME_LIMIT_EXCEEDED', 'MEMORY_LIMIT_EXCEEDED', 'OUTPUT_LIMIT_EXCEEDED', 'RUNTIME_ERROR', 'HACKED']],
    ['ce', '编译错误', ['COMPILATION_ERROR']],
    ['pending', '评测中', ['PENDING', 'FROZEN']],
];
const TOP_TEAMS = 10;
const TOP_SCHOOLS = 8;
const RECENT = 8;
const RECENT_WINDOW = 10 * 60_000;

export function contestOverview(input: OverviewInput) {
    const { data, now } = input;
    const duration = input.endAt - input.beginAt;
    const problemCount = data.contest.problem_quantity;
    const labels = (data.contest.problem_id as string[] | undefined) || [];
    const colors = (data.contest.balloon_color as { background_color?: string }[] | undefined) || [];
    const teamById = new Map(data.teams.map((team) => [team.team_id, team]));
    const unofficial = (teamId: string) => !!teamById.get(teamId)?.group.includes('unofficial');
    const submissions = [...new Map(data.submissions.map((record) => [record.submission_id, record])).values()]
        .filter((record) => teamById.has(record.team_id) && record.timestamp >= 0 && record.timestamp < duration
            && Number.isInteger(record.problem_id) && record.problem_id >= 0 && record.problem_id < problemCount)
        .sort((a, b) => a.timestamp - b.timestamp || a.submission_id.localeCompare(b.submission_id));
    const accepted = submissions.filter((record) => record.status === 'CORRECT');
    const official = data.teams.filter((team) => !team.group.includes('unofficial'));
    const schoolOf = (teamId: string) => (teamById.get(teamId)?.organization || '').trim();
    const schools = new Set(data.teams.map((team) => schoolOf(team.team_id)).filter((name) => !unsetSchool(name)));
    const status = now < input.beginAt ? 'before' : now >= input.endAt ? 'ended'
        : input.lockAt !== null && now >= input.lockAt ? 'frozen' : 'running';
    const rate = (part: number, whole: number) => (whole ? Math.round((part / whole) * 1000) / 10 : 0);
    const elapsed = Math.max(0, Math.min(now, input.endAt) - input.beginAt);

    // Per team and problem: first accept, and the penalised runs before it.
    const cells = new Map<string, { solvedAt: number | null; tries: number }>();
    for (const record of submissions) {
        const key = `${record.team_id}/${record.problem_id}`;
        const cell = cells.get(key) || { solvedAt: null, tries: 0 };
        cells.set(key, cell);
        if (cell.solvedAt !== null || pendingStatuses.has(record.status)) continue;
        if (record.status === 'CORRECT') cell.solvedAt = record.timestamp;
        else if (!exempt.has(record.status)) cell.tries++;
    }
    // Penalty in seconds: whole seconds per accepted time under Hydro's rule, whole minutes under the
    // ICPC rule, which then ranks the earlier last accept first (resolver/public/js/standings.js).
    const icpc = input.tieBreak === 'icpc';
    const scores = new Map(data.teams.map((team) => [team.team_id, { solved: 0, penalty: 0, last: -1 }]));
    for (const [key, cell] of cells) {
        if (cell.solvedAt === null) continue;
        const score = scores.get(key.slice(0, key.lastIndexOf('/')))!;
        score.solved++;
        score.penalty += (icpc ? Math.floor(cell.solvedAt / 60_000) * 60 : Math.floor(cell.solvedAt / 1000)) + cell.tries * PENALTY_SECONDS;
        score.last = Math.max(score.last, Math.floor(cell.solvedAt / 60_000));
    }
    const order = (a: { solved: number; penalty: number; last: number }, b: typeof a) => b.solved - a.solved || a.penalty - b.penalty
        || (icpc ? a.last - b.last : 0);
    // Official standings: teams the rule cannot separate share a rank, ties listed by name.
    const ranked = official.map((team) => ({ team, ...scores.get(team.team_id)! }))
        .sort((a, b) => order(a, b) || a.team.name.localeCompare(b.team.name, 'zh-CN'));
    const rankOf = new Map<string, number>();
    ranked.forEach((row, index) => {
        const previous = ranked[index - 1];
        const same = previous && order(previous, row) === 0;
        rankOf.set(row.team.team_id, same ? rankOf.get(previous.team.team_id)! : index + 1);
    });
    const topTeams = ranked.slice(0, TOP_TEAMS).map((row) => ({
        rank: rankOf.get(row.team.team_id)!, name: row.team.name, school: schoolOf(row.team.team_id),
        solved: row.solved, penaltyMinutes: Math.floor(row.penalty / 60),
    }));

    // First solves, following the board's eligibility for starred teams.
    const firstSolve = new Map<number, (typeof submissions)[number]>();
    for (const record of accepted) {
        if (firstSolve.has(record.problem_id) || (unofficial(record.team_id) && !input.unofficialFirstSolve)) continue;
        firstSolve.set(record.problem_id, record);
    }
    const problems = Array.from({ length: problemCount }, (_, index) => {
        const runs = submissions.filter((record) => record.problem_id === index);
        const solvedBy = new Set(runs.filter((record) => record.status === 'CORRECT').map((record) => record.team_id));
        const first = firstSolve.get(index);
        return {
            label: labels[index] || String.fromCharCode(65 + index),
            color: colors[index]?.background_color || null,
            solvedTeams: solvedBy.size,
            attemptedTeams: new Set(runs.map((record) => record.team_id)).size,
            submissions: runs.length,
            accepted: runs.filter((record) => record.status === 'CORRECT').length,
            firstSolve: first ? { minute: Math.floor(first.timestamp / 60_000), team: teamById.get(first.team_id)!.name, school: schoolOf(first.team_id) } : null,
        };
    });

    // Schools: teams, teams with a solve, problems solved in all and the best official rank.
    const schoolRows = new Map<string, { name: string; teams: number; solvedTeams: number; solved: number; bestRank: number | null }>();
    for (const team of data.teams) {
        const name = schoolOf(team.team_id);
        if (unsetSchool(name)) continue;
        const row = schoolRows.get(name) || { name, teams: 0, solvedTeams: 0, solved: 0, bestRank: null };
        schoolRows.set(name, row);
        const score = scores.get(team.team_id)!;
        row.teams++;
        row.solved += score.solved;
        if (score.solved) row.solvedTeams++;
        const rank = rankOf.get(team.team_id);
        if (rank !== undefined && score.solved && (row.bestRank === null || rank < row.bestRank)) row.bestRank = rank;
    }
    const schoolList = [...schoolRows.values()].sort((a, b) => (a.bestRank ?? Infinity) - (b.bestRank ?? Infinity)
        || b.solved - a.solved || b.teams - a.teams || a.name.localeCompare(b.name, 'zh-CN'));

    // How many teams solved 0, 1, … problems.
    const histogram = Array.from({ length: problemCount + 1 }, (_, solved) => ({ solved, teams: 0 }));
    for (const score of scores.values()) histogram[score.solved].teams++;

    const groups = input.masked ? maskedVerdictGroups : verdictGroups;
    const verdicts = groups.map(([key, label, statuses]) => ({
        key, label, count: submissions.filter((record) => statuses.includes(record.status)).length,
    }));
    verdicts.splice(verdicts.length - 1, 0, {
        key: 'other', label: '其他',
        count: submissions.filter((record) => !groups.some(([, , statuses]) => statuses.includes(record.status))).length,
    });

    const recentAccepts = accepted.filter((record) => record.timestamp <= elapsed).slice(-RECENT).reverse().map((record) => ({
        minute: Math.floor(record.timestamp / 60_000), team: teamById.get(record.team_id)!.name, school: schoolOf(record.team_id),
        problem: labels[record.problem_id] || String.fromCharCode(65 + record.problem_id), color: colors[record.problem_id]?.background_color || null,
        firstSolve: firstSolve.get(record.problem_id) === record, unofficial: unofficial(record.team_id),
    }));
    const recentFrom = elapsed - RECENT_WINDOW;
    const recent = submissions.filter((record) => record.timestamp >= recentFrom && record.timestamp <= elapsed);

    // Cumulative submissions and accepted runs, in up to 60 steps over the elapsed contest time.
    const steps = elapsed ? Math.min(60, Math.max(1, Math.ceil(elapsed / 60_000))) : 0;
    const width = steps ? elapsed / steps : 0;
    const trend = Array.from({ length: steps }, (_, index) => ({ minute: Math.round(((index + 1) * width) / 60_000), submissions: 0, accepted: 0 }));
    for (const record of submissions) {
        if (!steps || record.timestamp > elapsed) continue;
        const index = Math.min(steps - 1, Math.floor(record.timestamp / width));
        trend[index].submissions++;
        if (record.status === 'CORRECT') trend[index].accepted++;
    }
    for (let index = 1; index < trend.length; index++) {
        trend[index].submissions += trend[index - 1].submissions;
        trend[index].accepted += trend[index - 1].accepted;
    }
    const solvedTeams = [...scores.values()].filter((score) => score.solved).length;
    const totalSolved = [...scores.values()].reduce((sum, score) => sum + score.solved, 0);

    return {
        title: input.title,
        status,
        serverTime: now,
        beginAt: input.beginAt,
        endAt: input.endAt,
        lockAt: input.lockAt,
        teams: data.teams.length,
        officialTeams: official.length,
        unofficialTeams: data.teams.length - official.length,
        schools: schools.size,
        problems: problemCount,
        solvedProblems: problems.filter((problem) => problem.solvedTeams).length,
        submissions: submissions.length,
        accepted: accepted.length,
        pending: submissions.filter((record) => pendingStatuses.has(record.status)).length,
        /** Percent, one decimal. */
        acceptRate: rate(accepted.length, submissions.length),
        solvedTeams,
        solvedTeamsRate: rate(solvedTeams, data.teams.length),
        /** Problems solved per team, one decimal. */
        averageSolved: data.teams.length ? Math.round((totalSolved / data.teams.length) * 10) / 10 : 0,
        /** The last ten minutes of contest time. */
        recentSubmissions: recent.length,
        recentAccepted: recent.filter((record) => record.status === 'CORRECT').length,
        topTeams,
        problemStats: problems,
        schoolStats: schoolList.slice(0, TOP_SCHOOLS),
        histogram,
        verdicts,
        recentAccepts,
        trend,
    };
}

export type ContestOverview = ReturnType<typeof contestOverview>;
