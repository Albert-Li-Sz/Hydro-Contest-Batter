import { createHash } from 'node:crypto';
import type { BoardSettings, MedalPool, Medals } from './settings';
import { awardsFor, cappedMedals, medalCounts } from './settings';
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
    return problemColorOrNull(entry) ?? UNSET_PROBLEM_COLOR;
}

/** The colour set for a problem, or null when none is: #e2e8f0 chosen on purpose stays a colour. */
export function problemColorOrNull(entry: unknown): string | null {
    const raw = typeof entry === 'string' ? entry : (entry as { color?: unknown } | null | undefined)?.color;
    const hex = typeof raw === 'string' ? /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(raw.trim())?.[1].toLowerCase() : undefined;
    if (!hex) return null;
    return `#${hex.length === 3 ? hex.replace(/./g, '$&$&') : hex}`;
}

/**
 * A problem's colour in the board data. XCPCIO needs a background for every problem, so one without a colour
 * shows UNSET_PROBLEM_COLOR and says so in `hydro_unset` (Live and CCS then report no colour).
 */
export function boardBalloon(entry: unknown) {
    const color = problemColorOrNull(entry);
    return { color: '#000', background_color: color ?? UNSET_PROBLEM_COLOR, hydro_unset: color === null };
}

/** Whether a board data balloon entry has no colour of its own (older data without `hydro_unset`: by the placeholder). */
export function balloonUnset(entry: { background_color?: string; hydro_unset?: boolean } | undefined) {
    if (typeof entry?.hydro_unset === 'boolean') return entry.hydro_unset;
    return problemColor(entry?.background_color) === UNSET_PROBLEM_COLOR;
}

export function schoolName(name?: string): string {
    return (name || '').normalize('NFKC').trim().replace(/\s+/g, ' ') || '未填写学校';
}

export function schoolGroup(name: string): string {
    return `school-${createHash('sha256').update(schoolName(name)).digest('hex').slice(0, 16)}`;
}

/**
 * The official teams of `teamIds` that medal counts may be based on (lib/settings.ts MedalBase): all of them,
 * those with a submission during the contest, and those with an accepted one among the submissions given.
 */
export function medalPool(data: Pick<BoardData, 'contest' | 'teams' | 'submissions'>, teamIds: Iterable<string>): MedalPool {
    const ids = new Set(teamIds);
    const official = new Set(data.teams.filter((team) => ids.has(team.team_id) && !team.group.includes('unofficial')).map((team) => team.team_id));
    const duration = (data.contest.end_time - data.contest.start_time) * 1000;
    const submitted = new Set<string>();
    const solved = new Set<string>();
    for (const record of data.submissions) {
        if (!official.has(record.team_id) || !(record.timestamp >= 0 && record.timestamp < duration)
            || !(record.problem_id >= 0 && record.problem_id < data.contest.problem_quantity)) continue;
        submitted.add(record.team_id);
        if (record.status === 'CORRECT') solved.add(record.team_id);
    }
    return { registered: official.size, submitted: submitted.size, solved: solved.size };
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
    // CCPC 新榜单模式 (lib/ccpc-board.ts): columns from here on are positions in each team's row, not problems.
    const { hiddenFrom } = data;
    const medal: Record<string, Medals & { hydroAwards: ReturnType<typeof awardsFor> & { hiddenFrom?: number } }> = {};
    const allGroups = ['all', ...Object.keys(groups)];
    for (const id of allGroups) {
        const members = teams.filter((team) => id === 'all' || team.group.includes(id));
        const awards = awardsFor(settings, id);
        // Medals go to official teams on this board that solved something; the counts may rest on more of them.
        const pool = medalPool(data, members.map((team) => team.team_id));
        medal[id] = { ...cappedMedals(medalCounts(awards, pool), pool.solved), hydroAwards: hiddenFrom === undefined ? awards : { ...awards, hiddenFrom } };
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
