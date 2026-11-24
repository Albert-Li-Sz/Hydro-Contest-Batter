/**
 * 学校排名与奖杯, shared by the board (lib/award-policy.mjs), the resolver (medals.js), Live, the CCS API and
 * the results export (lib/live/scoreboard.ts), so every channel names the same winners.
 *
 * `rows` are the teams in ranking order: { teamId, official, solved, school, lastAcceptMs }; `same(a, b)` tells
 * whether the ranking rule puts two of them on one rank.
 *
 * School rank (CCPC 基本规则 4.2): only each school's best official team is ranked among schools; any other
 * official team takes the school rank right after its own position, shared. With 甲1, 甲2, 乙1, 丙1 apart,
 * the schools are 甲 1, 乙 2, 丙 3, and 甲2 shares 2 with 乙1.
 */

/** School rank of every official team: 1 + the schools whose best team is strictly ahead of it. */
export function schoolRanks(rows, same) {
  const best = [];
  const schools = new Set();
  const official = rows.filter((row) => row.official);
  for (const row of official) {
    if (schools.has(row.school)) continue;
    schools.add(row.school);
    best.push(row);
  }
  const position = new Map(official.map((row, index) => [row, index]));
  const ranks = new Map();
  for (const row of official) {
    const at = position.get(row);
    let ahead = 0;
    for (const other of best) {
      if (position.get(other) >= at) break;
      if (!same(other, row)) ahead++;
    }
    ranks.set(row.teamId, ahead + 1);
  }
  return ranks;
}

export const TROPHY_DEFAULTS = Object.freeze({ basis: 'team', tie: 'lastAccept', names: Object.freeze(['冠军', '亚军', '季军']) });

/**
 * 冠军、亚军、季军 (or the names the contest sets): official teams that solved something, by team rank, or with
 * `basis: 'school'` each school's best team by school rank. Teams the ranking rule cannot separate either share
 * the trophy (`tie: 'shared'`, the next trophy skips as many places) or, as CCPC 附录二, the earlier last accepted
 * run takes it (`tie: 'lastAccept'`) and the others move down; accepts in the same millisecond still share.
 */
export function trophyWinners(rows, options = TROPHY_DEFAULTS, same) {
  const names = Array.isArray(options.names) ? options.names : TROPHY_DEFAULTS.names;
  const schools = new Set();
  const candidates = rows.filter((row) => {
    if (!row.official || row.solved <= 0) return false;
    if (options.basis !== 'school') return true;
    if (schools.has(row.school)) return false;
    schools.add(row.school);
    return true;
  });
  const winners = names.map((name, place) => ({ name, place, teamIds: [] }));
  let place = 0;
  for (let start = 0; start < candidates.length && place < names.length;) {
    let end = start + 1;
    while (end < candidates.length && same(candidates[start], candidates[end])) end++;
    const tied = candidates.slice(start, end);
    const parts = [];
    if (options.tie === 'shared') parts.push(tied);
    else {
      const ordered = [...tied].sort((a, b) => (a.lastAcceptMs ?? Infinity) - (b.lastAcceptMs ?? Infinity));
      for (const row of ordered) {
        const last = parts[parts.length - 1];
        if (last && last[0].lastAcceptMs === row.lastAcceptMs) last.push(row);
        else parts.push([row]);
      }
    }
    for (const part of parts) {
      if (place >= names.length) break;
      winners[place].teamIds.push(...part.map((row) => row.teamId));
      place += part.length;
    }
    start = end;
  }
  return winners.filter((winner) => winner.teamIds.length);
}
