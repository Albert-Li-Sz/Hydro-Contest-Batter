/*
 * Port of ICPC Tools v2.6.1331 FireworksPresentation, SinglePhotoPresentation ("Photo and caption")
 * and TeamJudgePresentation ("Team Judgements").
 */
import { Animator, Movement } from "./animator.js";
import { javaFont, stringWidth, drawString } from "./java-text.js";
import { Color, JColor, fillRect, scaleImage } from "./java-graphics.js";
import { JavaPresentation } from "./presentation-java.js";
import { problemColor } from "./pres-charts.js";
import { shadedRect, shadedPaint } from "./pres-scoreboard.js";
import { ICPCColors } from "./java-graphics.js";

const trunc = Math.trunc, f32 = Math.fround;
const BITS = 10000, BIT_MAX = 300, RU = 90, RV = 50;

/** FireworksPresentation: the original pixel-buffer particle effect. */
export class Fireworks extends JavaPresentation {
  constructor() {
    super();
    this.bit = { px: new Float64Array(BITS), py: new Float64Array(BITS), vx: new Float64Array(BITS), vy: new Float64Array(BITS),
      sx: new Int32Array(BITS), sy: new Int32Array(BITS), l: new Int32Array(BITS), f: new Int32Array(BITS), p: new Int32Array(BITS), c: new Int32Array(BITS) };
    this.nextTime = 0;
  }
  setSize(w, h) {
    super.setSize(w, h);
    this.pix0 = new Int32Array(w * h);
    this.pixls2 = w * h - w * 2;
    this.bit.f.fill(0);
    this.canvas = document.createElement("canvas");
    this.canvas.width = w;
    this.canvas.height = h;
    this.imageData = this.canvas.getContext("2d").createImageData(w, h);
  }
  aboutToShow() {
    this.nextTime = 0;
  }
  bitSet(i, j, k) {
    const index = i + j * this.width;
    if (index >= 0 && index < this.pix0.length) this.pix0[index] = k;
  }
  incrementTimeMs() {
    const time = this.getTimeMs(), b = this.bit;
    if (time < this.nextTime) return;
    this.nextTime = time + 1000;
    const mx = trunc(Math.random() * (this.width - 100)) + 50, my = trunc(Math.random() * (this.height - 200)) + 50;
    const color = (trunc(Math.random() * 256) << 16) | (trunc(Math.random() * 256) << 8) | trunc(Math.random() * 256) | 0xff000000;
    let k1 = 0;
    for (let l1 = 0; l1 < BITS; l1++) {
      if (b.f[l1] !== 0) continue;
      b.px[l1] = mx;
      b.py[l1] = my;
      const d = Math.random() * 6.28, d1 = Math.random();
      b.vx[l1] = Math.sin(d) * d1;
      b.vy[l1] = Math.cos(d) * d1;
      b.l[l1] = trunc(Math.random() * 100) + 100;
      b.p[l1] = trunc(Math.random() * 3);
      b.c[l1] = color;
      b.sx[l1] = mx;
      b.sy[l1] = this.height - 5;
      b.f[l1] = 2;
      if (++k1 === BIT_MAX) break;
    }
  }
  rend() {
    const b = this.bit;
    for (let k = 0; k < BITS; k++) {
      if (b.f[k] === 1) {
        b.vy[k] += Math.random() / 50;
        b.px[k] += b.vx[k];
        b.py[k] += b.vy[k];
        b.l[k]--;
        if (b.l[k] === 0 || b.px[k] < 0 || b.py[k] < 0 || b.px[k] > this.width || b.py[k] > this.height - 3) {
          b.c[k] = 0xff000000;
          b.f[k] = 0;
        } else if (b.p[k] === 0) {
          if (trunc(Math.random() * 2) === 0) this.bitSet(trunc(b.px[k]), trunc(b.py[k]), -1);
        } else this.bitSet(trunc(b.px[k]), trunc(b.py[k]), b.c[k]);
      } else if (b.f[k] === 2) {
        b.sy[k] -= 10;
        if (b.sy[k] <= b.py[k]) b.f[k] = 1;
        if (trunc(Math.random() * 20) === 0) this.bitSet(b.sx[k] + trunc(Math.random() * 2), b.sy[k] + trunc(Math.random() * 10), -1);
      }
    }
  }
  paint(g) {
    const pix = this.pix0, w = this.width, out = this.imageData.data;
    for (let j = 0; j < this.pixls2; j++) {
      const k = pix[j], l = pix[j + 1], i1 = pix[j + w], j1 = pix[j + w + 1];
      let i = (k & 0xff0000) >> 16;
      const k1 = (((((l & 0xff0000) >> 16) - i) * RU) >> 8) + i;
      i = (k & 0xff00) >> 8;
      const l1 = (((((l & 0xff00) >> 8) - i) * RU) >> 8) + i;
      i = k & 0xff;
      const i2 = ((((l & 0xff) - i) * RU) >> 8) + i;
      i = (i1 & 0xff0000) >> 16;
      const j2 = (((((j1 & 0xff0000) >> 16) - i) * RU) >> 8) + i;
      i = (i1 & 0xff00) >> 8;
      const k2 = (((((j1 & 0xff00) >> 8) - i) * RU) >> 8) + i;
      i = i1 & 0xff;
      const l2 = ((((j1 & 0xff) - i) * RU) >> 8) + i;
      const r = (((j2 - k1) * RV) >> 8) + k1, gg = (((k2 - l1) * RV) >> 8) + l1, bb = (((l2 - i2) * RV) >> 8) + i2;
      const a = Math.min(255, trunc((r + gg + bb) / f32(3.5)));
      pix[j] = (a << 24) | (r << 16) | (gg << 8) | bb;
    }
    this.rend();
    for (let j = 0; j < pix.length; j++) {
      const v = pix[j], o = j * 4;
      out[o] = (v >> 16) & 0xff;
      out[o + 1] = (v >> 8) & 0xff;
      out[o + 2] = v & 0xff;
      out[o + 3] = (v >>> 24) & 0xff;
    }
    this.canvas.getContext("2d").putImageData(this.imageData, 0, 0);
    g.drawImage(this.canvas, 0, 0);
  }
}

/** SinglePhotoPresentation: the first program image, fitted, with the item's text as caption. */
export class SinglePhoto extends JavaPresentation {
  paint(g) {
    const url = this.item?.images?.[0], img = this.image(url);
    if (img && (!this.scaled || this.scaledFrom !== img)) {
      this.scaled = scaleImage(img, this.width, this.height);
      this.scaledFrom = img;
    }
    if (img && this.scaled) g.drawImage(this.scaled, trunc((this.width - this.scaled.width) / 2), trunc((this.height - this.scaled.height) / 2));
    const s = this.item?.text, fm = javaFont(55, true);
    if (s) drawString(g, fm, s, trunc((this.width - stringWidth(g, fm, s)) / 2), this.height - 20 - fm.descent, Color.WHITE.css());
  }
}

const ROWS = 3, COLUMNS = 7, BORDER = 5;

/** TeamJudgePresentation: a grid of live submissions with team logos. */
export class TeamJudgements extends JavaPresentation {
  constructor() {
    super();
    this.records = [];
    this.lastPosition = 0;
    this.seen = null;
  }
  setSize(w, h) {
    super.setSize(w, h);
    const size = f32(f32(f32(h * 36) * f32(0.06)) / 96);
    // ShadedRectangle's static status font is unset in a standalone client, so cube text uses this font too.
    this.titleFont = javaFont(f32(size * f32(1.2)), true, true);
  }
  aboutToShow() {
    this.records = [];
    const contest = this.getContest(), subs = contest.getAllSubmissions();
    this.seen = new Set(subs.map((s) => s.index));
    if (!contest.isFrozen(this.getTimeMs())) for (const s of subs) if (s.status === "SUBMITTED") this.handleSubmission(s);
    this.updateTargets(true);
  }
  handleSubmission(submission) {
    for (const sr of this.records)
      if (sr.submission.index === submission.index) {
        sr.submission = submission;
        return;
      }
    if (this.records.length >= ROWS * COLUMNS) return;
    // The next free cell: a slow judgement still holds its cell, and two submissions in one cell covered each other.
    const used = new Set(this.records.map((sr) => sr.position));
    let position = this.lastPosition;
    for (let k = 0; k < ROWS * COLUMNS && used.has(position); k++) position = (position + 1) % (ROWS * COLUMNS);
    const sr = { submission, position, anim: new Animator(0, new Movement(0.5, 1)), fullAge: 0, actionAge: 0, action: null };
    this.lastPosition = (position + 1) % (ROWS * COLUMNS);
    const problem = this.getContest().getProblems()[submission.problemIndex];
    sr.text = `${problem?.label} - ${Math.floor(submission.contestTime / 60000)}`;
    sr.logoUrl = submission.team?.logo;
    this.records.push(sr);
    this.updateTargets(false);
  }
  incrementTimeMs(dt) {
    const contest = this.getContest(), all = contest.getAllSubmissions(), frozen = contest.isFrozen(this.getTimeMs());
    for (const sr of this.records) if (all[sr.submission.index]) sr.submission = all[sr.submission.index];
    if (this.seen) for (const s of all) if (!this.seen.has(s.index)) this.seen.add(s.index), this.handleSubmission(s);
    const remove = [];
    for (const sr of this.records) {
      sr.anim.incrementTimeMs(dt);
      sr.fullAge += dt;
      if (sr.action == null) {
        if (!frozen && sr.submission.status !== "SUBMITTED") {
          sr.actionAge += dt;
          const solved = sr.submission.status === "SOLVED";
          if (solved && sr.actionAge > 8000) sr.action = "MOVE_UP";
          else if (!solved && sr.actionAge > 5000) sr.action = "MOVE_DOWN";
          if (sr.action != null) sr.actionAge = 0;
        } else if (frozen && sr.fullAge > 7000) sr.action = "MOVE_OUT";
      } else sr.actionAge += dt;
      if ((sr.action === "MOVE_UP" || sr.action === "MOVE_OUT") && sr.actionAge > 12000) remove.push(sr);
      else if (sr.action === "MOVE_DOWN" && sr.actionAge > 9000) remove.push(sr);
    }
    this.records = this.records.filter((sr) => !remove.includes(sr));
    this.updateTargets(false);
  }
  updateTargets(force) {
    for (const sr of this.records) {
      const target = sr.action === "MOVE_UP" ? -2 : sr.action === "MOVE_DOWN" ? 2 : 0;
      if (force) sr.anim.reset(target);
      else sr.anim.setTarget(target);
    }
  }
  paint(g) {
    const { width, height } = this, cw = trunc(width / COLUMNS), ch = trunc(height / ROWS);
    for (const sr of this.records.slice()) {
      const x = trunc((width * (sr.position % COLUMNS)) / COLUMNS), y = trunc((height * trunc(sr.position / COLUMNS)) / ROWS);
      g.save();
      g.beginPath();
      g.rect(x + 1, y + 1, cw - 2, ch - 2);
      g.clip();
      g.translate(x, y + trunc((sr.anim.getValue() * height) / 3.0));
      if (sr.action === "MOVE_DOWN") g.globalAlpha = f32(Math.min(1.0, Math.max(0.1, 1.0 - ((sr.actionAge - 5000) * 2.0) / 5000)));
      else if (sr.action === "MOVE_OUT") g.globalAlpha = Math.max(0, f32(1.0 - sr.actionAge / 2000));
      this.paintSubmission(g, sr, cw, ch);
      g.restore();
    }
  }
  paintSubmission(g, sr, cw, ch) {
    const c = problemColor(this.getContest().getProblems()[sr.submission.problemIndex]);
    fillRect(g, 0, 0, cw, ch, new JColor(c.r, c.g, c.b, 127));
    const team = sr.submission.team;
    if (!team) return;
    const img = this.logo(sr);
    if (img) g.drawImage(img, trunc(cw / 2) - trunc(img.width / 2), trunc(ch / 2) - trunc(img.height / 2));
    const cubeWidth = trunc(cw / 2.0), cubeHeight = trunc(ch / 8.0), s = sr.submission;
    const paint = shadedPaint(g, cubeHeight, s.status, this.getContest().isRecentSubmission(s, Date.now()), s.firstToSolve, 0);
    shadedRect(g, trunc(cw / 2) - trunc(cubeWidth / 2), ch - cubeHeight - BORDER, cubeWidth, cubeHeight, paint,
      s.firstToSolve ? ICPCColors.SOLVED_COLOR : null, sr.text, { dialog: true });
    const name = team.displayName || team.name, fm = this.titleFont;
    drawString(g, fm, name, trunc(cw / 2) - trunc(stringWidth(g, fm, name) / 2), BORDER + fm.ascent, Color.WHITE.css());
  }
  logo(sr) {
    const w = trunc((this.width * 0.85) / COLUMNS), h = trunc((this.height * 0.6) / ROWS), img = this.image(sr.logoUrl);
    if (!img) return null;
    if (!sr.logo || sr.logoFrom !== img) {
      sr.logo = scaleImage(img, w, h);
      sr.logoFrom = img;
    }
    return sr.logo;
  }
}
