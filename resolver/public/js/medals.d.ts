import type { StandingsRow } from './standings.js';
export interface MedalContest {
    scoringMode?: string;
    tieBreak?: 'hydro' | 'icpc' | 'ccpc';
    durationMs?: number;
    teams: { id: string; name?: string; unrank?: boolean; unofficial?: boolean; schoolKey?: string; organizationName?: string }[];
    problems?: { id: string; label?: string }[];
    submissions?: { teamId: string; problemId: string; contestTime: number; status: 'solved' | 'pending' | 'failed' }[];
    awards?: unknown[];
}
export interface ConfiguredAward { id: string; citation: string; teamIds: string[]; displayMode: string; awardType: string }
export function configuredAwards(contest: MedalContest, options: Record<string, unknown>, standings: StandingsRow[]): ConfiguredAward[];
