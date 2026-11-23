import { compareStandings, sameStanding } from '../resolver/public/js/standings.js';

// Reserved team tag understood by the pinned XCPCIO engine extension.
export const AWARD_EXEMPT_TAG = 'hydro:award-exempt';

/** Apply the selected board's rules after the upstream engine scores visible submissions. */
export function applyAwardEligibility(rank) {
    const rules = rank.contest.medal?.[rank.options.group]?.hydroAwards;
    // The contest's ranking rule (lib/settings.ts TieBreak), the same one the resolver and the screens use.
    const ranking = { scoringMode: 'hydro', tieBreak: rules?.tieBreak === 'icpc' ? 'icpc' : 'hydro' };
    const ordered = rank.teams.map((team) => ({ team, teamId: team.id, solved: team.solvedProblemNum,
        timeSeconds: team.penalty, lastSolutionTime: team.lastSolvedProblemStatistics?.solvedTimestampToMinute ?? -1,
        sortName: team.name.getOrDefault('zh-CN') }));
    ordered.sort((a, b) => compareStandings(ranking, a, b));
    rank.teams = ordered.map((row) => row.team);
    const rows = new Map(ordered.map((row) => [row.team, row]));
    const awards = rank.contest.awards?.get(rank.options.group) || [];
    let position = 0;
    let previous;
    let awardRank = 0;
    const podium = [];
    for (const team of rank.teams) {
        team.awards = [];
        if (team.isUnofficial || team.tag.includes(AWARD_EXEMPT_TAG)) {
            team.rank = 0;
            continue;
        }
        position++;
        const tied = previous && sameStanding(ranking, rows.get(previous), rows.get(team));
        team.rank = tied ? previous.rank : position;
        awardRank = rules?.medalSameScore === false ? position : team.rank;
        if (team.solvedProblemNum > 0) {
            team.awards = awards.filter((award) => awardRank >= award.minRank && awardRank <= award.maxRank)
                .map((award) => award.medalType);
            if (rules?.podiumEnabled && podium.length < 3) podium.push({ id: team.id, name: team.name.getOrDefault('zh-CN') });
        }
        previous = team;
    }
    // Recompute first solves within this board, using the same visible submission set.
    for (const problem of rank.contest.problems) problem.statistics.firstSolveSubmissions = [];
    for (const team of rank.teams) {
        for (const cell of team.problemStatistics) {
            cell.isFirstSolved = false;
            for (const submission of cell.submissions) submission.isFirstSolved = false;
            if (!rules?.firstSolve || (team.isUnofficial && !rules.unofficialFirstSolve)) continue;
            const solved = cell.submissions.find((submission) => submission.isSolved && submission.isAccepted());
            if (!solved) continue;
            const first = cell.problem.statistics.firstSolveSubmissions;
            if (!first.length || solved.timestamp < first[0].timestamp) first.splice(0, first.length, solved);
            else if (solved.timestamp === first[0].timestamp) first.push(solved);
        }
    }
    for (const problem of rank.contest.problems) {
        for (const submission of problem.statistics.firstSolveSubmissions) {
            submission.isFirstSolved = true;
            rank.teamsMap.get(submission.teamId).problemStatisticsMap.get(problem.id).isFirstSolved = true;
        }
    }
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('hydro-xcpcio-awards', { detail: { rules, podium } }));
    }
    return rank;
}
