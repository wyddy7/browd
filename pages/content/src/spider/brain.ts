/**
 * What the spider does when no command drives it: behaviour by the agent's
 * mood. The rig only moves; this decides where to and how.
 *
 * - thinking (a model call runs): reads the page the way a spider moves —
 *   short bursts and freezes, a front leg feeling ahead — preferring blocks
 *   that mention the focus words (the task and the current subgoal), and
 *   tears those words out of the page as it goes;
 * - acting: the same reading, no tearing (an approach is about to come);
 * - waiting (a page loads): still, a front leg tapping;
 * - asking (the agent waits for the user): turned to the side panel, front
 *   legs up, hands waving;
 * - done: a quick turn on the spot; failed: a droop. Then it can leave.
 */
import type { SpiderMood, SpiderPoint as V } from '@extension/shared';
import { add, clamp, clampLen, dist, easeInOut, fromAngle, lerp, sub, unit, vec } from './geometry';
import type { Palette } from './palette';
import { type Block, type Line, findBlocks, findWords, focusMatcher, pickNext } from './reader';
import { type Control, HAND_TIP, type Rig } from './rig';
import type { Stickers } from './stickers';

type Plan =
  | { kind: 'pause'; until: number }
  | { kind: 'travel'; goal: V; then: 'read' | 'look'; block?: Block; lines?: Line[] }
  | { kind: 'read'; block: Block; lines: Line[]; line: number; x: number }
  | { kind: 'look'; until: number; base: number };

interface Stop {
  until: number;
  feelSide: 1 | -1 | 0;
  /** This freeze is at the goal (not a pause on the way): the plan moves on after it. */
  atGoal: boolean;
}

export interface BrainLog {
  (e: { op: string; point?: V; body?: V }): void;
}

const PACE = { calm: 0.72, normal: 1, fast: 1.4 } as const;

export class Brain {
  mood: SpiderMood | null = null;
  private moodAt = 0;
  private matcher: RegExp | null = null;
  private words: string[] = [];
  private plan: Plan = { kind: 'pause', until: 0 };
  private visited = new WeakSet<Element>();
  /** Stop-and-go: the current waypoint (document space) or a freeze. */
  private waypoint: V | null = null;
  private stop: Stop | null = null;
  private pull: { side: 1 | -1; at: number; from: V; to: V } | null = null;
  private turnFrom = 0;
  pace: keyof typeof PACE = 'normal';
  tear = true;

  constructor(
    private readonly rig: Rig,
    private readonly stickers: Stickers,
    private readonly log: BrainLog,
    private readonly reducedMotion: boolean,
  ) {}

  setMood(mood: SpiderMood, now: number): void {
    if (mood === this.mood) return;
    this.mood = mood;
    this.moodAt = now;
    this.stop = null;
    this.waypoint = null;
    this.endPull();
    this.rig.feel(1, null);
    this.rig.feel(-1, null);
    if (mood !== 'thinking' && mood !== 'acting') this.stickers.returnAll(now);
    if (mood === 'done') this.turnFrom = this.rig.heading;
    if (mood === 'asking') this.rig.handMode = { kind: 'wave' };
    else if (this.rig.handMode.kind === 'wave') this.rig.handMode = { kind: 'rest' };
    this.log({ op: `mood:${mood}`, body: { ...this.rig.body } });
  }

  setFocus(words: string[]): void {
    this.words = words.slice(0, 12);
    this.matcher = focusMatcher(this.words);
    this.log({ op: `focus:${this.words.join(',')}` });
  }

  /** A command took over (approach, depart…): drop the plan and the pulls; look around for `pauseMs` after. */
  interrupt(now: number, pauseMs = 450): void {
    this.plan = { kind: 'pause', until: now + pauseMs };
    this.waypoint = null;
    this.stop = null;
    this.endPull();
    this.rig.feel(1, null);
    this.rig.feel(-1, null);
    this.stickers.returnAll(now);
  }

  onScroll(kind: 'cut' | 'walk', now: number): void {
    if (this.plan.kind === 'read' || this.plan.kind === 'travel') {
      this.plan = { kind: 'pause', until: now + (kind === 'cut' ? 500 : 300) };
      this.waypoint = null;
      this.stop = null;
    }
  }

  /** True once the done/failed gesture has played (the spider may leave). */
  gestureDone(now: number): boolean {
    return (this.mood !== 'done' && this.mood !== 'failed') || now - this.moodAt > 750;
  }

  control(now: number, pal: Palette): Control {
    const m = PACE[this.pace] ?? 1;
    const s = this.rig.size;
    const here = this.rig.body;
    const hold: Control = { target: here, k: 0, c: 0, vmax: 0, face: null, leap: false, hold: true };
    const since = now - this.moodAt;

    if (this.reducedMotion) return hold;

    if (this.mood === 'done') {
      // A quick full turn on the spot, then still.
      const t = clamp(since / 650, 0, 1);
      return { ...hold, face: this.turnFrom + Math.PI * 2 * easeInOut(t) };
    }
    if (this.mood === 'failed') {
      this.rig.crouch = Math.min(1, this.rig.crouch + 0.05);
      return hold;
    }
    if (this.mood === 'waiting') {
      // Still, a front leg tapping every half second.
      const phase = (since % 520) / 520;
      const side: 1 | -1 = Math.floor(since / 1040) % 2 ? 1 : -1;
      if (phase < 0.3) this.rig.feel(side, add(this.rig.frontFoot(side), fromAngle(this.rig.heading, 6 * s)));
      else this.rig.feel(side, null);
      return hold;
    }
    if (this.mood === 'asking') {
      // Turned toward the side panel at the right edge, front legs raised.
      const up = (side: 1 | -1) => add(here, fromAngle(-0.5 + side * 0.45, 70 * s));
      this.rig.feel(1, up(1));
      this.rig.feel(-1, up(-1));
      return { ...hold, face: 0 };
    }
    return this.read(now, m, s, pal);
  }

  // ---------- reading ----------

  private read(now: number, m: number, s: number, pal: Palette): Control {
    const rig = this.rig;
    const here = rig.body;
    this.updatePull(now);

    // Freeze between bursts.
    if (this.stop) {
      if (now < this.stop.until) {
        return { target: here, k: 0, c: 0, vmax: 0, face: this.faceForPlan(now), leap: false, hold: true };
      }
      if (this.stop.feelSide) rig.feel(this.stop.feelSide, null);
      const atGoal = this.stop.atGoal;
      this.stop = null;
      if (atGoal) this.advance(now, s, pal);
    }

    const plan = this.plan;
    if (plan.kind === 'pause' || plan.kind === 'look') {
      if (now < plan.until) {
        return { target: here, k: 0, c: 0, vmax: 0, face: this.faceForPlan(now), leap: false, hold: true };
      }
      this.pickBlock(now, s);
    }

    const goal = this.goal();
    if (!goal) return { target: here, k: 0, c: 0, vmax: 0, face: null, leap: false, hold: true };
    const goalView = rig.toView(goal);
    if (!this.waypoint) {
      // Next burst: 50–110 px toward the goal.
      const step = clampLen(vec(0, 0), sub(goalView, here), (50 + Math.random() * 60) * s);
      this.waypoint = rig.toDoc(add(here, step));
    }
    const wpView = rig.toView(this.waypoint);
    const speed = Math.hypot(rig.vel.x, rig.vel.y);
    if (dist(here, wpView) < 4 * s && speed < 40) {
      this.waypoint = null;
      const atGoal = dist(here, goalView) < 6 * s;
      // Freeze; now and then a front leg feels ahead.
      const reading = this.plan.kind === 'read';
      const feelSide: 1 | -1 | 0 = !atGoal && Math.random() < 0.35 ? (Math.random() < 0.5 ? 1 : -1) : 0;
      if (feelSide) rig.feel(feelSide, add(here, mul2(unit(sub(goalView, here)), 55 * s)));
      // Freezes: short while reading along a line, longer between moves elsewhere.
      const freeze = reading ? 160 + Math.random() * 220 : 220 + Math.random() * 320;
      this.stop = { until: now + freeze / m, feelSide, atGoal };
      if (atGoal) this.arrive(now, s, pal);
      return { target: here, k: 0, c: 0, vmax: 0, face: this.faceForPlan(now), leap: false, hold: true };
    }
    return { target: wpView, k: 240 * m * m, c: 26 * m, vmax: 600 * m * s, face: null, leap: false, hold: false };
  }

  private goal(): V | null {
    const p = this.plan;
    if (p.kind === 'travel') return p.goal;
    if (p.kind === 'read') {
      const line = p.lines[p.line];
      return { x: p.x - HAND_TIP * this.rig.size, y: line.y };
    }
    return null;
  }

  private faceForPlan(now: number): number | null {
    const p = this.plan;
    if (p.kind === 'read') return 0;
    if (p.kind === 'look') return p.base + Math.sin(now / 260) * 0.35;
    return null;
  }

  private pickBlock(now: number, s: number): void {
    const blocks = findBlocks(innerWidth, innerHeight);
    let next = pickNext(blocks, this.rig.body, this.visited, this.matcher);
    if (!next && blocks.length) {
      this.visited = new WeakSet();
      next = pickNext(blocks, this.rig.body, this.visited, this.matcher);
    }
    if (!next) {
      // Nothing readable on screen: a short wander.
      const a = this.rig.heading + (Math.random() - 0.5) * 2.4;
      const p = add(this.rig.body, fromAngle(a, (60 + Math.random() * 100) * s));
      const goal = this.rig.toDoc({ x: clamp(p.x, 60, innerWidth - 60), y: clamp(p.y, 60, innerHeight - 60) });
      this.plan = { kind: 'travel', goal, then: 'look' };
      return;
    }
    this.visited.add(next.el);
    const lines = next.lines.map(l => ({ x0: l.x0 + scrollX, x1: l.x1 + scrollX, y: l.y + scrollY }));
    this.plan = {
      kind: 'travel',
      goal: { x: lines[0].x0 + 4 - HAND_TIP * s, y: lines[0].y },
      then: 'read',
      block: next,
      lines,
    };
    this.log({ op: 'read', point: this.rig.toView({ x: lines[0].x0, y: lines[0].y }), body: { ...this.rig.body } });
    void now;
  }

  /** The current goal was reached. */
  private arrive(now: number, s: number, pal: Palette): void {
    const p = this.plan;
    if (p.kind === 'travel') {
      if (p.then === 'read' && p.block && p.lines) {
        this.plan = { kind: 'read', block: p.block, lines: p.lines, line: 0, x: p.lines[0].x0 + 4 };
      } else {
        this.plan = { kind: 'look', until: now + 600, base: this.rig.heading };
      }
      return;
    }
    if (p.kind === 'read') {
      const cursor = this.rig.toView({ x: p.x, y: p.lines[p.line].y });
      this.rig.handMode = { kind: 'read', p: cursor };
      if (this.tear && this.mood !== 'acting') this.maybeTear(now, cursor, s, pal);
    }
  }

  /** After a freeze while reading: move the cursor on, or to the next line, or finish. */
  private advance(now: number, s: number, pal: Palette): void {
    const p = this.plan;
    void pal;
    if (p.kind !== 'read') return;
    const line = p.lines[p.line];
    // A focus word further along this line: go straight to it.
    const ahead = this.nextFocusOnLine(p, line);
    if (ahead !== null) {
      p.x = ahead;
      return;
    }
    // Otherwise skim the start of the line, a few steps along it.
    const end = Math.min(line.x1 - 4, line.x0 + 300);
    if (p.x < end) {
      p.x = Math.min(end, p.x + (60 + Math.random() * 50) * s);
      return;
    }
    if (p.line + 1 < p.lines.length) {
      p.line++;
      p.x = p.lines[p.line].x0 + 4;
      return;
    }
    this.rig.handMode = { kind: 'rest' };
    this.plan = { kind: 'look', until: now + 500 + Math.random() * 400, base: this.rig.heading };
    this.log({ op: 'look', body: { ...this.rig.body } });
  }

  /** Document x just before the next focus word on this line, if there is one ahead of the cursor. */
  private nextFocusOnLine(p: Extract<Plan, { kind: 'read' }>, line: Line): number | null {
    if (!this.matcher || !this.tear || this.mood === 'acting') return null;
    const lineView = line.y - scrollY;
    const hit = findWords(p.block.el, this.matcher, innerHeight)
      .filter(h => Math.abs(h.rect.y + h.rect.height / 2 - lineView) < h.rect.height * 0.6)
      .map(h => h.rect.x + scrollX)
      .filter(x => x > p.x + 20)
      .sort((a, b) => a - b)[0];
    return hit === undefined ? null : hit - 6;
  }

  private maybeTear(now: number, cursor: V, s: number, pal: Palette): void {
    if (!this.matcher || this.pull || this.stickers.live >= 3) return;
    const p = this.plan;
    if (p.kind !== 'read') return;
    // The focus word nearest the hands, within a leg's reach.
    const hit = findWords(p.block.el, this.matcher, innerHeight)
      .map(h => ({ h, c: { x: h.rect.x + h.rect.width / 2, y: h.rect.y + h.rect.height / 2 } }))
      .filter(({ c }) => dist(c, this.rig.body) < 140 * s)
      .sort((a, b) => dist(a.c, cursor) - dist(b.c, cursor))[0]?.h;
    if (!hit) return;
    const c = { x: hit.rect.x + hit.rect.width / 2, y: hit.rect.y + hit.rect.height / 2 };
    // The front leg on the word's side does the pulling.
    const side: 1 | -1 = c.y >= this.rig.body.y ? 1 : -1;
    const fill = pal.stickers[Math.floor(Math.random() * pal.stickers.length)];
    if (!this.stickers.tear(hit, side, now, fill, pal.stickerText, Math.random() < 0.65)) return;
    const away = unit(sub(c, this.rig.body));
    this.pull = { side, at: now, from: c, to: add(add(c, mul2(away, 38 * s)), { x: 0, y: -22 * s }) };
    this.log({ op: 'tear', point: c, body: { ...this.rig.body } });
  }

  /** The pulling leg: reach the word, then draw it out. */
  private updatePull(now: number): void {
    const pull = this.pull;
    if (!pull) return;
    const t = now - pull.at;
    if (t > 900 || !this.stickers.pulling()) {
      this.endPull();
      return;
    }
    const point = t < 150 ? pull.from : lerp(pull.from, pull.to, easeInOut(clamp((t - 150) / 500, 0, 1)));
    this.rig.feel(pull.side, point);
  }

  private endPull(): void {
    if (this.pull) this.rig.feel(this.pull.side, null);
    this.pull = null;
  }
}

const mul2 = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
