/**
 * Shared by the engine and canvas: one scoring and tie-breaking rule.
 * HydroXCPCIO: a Hydro contest ranks by solved count and penalty in whole seconds (Hydro's ACM rule), or, with
 * `tieBreak: 'icpc'`, by the ICPC regional rule: total time in minutes (each accepted time truncated to the
 * minute plus 20 minutes per rejected run), then the earlier last accepted run. Teams still equal share a rank.
 * `tieBreak: 'ccpc'` (CCPC 基本规则 4.1): total time in minutes as ICPC, and teams equal in solved and time share
 * the rank; within it the earlier last accepted run comes first (附录二, the order trophies follow).
 */
const icpcTies = (contest) => contest.scoringMode !== 'hydro' || contest.tieBreak === 'icpc';
const minuteRule = (contest) => contest.scoringMode !== 'hydro' || contest.tieBreak === 'icpc' || contest.tieBreak === 'ccpc';
const ccpcOrder = (contest) => contest.scoringMode === 'hydro' && contest.tieBreak === 'ccpc';
const scoreTime = (row) => row.timeSeconds ?? row.time * 60;

export function scoreTeam(contest, team, cells = []) {
  const seconds = !minuteRule(contest);
  const penalty = Number(contest.penaltyMinutes ?? 20);
  let solved = 0;
  let time = 0;
  let timeSeconds = 0;
  let lastSolutionTime = -1;
  let lastSolutionSeconds = -1;
  for (const cell of cells) {
    if (cell?.status !== 'solved') continue;
    const minutes = Number(cell.time) || 0;
    const penalties = cell.penaltyCount ?? cell._penaltyCount ?? Math.max(0, (Number(cell.attempts) || 0) - 1);
    solved += 1;
    time += minutes + penalties * penalty;
    if (seconds) timeSeconds += (cell.timeSeconds ?? minutes * 60) + penalties * penalty * 60;
    lastSolutionTime = Math.max(lastSolutionTime, minutes);
    lastSolutionSeconds = Math.max(lastSolutionSeconds, cell.timeSeconds ?? minutes * 60);
  }
  return { teamId: team.id, displayName: team.displayName || team.name || team.id,
    sortName: team.name || team.displayName || team.id, solved,
    time: seconds ? Math.floor(timeSeconds / 60) : time,
    ...(seconds ? { timeSeconds } : {}), ...(team.unrank ? { unrank: true } : {}), lastSolutionTime, lastSolutionSeconds, rank: 0 };
}

/** Equal on everything the rule ranks by, so the two share a rank (and, with 并列同奖, an award). */
export function sameStanding(contest, a, b) {
  return a.solved === b.solved && scoreTime(a) === scoreTime(b) && (!icpcTies(contest) || a.lastSolutionTime === b.lastSolutionTime);
}

const names = new Intl.Collator('en');
export function compareStandings(contest, a, b) {
  return b.solved - a.solved || scoreTime(a) - scoreTime(b) ||
    (icpcTies(contest) ? a.lastSolutionTime - b.lastSolutionTime : 0) ||
    (ccpcOrder(contest) ? (a.lastSolutionSeconds ?? a.lastSolutionTime * 60) - (b.lastSolutionSeconds ?? b.lastSolutionTime * 60) : 0) ||
    names.compare(String(a.sortName ?? a.displayName), String(b.sortName ?? b.displayName)) ||
    (String(a.teamId) < String(b.teamId) ? -1 : String(a.teamId) > String(b.teamId) ? 1 : 0);
}

function assignRanks(contest, records) {
  let previous = null;
  let rankedCount = 0;
  for (const record of records) {
    if (record.unrank) continue;
    rankedCount += 1;
    record.rank = previous && sameStanding(contest, previous, record) ? previous.rank : rankedCount;
    previous = record;
  }
  return records;
}

export function scoreStandings(contest, results) {
  return assignRanks(contest, (contest.teams || []).map((team) => scoreTeam(contest, team, results[team.id]))
    .sort((a, b) => compareStandings(contest, a, b)));
}

/** Only one team's score changes at a reveal: reinsert that record. */
export function updateStandings(contest, records, team, cells, { ranks = true } = {}) {
  const oldIndex = records.findIndex((row) => row.teamId === team.id);
  if (oldIndex >= 0) records.splice(oldIndex, 1);
  const row = scoreTeam(contest, team, cells);
  let low = 0; let high = records.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (compareStandings(contest, records[mid], row) <= 0) low = mid + 1;
    else high = mid;
  }
  records.splice(low, 0, row);
  if (ranks) assignRanks(contest, records);
  return { from: oldIndex, to: low };
}

/** Hydro displays exact elapsed/penalty time as minutes:seconds. */
export function formatSeconds(seconds) {
  const value = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
