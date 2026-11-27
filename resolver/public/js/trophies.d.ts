export interface TrophyRow {
    teamId: string;
    official: boolean;
    solved: number;
    school: string;
    lastAcceptMs: number | null;
}
export interface TrophyOptions { basis?: 'team' | 'school'; tie?: 'lastAccept' | 'shared'; names?: readonly string[] }
export const TROPHY_DEFAULTS: Readonly<Required<TrophyOptions>>;
export function awardPlaces<T extends TrophyRow>(rows: T[], same: (a: T, b: T) => boolean): Map<string, { rank: number; school: number; position: number }>;
export function schoolRanks<T extends TrophyRow>(rows: T[], same: (a: T, b: T) => boolean): Map<string, number>;
export function trophyWinners<T extends TrophyRow>(rows: T[], options: TrophyOptions, same: (a: T, b: T) => boolean): { name: string; place: number; teamIds: string[] }[];
