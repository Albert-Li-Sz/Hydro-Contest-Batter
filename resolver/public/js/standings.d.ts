export interface StandingsRecord {
    solved: number;
    time?: number;
    timeSeconds?: number;
    lastSolutionTime?: number;
    /** The last accept in seconds (orders a CCPC tie; equal minutes still share the rank). */
    lastSolutionSeconds?: number;
    sortName?: string;
    displayName?: string;
    teamId: string;
}
export interface RankingContest { scoringMode?: string; tieBreak?: 'hydro' | 'icpc' | 'ccpc' }
export function compareStandings(contest: RankingContest, a: StandingsRecord, b: StandingsRecord): number;
export function sameStanding(contest: RankingContest, a: StandingsRecord, b: StandingsRecord): boolean;
export function formatSeconds(seconds: number): string;
export interface StandingsCell { status: 'solved' | string; time: number; timeSeconds?: number; penaltyCount?: number }
export interface StandingsRow extends Required<Pick<StandingsRecord, 'solved' | 'time' | 'lastSolutionTime' | 'teamId'>> { timeSeconds?: number; lastSolutionSeconds: number; rank: number; unrank?: boolean }
export function scoreStandings(contest: RankingContest & { penaltyMinutes?: number; teams: { id: string; name?: string; unrank?: boolean }[] },
    results: Record<string, StandingsCell[]>): StandingsRow[];
