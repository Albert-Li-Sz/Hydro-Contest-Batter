import type { BoardRules, MedalPool, Medals } from './settings';

export interface ResolverTeam {
    id: string;
    name: string;
    displayName: string;
    organizationName: string;
    unrank: boolean;
    unofficial?: boolean;
    /** Team contests: member names, shown on the team's award page. */
    members?: string[];
    photo?: string;
    logo: string;
}

export interface ResolverSubmission {
    id: string;
    teamId: string;
    problemId: string;
    contestTime: number;
    status: 'solved' | 'failed' | 'pending';
    penalty: boolean;
}

export interface ResolverContest {
    contestId: string;
    name: string;
    startTime: string;
    durationMs: number;
    freezeDurationMs: number;
    scoringMode: 'hydro';
    /** lib/settings.ts TieBreak; omitted means Hydro's rule. */
    tieBreak?: 'hydro' | 'icpc' | 'ccpc';
    penaltyMinutes: number;
    unofficialFirstSolve: boolean;
    firstSolveEnabled: boolean;
    teams: ResolverTeam[];
    problems: { id: string; label: string; color: string }[];
    submissions: ResolverSubmission[];
    awards: unknown[];
}

export interface ResolverBoard {
    id: string;
    name: string;
    teamIds: string[];
    medals: Medals;
    awards: BoardRules;
    /** Official members that solved something in this data: the medal cap. */
    eligible: number;
    /** Official members counted three ways, the base of 按比例设奖 (sessions saved before it lack this). */
    pool?: MedalPool;
    /** Medals of each tier these rules give `eligible` teams (before ties share a medal). */
    medalCounts: Medals;
}

export interface ResolverConfig {
    mode: 'board' | 'official';
    boardId: string;
    rehearsal: boolean;
    freezeMode: 'contest' | 'custom';
    freezeAtSeconds: number | null;
    goldCount: number;
    silverCount: number;
    bronzeCount: number;
    goldCitation: string;
    silverCitation: string;
    bronzeCitation: string;
    medalSameScore: boolean;
    unofficialMedals?: boolean;
    podiumEnabled: boolean;
    podiumBasis: 'team' | 'school';
    podiumTie: 'lastAccept' | 'shared';
    podiumNames: string[];
    medalRanking: 'team' | 'school';
    /** ICPC World Finals Honors by place (resolver/public/js/honors.js). */
    honorsEnabled?: boolean;
    honorsHighest?: number;
    honorsHigh?: number;
    honorsStandard?: number;
    firstSolve: boolean;
    rowsPerScreen: number;
    autoplay: boolean;
    autoplaySpeed: number;
    autoStopAtMedals: boolean;
    startScreen: 'splash' | 'scoreboard';
    renderer?: '2d' | '3d';
    showSchool: boolean;
}

export interface ResolverStep {
    type: string;
    screen?: string;
    role?: string;
    [key: string]: unknown;
}

export interface ResolverGame {
    id?: string;
    contest: ResolverContest;
    options: Record<string, unknown>;
    initialState: Record<string, unknown>;
    steps: ResolverStep[];
    meta: {
        pendingCount: number;
        discardedUnjudged: number;
        teamCount: number;
        problemCount: number;
        stepCount: number;
        [key: string]: unknown;
    };
}

export interface ResolverOverview {
    title: string;
    teamCount: number;
    officialCount: number;
    problemCount: number;
    pendingCount: number;
    unjudgedCount: number;
    freezeAtSeconds: number | null;
    durationSeconds: number;
    capturedAt: string;
    ended: boolean;
    rehearsal: boolean;
}

export interface ResolverPayload {
    snapshot: ResolverContest;
    config: ResolverConfig;
    overview: ResolverOverview;
    game: ResolverGame;
}
