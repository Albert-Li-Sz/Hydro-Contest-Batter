/*
 * Read-only view of the public presentation data shaped like the ICPC Tools IContest API, so
 * presentation ports can follow the Java code line by line.
 */
const trunc = Math.trunc;
const STATUS = { solved: "SOLVED", failed: "FAILED", pending: "SUBMITTED" };

/** AbstractICPCPresentation.getTime(ms, floor) */
export function formatTime(ms, floor) {
  // Hydro: no 48-hour wrap, so multi-day contests show their full hour count.
  const ss = floor ? Math.floor(ms / 1000) : Math.ceil(ms / 1000), h = trunc(ss / 3600),
    m = trunc(Math.abs(ss) / 60) % 60, s = Math.abs(ss) % 60;
  return `${ms < 0 && h === 0 ? "-" : ""}${h}:${m < 10 ? "0" : ""}${m}:${s < 10 ? "0" : ""}${s}`;
}

export class ContestView {
  constructor(data, words = {}) {
    this.data = data || {};
    this.c = this.data.contest || { teams: [], problems: [], organizations: [], submissions: [] };
    this.words = words;
    this.teamById = new Map((this.c.teams || []).map((t) => [t.id, t]));
    this.orgById = new Map((this.c.organizations || []).map((o) => [o.id, o]));
    this.rowById = new Map((this.data.standings || []).map((r) => [r.teamId, r]));
    this.problemIndex = new Map((this.c.problems || []).map((p, i) => [p.id, i]));
  }
  getProblems() {
    return this.c.problems || [];
  }
  getOrderedTeams() {
    return (this.data.standings || []).map((r) => this.teamById.get(r.teamId)).filter(Boolean);
  }
  getNumTeams() {
    return this.getOrderedTeams().length;
  }
  getGroups() {
    return this.c.groups || [];
  }
  getOrganizationById(id) {
    return id == null ? null : this.orgById.get(id) || null;
  }
  getStanding(team) {
    const row = this.rowById.get(team.id) || {};
    return { rank: row.rank == null || row.rank === "" ? "" : String(row.rank), numSolved: row.solved || 0, time: row.time || 0 };
  }
  getResult(team, i) {
    const cell = this.data.results?.[team.id]?.[i];
    const n = cell?.attempts || 0;
    return {
      numSubmissions: n,
      numJudged: Math.max(0, n - (cell?.pending || 0)),
      contestTimeMin: cell?.time || 0,
      // Java appends the time when the result's contest time (ms) is positive.
      hasTime: cell?.time != null,
      status: n ? STATUS[cell.status] || "UNATTEMPTED" : "UNATTEMPTED",
      firstToSolve: Boolean(cell?.firstToSolve && cell.status === "solved"),
    };
  }
  /** IProblemSummary: pending/solved counts over all teams. */
  getProblemSummary(i) {
    let numPending = 0, numSolved = 0;
    // Hydro: a column past `hiddenFrom` (CCPC 新榜单模式) is no problem to count.
    if (i >= (this.data.hiddenFrom ?? Infinity)) return { numPending, numSolved };
    for (const cells of Object.values(this.data.results || {})) {
      const cell = cells?.[i];
      if (cell?.status === "pending") numPending += cell.pending || 1;
      else if (cell?.status === "solved") numSolved++;
    }
    return { numPending, numSolved };
  }
  getSubmissions() {
    return this.c.submissions || [];
  }
  getProblemIndex(id) {
    return this.problemIndex.get(id) ?? -1;
  }
  getLanguages() {
    return this.c.languages || [];
  }
  /** contest.getContestTimeOfLastEvent() */
  getContestTimeOfLastEvent() {
    return this.data.stats?.lastEventMs || 0;
  }
  /**
   * All public submissions in feed order (stats.submissions), with Java status names, the
   * Contest first-to-solve flag and judgement timing.
   */
  getAllSubmissions() {
    if (this.all) return this.all;
    const flat = this.data.stats?.submissions || [], teams = this.c.teams || [], out = [];
    for (let i = 0; i + 6 < flat.length; i += 7) {
      const code = flat[i + 3];
      out.push({
        index: out.length,
        team: teams[flat[i]],
        teamId: teams[flat[i]]?.id,
        problemIndex: flat[i + 1],
        contestTime: flat[i + 2],
        status: code === 0 ? "SOLVED" : code === 2 ? "SUBMITTED" : "FAILED",
        penalty: code === 1,
        languageIndex: flat[i + 4],
        judgeStart: flat[i + 5],
        judgeEnd: flat[i + 6],
      });
    }
    // Contest.calculateResultsAndStandings: first submission (by time) per problem decides FTS.
    // Hydro: from `hiddenFrom` on (CCPC 新榜单模式) a column is a position in each team's row, not a problem.
    const fts = [], hiddenFrom = this.data.hiddenFrom ?? Infinity;
    const sorted = out.filter((s) => s.team && s.contestTime >= 0 && s.contestTime < this.c.durationMs)
      .sort((a, b) => a.contestTime - b.contestTime || a.index - b.index);
    for (const s of sorted) {
      if (fts[s.problemIndex] !== undefined || s.team.unrank || s.problemIndex >= hiddenFrom) continue;
      if (s.status === "SOLVED") fts[s.problemIndex] = s.index;
      else if (s.status === "SUBMITTED") fts[s.problemIndex] = -1;
    }
    for (const s of out) s.firstToSolve = fts[s.problemIndex] === s.index;
    return (this.all = out);
  }
  /** ContestUtil.isRecent(contest, submission) */
  isRecentSubmission(s, now) {
    if (s.status === "SUBMITTED") return true;
    const start = this.startMs();
    return start !== null && s.contestTime > (now - start) * this.multiplier() - 5 * 60 * 1000;
  }
  /** IState.getStarted() / getEnded() */
  stateStarted() {
    const raw = this.data.clock?.started, t = typeof raw === "number" ? raw : Date.parse(raw);
    return Number.isFinite(t) ? t : null;
  }
  stateEnded() {
    return Boolean(this.data.clock?.ended);
  }
  getDurationMs() {
    return this.c.durationMs || 0;
  }
  getFreezeDurationMs() {
    return this.c.freezeDurationMs || 0;
  }
  startMs() {
    const raw = this.data.clock?.startTime ?? this.c.startTime, start = typeof raw === "number" ? raw : Date.parse(raw);
    return Number.isFinite(start) ? start : null;
  }
  multiplier() {
    return this.data.clock?.multiplier || 1;
  }
  /** IState.isFrozen(): the freeze has started and the scoreboard is not thawed. */
  isFrozen(now) {
    const start = this.startMs();
    if (!this.data.frozen || start === null || !(this.c.freezeDurationMs > 0)) return false;
    return (now - start) * this.multiplier() >= this.c.durationMs - this.c.freezeDurationMs;
  }
  /** State.getEnded() != null: only the feed's state decides, as in AbstractICPCPresentation. */
  isOver() {
    return Boolean(this.data.clock?.ended);
  }
  /** AbstractICPCPresentation.getContestTime() */
  getContestTime(now) {
    const start = this.startMs();
    if (start === null) return "";
    if (this.isOver(now)) return this.words.contestOver || "Contest is over";
    return formatTime((now - start) * this.multiplier(), true);
  }
  /** AbstractICPCPresentation.getRemainingTime() */
  getRemainingTime(now) {
    const start = this.startMs();
    if (start === null) return "";
    if (this.isOver(now)) return this.words.contestOver || "Contest is over";
    return formatTime((start - now) * this.multiplier() + this.c.durationMs, false);
  }
  /**
   * Contest.getRecent(team). v2.6.1331 indexes recent activity by submission id instead of team
   * id, so no team ever has recent activity; mirror that to keep tiles identical.
   */
  getRecent() {
    return null;
  }
  /** ContestUtil.isRecent(contest, result): pending, or judged within the last 5 contest minutes. */
  isRecentResult(r, now) {
    if (!r.numSubmissions) return false;
    if (r.status === "SUBMITTED") return true;
    const start = this.startMs();
    return start !== null && r.contestTimeMin * 60000 > (now - start) * this.multiplier() - 5 * 60 * 1000;
  }
}
