import { createHash } from 'node:crypto';
import type { BoardSettings, Medals } from './settings';
import { awardsFor, medalCounts } from './settings';
import { AWARD_EXEMPT_TAG, SCHOOL_TAG } from './award-policy.mjs';

export interface BoardTeam {
    team_id: string;
    name: string;
    organization?: string;
    group: string[];
    /** Members of a Hydro team (team contests only); XCPCIO shows them with the team. */
    members?: string[];
    /** Which school the team counts for in school ranks (`s1`, `s2`…), also when the school name is private. */
    school_key?: string;
    [key: string]: unknown;
}

export interface BoardSubmission {
    submission_id: string;
    team_id: string;
    problem_id: number;
    timestamp: number;
    status: string;
    /** Present in the staff projection only, to compare rejudged scores. */
    score?: number | null;
    [key: string]: unknown;
}

export interface BoardData {
    contest: {
        contest_name: string;
        start_time: number;
        end_time: number;
        problem_quantity: number;
        [key: string]: unknown;
    };
    teams: BoardTeam[];
    submissions: BoardSubmission[];
    /** CCPC 新榜单模式 before the freeze (lib/ccpc-board.ts): the first column that is a position, not a problem. */
    hiddenFrom?: number;
}

/** Sent for problems without a Hydro balloon colour; the board draws those headers plain (see board-ui.js). */
export const UNSET_PROBLEM_COLOR = '#e2e8f0';

/** Hydro stores a contest's balloon colours per problem as `{ color, name }` (older data: a bare string),
 * picked with a hex input. Normalise to `#rrggbb`; anything else counts as not set. */
export function problemColor(entry: unknown): string {
    const raw = typeof entry === 'string' ? entry : (entry as { color?: unknown } | null | undefined)?.color;
    const hex = typeof raw === 'string' ? /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim())?.[1].toLowerCase() : undefined;
    if (!hex) return UNSET_PROBLEM_COLOR;
    return `#${hex.length === 3 ? hex.replace(/./g, '$&$&') : hex}`;
}

export function schoolName(name?: string): string {
    return (name || '').normalize('NFKC').trim().replace(/\s+/g, ' ') || '未填写学校';
}

export function schoolGroup(name: string): string {
    return `school-${createHash('sha256').update(schoolName(name)).digest('hex').slice(0, 16)}`;
}

function cappedMedals(configured: Medals, solvedTeams: number): Medals {
    let remaining = solvedTeams;
    const result = { gold: 0, silver: 0, bronze: 0 };
    for (const key of ['gold', 'silver', 'bronze'] as const) {
        result[key] = Math.min(configured[key], remaining);
        remaining -= result[key];
    }
    return result;
}

/** Names the board switcher already shows for automatic boards, which manual boards must not repeat. */
export function reservedBoardNames(teams: BoardTeam[], settings: BoardSettings): string[] {
    return ['所有队伍', '主榜', '总榜', ...(settings.participationBoards ? ['正式参赛', '非正式参赛'] : []),
        ...(settings.schoolBoards ? [...new Set(teams.map((team) => `${schoolName(team.organization)}榜`))] : [])];
}

export function automaticBoards(teams: BoardTeam[]) {
    return [{ id: 'official', name: '正式参赛', kind: 'participation' },
        { id: 'unofficial', name: '非正式参赛', kind: 'participation' },
        ...[...new Set(teams.map((team) => schoolName(team.organization)))].sort((a, b) => a.localeCompare(b, 'zh-CN'))
            .map((school) => ({ id: schoolGroup(school), name: `${school}榜`, kind: 'school' }))];
}

/** Group membership is additive; it never changes Hydro's official/unofficial flag. */
export function enhanceBoard(data: BoardData, settings: BoardSettings, { identity = true } = {}): BoardData {
    // Without identity the school is private: no school column, no school boards.
    const schoolBoards = settings.schoolBoards && identity;
    const groups: Record<string, string> = {};
    if (settings.participationBoards) {
        groups.official = '正式参赛';
        groups.unofficial = '非正式参赛';
    }
    const membership = new Map(settings.manualBoards.map((board) => [board.id, new Set(board.teamIds)]));
    // Hand-made boards come before the school list, which can run to hundreds of entries.
    for (const board of settings.manualBoards) groups[`manual-${board.id}`] = board.name;
    const schools = [...new Set(data.teams.map((team) => schoolName(team.organization)))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
    if (schoolBoards) {
        for (const school of schools) groups[schoolGroup(school)] = `${school}榜`;
    }
    const teams = data.teams.map((team) => ({
        ...team,
        tag: [
            ...(Array.isArray(team.tag) ? team.tag.filter((tag) => typeof tag === 'string' && tag !== AWARD_EXEMPT_TAG && !tag.startsWith(SCHOOL_TAG)) : []),
            ...(team.group.includes('unofficial') ? [AWARD_EXEMPT_TAG] : []),
            `${SCHOOL_TAG}${team.school_key ?? (team.organization?.trim() ? schoolGroup(team.organization).slice('school-'.length) : `#${team.team_id}`)}`,
        ],
        organization: identity ? schoolName(team.organization) : '',
        group: [...new Set([
            ...team.group,
            ...(schoolBoards ? [schoolGroup(schoolName(team.organization))] : []),
            ...settings.manualBoards.filter((board) => membership.get(board.id)!.has(team.team_id)).map((board) => `manual-${board.id}`),
        ])],
    }));
    const duration = (data.contest.end_time - data.contest.start_time) * 1000;
    const solved = new Set(data.submissions.filter((submission) => submission.status === 'CORRECT'
        && submission.timestamp >= 0 && submission.timestamp < duration
        && submission.problem_id >= 0 && submission.problem_id < data.contest.problem_quantity).map((submission) => submission.team_id));
    // CCPC 新榜单模式 (lib/ccpc-board.ts): columns from here on are positions in each team's row, not problems.
    const { hiddenFrom } = data;
    const medal: Record<string, Medals & { hydroAwards: ReturnType<typeof awardsFor> & { hiddenFrom?: number } }> = {};
    const allGroups = ['all', ...Object.keys(groups)];
    for (const id of allGroups) {
        const members = teams.filter((team) => id === 'all' || team.group.includes(id));
        const awards = awardsFor(settings, id);
        // Eligible: official teams on this board that solved something (also the base of 按比例设奖).
        const eligible = members.filter((team) => solved.has(team.team_id) && !team.group.includes('unofficial')).length;
        medal[id] = { ...cappedMedals(medalCounts(awards, eligible), eligible), hydroAwards: hiddenFrom === undefined ? awards : { ...awards, hiddenFrom } };
    }
    return {
        ...data,
        contest: { ...data.contest, group: groups, medal, options: {
            ...(data.contest.options && typeof data.contest.options === 'object' ? data.contest.options : {}),
            enable_organization: identity,
            submission_timestamp_unit: 'millisecond',
            // Hydro's ACM rule sums and orders penalty by the second; the ICPC rule by the minute (award-policy.mjs
            // breaks the remaining ties). The board displays minutes either way.
            calculation_of_penalty: settings.tieBreak === 'icpc' || settings.tieBreak === 'ccpc' ? 'in_minutes' : 'in_seconds',
        } },
        teams,
    };
}
