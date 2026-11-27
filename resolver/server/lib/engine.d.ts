import type { ResolverContest, ResolverGame } from '../../../lib/resolver-types';
export function buildGame(contest: ResolverContest, options?: Record<string, unknown>, meta?: { id?: string }): ResolverGame;
export function computeCells(contest: ResolverContest, options?: { frozen?: boolean }): {
    standings: { teamId: string; rank: number; solved: number; timeSeconds: number; unrank?: boolean }[];
    results: Record<string, { status: string; pending: number; timeSeconds: number; _penaltyCount: number }[]>;
    pendingCount: number;
};
/** Loose shape: the big-screen adapter passes the normalized contest straight back to the renderer. */
export function normalizeContest(input: Record<string, unknown>): Record<string, any>;
export function usableAsset(value: unknown): string | null;
