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
import { add, clamp, clampLen, dist, easeInOut, fromAngle, lerp, minJerk, sub, unit, vec } from './geometry';
import type { Palette } from './palette';
import { type Block, type Line, type WordHit, findBlocks, findWords, focusMatcher, pickNext } from './reader';
import { type Control, HAND_TIP, type Rig } from './rig';
import type { Stickers } from './stickers';

/** A focus word of the current block, read once when the block was chosen (document coordinates). */
interface Word {
  hit: WordHit;
  doc: { x: number; y: number; width: number; height: number };
}

type Plan =
  | { kind: 'pause'; until: number }
  | { kind: 'travel'; goal: V; then: 'read' | 'look'; block?: Block; lines?: Line[]; words?: Word[] }
  | { kind: 'read'; block: Block; lines: Line[]; line: number; x: number; words: Word[] }
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
  /** Stop-and-go: the current burst along a minimum-jerk path (document space), or a freeze. */
  private burst: { from: V; to: V; t0: number; T: number } | null = null;
  /** Where the body rests during a freeze or a mood pose (document space). */
  private anchor: V | null = null;
  private stop: Stop | null = null;
  private pull: { side: 1 | -1; at: number; from: V; to: V } | null = null;
  private turnFrom = 0;
  pace: keyof typeof PACE = 'normal';
  private scanningOn = false;

  /** The agent is reading the DOM: ease out of the current burst, start no new one. */
  get scanning(): boolean {
    return this.scanningOn;
  }

  set scanning(on: boolean) {
    if (on && !this.scanningOn && this.burst) {
      // Come to rest a little ahead, on the soft spring — no brake.
      this.burst = null;
      this.anchor = this.rig.toDoc(add(this.rig.body, { x: this.rig.vel.x * 0.06, y: this.rig.vel.y * 0.06 }));
    }
    this.scanningOn = on;
  }
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
    this.burst = null;
    this.anchor = null;
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
    // The cached words of the current block are for the old focus: pick afresh.
    if (this.plan.kind === 'read' || this.plan.kind === 'travel') this.plan = { kind: 'pause', until: 0 };
    this.log({ op: `focus:${this.words.join(',')}` });
  }

  /** A command took over (approach, depart…): drop the plan and the pulls; look around for `pauseMs` after. */
  interrupt(now: number, pauseMs = 450): void {
    this.plan = { kind: 'pause', until: now + pauseMs };
    this.burst = null;
    this.anchor = null;
    this.stop = null;
    this.rig.gripRects = [];
    this.endPull();
    this.rig.feel(1, null);
    this.rig.feel(-1, null);
    this.stickers.returnAll(now);
  }

  onScroll(kind: 'cut' | 'walk', now: number): void {
    if (this.plan.kind === 'read' || this.plan.kind === 'travel') {
      this.plan = { kind: 'pause', until: now + (kind === 'cut' ? 500 : 300) };
      this.burst = null;
      this.anchor = null;
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
    const hold = this.settle(m, null);
    const since = now - this.moodAt;

    if (this.reducedMotion) return { target: here, k: 0, c: 0, vmax: 0, face: null, leap: false, hold: true };

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

    // Freeze between bursts: a soft spring to where it stopped, no brake.
    if (this.stop) {
      if (now < this.stop.until) return this.settle(m, this.faceForPlan(now));
      if (this.stop.feelSide) rig.feel(this.stop.feelSide, null);
      const atGoal = this.stop.atGoal;
      this.stop = null;
      if (atGoal) this.advance(now, s, pal);
    }

    const plan = this.plan;
    if (plan.kind === 'pause' || plan.kind === 'look') {
      if (now < plan.until) return this.settle(m, this.faceForPlan(now));
      this.pickBlock(now, s);
    }

    const goal = this.goal();
    if (!goal) return this.settle(m, null);
    const goalView = rig.toView(goal);
    // While the agent reads the DOM the page may freeze for a moment: stand still then,
    // so a stall looks like a pause, not like a hitch in the middle of a move.
    if (!this.burst && this.scanning) return this.settle(m, this.faceForPlan(now));
    if (!this.burst) {
      // Next burst: 50–110 px toward the goal, on a minimum-jerk path — it
      // starts and stops with zero acceleration, so nothing jolts.
      const step = clampLen(vec(0, 0), sub(goalView, here), (60 + Math.random() * 70) * s);
      const length = Math.hypot(step.x, step.y);
      const T = (clamp(length / (240 * s), 0.26, 0.6) * 1000) / m;
      this.burst = { from: rig.toDoc(here), to: rig.toDoc(add(here, step)), t0: now, T };
      this.anchor = null;
    }
    const b = this.burst;
    const tau = (now - b.t0) / b.T;
    const toView = rig.toView(b.to);
    if (tau >= 1 && dist(here, toView) < 3 * s) {
      this.burst = null;
      this.anchor = b.to;
      const atGoal = dist(here, goalView) < 6 * s;
      const reading = this.plan.kind === 'read';
      // Now and then a front leg feels ahead during the freeze.
      const feelSide: 1 | -1 | 0 = !atGoal && Math.random() < 0.2 ? (Math.random() < 0.5 ? 1 : -1) : 0;
      if (feelSide) rig.feel(feelSide, add(here, mul2(unit(sub(goalView, here)), 55 * s)));
      const freeze = reading ? 160 + Math.random() * 200 : 200 + Math.random() * 260;
      this.stop = { until: now + freeze / m, feelSide, atGoal };
      if (atGoal) this.arrive(now, s, pal);
      return this.settle(m, this.faceForPlan(now));
    }
    const along = rig.toView(lerp(b.from, b.to, minJerk(tau)));
    // A stiff spring tracks the smooth path.
    return { target: along, k: 600 * m * m, c: 46 * m, vmax: 1200 * m, face: null, leap: false, hold: false };
  }

  /** Rest at the anchor (taken where the body is when first asked) on a soft spring. */
  private settle(m: number, face: number | null): Control {
    this.anchor ??= this.rig.toDoc(this.rig.body);
    return {
      target: this.rig.toView(this.anchor),
      k: 300 * m * m,
      c: 34 * m,
      vmax: 600 * m,
      face,
      leap: false,
      hold: false,
    };
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
    // The block's focus words, read from the layout once, here — never per step.
    const words: Word[] =
      this.matcher && this.tear
        ? findWords(next.el, this.matcher, innerHeight, 12).map(hit => ({
            hit,
            doc: { x: hit.rect.x + scrollX, y: hit.rect.y + scrollY, width: hit.rect.width, height: hit.rect.height },
          }))
        : [];
    // Feet snap to these instead of asking the page what is under them.
    this.rig.gripRects = [
      ...lines.map(l => ({ x: l.x0, y: l.y - 8, width: l.x1 - l.x0, height: 16 })),
      ...words.map(w => w.doc),
    ];
    // A block picked for a focus word: go straight to that word, not to the start of its line.
    const first = words[0];
    const goal = first
      ? { x: first.doc.x - 6 - HAND_TIP * s, y: first.doc.y + first.doc.height / 2 }
      : { x: lines[0].x0 + 4 - HAND_TIP * s, y: lines[0].y };
    this.plan = { kind: 'travel', goal, then: 'read', block: next, lines, words };
    this.log({ op: 'read', point: this.rig.toView({ x: lines[0].x0, y: lines[0].y }), body: { ...this.rig.body } });
    void now;
  }

  /** The current goal was reached. */
  private arrive(now: number, s: number, pal: Palette): void {
    const p = this.plan;
    if (p.kind === 'travel') {
      if (p.then === 'read' && p.block && p.lines) {
        // Start reading where it arrived: on the focus word's line, or at the top.
        const at = p.goal.x + HAND_TIP * s;
        const lines = p.lines;
        const nearest = lines.reduce(
          (best, l, i) => (Math.abs(l.y - p.goal.y) < Math.abs(lines[best].y - p.goal.y) ? i : best),
          0,
        );
        const onWord = (p.words ?? []).length > 0;
        this.plan = {
          kind: 'read',
          block: p.block,
          lines: p.lines,
          line: onWord ? nearest : 0,
          x: onWord ? at : p.lines[0].x0 + 4,
          words: p.words ?? [],
        };
        // Arrived on the word itself: the hands are on it now.
        const cursor = this.rig.toView({ x: this.plan.x, y: p.goal.y });
        this.rig.handMode = { kind: 'read', p: cursor };
        if (onWord && this.tear && this.mood !== 'acting') this.maybeTear(now, cursor, s, pal);
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
    const x = p.words
      .filter(w => Math.abs(w.doc.y + w.doc.height / 2 - line.y) < w.doc.height * 0.6)
      .map(w => w.doc.x)
      .filter(wx => wx > p.x + 20)
      .sort((a, b) => a - b)[0];
    return x === undefined ? null : x - 6;
  }

  private maybeTear(now: number, cursor: V, s: number, pal: Palette): void {
    if (!this.matcher || this.pull || this.stickers.live >= 3) return;
    const p = this.plan;
    if (p.kind !== 'read') return;
    // The focus word nearest the hands, within a leg's reach (from the block's cached words).
    const hit = p.words
      .map(w => ({
        h: { ...w.hit, rect: { ...w.hit.rect, x: w.doc.x - scrollX, y: w.doc.y - scrollY } },
        c: this.rig.toView({ x: w.doc.x + w.doc.width / 2, y: w.doc.y + w.doc.height / 2 }),
      }))
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
