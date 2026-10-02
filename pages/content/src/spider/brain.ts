/**
 * What the spider does when no command drives it: behaviour by the agent's
 * mood. The rig only moves; this decides where to and how.
 *
 * Every move is a glide (`motion.ts`): it starts with the velocity the body
 * already has and ends at rest, with no jolt at either end. Stops happen only
 * where they mean something — on a focus word, at the end of what it read.
 *
 * - thinking (a model call runs): reads the page — glides to a block (in a
 *   slight arc), runs its hands along a line like a finger, preferring blocks
 *   that mention the focus words (the task and the current subgoal), stops on
 *   those words and tears them out;
 * - acting: the same reading, no tearing (an approach is about to come);
 * - waiting (a page loads): still, a front leg tapping;
 * - asking (the agent waits for the user): turned to the side panel, front
 *   legs up, hands waving;
 * - done: a quick turn on tiptoe; failed: a droop. Then it can leave.
 */
import type { SpiderMood, SpiderPoint as V } from '@extension/shared';
import { add, clamp, dist, easeInOut, fromAngle, lerp, sub, unit, vec } from './geometry';
import { type Glide, brake, glide, glideAt, moveTime } from './motion';
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
  | {
      kind: 'travel';
      goal: V;
      then: 'read' | 'look';
      block?: Block;
      lines?: Line[];
      words?: Word[];
      /** The walk lands on a focus word (and stops there) rather than at the start of a line. */
      onWord?: boolean;
      /** One heading for the whole walk, set when it starts: no turning mid-way. */
      face?: number;
    }
  | {
      kind: 'read';
      block: Block;
      line: Line;
      /** Document x of the reading point (the hands). */
      x: number;
      /** Where the current stroke along the line ends, and whether that is a focus word. */
      to: number;
      atWord: boolean;
      words: Word[];
      /** A stop on a focus word lasts until then. */
      restUntil: number;
    }
  | { kind: 'look'; until: number; base: number };

export interface BrainLog {
  (e: { op: string; point?: V; body?: V }): void;
}

const PACE = { calm: 0.72, normal: 1, fast: 1.4 } as const;
/** Reading speed along a line, px/s at size 1 — about a finger following text. */
const READ_SPEED = 100;
/** How far along a line it reads before moving on. */
const READ_SPAN = 300;

export class Brain {
  mood: SpiderMood | null = null;
  private moodAt = 0;
  private matcher: RegExp | null = null;
  private words: string[] = [];
  private plan: Plan = { kind: 'pause', until: 0 };
  private visited = new WeakSet<Element>();
  /** The move in progress (document space) and what it is for. */
  private move: Glide | null = null;
  private moveFor: 'travel' | 'read' | 'brake' = 'brake';
  /** Where the body rests between moves (document space). */
  private anchor: V | null = null;
  private pull: { side: 1 | -1; at: number; from: V; to: V } | null = null;
  private turnFrom = 0;
  /** Where the tapping front foot stands (view space) while waiting. */
  private tapBase: V | null = null;
  pace: keyof typeof PACE = 'normal';
  private scanningOn = false;

  /** The agent is reading the DOM: ease out of the current move, start no new one. */
  get scanning(): boolean {
    return this.scanningOn;
  }

  set scanning(on: boolean) {
    if (on && !this.scanningOn) this.easeOut(performance.now(), 280);
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
    this.tapBase = null;
    this.easeOut(now);
    this.endPull();
    this.rig.feel(1, null);
    this.rig.feel(-1, null);
    if (mood !== 'thinking' && mood !== 'acting') this.stickers.returnAll(now);
    if (mood === 'done') this.turnFrom = this.rig.heading;
    if (mood === 'asking') this.rig.handMode = { kind: 'wave' };
    else if (this.rig.handMode.kind === 'wave' || this.rig.handMode.kind === 'read')
      this.rig.handMode = { kind: 'rest' };
    this.log({ op: `mood:${mood}`, body: { ...this.rig.body } });
  }

  setFocus(words: string[]): void {
    this.words = words.slice(0, 12);
    this.matcher = focusMatcher(this.words);
    // The cached words of the current block are for the old focus: pick afresh.
    if (this.plan.kind === 'read' || this.plan.kind === 'travel') {
      this.plan = { kind: 'pause', until: 0 };
      this.easeOut(performance.now());
    }
    this.log({ op: `focus:${this.words.join(',')}` });
  }

  /** A command took over (approach, depart…): drop the plan and the pulls; look around for `pauseMs` after. */
  interrupt(now: number, pauseMs = 450): void {
    this.plan = { kind: 'pause', until: now + pauseMs };
    this.move = null;
    this.anchor = null;
    this.rig.gripRects = [];
    this.endPull();
    this.rig.feel(1, null);
    this.rig.feel(-1, null);
    this.stickers.returnAll(now);
    if (this.rig.handMode.kind === 'read') this.rig.handMode = { kind: 'rest' };
  }

  onScroll(kind: 'cut' | 'walk', now: number): void {
    if (this.plan.kind === 'read' || this.plan.kind === 'travel') {
      this.plan = { kind: 'pause', until: now + (kind === 'cut' ? 500 : 300) };
      this.easeOut(now, 250);
      if (this.rig.handMode.kind === 'read') this.rig.handMode = { kind: 'rest' };
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
    const since = now - this.moodAt;

    if (this.reducedMotion) return { target: here, k: 0, c: 0, vmax: 0, face: null, leap: false, hold: true };

    if (this.mood === 'done') {
      // A quick full turn on tiptoe (the feet turn with it), then still.
      const t = clamp(since / 650, 0, 1);
      return { ...this.rest(now, m, this.turnFrom + Math.PI * 2 * easeInOut(t)), spin: since < 1000 };
    }
    if (this.mood === 'failed') {
      this.rig.crouch = Math.min(1, this.rig.crouch + 0.05);
      return this.rest(now, m, null);
    }
    if (this.mood === 'waiting') {
      // Still, a front leg tapping every half second: up and forward from where
      // the foot stands, and down on the same spot.
      const phase = (since % 520) / 520;
      const side: 1 | -1 = Math.floor(since / 1040) % 2 ? 1 : -1;
      if (phase < 0.35) {
        this.tapBase ??= this.rig.frontFoot(side);
        const up = Math.sin((Math.PI * phase) / 0.35);
        this.rig.feel(side, add(this.tapBase, fromAngle(this.rig.heading, 10 * s * up)));
      } else {
        this.rig.feel(side, null);
        this.tapBase = null;
      }
      return this.rest(now, m, null);
    }
    if (this.mood === 'asking') {
      // Turned toward the side panel at the right edge, front legs raised.
      const up = (side: 1 | -1) => add(here, fromAngle(-0.5 + side * 0.45, 70 * s));
      this.rig.feel(1, up(1));
      this.rig.feel(-1, up(-1));
      return this.rest(now, m, 0);
    }
    return this.read(now, m, s, pal);
  }

  // ---------- moving ----------

  /** Ease out of the current motion (no brake): a short glide to rest along the way it was going. */
  private easeOut(now: number, T = 320): void {
    const v = this.rig.vel;
    if (Math.hypot(v.x, v.y) < 15) {
      this.move = null;
      this.anchor = null;
      return;
    }
    this.move = brake(this.rig.toDoc(this.rig.body), v, now, T);
    this.moveFor = 'brake';
    this.anchor = null;
  }

  /** Follow a glide: a stiff spring with the glide's velocity fed forward. */
  private track(at: { p: V; v: V; a: V }, face: number | null): Control {
    const { p, v, a } = at;
    return { target: this.rig.toView(p), tvel: v, tacc: a, k: 700, c: 55, vmax: 3000, face, leap: false, hold: false };
  }

  /** At rest: finish an easing-out glide if one runs, then hold the anchor on a soft spring. */
  private rest(now: number, m: number, face: number | null): Control {
    if (this.move && this.moveFor === 'brake') {
      const at = glideAt(this.move, now);
      if (!at.done) return this.track(at, face);
      this.anchor = this.move.p1;
      this.move = null;
    }
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

  // ---------- reading ----------

  private read(now: number, m: number, s: number, pal: Palette): Control {
    const rig = this.rig;
    this.updatePull(now);

    // A move in progress: follow it; when it ends, the plan takes its next step.
    if (this.move && this.moveFor !== 'brake') {
      const at = glideAt(this.move, now);
      if (this.moveFor === 'read') rig.handMode = { kind: 'read', p: rig.headTip() };
      if (!at.done) return this.track(at, this.faceForPlan(now));
      this.anchor = this.move.p1;
      this.move = null;
      this.arrive(now, s, pal);
    }

    const plan = this.plan;
    if (plan.kind === 'pause' || plan.kind === 'look') {
      if (now < plan.until) return this.rest(now, m, this.faceForPlan(now));
      this.pickBlock(now, s);
    }
    const p = this.plan;
    if (p.kind === 'read' && now < p.restUntil) return this.rest(now, m, this.faceForPlan(now));
    // While the agent reads the DOM the page may freeze for a moment: start no
    // move then, so a stall looks like a pause, not like a hitch mid-move.
    if (this.scanning || (this.move && this.moveFor === 'brake')) return this.rest(now, m, this.faceForPlan(now));

    if (p.kind === 'travel') this.startTravel(now, m, s);
    else if (p.kind === 'read') this.startStroke(now, m, s);
    if (!this.move) return this.rest(now, m, this.faceForPlan(now));
    return this.track(glideAt(this.move, now), this.faceForPlan(now));
  }

  /** One glide to the block, bowed a little (an arc reads as alive, a ruler line does not). */
  private startTravel(now: number, m: number, s: number): void {
    const p = this.plan;
    if (p.kind !== 'travel') return;
    const from = this.rig.toDoc(this.rig.body);
    const len = dist(from, p.goal);
    if (len < 4 * s) {
      this.arrive(now, s, null);
      return;
    }
    // A quintic peaks at ~1.875× its mean speed: long walks take longer instead of rushing (peak ≈ 380 px/s).
    const T = Math.max(moveTime(len, 600, 260 * s, 800, 4200), (1.875 * len * 1000) / (380 * s)) / m;
    const bow = (Math.random() < 0.5 ? -1 : 1) * (0.05 + Math.random() * 0.04);
    // Arriving at the start of a line it keeps going: the walk flows into reading.
    const flowsOn = p.then === 'read' && !p.onWord;
    const v1 = flowsOn ? vec(READ_SPEED * s * m, 0) : vec(0, 0);
    this.move = glide(from, this.rig.vel, p.goal, now, T, bow, v1);
    this.moveFor = 'travel';
    this.anchor = null;
  }

  /** One stroke along the line: to the next focus word (a stop) or to where it stops reading. */
  private startStroke(now: number, m: number, s: number): void {
    const p = this.plan;
    if (p.kind !== 'read') return;
    const to = this.nextFocusOnLine(p);
    const end = Math.min(p.line.x1 - 4, p.line.x0 + READ_SPAN);
    p.atWord = to !== null;
    p.to = to ?? end;
    const from = this.rig.toDoc(this.rig.body);
    const goal = { x: p.to - HAND_TIP * s, y: p.line.y };
    const len = dist(from, goal);
    if (p.to <= p.x + 2 || len < 3 * s) {
      this.finishReading(now);
      return;
    }
    const T = moveTime(len, 300, READ_SPEED * s * m, 500, 4500);
    this.move = glide(from, this.rig.vel, goal, now, T);
    this.moveFor = 'read';
    this.anchor = null;
  }

  private finishReading(now: number): void {
    this.rig.handMode = { kind: 'rest' };
    this.plan = { kind: 'look', until: now + 600 + Math.random() * 400, base: this.rig.heading };
    this.log({ op: 'look', body: { ...this.rig.body } });
  }

  /**
   * Where to face. Turning the body while the feet stay planted sweeps the
   * legs across each other, so the heading changes rarely: along the line
   * while reading, one direction per walk, a small slow look around.
   */
  private faceForPlan(now: number): number | null {
    const p = this.plan;
    if (p.kind === 'read') return 0;
    if (p.kind === 'look') return p.base + Math.sin(now / 420) * 0.15;
    if (p.kind === 'travel') {
      if (p.face === undefined) {
        const g = this.rig.toView(p.goal);
        p.face = Math.atan2(g.y - this.rig.body.y, g.x - this.rig.body.x);
      }
      return p.face;
    }
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
    this.plan = { kind: 'travel', goal, then: 'read', block: next, lines, words, onWord: !!first };
    this.log({ op: 'read', point: this.rig.toView({ x: lines[0].x0, y: lines[0].y }), body: { ...this.rig.body } });
    void now;
  }

  /** The current move ended at its goal. */
  private arrive(now: number, s: number, pal: Palette | null): void {
    const p = this.plan;
    if (p.kind === 'travel') {
      if (p.then === 'read' && p.block && p.lines) {
        // Read one line: the focus word's line (starting on the word), or the first.
        const lines = p.lines;
        const nearest = lines.reduce(
          (best, l, i) => (Math.abs(l.y - p.goal.y) < Math.abs(lines[best].y - p.goal.y) ? i : best),
          0,
        );
        const line = p.onWord ? lines[nearest] : lines[0];
        const x = p.goal.x + HAND_TIP * s;
        this.plan = {
          kind: 'read',
          block: p.block,
          line,
          x,
          to: x,
          atWord: !!p.onWord,
          words: p.words ?? [],
          restUntil: 0,
        };
        this.rig.handMode = { kind: 'read', p: this.rig.toView({ x, y: line.y }) };
        if (p.onWord) this.stopOnWord(now, s, pal);
      } else {
        this.plan = { kind: 'look', until: now + 600, base: this.rig.heading };
      }
      return;
    }
    if (p.kind === 'read') {
      p.x = p.to;
      if (p.atWord) this.stopOnWord(now, s, pal);
      else this.finishReading(now);
    }
  }

  /** On a focus word: a real stop — hands on it, tear it out, then read on past it. */
  private stopOnWord(now: number, s: number, pal: Palette | null): void {
    const p = this.plan;
    if (p.kind !== 'read') return;
    const m = PACE[this.pace] ?? 1;
    p.restUntil = now + (500 + Math.random() * 300) / m;
    const cursor = this.rig.toView({ x: p.x, y: p.line.y });
    this.rig.handMode = { kind: 'read', p: cursor };
    if (pal && this.tear && this.mood !== 'acting') this.maybeTear(now, cursor, s, pal);
    // Read on from the end of this word.
    const word = p.words.find(w => Math.abs(w.doc.x - 6 - p.x) < 4);
    if (word) p.x = word.doc.x + word.doc.width + 2;
  }

  /** Document x just before the next focus word on this line, if there is one ahead of the hands. */
  private nextFocusOnLine(p: Extract<Plan, { kind: 'read' }>): number | null {
    if (!this.matcher || !this.tear || this.mood === 'acting') return null;
    const end = Math.min(p.line.x1 - 4, p.line.x0 + READ_SPAN);
    const x = p.words
      .filter(w => Math.abs(w.doc.y + w.doc.height / 2 - p.line.y) < w.doc.height * 0.6)
      .map(w => w.doc.x)
      .filter(wx => wx - 6 > p.x + 4 && wx <= end)
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
