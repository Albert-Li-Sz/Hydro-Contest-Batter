/**
 * Wire types of the ICPC Live v3 overlay and admin (src/frontend/generated/api.ts, MIT).
 * Only the ICPC flavour is produced here: Hydro's ACM rule is the data source.
 */

export type OptimismLevel = 'normal' | 'optimistic' | 'pessimistic';
export const optimismLevels: OptimismLevel[] = ['normal', 'optimistic', 'pessimistic'];

export type ContestStatus =
    | { type: 'before'; holdTimeMs?: number | null; scheduledStartAtUnixMs?: number | null }
    | { type: 'running'; startedAtUnixMs: number; frozenAtUnixMs?: number | null }
    | { type: 'over'; startedAtUnixMs: number; finishAtUnixMs: number; frozenAtUnixMs?: number | null }
    | { type: 'finalized'; startedAtUnixMs: number; finishAtUnixMs: number; finalizedAtUnixMs: number; frozenAtUnixMs?: number | null };

export interface MediaImage {
    type: 'Image';
    url: string;
    vertical?: boolean;
}
export type MediaType = MediaImage | { type: string; url: string; [key: string]: unknown };

export interface ProblemInfo {
    id: string;
    letter: string;
    name: string;
    ordinal: number;
    minScore: number | null;
    maxScore: number | null;
    color: string | null;
    scoreMergeMode: null;
    isHidden: boolean;
    weight: number;
    ftsMode: { type: 'auto' | 'hidden' };
}

export interface TeamInfo {
    id: string;
    name: string;
    shortName: string;
    groups: string[];
    hashTag: string | null;
    medias: Record<string, MediaType[]>;
    isHidden: boolean;
    isOutOfContest: boolean;
    organizationId: string | null;
    color?: string | null;
    customFields: Record<string, string>;
    reactionVideoTemplate: MediaType[] | null;
    sourceTemplate: MediaType[] | null;
}

export interface GroupInfo {
    id: string;
    displayName: string;
    isHidden: boolean;
    isOutOfContest: boolean;
}

export interface OrganizationInfo {
    id: string;
    displayName: string;
    fullName: string;
    logo: MediaType[];
    customFields: Record<string, string>;
}

export interface RankBasedAward {
    id: string;
    citation: string;
    maxRank?: number | null;
    minScore?: number | null;
    tiebreakMode?: 'NONE' | 'ALL';
    limit?: number | null;
    chainLimit?: number | null;
    manualTeamIds?: string[];
}

export interface AwardChain {
    awards: RankBasedAward[];
    groups?: string[];
    excludedGroups?: string[];
    /** HydroXCPCIO: medals by school rank instead of team rank (resolver/public/js/trophies.js). */
    hydroMedalRanking?: 'team' | 'school';
    /** HydroXCPCIO: trophies (冠军、亚军、季军…) of this board. */
    hydroPodium?: { basis: 'team' | 'school'; tie: 'lastAccept' | 'shared'; names: string[] };
}

export interface QueueSettings {
    waitTimeSeconds: number;
    firstToSolveWaitTimeSeconds: number;
    featuredRunWaitTimeSeconds: number;
    inProgressRunWaitTimeSeconds: number;
    maxQueueSize: number;
    maxUntestedRun: number;
}

export interface ContestInfo {
    name: string;
    status: ContestStatus;
    resultType: 'ICPC';
    contestLengthMs: number;
    freezeTimeMs: number | null;
    problems: ProblemInfo[];
    teams: TeamInfo[];
    groups: GroupInfo[];
    organizations: OrganizationInfo[];
    languages: never[];
    /** sum_in_seconds: Hydro's rule; each_submission_down_to_minute: the ICPC rule (lib/settings.ts TieBreak). */
    penaltyRoundingMode: 'sum_in_seconds' | 'each_submission_down_to_minute';
    emulationSpeed: number;
    awardsSettings: AwardChain[];
    penaltyPerWrongAttemptSeconds: number;
    queueSettings: QueueSettings;
    showTeamsWithoutSubmissions: boolean;
    problemColorPolicy: { type: 'always' };
    customFields: Record<string, string>;
    persons: never[];
    accounts: never[];
    mainScoreboardGroupId: string | null;
}

export interface Verdict {
    shortName: string;
    isAddingPenalty: boolean;
    isAccepted: boolean;
}

export type RunResult =
    | { type: 'ICPC'; verdict: Verdict; isFirstToSolveRun: boolean; isAfterFirstOk: boolean }
    | { type: 'IN_PROGRESS'; frozen?: true; testedPart: number; isAfterFirstOk: boolean };

export interface RunInfo {
    id: string;
    result: RunResult;
    problemId: string;
    teamId: string;
    /** Contest time in milliseconds. */
    time: number;
    languageId: string | null;
    reactionVideos: MediaType[];
    isHidden: boolean;
}

export interface ICPCProblemResult {
    type: 'ICPC';
    wrongAttempts: number;
    pendingAttempts: number;
    isSolved: boolean;
    isFirstToSolve: boolean;
    lastSubmitTimeMs: number | null;
}

export interface ScoreboardRow {
    totalScore: number;
    /** Seconds. */
    penalty: number;
    lastAcceptedMs: number;
    problemResults: ICPCProblemResult[];
}

export interface Award {
    id: string;
    citation: string;
    teams: string[];
}

export interface ScoreboardDiff {
    rows: Record<string, ScoreboardRow>;
    order: string[];
    ranks: number[];
    awards: Award[];
    /** Hydro extension read by the patched overlay: ranks and medals within each sub-board. */
    hydroGroups: Record<string, { ranks: Record<string, number>; awards: Award[] }>;
}

export interface QueueRunInfo {
    id: string;
    result: RunResult;
    problemId: string;
    teamId: string;
    featuredRunMedia: MediaType[] | null;
    reactionVideos: MediaType[];
}

export type TimeLineRunInfo =
    | { type: 'ICPC'; time: number; problemId: string; isAccepted: boolean; shortName: string }
    | { type: 'IN_PROGRESS'; frozen?: true; time: number; problemId: string };

export interface SolutionsStatistic {
    type: 'ICPC';
    teamsCount: number;
    verdictCounts: Record<string, number>;
    stats: { success: number; wrong: number; pending: number }[];
}
