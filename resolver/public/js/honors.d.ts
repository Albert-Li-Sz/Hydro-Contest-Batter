export interface HonorsRow { teamId: string; rank: number; solved: number }
export interface HonorsOptions { highest?: number; high?: number; standard?: number }
export const HONORS_DEFAULTS: Readonly<Required<HonorsOptions>>;
export const HONORS_TIERS: readonly { id: 'highest-honors' | 'high-honors' | 'honors'; citation: string; limit: keyof HonorsOptions }[];
export function honorsPlaces(rows: HonorsRow[], highest?: number): Map<string, number>;
export function honorsWinners(rows: HonorsRow[], options?: HonorsOptions): { id: 'highest-honors' | 'high-honors' | 'honors'; citation: string; teamIds: string[] }[];
