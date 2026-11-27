/*
 * Registry of ICPC Tools presentation ports. The view keeps one instance per program item and
 * drives it with PresentationWindowImpl timing (JavaPresentation.frame).
 */
import { ContestView } from "./java-contest.js";
import { TileScoreboard, TileRankScoreboard, TileListScoreboard } from "./pres-tiles.js";
import { GroupLeaderboard, AllGroupsLeaderboard, Timeline, Scoreboard, Leaderboard, FirstToSolve } from "./pres-scoreboard.js";
import * as charts from "./pres-charts.js";
import { ProblemSummaryPresentation, ProblemColorsPresentation } from "./pres-problems.js";
import { OrgLogoWall, OrgLogoFade, OrgLogoSlide } from "./pres-logos.js";
import { PolarCountdown } from "./pres-clock.js";
import { TeamIntro, World, GroupMap, BalloonMap } from "./pres-map.js";
import { ContestFloor, BalloonFloor } from "./pres-floor.js";
import { Fireworks, SinglePhoto, TeamJudgements } from "./pres-misc.js";

const FACTORIES = {
  "scoreboard:": () => new Scoreboard(),
  "leaders:": () => new Leaderboard(),
  "first-solves:": () => new FirstToSolve(),
  "tiles:standings": () => new TileScoreboard(),
  "tiles:rank": () => new TileRankScoreboard(),
  "tiles:list": () => new TileListScoreboard(),
  "groups:group": () => new GroupLeaderboard(),
  "groups:all": () => new AllGroupsLeaderboard(),
  "timeline:": () => new Timeline(),
  "chart:problems": () => new charts.ProblemSummaryChart(),
  "problems:summary": () => new ProblemSummaryPresentation(),
  "problems:colors": () => new ProblemColorsPresentation(),
  "logo-wall:wall": () => new OrgLogoWall(),
  "logo-wall:fade": () => new OrgLogoFade(),
  "logo-wall:slide": () => new OrgLogoSlide(),
  "countdown:polar": () => new PolarCountdown(),
  "world:orgs": () => new World(),
  "world:groups": () => new GroupMap(),
  "world:submissions": () => new BalloonMap(),
  "team-intro:": () => new TeamIntro(),
  "floor:floor": () => new ContestFloor(),
  "floor:balloons": () => new BalloonFloor(),
  "fireworks:": () => new Fireworks(),
  "photos:single": () => new SinglePhoto(),
  "queue:teams": () => new TeamJudgements(),
  "chart:languages": () => new charts.LanguageSummaryChart(),
  "chart:total": () => new charts.TotalProblemsChart(),
  "chart:score": () => new charts.ScoreboardChart(),
  "chart:judgement-time": () => new charts.JudgementChart(),
  "chart:queue-depth": () => new charts.JudgeQueueDepthChart(),
  "chart:comparison": () => new charts.ProblemComparisonChart(),
  "chart:problem-detail": () => new charts.ProblemDetailChart(),
};

export function portKey(item, variant) {
  const key = `${item.type}:${variant}`;
  return FACTORIES[key] ? key : FACTORIES[`${item.type}:`] ? `${item.type}:` : null;
}

export class PortHost {
  constructor(image) {
    this.image = image;
    this.key = null;
    this.instance = null;
  }
  /** Returns false when the item has no port. */
  render(ctx, data, item, variant, { width, height, now, elapsed, words, scale = 1 }) {
    const key = portKey(item, variant);
    if (!key) return false;
    const contest = new ContestView(data, words);
    if (this.key !== key || this.scale !== scale || this.instance?.width !== width || this.instance?.height !== height) {
      this.key = key;
      this.scale = scale;
      this.instance = FACTORIES[key]();
      // HydroXCPCIO: a screen device's zoom shows fewer, larger rows on the scoreboard family.
      if (typeof this.instance.teamsPerScreen === "number" && scale !== 1)
        this.instance.teamsPerScreen = Math.max(4, Math.round(this.instance.teamsPerScreen / scale));
      this.instance.image = this.image;
      this.instance.words = words;
      this.instance.item = item;
      this.instance.setContest(contest);
      this.instance.init();
      this.instance.setSize(width, height);
    }
    this.instance.words = words;
    this.instance.item = item;
    this.instance.setContest(contest);
    this.instance.frame(ctx, now, elapsed);
    return true;
  }
}
