import { compareStandings, sameStanding } from '../resolver/public/js/standings.js';
import { awardPlaces, trophyWinners } from '../resolver/public/js/trophies.js';

// Reserved team tag understood by the pinned XCPCIO engine extension.
export const AWARD_EXEMPT_TAG = 'hydro:award-exempt';
/** `hydro:school:<n>`: which school a team counts for, also when the board may not show school names. */
export const SCHOOL_TAG = 'hydro:school:';
const schoolOf = (team) => team.tag.find((tag) => tag.startsWith(SCHOOL_TAG)) ?? team.organization ?? '';
const rankingRule = (tieBreak) => (tieBreak === 'icpc' || tieBreak === 'ccpc' ? tieBreak : 'hydro');

/** Apply the selected board's rules after the upstream engine scores visible submissions. */
export function applyAwardEligibility(rank) {
    const rules = rank.contest.medal?.[rank.options.group]?.hydroAwards;
    // The contest's ranking rule (lib/settings.ts TieBreak), the same one the resolver and the screens use.
    const ranking = { scoringMode: 'hydro', tieBreak: rankingRule(rules?.tieBreak) };
    const ordered = rank.teams.map((team) => ({ team, teamId: team.id, solved: team.solvedProblemNum,
        timeSeconds: team.penalty, lastSolutionTime: team.lastSolvedProblemStatistics?.solvedTimestampToMinute ?? -1,
        lastSolutionSeconds: team.lastSolvedProblemStatistics?.solvedTimestamp ?? -1,
        sortName: team.name.getOrDefault('zh-CN'),
        official: !team.isUnofficial && !team.tag.includes(AWARD_EXEMPT_TAG), school: schoolOf(team),
        lastAcceptMs: team.lastSolvedProblemStatistics ? team.lastSolvedProblemStatistics.solvedTimestamp * 1000 : null }));
    ordered.sort((a, b) => compareStandings(ranking, a, b));
    rank.teams = ordered.map((row) => row.team);
    const awards = rank.contest.awards?.get(rank.options.group) || [];
    const same = (a, b) => sameStanding(ranking, a, b);
    const places = awardPlaces(ordered, same);
    for (const row of ordered) {
        const team = row.team;
        const place = places.get(team.id);
        team.rank = row.official ? place.rank : 0;
        team.awards = [];
        if (!row.solved || (!row.official && !rules?.unofficialMedals)) continue;
        const awardRank = rules?.medalRanking === 'school' ? place.school : rules?.medalSameScore === false ? place.position : place.rank;
        team.awards = awards.filter((award) => awardRank >= award.minRank && awardRank <= award.maxRank
            && (row.official || String(award.medalType).toLowerCase() !== 'honorable')).map((award) => award.medalType);
    }
    const names = new Map(rank.teams.map((team) => [team.id, team.name.getOrDefault('zh-CN')]));
    const podium = rules?.podiumEnabled
        ? trophyWinners(ordered, { basis: rules.podiumBasis, tie: rules.podiumTie, names: rules.podiumNames }, same)
            .map((trophy) => ({ name: trophy.name, teams: trophy.teamIds.map((id) => names.get(id)) }))
        : [];
    // Recompute first solves within this board, using the same visible submission set.
    for (const problem of rank.contest.problems) problem.statistics.firstSolveSubmissions = [];
    for (const team of rank.teams) {
        for (const cell of team.problemStatistics) {
            cell.isFirstSolved = false;
            for (const submission of cell.submissions) submission.isFirstSolved = false;
            if (!rules?.firstSolve || (team.isUnofficial && !rules.unofficialFirstSolve)) continue;
            // An unlabelled column of the CCPC board holds a different problem in every row.
            if (rules.hiddenFrom !== undefined && Number(cell.problem.id) >= rules.hiddenFrom) continue;
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
        const special = rank.contest.medal?.all?.hydroSpecialAwards || [];
        window.dispatchEvent(new CustomEvent('hydro-xcpcio-awards', { detail: { rules, podium, special } }));
    }
    return rank;
}
