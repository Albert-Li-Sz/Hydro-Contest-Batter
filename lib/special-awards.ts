/**
 * 特别奖 (lib/settings.ts SpecialAward): who gets each one, from the board data by the board's own ranking
 * rule (resolver/public/js/standings.js), so the board, the resolver and the CCS API agree.
 */
import type { BoardData } from './board';
import type { BoardSettings, SpecialAward } from './settings';
import { sameStanding, scoreStandings, type StandingsCell } from '../resolver/public/js/standings.js';

export interface SpecialResult {
    id: string;
    name: string;
    teamIds: string[];
}

export interface DisplayedSpecialAward {
    name: string;
    teams: string;
}

const pending = new Set(['PENDING', 'FROZEN']);
// Hydro's ACM rule charges no penalty for these (as the board, the resolver and the overview).
const exempt = new Set(['CORRECT', 'COMPILATION_ERROR', 'PRESENTATION_ERROR', 'CANCELED']);

/** Results are final for this data: the contest is over and nothing is hidden by the freeze or still judging. */
export function resultsFinal(data: BoardData, ended: boolean) {
    return ended && !data.submissions.some((record) => pending.has(record.status));
}

/** Send the winners on the same refresh as the results used to calculate them. */
export function displaySpecialAwards(data: BoardData, settings: BoardSettings, ended: boolean, frozen: boolean): BoardData {
    if (!settings.specialAwards.length || frozen || !resultsFinal(data, ended)) return data;
    const awards = specialAwardResults(data, settings).filter((award) => award.teamIds.length);
    if (!awards.length) return data;
    const names = new Map(data.teams.map((team) => [team.team_id, team.name]));
    const displayed: DisplayedSpecialAward[] = awards.map(({ name, teamIds }) => ({ name, teams: teamIds.map((id) => names.get(id)).join('、') }));
    const medal = data.contest.medal as Record<string, Record<string, unknown>>;
    return { ...data, contest: { ...data.contest, medal: { ...medal, all: { ...medal.all, hydroSpecialAwards: displayed } } } };
}

/** Each award with its winners (none when no team qualifies). `data` is the enhanced board, with its groups. */
export function specialAwardResults(data: BoardData, settings: Pick<BoardSettings, 'specialAwards' | 'tieBreak'>): SpecialResult[] {
    const awards = settings.specialAwards || [];
    if (!awards.length) return [];
    const duration = (data.contest.end_time - data.contest.start_time) * 1000;
    const known = new Set(data.teams.map((team) => team.team_id));
    // First accept and penalised runs before it, per team and problem.
    const cells = new Map<string, Map<number, { solvedAt: number | null; id: string; tries: number }>>();
    const records = [...new Map(data.submissions.map((record) => [record.submission_id, record])).values()]
        .filter((record) => known.has(record.team_id) && record.timestamp >= 0 && record.timestamp < duration
            && Number.isInteger(record.problem_id) && record.problem_id >= 0 && record.problem_id < data.contest.problem_quantity)
        .sort((a, b) => a.timestamp - b.timestamp || a.submission_id.localeCompare(b.submission_id));
    for (const record of records) {
        const team = cells.get(record.team_id) || new Map();
        cells.set(record.team_id, team);
        const cell = team.get(record.problem_id) || { solvedAt: null, id: '', tries: 0 };
        team.set(record.problem_id, cell);
        if (cell.solvedAt !== null || pending.has(record.status)) continue;
        if (record.status === 'CORRECT') { cell.solvedAt = record.timestamp; cell.id = record.submission_id; } else if (!exempt.has(record.status)) cell.tries++;
    }
    const ranking = { scoringMode: 'hydro', tieBreak: settings.tieBreak ?? 'hydro', penaltyMinutes: 20 };
    const results = Object.fromEntries([...cells].map(([teamId, team]) => [teamId, [...team.values()].filter((cell) => cell.solvedAt !== null)
        .map((cell): StandingsCell => ({ status: 'solved', time: Math.floor(cell.solvedAt! / 60_000), timeSeconds: Math.floor(cell.solvedAt! / 1000), penaltyCount: cell.tries }))]));

    const groups = data.contest.group as Record<string, string> | undefined;
    const winners = (award: SpecialAward): string[] => {
        if (award.kind === 'manual') return award.teamIds.filter((id) => known.has(id));
        if (award.board !== 'all' && !Object.hasOwn(groups || {}, award.board)) return [];
        const members = data.teams.filter((team) => (award.board === 'all' || team.group.includes(award.board))
            && (award.kind === 'rank' && award.unofficial || !team.group.includes('unofficial')));
        if (award.kind === 'lastAccept') {
            let latest = -1;
            let chosen: { teamId: string; id: string }[] = [];
            for (const team of members) {
                for (const cell of cells.get(team.team_id)?.values() || []) {
                    if (cell.solvedAt === null) continue;
                    // Hydro records whole seconds: accepts in one second are at the same time.
                    const second = Math.floor(cell.solvedAt / 1000);
                    if (second > latest) { latest = second; chosen = [{ teamId: team.team_id, id: cell.id }]; } else if (second === latest) chosen.push({ teamId: team.team_id, id: cell.id });
                }
            }
            chosen.sort((a, b) => a.id.localeCompare(b.id));
            return [...new Set((award.ties ? chosen : chosen.slice(-1)).map((item) => item.teamId))];
        }
        const contest = { ...ranking, teams: members.map((team) => ({ id: team.team_id, name: team.name })) };
        const rows = scoreStandings(contest, results).filter((row) => row.solved > 0);
        if (!rows.length) return [];
        if (award.kind === 'lastSolver') {
            const last = rows[rows.length - 1];
            return award.ties ? rows.filter((row) => sameStanding(contest, row, last)).map((row) => row.teamId) : [last.teamId];
        }
        return award.ties ? rows.filter((row) => row.rank === award.rank).map((row) => row.teamId) : rows[award.rank - 1] ? [rows[award.rank - 1].teamId] : [];
    };
    return awards.map((award) => ({ id: award.id, name: award.name, teamIds: winners(award) }));
}
