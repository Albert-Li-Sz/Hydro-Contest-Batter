import type { ResolverGame, ResolverStep } from '../../../lib/resolver-types';
export function actionIndicesFor(steps: ResolverStep[]): number[];
export function startIndexFor(game: ResolverGame): number;
export function tierOrder(award: { id: string; awardType?: string }): number;
export function awardStops(game: ResolverGame): number[];
export function nextAwardStop(game: ResolverGame, actions: number[], position: number, stops?: number[]): number | null;
export function confirmPrevious(armedAt: number | null, now: number): boolean;
