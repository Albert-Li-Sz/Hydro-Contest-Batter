// HydroXCPCIO: zero-solve teams do not receive medals or podium awards.
import { sameStanding } from './standings.js';
import { schoolRanks, trophyWinners } from './trophies.js';
export const MEDAL_DEFAULTS = Object.freeze({
  medalMode: 'imported', goldCount: 4, silverCount: 4, bronzeCount: 4,
  goldCitation: '金奖', silverCitation: '银奖', bronzeCitation: '铜奖', medalSameScore: true,
  podiumEnabled: false, championCitation: '冠军', runnerUpCitation: '亚军', thirdPlaceCitation: '季军',
  // HydroXCPCIO: trophies by team or school rank, how tied teams receive them, and their names; medals by school rank.
  podiumBasis: 'team', podiumTie: 'lastAccept', podiumNames: null, medalRanking: 'team',
  firstSolveMode: 'imported', firstSolveProblemIds: Object.freeze([]), firstSolveIncludeUnrank: false,
});

export function normalizeMedalOptions(raw = {}) {
  const options = { ...MEDAL_DEFAULTS, medalMode: raw.medalMode === 'custom' ? 'custom' : 'imported' };
  for (const tier of ['gold', 'silver', 'bronze']) {
    const count = raw[`${tier}Count`];
    if (count != null && count !== '' && Number.isFinite(Number(count))) options[`${tier}Count`] = Math.max(0, Math.min(10000, Math.trunc(Number(count))));
    if (typeof raw[`${tier}Citation`] === 'string') options[`${tier}Citation`] = raw[`${tier}Citation`].trim().slice(0, 80) || MEDAL_DEFAULTS[`${tier}Citation`];
  }
  if (typeof raw.medalSameScore === 'boolean') options.medalSameScore = raw.medalSameScore;
  if (typeof raw.podiumEnabled === 'boolean') options.podiumEnabled = raw.podiumEnabled;
  for (const field of ['championCitation', 'runnerUpCitation', 'thirdPlaceCitation']) {
    if (typeof raw[field] === 'string') options[field] = raw[field].trim().slice(0, 80) || MEDAL_DEFAULTS[field];
  }
  if (raw.podiumBasis === 'school') options.podiumBasis = 'school';
  if (raw.podiumTie === 'shared') options.podiumTie = 'shared';
  if (raw.medalRanking === 'school') options.medalRanking = 'school';
  if (Array.isArray(raw.podiumNames)) {
    const names = raw.podiumNames.filter((name) => typeof name === 'string' && name.trim()).map((name) => name.trim().slice(0, 80)).slice(0, 10);
    if (names.length) options.podiumNames = names;
  }
  options.firstSolveMode = ['all', 'selected'].includes(raw.firstSolveMode) ? raw.firstSolveMode : 'imported';
  options.firstSolveProblemIds = Array.isArray(raw.firstSolveProblemIds) ? [...new Set(raw.firstSolveProblemIds
    .filter((id) => typeof id === 'string' && id.trim() && id.length <= 200).map((id) => id.trim()))].slice(0, 30) : [];
  if (typeof raw.firstSolveIncludeUnrank === 'boolean') options.firstSolveIncludeUnrank = raw.firstSolveIncludeUnrank;
  return options;
}

/** Each team's school and last accepted run, as the trophies and school ranks need them. */
function trophyRows(contest, standings) {
  const teams = new Map((contest.teams || []).map((team) => [team.id, team]));
  const solved = new Map();
  const lastAccept = new Map();
  for (const submission of [...(contest.submissions || [])].sort((a, b) => a.contestTime - b.contestTime)) {
    if (submission.status !== 'solved' || (contest.durationMs > 0 && submission.contestTime >= contest.durationMs)) continue;
    const key = `${submission.teamId}/${submission.problemId}`;
    if (solved.has(key)) continue;
    solved.set(key, true);
    lastAccept.set(submission.teamId, Math.max(lastAccept.get(submission.teamId) ?? -1, Math.floor(submission.contestTime / 1000) * 1000));
  }
  return standings.map((row) => {
    const team = teams.get(row.teamId);
    return { ...row, official: !row.unrank, school: team?.schoolKey || team?.organizationName || `#${row.teamId}`,
      lastAcceptMs: lastAccept.get(row.teamId) ?? null };
  });
}

/** Cumulative award cutoffs; equal solved/time groups inherit the higher tier. With school ranking, by school rank. */
function medalAwards(options, standings, contest = {}) {
  const tiers = ['gold', 'silver', 'bronze'];
  const awards = tiers.map((tier) => ({ id: `medal-${tier}`, citation: options[`${tier}Citation`], teamIds: [], displayMode: 'detail', awardType: 'medal' }));
  const limits = [];
  let total = 0;
  for (const tier of tiers) limits.push(total += options[`${tier}Count`]);
  const ranked = standings.filter((row) => !row.unrank && row.solved > 0);
  const bySchool = options.medalRanking === 'school'
    ? schoolRanks(trophyRows(contest, standings), (a, b) => sameStanding(contest, a, b)) : null;
  let previous = null;
  let tier = -1;
  ranked.forEach((row, i) => {
    if (bySchool) tier = limits.findIndex((limit) => bySchool.get(row.teamId) <= limit);
    // Teams the ranking rule cannot separate (they share a rank) share the higher medal.
    else if (!(options.medalSameScore && previous && sameStanding(contest, row, previous))) tier = limits.findIndex((limit) => i < limit);
    if (tier >= 0) awards[tier].teamIds.push(row.teamId);
    previous = row;
  });
  return awards.filter((award) => award.teamIds.length);
}

function podiumAwards(options, standings, contest = {}) {
  const names = options.podiumNames || [options.championCitation, options.runnerUpCitation, options.thirdPlaceCitation];
  const ids = ['champion', 'runner-up', 'third-place'];
  return trophyWinners(trophyRows(contest, standings), { basis: options.podiumBasis, tie: options.podiumTie, names },
    (a, b) => sameStanding(contest, a, b)).map((trophy) => ({
    id: `podium-${ids[trophy.place] ?? `place-${trophy.place + 1}`}`, citation: trophy.name,
    teamIds: trophy.teamIds, displayMode: 'detail', awardType: trophy.place === 0 ? 'winner' : 'rank',
  }));
}

/** Earliest AC per problem, using full submission timestamps rather than penalty or rounded minutes. */
function firstSolveAwards(contest, options, standings) {
  const selected = new Set(options.firstSolveProblemIds);
  const problems = (contest.problems || []).filter((problem) => options.firstSolveMode === 'all' || selected.has(problem.id));
  const teams = new Set(standings.filter((row) => options.firstSolveIncludeUnrank || !row.unrank).map((row) => row.teamId));
  const attempts = new Map(problems.map((problem) => [problem.id, { time: Infinity, pending: Infinity, winners: new Set() }]));
  for (const submission of contest.submissions || []) {
    const attempt = attempts.get(submission.problemId);
    if (!attempt || !teams.has(submission.teamId) || !Number.isFinite(submission.contestTime) || submission.contestTime < 0 ||
        (contest.durationMs > 0 && submission.contestTime >= contest.durationMs)) continue;
    if (submission.status === 'pending') attempt.pending = Math.min(attempt.pending, submission.contestTime);
    if (submission.status !== 'solved' || submission.contestTime > attempt.time) continue;
    if (submission.contestTime < attempt.time) { attempt.time = submission.contestTime; attempt.winners.clear(); }
    attempt.winners.add(submission.teamId);
  }
  return problems.flatMap((problem) => {
    const attempt = attempts.get(problem.id);
    // An unresolved earlier/equal submission could change the winner(s).
    if (!attempt.winners.size || attempt.pending <= attempt.time) return [];
    return [{ id: `first-to-solve-${problem.id}`, citation: `${problem.label || problem.id} 题最快解题奖`,
      teamIds: standings.filter((row) => attempt.winners.has(row.teamId)).map((row) => row.teamId),
      displayMode: 'detail', awardType: 'first-to-solve' }];
  });
}

/** Each award category can be configured independently and shares one preview/game calculation. */
export function configuredAwards(contest, rawOptions, standings) {
  const options = normalizeMedalOptions(rawOptions);
  let awards = [...(contest.awards || [])];
  if (options.medalMode === 'custom') {
    awards = awards.filter((award) => award.awardType !== 'medal' && !/^medal-/.test(award.id))
      .concat(medalAwards(options, standings, contest));
  }
  if (options.podiumEnabled) {
    awards = awards.filter((award) => award.awardType !== 'winner' &&
      !/^podium-/.test(award.id) && !/^rank-[123]$/.test(award.id))
      .concat(podiumAwards(options, standings, contest));
  }
  if (options.firstSolveMode !== 'imported') {
    awards = awards.filter((award) => award.awardType !== 'first-to-solve' && !/^first-to-solve-/.test(award.id))
      .concat(firstSolveAwards(contest, options, standings));
  }
  return awards;
}
