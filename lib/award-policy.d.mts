export const AWARD_EXEMPT_TAG: string;
export const SCHOOL_TAG: string;
interface AwardTeam {
    tag: string[];
    awards: unknown[];
    solvedProblemNum: number;
    isEqualRank(other: AwardTeam): boolean;
}
interface AwardRank {
    teams: AwardTeam[];
    contest: { awards?: Map<string, { minRank: number; maxRank: number; medalType: unknown }[]> };
    options: { group: string };
}
export function applyAwardEligibility<T extends AwardRank>(rank: T): T;
