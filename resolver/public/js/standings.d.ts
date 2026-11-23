export interface StandingsRecord {
    solved: number;
    time?: number;
    timeSeconds?: number;
    lastSolutionTime?: number;
    sortName?: string;
    displayName?: string;
    teamId: string;
}
export interface RankingContest { scoringMode?: string; tieBreak?: 'hydro' | 'icpc' }
export function compareStandings(contest: RankingContest, a: StandingsRecord, b: StandingsRecord): number;
export function sameStanding(contest: RankingContest, a: StandingsRecord, b: StandingsRecord): boolean;
export function formatSeconds(seconds: number): string;
