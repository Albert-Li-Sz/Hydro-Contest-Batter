/**
 * ICPC World Finals Honors (2026 ICPC World Finals Rules, "Scoring of the Finals"), shared by the resolver
 * (medals.js), Live, the CCS API and the results export (lib/live/scoreboard.ts) and the board
 * (lib/award-policy.mjs), so every channel names the same teams.
 *
 * The place of a Highest Honors team is its rank. Every other team takes the highest rank among the teams
 * below Highest Honors that solved as many problems, so they share a place. Highest Honors go to places 1 to
 * `highest`, High Honors to `high`, Honors to `standard`. Teams that solved nothing receive none.
 *
 * `rows` are the official teams in ranking order: { teamId, rank, solved }.
 */
export const HONORS_DEFAULTS = Object.freeze({ highest: 25, high: 50, standard: 100 });
export const HONORS_TIERS = Object.freeze([
  Object.freeze({ id: 'highest-honors', citation: 'Highest Honors', limit: 'highest' }),
  Object.freeze({ id: 'high-honors', citation: 'High Honors', limit: 'high' }),
  Object.freeze({ id: 'honors', citation: 'Honors', limit: 'standard' }),
]);

/** Place of every row: the rank within Highest Honors, the best rank of the same solved count below it. */
export function honorsPlaces(rows, highest = HONORS_DEFAULTS.highest) {
  const best = new Map();
  for (const row of rows) {
    if (row.rank <= highest) continue;
    if (!best.has(row.solved) || row.rank < best.get(row.solved)) best.set(row.solved, row.rank);
  }
  return new Map(rows.map((row) => [row.teamId, row.rank <= highest ? row.rank : best.get(row.solved)]));
}

/** The three awards with their teams, in ranking order; empty ones are kept so CCS can say nobody holds them. */
export function honorsWinners(rows, options = HONORS_DEFAULTS) {
  const limits = { highest: options.highest ?? HONORS_DEFAULTS.highest, high: options.high ?? HONORS_DEFAULTS.high,
    standard: options.standard ?? HONORS_DEFAULTS.standard };
  const places = honorsPlaces(rows, limits.highest);
  const awards = HONORS_TIERS.map((tier) => ({ id: tier.id, citation: tier.citation, teamIds: [] }));
  for (const row of rows) {
    if (!(row.solved > 0)) continue;
    const place = places.get(row.teamId);
    const tier = HONORS_TIERS.findIndex((item) => place <= limits[item.limit]);
    if (tier >= 0) awards[tier].teamIds.push(row.teamId);
  }
  return awards;
}
