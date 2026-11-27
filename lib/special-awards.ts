/**
 * 特别奖 (lib/settings.ts SpecialAward): who gets each one, from the board data by the board's own ranking
 * rule (resolver/public/js/standings.js), so the board, the resolver and the CCS API agree.
 */
import type { BoardData, BoardTeam } from './board';
import { medalPool } from './board';
import type { BoardSettings, SpecialAward } from './settings';
import { awardsFor, medalCounts } from './settings';
import { SCHOOL_TAG } from './award-policy.mjs';
import { compareStandings, sameStanding, scoreStandings, type StandingsCell, type StandingsRow } from '../resolver/public/js/standings.js';
import { configuredAwards } from '../resolver/public/js/medals.js';
import { honorsWinners } from '../resolver/public/js/honors.js';

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
    const honors = awardsFor(settings, 'all').honors?.enabled;
    if ((!settings.specialAwards.length && !honors) || frozen || !resultsFinal(data, ended)) return data;
    const awards = [...specialAwardResults(data, settings), ...honorsResults(data, settings)].filter((award) => award.teamIds.length);
    if (!awards.length) return data;
    const names = new Map(data.teams.map((team) => [team.team_id, team.name]));
    const displayed: DisplayedSpecialAward[] = awards.map(({ name, teamIds }) => ({ name, teams: teamIds.map((id) => names.get(id)).join('、') }));
    const medal = data.contest.medal as Record<string, Record<string, unknown>>;
    return { ...data, contest: { ...data.contest, medal: { ...medal, all: { ...medal.all, hydroSpecialAwards: displayed } } } };
}

type Settings = Pick<BoardSettings, 'specialAwards' | 'tieBreak'> & Partial<BoardSettings>;
type Cell = { solvedAt: number | null; id: string; tries: number };

/** First accept and penalised runs before it, per team and problem, from the final results in `data`. */
function standingsInput(data: BoardData, settings: Settings) {
    const duration = (data.contest.end_time - data.contest.start_time) * 1000;
    const known = new Set(data.teams.map((team) => team.team_id));
    const cells = new Map<string, Map<number, Cell>>();
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
    return { duration, known, cells, ranking, results };
}

const schoolOf = (team: BoardTeam) => (Array.isArray(team.tag) ? (team.tag as string[]).find((tag) => tag.startsWith(SCHOOL_TAG))?.slice(SCHOOL_TAG.length) : undefined)
    ?? team.school_key ?? (team.organization || `#${team.team_id}`);

/**
 * The main board's standings of every team (unofficial ones unranked) and its gold, silver and bronze winners,
 * with the resolver's medal calculation (resolver/public/js/medals.js) and the board's counts (lib/board.ts).
 */
function mainBoardMedals(data: BoardData, settings: Settings, input: ReturnType<typeof standingsInput>) {
    const contest = { ...input.ranking, durationMs: input.duration,
        teams: data.teams.map((team) => ({ id: team.team_id, name: team.name, unrank: team.group.includes('unofficial'), unofficial: team.group.includes('unofficial'), schoolKey: schoolOf(team) })),
        submissions: [...input.cells].flatMap(([teamId, team]) => [...team].filter(([, cell]) => cell.solvedAt !== null)
            .map(([problem, cell]) => ({ teamId, problemId: String(problem), contestTime: cell.solvedAt!, status: 'solved' as const }))) };
    const standings = scoreStandings(contest, input.results);
    const tiers: Set<string>[] = [new Set(), new Set(), new Set()];
    if (settings.medals && settings.manualBoards && settings.boardAwards) {
        const rules = awardsFor(settings as BoardSettings, 'all');
        const pool = medalPool(data, data.teams.map((team) => team.team_id));
        const counts = medalCounts(rules, pool);
        const awards = configuredAwards(contest, { medalMode: 'custom', goldCount: counts.gold, silverCount: counts.silver, bronzeCount: counts.bronze,
            medalSameScore: rules.medalSameScore, unofficialMedals: rules.unofficialMedals, medalRanking: rules.medalRanking }, standings);
        ['gold', 'silver', 'bronze'].forEach((tier, index) => {
            for (const id of awards.find((award) => award.id === `medal-${tier}`)?.teamIds || []) tiers[index].add(id);
        });
    }
    return { standings, rows: new Map(standings.map((row) => [row.teamId, row])), tiers };
}

/** Each award with its winners (none when no team qualifies). `data` is the enhanced board, with its groups. */
export function specialAwardResults(data: BoardData, settings: Settings): SpecialResult[] {
    const awards = settings.specialAwards || [];
    if (!awards.length) return [];
    const input = standingsInput(data, settings);
    const { known, cells, ranking, results } = input;
    let main: ReturnType<typeof mainBoardMedals> | null = null;
    const medals = () => (main ??= mainBoardMedals(data, settings, input));
    const medalists = () => new Set(medals().tiers.flatMap((tier) => [...tier]));
    // The lowest standing that still meets the floor: the last official team holding that medal or a better one.
    const floorRow = (floor: SpecialAward['floor']): StandingsRow | null | undefined => {
        if (floor === 'none') return undefined;
        const { standings, tiers } = medals();
        const holders = new Set(tiers.slice(0, ['gold', 'silver', 'bronze'].indexOf(floor) + 1).flatMap((tier) => [...tier]));
        return standings.filter((row) => !row.unrank && holders.has(row.teamId)).at(-1) ?? null;
    };

    const groups = data.contest.group as Record<string, string> | undefined;
    const lastAccepts = (team: BoardTeam) => {
        let latest: { second: number; id: string } | null = null;
        for (const cell of cells.get(team.team_id)?.values() || []) {
            if (cell.solvedAt === null) continue;
            // Hydro records whole seconds: accepts in one second are at the same time.
            const second = Math.floor(cell.solvedAt / 1000);
            if (!latest || second > latest.second || (second === latest.second && cell.id > latest.id)) latest = { second, id: cell.id };
        }
        return latest;
    };
    const winners = (award: SpecialAward): string[] => {
        if (award.kind === 'manual') return award.teamIds.filter((id) => known.has(id));
        if (award.board !== 'all' && !Object.hasOwn(groups || {}, award.board)) return [];
        let members = data.teams.filter((team) => (award.board === 'all' || team.group.includes(award.board))
            && (award.unofficial || !team.group.includes('unofficial')));
        if ((award.minTeams ?? 0) > members.length) return [];
        const minSolved = award.minSolved ?? 1;
        if (minSolved > 1) members = members.filter((team) => [...cells.get(team.team_id)?.values() || []].filter((cell) => cell.solvedAt !== null).length >= minSolved);
        if (award.excludeMedalists || award.kind === 'honorable') {
            const excluded = medalists();
            members = members.filter((team) => !excluded.has(team.team_id));
        }
        const floor = floorRow(award.floor ?? 'none');
        if (floor === null) return [];
        if (floor) {
            const rows = medals().rows;
            members = members.filter((team) => {
                const row = rows.get(team.team_id);
                return !!row && (compareStandings(ranking, row, floor) <= 0 || sameStanding(ranking, row, floor));
            });
        }
        const count = Math.max(1, award.count ?? 1);
        if (award.kind === 'lastAccept' || award.kind === 'firstSolution') {
            const last = award.kind === 'lastAccept';
            const picks = members.flatMap((team) => {
                if (last) { const latest = lastAccepts(team); return latest ? [{ teamId: team.team_id, ...latest }] : []; }
                const first = [...cells.get(team.team_id)?.values() || []].filter((cell) => cell.solvedAt !== null)
                    .sort((a, b) => a.solvedAt! - b.solvedAt! || a.id.localeCompare(b.id))[0];
                return first ? [{ teamId: team.team_id, second: Math.floor(first.solvedAt! / 1000), id: first.id }] : [];
            });
            // Latest (or earliest) first; among accepts in one second, the later (earlier) record wins alone.
            picks.sort((a, b) => (last ? b.second - a.second || b.id.localeCompare(a.id) : a.second - b.second || a.id.localeCompare(b.id)));
            const take = last ? count : 1;
            if (!picks.length) return [];
            const boundary = picks[Math.min(take, picks.length) - 1].second;
            const chosen = award.ties ? picks.filter((pick, index) => index < take || pick.second === boundary) : picks.slice(0, take);
            // Winners of one second are listed in record order.
            return chosen.sort((a, b) => (last ? b.second - a.second : a.second - b.second) || a.id.localeCompare(b.id)).map((pick) => pick.teamId);
        }
        const contest = { ...ranking, teams: members.map((team) => ({ id: team.team_id, name: team.name })) };
        const rows = scoreStandings(contest, results).filter((row) => row.solved > 0);
        if (!rows.length) return [];
        if (award.kind === 'honorable') return rows.map((row) => row.teamId);
        if (award.kind === 'lastSolver') {
            const boundary = rows[Math.max(0, rows.length - count)];
            return award.ties ? rows.filter((row, index) => index >= rows.length - count || sameStanding(contest, row, boundary)).map((row) => row.teamId)
                : rows.slice(-count).map((row) => row.teamId);
        }
        return award.ties ? rows.filter((row) => row.rank === award.rank).map((row) => row.teamId) : rows[award.rank - 1] ? [rows[award.rank - 1].teamId] : [];
    };
    return awards.map((award) => ({ id: award.id, name: award.name, teamIds: winners(award) }));
}

/** ICPC World Finals Honors on the main board (resolver/public/js/honors.js), for the board's award list. */
export function honorsResults(data: BoardData, settings: Settings): SpecialResult[] {
    if (!settings.medals || !settings.manualBoards || !settings.boardAwards) return [];
    const honors = awardsFor(settings as BoardSettings, 'all').honors;
    if (!honors?.enabled) return [];
    const { standings } = mainBoardMedals(data, settings, standingsInput(data, settings));
    const ranked = standings.filter((row) => !row.unrank).map((row) => ({ teamId: row.teamId, rank: row.rank, solved: row.solved }));
    return honorsWinners(ranked, honors).map((award) => ({ id: award.id, name: award.citation, teamIds: award.teamIds }));
}
