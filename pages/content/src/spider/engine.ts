/**
 * The agent spider: a line-drawn spider that lives in a closed shadow root
 * on top of the page while the agent works in this tab.
 *
 * Body: a head (cephalothorax) on springs in viewport coordinates and an
 * abdomen that follows it on its own spring — it lags on turns and swings
 * on stops. Legs: planted in document coordinates, solved in a vertical
 * plane with the knee always up and bowed outward by a fixed rule per leg
 * (no knee flips), never drawn longer than the bones. A big scroll is a cut:
 * the page carries the spider a little and the feet re-grip; small scrolls
 * are walked. Two short front appendages are the hands: they wind up and
 * tap the exact point the agent clicks, drum while it types, and trace the
 * lines while the spider reads a block between actions.
 *
 * Contract with the page: the host element is appended once and never
 * touched again (the agent hashes `documentElement.outerHTML` around
 * coordinate clicks), everything is drawn on one canvas, nothing receives
 * pointer events, and the site's own DOM is never modified.
 */
import type {
  SpiderAck,
  SpiderArrival,
  SpiderEvent,
  SpiderLook,
  SpiderPlace,
  SpiderPoint as V,
  SpiderPose,
  SpiderRect,
} from '@extension/shared';
import {
  add,
  angleDiff,
  clamp,
  clampLen,
  dist,
  easeIn,
  easeInOut,
  easeOutBack,
  fromAngle,
  kneeInPlane,
  lerp,
  mul,
  nearestOnRectEdge,
  rot90,
  springStep,
  sub,
  unit,
  vec,
} from './geometry';
import { type Block, type Line, findBlocks, pickNext } from './reader';

type Mode = 'gone' | 'descend' | 'arrive' | 'idle' | 'approach' | 'busy' | 'depart' | 'departed' | 'leave';

type Idle =
  | { kind: 'pause'; until: number }
  | { kind: 'walk'; block: Block; lines: Line[] }
  | { kind: 'read'; block: Block; lines: Line[]; line: number; x: number; holdUntil: number }
  | { kind: 'look'; until: number; base: number }
  | { kind: 'wander'; until: number };

interface Leg {
  side: 1 | -1;
  group: 0 | 1;
  hipAngle: number;
  angle: number;
  home: number;
  femur: number;
  tibia: number;
  /** +1 bows the knee toward the tail, -1 toward the head; fixed, so knees never flip. */
  bow: 1 | -1;
  /** Document coordinates. */
  foot: V;
  from: V;
  to: V;
  /** Step progress 0..1, or -1 when planted. */
  t: number;
  dur: number;
  lift: number;
  lastStep: number;
  grip: SpiderRect | null;
  /** In the air: the foot relative to the body, smoothed there so speed adds no lag. */
  rel: V | null;
}

interface Drawn {
  hip: V;
  knee: V;
  foot: V;
}

interface Waiter {
  resolve: (ack: SpiderAck) => void;
  timers: number[];
}

const PACE = { calm: 0.72, normal: 1, fast: 1.4 } as const;
const GRIP_TAGS = new Set([
  'A',
  'SPAN',
  'B',
  'I',
  'EM',
  'STRONG',
  'CODE',
  'BUTTON',
  'INPUT',
  'LABEL',
  'IMG',
  'SUP',
  'SUB',
  'SMALL',
  'ABBR',
  'CITE',
  'TIME',
  'KBD',
  'MARK',
  'SELECT',
  'TEXTAREA',
  'svg',
]);

// Leg pairs, head to tail, at size 1: where the hip sits on the head rim,
// the rest direction, the rest distance as a share of the full length,
// femur and tibia. Front pairs bow toward the tail, rear pairs toward the
// head: the "( )" silhouette of a spider seen from above.
const LEG_LAYOUT = [
  { hipAngle: 0.55, angle: 0.6, home: 0.8, femur: 33, tibia: 37, bow: 1 },
  { hipAngle: 1.15, angle: 1.27, home: 0.78, femur: 28, tibia: 32, bow: 1 },
  { hipAngle: 1.85, angle: 1.98, home: 0.78, femur: 26, tibia: 30, bow: -1 },
  { hipAngle: 2.45, angle: 2.6, home: 0.82, femur: 31, tibia: 37, bow: -1 },
] as const;

const HEAD = { rx: 7.5, ry: 6.2, rim: 5.2 };
const ABDOMEN = { rx: 11, ry: 8.4, gap: 16 };
const HAND = { along: 6, lat: 2.6, femur: 8, tibia: 8 };
const HAND_TIP = 22;
const HIP_Z = 9;
/** Oblique view: how much height lifts a point up the screen. */
const LIFT = 0.24;

export class Spider {
  private host: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private dpr = 1;
  private raf = 0;
  private lastFrame = 0;
  private frameCount = 0;
  private frames: number[] = [];
  private lastBox: [number, number, number, number] | null = null;

  private look: SpiderLook = { size: 1, pace: 'normal', marks: 'target' };
  private mode: Mode = 'gone';
  private visible = true;
  private readonly reducedMotion: boolean;

  private body = vec(0, 0);
  private vel = vec(0, 0);
  private heading = Math.PI / 2;
  private angVel = 0;
  private target = vec(0, 0);
  private faceTo: V | null = null;
  private abdomen = vec(0, 0);
  private abdVel = vec(0, 0);
  private legs: Leg[] = [];
  private drawn: Drawn[] = [];
  private airborne = true;
  /** Mid-leap: legs gathered under the body, nothing planted. */
  private dashing = false;
  /** Smoothed 1 → 1.06 while leaping: the body comes up toward the viewer. */
  private leapScale = 1;
  private thread: { anchor: V; alpha: number } | null = null;
  private lastScroll = vec(0, 0);
  /** How fast the page is moving under the spider, document px/s (smoothed). */
  private scrollVel = vec(0, 0);
  private velScrollAt = vec(0, 0);

  private scale = 1;
  private crouch = 0;
  private squashAt = -Infinity;
  private dip = vec(0, 0);
  private modeAt = 0;
  private dartFrom = vec(0, 0);
  private dartAnticipate = false;
  private departTimer = 0;
  private rings: Array<{ p: V; born: number; dur: number; from: number; to: number; inward: boolean }> = [];

  private hands: [V, V] = [vec(0, 0), vec(0, 0)];
  private handMode:
    | { kind: 'rest' }
    | { kind: 'reach'; p: V }
    | { kind: 'type'; p: V }
    | { kind: 'read'; p: V }
    | { kind: 'tap'; p: V; born: number } = { kind: 'rest' };
  private tapResolve: (() => void) | null = null;

  private targetMark: { rect: SpiderRect; born: number; hue: number } | null = null;
  private released: Array<{ rect: SpiderRect; born: number; hue: number }> = [];

  private idle: Idle = { kind: 'pause', until: 0 };
  private visited = new WeakSet<Element>();
  private busyUntil = 0;
  private approachWaiter: Waiter | null = null;
  private departWaiter: Waiter | null = null;
  private hideWaiter: Waiter | null = null;
  private events: SpiderEvent[] = [];

  /** Called with the spider's place when the page starts to unload. */
  onUnload: ((place: SpiderPlace) => void) | null = null;

  constructor() {
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  get spawned(): boolean {
    return this.mode !== 'gone';
  }

  place(): SpiderPlace {
    return { x: round(this.body.x), y: round(this.body.y), heading: round(this.heading) };
  }

  // ---------- commands ----------

  spawn(look: SpiderLook, at?: SpiderPlace, arrive: SpiderArrival = 'descend'): SpiderAck {
    this.look = { ...look };
    if (this.mode !== 'gone' && this.mode !== 'leave' && this.mode !== 'departed') {
      return this.ack({ ok: true });
    }
    this.mount();
    const vw = innerWidth;
    const vh = innerHeight;
    const x = clamp(at?.x ?? vw * 0.62, 50, vw - 50);
    const y = clamp(at?.y ?? vh * 0.4, 70, vh - 50);
    const teleport = arrive === 'teleport';
    this.heading = teleport && at ? at.heading : Math.PI / 2;
    this.angVel = 0;
    this.vel = vec(0, 0);
    this.target = vec(x, y);
    this.faceTo = null;
    this.handMode = { kind: 'rest' };
    this.idle = { kind: 'pause', until: performance.now() + 700 };
    this.body = this.reducedMotion || teleport ? vec(x, y) : vec(x, -70 * this.look.size);
    this.abdomen = add(this.body, fromAngle(this.heading + Math.PI, ABDOMEN.gap * this.look.size));
    this.abdVel = vec(0, 0);
    this.lastScroll = vec(scrollX, scrollY);
    this.velScrollAt = vec(scrollX, scrollY);
    this.scrollVel = vec(0, 0);
    this.legs = this.buildLegs();
    this.hands = [this.headTip(), this.headTip()];
    this.modeAt = performance.now();
    this.scale = 1;
    window.clearTimeout(this.departTimer);
    if (this.reducedMotion) {
      this.mode = 'idle';
      this.land();
    } else if (teleport) {
      this.mode = 'arrive';
      this.scale = 0;
      this.airborne = true;
      this.thread = null;
      this.ring(this.body, 140, 30, 4, true);
    } else {
      this.mode = 'descend';
      this.airborne = true;
      this.thread = { anchor: vec(x, -20), alpha: 1 };
    }
    this.log({ op: teleport ? 'spawn-teleport' : 'spawn', body: { x, y } });
    this.start();
    return this.ack({ ok: true });
  }

  tune(look: SpiderLook): SpiderAck {
    const resized = look.size !== this.look.size;
    this.look = { ...look };
    if (resized && this.spawned) {
      this.legs = this.buildLegs();
      this.land();
    }
    return this.ack({ ok: true });
  }

  approach(point: V, rect: SpiderRect | undefined, capMs: number): Promise<SpiderAck> {
    if (!this.spawned || this.mode === 'leave') {
      return Promise.resolve(this.ack({ ok: false, reason: 'not-spawned' }));
    }
    if (this.mode === 'departed' || this.mode === 'depart') this.reappear();
    this.settleWaiter(this.approachWaiter, { ok: true, arrived: false, reason: 'cap' });
    const s = this.look.size;
    const toPoint = sub(point, this.body);
    const far = Math.hypot(toPoint.x, toPoint.y);
    const dir = far < 30 * s ? fromAngle(this.heading) : unit(toPoint);
    const goal = sub(point, mul(dir, HAND_TIP * s));
    this.target = vec(clamp(goal.x, 16, innerWidth - 16), clamp(goal.y, 16, innerHeight - 16));
    this.faceTo = { ...point };
    const wasArriving = this.mode === 'arrive';
    if (!wasArriving) this.mode = 'approach';
    this.modeAt = wasArriving ? this.modeAt : performance.now();
    this.dartFrom = { ...this.body };
    this.dartAnticipate = far > 120 * s && !this.airborne;
    this.handMode = { kind: 'rest' };
    if (this.thread) this.thread.alpha = Math.min(this.thread.alpha, 0.6);
    if (rect && this.look.marks === 'target') {
      this.targetMark = { rect: this.toDocRect(rect), born: Infinity, hue: this.hue() };
    }
    this.log({ op: 'approach', point: { ...point }, body: { ...this.body } });

    if (this.reducedMotion || document.hidden) {
      this.teleport();
      const reason = this.reducedMotion ? 'reduced-motion' : 'hidden';
      this.log({ op: 'arrive', arrived: false, body: { ...this.body } });
      return Promise.resolve(this.ack({ ok: true, arrived: false, reason }));
    }
    if (this.mode === 'approach' && this.arrived()) {
      this.mode = 'busy';
      this.busyUntil = performance.now() + 1500;
      this.log({ op: 'arrive', arrived: true, body: { ...this.body } });
      return Promise.resolve(this.ack({ ok: true, arrived: true }));
    }
    return new Promise(resolve => {
      const framesAtStart = this.frameCount;
      const waiter: Waiter = { resolve, timers: [] };
      waiter.timers.push(
        window.setTimeout(() => {
          // No animation frame within 150 ms: the tab is throttled. Jump.
          if (this.frameCount === framesAtStart) {
            this.teleport();
            this.log({ op: 'arrive', arrived: false, body: { ...this.body } });
            this.settleWaiter(waiter, { ok: true, arrived: false, reason: 'no-frames' });
          }
        }, 150),
        window.setTimeout(() => {
          this.log({ op: 'arrive', arrived: false, body: { ...this.body } });
          this.settleWaiter(waiter, { ok: true, arrived: false, reason: 'cap' });
        }, capMs),
      );
      this.approachWaiter = waiter;
    });
  }

  strike(point: V, rect?: SpiderRect): Promise<SpiderAck> {
    if (!this.spawned) return Promise.resolve(this.ack({ ok: false, reason: 'not-spawned' }));
    if (rect && this.look.marks === 'target') {
      this.targetMark = { rect: this.toDocRect(rect), born: performance.now(), hue: this.hue() };
    } else if (this.targetMark) {
      this.targetMark.born = performance.now();
    }
    if (this.mode !== 'arrive') this.mode = 'busy';
    this.busyUntil = performance.now() + 800;
    this.faceTo = { ...point };
    if (this.reducedMotion || document.hidden || !this.raf) {
      this.ring(point, 260, 4, 22);
      this.log({ op: 'strike', point: { ...point }, body: { ...this.body } });
      this.draw();
      return Promise.resolve(this.ack({ ok: true }));
    }
    return new Promise(resolve => {
      const done = () => {
        window.clearTimeout(fallback);
        this.tapResolve = null;
        resolve(this.ack({ ok: true }));
      };
      const fallback = window.setTimeout(done, 260);
      this.tapResolve = done;
      this.handMode = { kind: 'tap', p: { ...point }, born: performance.now() };
    });
  }

  typing(on: boolean): SpiderAck {
    if (!this.spawned) return this.ack({ ok: false, reason: 'not-spawned' });
    if (on) {
      const hm = this.handMode;
      const p = hm.kind === 'rest' ? (this.faceTo ?? this.headTip()) : hm.p;
      this.handMode = { kind: 'type', p: { ...p } };
      this.mode = 'busy';
      this.busyUntil = Infinity;
    } else {
      this.handMode = this.faceTo ? { kind: 'reach', p: this.faceTo } : { kind: 'rest' };
      this.busyUntil = performance.now() + 600;
    }
    this.log({ op: on ? 'typing-on' : 'typing-off' });
    return this.ack({ ok: true });
  }

  /** A hint only: the scroll itself is handled from the page's scroll position. */
  scroll(): SpiderAck {
    if (!this.spawned) return this.ack({ ok: false, reason: 'not-spawned' });
    this.log({ op: 'scroll' });
    return this.ack({ ok: true });
  }

  hide(): Promise<SpiderAck> {
    this.visible = false;
    if (this.canvas) this.canvas.style.visibility = 'hidden';
    this.clearAll();
    this.log({ op: 'hide', body: { ...this.body } });
    if (!this.raf || document.hidden) return Promise.resolve(this.ack({ ok: true }));
    // Resolve after two presented frames so the cleared canvas is on screen
    // before the background captures it.
    return new Promise(resolve => {
      const waiter: Waiter = { resolve, timers: [] };
      let n = 0;
      const step = () => {
        if (++n >= 2) this.settleWaiter(waiter, { ok: true });
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      waiter.timers.push(window.setTimeout(() => this.settleWaiter(waiter, { ok: true }), 80));
      this.hideWaiter = waiter;
    });
  }

  show(): SpiderAck {
    this.visible = true;
    if (this.canvas) this.canvas.style.visibility = 'visible';
    this.log({ op: 'show' });
    return this.ack({ ok: true });
  }

  leave(): SpiderAck {
    if (!this.spawned) return this.ack({ ok: true });
    this.settleWaiter(this.approachWaiter, { ok: true, arrived: false, reason: 'not-spawned' });
    this.log({ op: 'leave', body: { ...this.body } });
    if (this.reducedMotion || document.hidden || this.mode === 'departed') {
      this.unmount();
      return this.ack({ ok: true });
    }
    this.mode = 'leave';
    this.scale = 1;
    this.handMode = { kind: 'rest' };
    this.airborne = true;
    this.thread = { anchor: vec(this.body.x, -20), alpha: 1 };
    this.target = vec(this.body.x, -150 * this.look.size);
    return this.ack({ ok: true });
  }

  /** Collapse into a point: the page is about to go, or the agent moves to another tab. */
  depart(): Promise<SpiderAck> {
    if (!this.spawned || this.mode === 'leave') return Promise.resolve(this.ack({ ok: true }));
    if (this.mode === 'depart' || this.mode === 'departed') {
      const pending = this.departWaiter;
      if (!pending) return Promise.resolve(this.ack({ ok: true }));
      return new Promise(resolve => {
        const prev = pending.resolve;
        pending.resolve = a => {
          prev(a);
          resolve(a);
        };
      });
    }
    this.settleWaiter(this.approachWaiter, { ok: true, arrived: false, reason: 'not-spawned' });
    this.log({ op: 'depart', body: { ...this.body } });
    if (this.reducedMotion || document.hidden || !this.raf) {
      this.mode = 'departed';
      this.scale = 0;
      this.draw();
      this.armReappear();
      return Promise.resolve(this.ack({ ok: true }));
    }
    this.mode = 'depart';
    this.modeAt = performance.now();
    this.handMode = { kind: 'rest' };
    return new Promise(resolve => {
      const waiter: Waiter = { resolve, timers: [] };
      waiter.timers.push(window.setTimeout(() => this.settleWaiter(waiter, { ok: true }), 320));
      this.departWaiter = waiter;
    });
  }

  state(): SpiderAck {
    const frameMs =
      this.frames.length > 1 ? (this.frames[this.frames.length - 1] - this.frames[0]) / (this.frames.length - 1) : 0;
    return { ...this.ack({ ok: true }), events: [...this.events], frameMs };
  }

  // ---------- simulation ----------

  private buildLegs(): Leg[] {
    const s = this.look.size;
    const legs: Leg[] = [];
    for (const side of [1, -1] as const) {
      LEG_LAYOUT.forEach((l, i) => {
        const leg: Leg = {
          side,
          // Alternating tetrapod gait: L1 R2 L3 R4 against R1 L2 R3 L4.
          group: ((i + (side === 1 ? 0 : 1)) % 2) as 0 | 1,
          hipAngle: l.hipAngle,
          angle: l.angle,
          home: l.home * (l.femur + l.tibia) * s,
          femur: l.femur * s,
          tibia: l.tibia * s,
          bow: l.bow,
          foot: vec(0, 0),
          from: vec(0, 0),
          to: vec(0, 0),
          t: -1,
          dur: 0.14,
          lift: 0,
          lastStep: 0,
          grip: null,
          rel: null,
        };
        leg.foot = this.idealFoot(leg, this.toDoc(this.body), 0);
        legs.push(leg);
      });
    }
    return legs;
  }

  private hip(leg: Leg, bodyDoc: V): V {
    return add(bodyDoc, fromAngle(this.heading + leg.side * leg.hipAngle, HEAD.rim * this.look.size));
  }

  private reach(leg: Leg): number {
    return leg.femur + leg.tibia;
  }

  private idealFoot(leg: Leg, bodyDoc: V, lead: number): V {
    const home = add(this.hip(leg, bodyDoc), fromAngle(this.heading + leg.side * leg.angle, leg.home));
    return add(home, mul(this.vel, lead));
  }

  /** Plant all feet around `at` (where the body will settle; default: where it is). */
  private land(at: V = this.body): void {
    this.airborne = false;
    this.dashing = false;
    const bodyDoc = this.toDoc(at);
    const here = this.toDoc(this.body);
    for (const leg of this.legs) {
      const g = this.grip(this.idealFoot(leg, bodyDoc, 0));
      leg.foot = clampLen(this.hip(leg, here), g.p, this.reach(leg) * 0.99);
      leg.grip = g.rect;
      leg.t = -1;
      leg.lift = 0;
      leg.rel = null;
    }
  }

  private teleport(): void {
    this.body = { ...this.target };
    this.vel = vec(0, 0);
    if (this.faceTo) this.heading = Math.atan2(this.faceTo.y - this.body.y, this.faceTo.x - this.body.x);
    this.abdomen = add(this.body, fromAngle(this.heading + Math.PI, ABDOMEN.gap * this.look.size));
    this.thread = null;
    this.scale = 1;
    this.land();
    this.mode = 'busy';
    this.busyUntil = performance.now() + 800;
    this.draw();
  }

  /** The navigation did not happen (or the tab came back): pop back in where it was. */
  private reappear(): void {
    window.clearTimeout(this.departTimer);
    this.settleWaiter(this.departWaiter, { ok: true });
    this.mode = 'arrive';
    this.modeAt = performance.now();
    this.airborne = true;
    this.scale = 0;
    this.ring(this.body, 140, 30, 4, true);
    this.log({ op: 'reappear', body: { ...this.body } });
  }

  private armReappear(): void {
    window.clearTimeout(this.departTimer);
    this.departTimer = window.setTimeout(() => {
      if (this.mode === 'departed') this.reappear();
    }, 2500);
  }

  private arrived(): boolean {
    return dist(this.body, this.target) < 3.5 * this.look.size && Math.hypot(this.vel.x, this.vel.y) < 50;
  }

  private headTip(): V {
    return add(this.body, fromAngle(this.heading, HAND_TIP * this.look.size));
  }

  private tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = this.lastFrame ? Math.min(0.05, (now - this.lastFrame) / 1000) : 1 / 60;
    this.lastFrame = now;
    this.frameCount++;
    this.frames.push(now);
    while (this.frames.length && now - this.frames[0] > 1000) this.frames.shift();

    // Page speed is sampled here only (pose reads also sync the scroll).
    const moved = vec((scrollX - this.velScrollAt.x) / dt, (scrollY - this.velScrollAt.y) / dt);
    this.velScrollAt = vec(scrollX, scrollY);
    // A jump is a cut, not motion: keep it out of the speed.
    this.scrollVel =
      Math.hypot(moved.x, moved.y) * dt > 22 * this.look.size ? vec(0, 0) : lerp(this.scrollVel, moved, 0.35);
    this.syncScroll(now);
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let i = 0; i < steps && this.mode !== 'gone'; i++) this.step(dt / steps, now);
    this.draw();
  };

  /**
   * The page moved under the spider. Small moves are walked (feet are in
   * document space); a jump — the agent's instant scroll — is a cut: the
   * page carries the body a little, the feet re-grip at once, and the body
   * springs back to where it was on screen.
   */
  private syncScroll(now: number): void {
    const dx = scrollX - this.lastScroll.x;
    const dy = scrollY - this.lastScroll.y;
    if (!dx && !dy) return;
    this.lastScroll = vec(scrollX, scrollY);
    if (this.airborne || this.mode === 'gone') return;
    const s = this.look.size;
    if (Math.hypot(dx, dy) > 22 * s) {
      const carry = clampLen(vec(0, 0), vec(-dx, -dy), 56 * s);
      this.body = add(this.body, carry);
      this.abdomen = add(this.abdomen, mul(carry, 1.25));
      this.vel = add(this.vel, mul(carry, 3));
      this.land();
      this.squashAt = now;
      if (this.idle.kind === 'read' || this.idle.kind === 'walk') this.idle = { kind: 'pause', until: now + 500 };
      this.log({ op: 'scroll-cut', body: { ...this.body } });
    } else {
      // Walked: the planted feet ride the page, slipping at full reach if it outruns them.
      const bodyDoc = this.toDoc(this.body);
      for (const leg of this.legs) {
        if (this.dashing) continue;
        if (leg.t < 0) {
          leg.foot = clampLen(this.hip(leg, bodyDoc), leg.foot, this.reach(leg) * 0.99);
        } else {
          // A foot in the air is not on the page: it travels with the body.
          leg.from = add(leg.from, vec(dx, dy));
          leg.to = add(leg.to, vec(dx, dy));
          leg.foot = add(leg.foot, vec(dx, dy));
        }
      }
      if (this.idle.kind === 'read' || this.idle.kind === 'walk') this.idle = { kind: 'pause', until: now + 300 };
    }
  }

  private step(dt: number, now: number): void {
    const m = PACE[this.look.pace] ?? 1;
    const s = this.look.size;
    const sinceMode = now - this.modeAt;

    if (this.mode === 'idle') this.stepIdle(now, m, s);
    if (this.mode === 'busy' && now > this.busyUntil && this.handMode.kind !== 'type') {
      this.mode = 'idle';
      this.faceTo = null;
      this.handMode = { kind: 'rest' };
      this.idle = { kind: 'pause', until: now + 450 / m };
    }

    // Body spring per mode. The dart (~0.5 s) overshoots once, a few
    // percent, and settles: inertia you can see, not a bounce.
    let target = this.target;
    let k = 34 * m * m;
    let c = 11.5 * m;
    let vmax = 300 * m * s;
    if (this.mode === 'approach' || this.mode === 'busy') {
      k = 170 * m * m;
      c = 20 * m;
      vmax = 2400 * m;
      if (this.mode === 'approach' && this.dartAnticipate && sinceMode < 75) {
        // Anticipation: crouch and pull back a little before the leap.
        target = sub(this.dartFrom, mul(unit(sub(this.target, this.dartFrom)), 6 * s));
        k = 320;
        c = 32;
        this.crouch = Math.min(1, this.crouch + dt * 16);
      }
    } else if (this.mode === 'descend' || this.mode === 'leave') {
      k = 55 * m * m;
      c = 13 * m;
      vmax = 1400 * m;
    } else if (this.mode === 'idle' && this.idle.kind === 'read') {
      k = 90 * m * m;
      c = 17 * m;
      vmax = 600 * m;
    } else if (this.mode === 'idle' && this.idle.kind === 'walk') {
      k = 42 * m * m;
      c = 12.5 * m;
      vmax = 320 * m * s;
    }
    if (this.mode !== 'arrive' && this.mode !== 'depart' && this.mode !== 'departed') {
      springStep(this.body, this.vel, target, k, c, dt, vmax);
    }
    const speed = Math.hypot(this.vel.x, this.vel.y);

    // Heading.
    let want = this.heading;
    const near = this.faceTo && dist(this.body, this.target) < 60 * s;
    if (this.mode === 'approach' && this.dartAnticipate && sinceMode < 75 && this.faceTo) {
      want = Math.atan2(this.faceTo.y - this.body.y, this.faceTo.x - this.body.x);
    } else if (this.faceTo && (near || this.mode === 'busy')) {
      want = Math.atan2(this.faceTo.y - this.body.y, this.faceTo.x - this.body.x);
    } else if (this.mode === 'descend' || this.mode === 'leave') {
      want = this.mode === 'descend' ? Math.PI / 2 : -Math.PI / 2;
    } else if (this.mode === 'idle' && this.idle.kind === 'read') {
      want = 0;
    } else if (this.mode === 'idle' && this.idle.kind === 'look') {
      want = this.idle.base + Math.sin(now / 260) * 0.35;
    } else if (speed > 30) {
      want = Math.atan2(this.vel.y, this.vel.x);
    }
    const ka = 70 * m;
    const ca = 15 * Math.sqrt(m);
    this.angVel += (ka * angleDiff(this.heading, want) - ca * this.angVel) * dt;
    this.heading += this.angVel * dt;

    // Abdomen: its own looser spring behind the head, held at pedicel length.
    const gap = ABDOMEN.gap * s;
    springStep(this.abdomen, this.abdVel, add(this.body, fromAngle(this.heading + Math.PI, gap)), 260, 17, dt, 5000);
    this.abdomen = add(this.body, mul(unit(sub(this.abdomen, this.body)), gap));

    // Mode timelines.
    if (this.mode === 'descend' && dist(this.body, this.target) < 5 * s && speed < 80) {
      this.mode = 'idle';
      this.idle = { kind: 'pause', until: now + 700 / m };
      this.land();
      this.squashAt = now;
      this.log({ op: 'landed', body: { ...this.body } });
    }
    if (this.mode === 'arrive') {
      // Ring closes in (0–140 ms), the spider pops out of the point with an
      // overshoot (140–420 ms), the legs unfold and grip.
      const t = clamp((sinceMode - 140) / 280, 0, 1);
      this.scale = sinceMode < 140 ? 0 : easeOutBack(t);
      if (this.airborne && sinceMode > 300) {
        this.land();
        this.squashAt = now;
      }
      if (sinceMode > 440) {
        this.scale = 1;
        this.log({ op: 'arrived-teleport', body: { ...this.body } });
        if (this.faceTo) {
          // An action came in while it was arriving: go do it.
          this.mode = 'approach';
          this.modeAt = now;
          this.dartAnticipate = false;
        } else {
          this.mode = 'idle';
          this.idle = { kind: 'pause', until: now + 600 / m };
        }
      }
    }
    if (this.mode === 'depart') {
      // Tuck and crouch (0–90 ms), then collapse into the point (90–200 ms).
      this.airborne = true;
      this.crouch = Math.min(1, sinceMode / 90);
      this.scale =
        sinceMode < 90 ? 1 - 0.1 * (sinceMode / 90) : 0.9 * (1 - easeIn(clamp((sinceMode - 90) / 110, 0, 1)));
      if (sinceMode >= 90 && !this.rings.some(r => !r.inward && now - r.born < 300)) {
        this.ring(this.body, 260, 4, 30);
      }
      if (sinceMode >= 200) {
        this.mode = 'departed';
        this.scale = 0;
        this.crouch = 0;
        this.settleWaiter(this.departWaiter, { ok: true });
        this.armReappear();
      }
    } else if (this.crouch > 0) {
      this.crouch = Math.max(0, this.crouch - dt * 6);
    }
    if (this.thread && this.mode !== 'descend' && this.mode !== 'leave') {
      this.thread.alpha -= dt * 2;
      if (this.thread.alpha <= 0) this.thread = null;
    }
    if (this.mode === 'leave' && this.body.y < -100 * s) {
      this.unmount();
      return;
    }

    // Arrival of an approach.
    if (this.mode === 'approach' && sinceMode > 75 && this.arrived()) {
      this.mode = 'busy';
      this.busyUntil = now + 1500;
      this.squashAt = now;
      this.handMode = this.faceTo ? { kind: 'reach', p: { ...this.faceTo } } : { kind: 'rest' };
      this.log({ op: 'arrive', arrived: true, body: { ...this.body } });
      this.settleWaiter(this.approachWaiter, { ok: true, arrived: true });
    }

    this.dip = mul(this.dip, Math.max(0, 1 - dt * 12));
    this.leapScale += ((this.dashing ? 1.06 : 1) - this.leapScale) * Math.min(1, dt * 14);
    this.stepLegs(dt, now, speed);
    this.stepHands(dt, now);
  }

  /** Between actions: walk to a text block, read a few lines with the hands on them, look up, move on. */
  private stepIdle(now: number, m: number, s: number): void {
    const idle = this.idle;
    if (this.reducedMotion) return;
    if (idle.kind === 'pause' || idle.kind === 'look' || idle.kind === 'wander') {
      if (now < idle.until) return;
      const blocks = findBlocks(innerWidth, innerHeight);
      let next = pickNext(blocks, this.body, this.visited);
      if (!next && blocks.length) {
        this.visited = new WeakSet();
        next = pickNext(blocks, this.body, this.visited);
      }
      if (next) {
        this.visited.add(next.el);
        const lines = next.lines.map(l => ({ x0: l.x0 + scrollX, x1: l.x1 + scrollX, y: l.y + scrollY }));
        const first = lines[0];
        this.target = sub(this.toView({ x: first.x0 + 4, y: first.y }), vec(HAND_TIP * s, 0));
        this.idle = { kind: 'walk', block: next, lines };
        this.handMode = { kind: 'rest' };
        this.log({ op: 'read', point: this.toView({ x: first.x0, y: first.y }), body: { ...this.body } });
      } else {
        // Nothing readable on screen: drift a little.
        const a = this.heading + (Math.random() - 0.5) * 2.4;
        const p = add(this.body, fromAngle(a, (60 + Math.random() * 120) * s));
        this.target = vec(clamp(p.x, 50, innerWidth - 50), clamp(p.y, 50, innerHeight - 50));
        this.idle = { kind: 'wander', until: now + (1500 + Math.random() * 1500) / m };
      }
      return;
    }
    if (idle.kind === 'walk') {
      if (dist(this.body, this.target) < 6 * s) {
        const first = idle.lines[0];
        this.idle = {
          kind: 'read',
          block: idle.block,
          lines: idle.lines,
          line: 0,
          x: first.x0 + 4,
          holdUntil: now + 120,
        };
      }
      return;
    }
    // Reading: a cursor runs along the line at reading pace, the hands on it.
    if (now < idle.holdUntil) return;
    const line = idle.lines[idle.line];
    // Skims: the first ~420 px of each line at reading pace, then the next line.
    const end = Math.min(line.x1 - 4, line.x0 + 420);
    idle.x = Math.min(end, idle.x + (220 * m) / 120);
    const cursorView = this.toView({ x: idle.x, y: line.y });
    if (cursorView.y < 30 || cursorView.y > innerHeight - 30) {
      this.idle = { kind: 'pause', until: now + 200 };
      return;
    }
    this.target = sub(cursorView, vec(HAND_TIP * s, 0));
    this.handMode = { kind: 'read', p: cursorView };
    if (idle.x >= end) {
      if (idle.line + 1 < idle.lines.length) {
        idle.line++;
        idle.x = idle.lines[idle.line].x0 + 4;
        idle.holdUntil = now + 160 / m;
      } else {
        this.handMode = { kind: 'rest' };
        this.idle = { kind: 'look', until: now + (600 + Math.random() * 400) / m, base: this.heading };
        this.log({ op: 'look', body: { ...this.body } });
      }
    }
  }

  private stepLegs(dt: number, now: number, bodySpeed: number): void {
    let speed = bodySpeed;
    const s = this.look.size;
    const bodyDoc = this.toDoc(this.body);
    // A fast dart is a leap: legs gather under the body in the air and the
    // spider lands with them spread, instead of dragging eight legs behind.
    if (!this.airborne) {
      const sinceMode = now - this.modeAt;
      const leap =
        this.mode === 'approach' && this.dartAnticipate && sinceMode >= 75 && dist(this.body, this.target) > 20 * s;
      if (!this.dashing && (leap || speed > 650 * s)) {
        this.dashing = true;
        for (const leg of this.legs) {
          if (leg.grip && this.look.marks === 'feet')
            this.released.push({ rect: leg.grip, born: now, hue: this.hue() });
          leg.grip = null;
          leg.t = -1;
        }
      } else if (this.dashing && !leap && speed < 380 * s) {
        this.dashing = false;
        this.land(this.target);
        this.squashAt = now;
        this.log({ op: 'leap-land', body: { ...this.body } });
      }
    }
    if (this.dashing && !this.airborne) {
      for (const leg of this.legs) {
        // Front legs fold forward, rear legs back, all pulled in close.
        const fold = leg.angle < Math.PI / 2 ? leg.angle * 0.7 : Math.PI - (Math.PI - leg.angle) * 0.7;
        const gathered = sub(
          add(this.hip(leg, bodyDoc), fromAngle(this.heading + leg.side * fold, leg.home * 0.5)),
          bodyDoc,
        );
        leg.rel = lerp(leg.rel ?? sub(leg.foot, bodyDoc), gathered, Math.min(1, dt * 30));
        leg.foot = add(bodyDoc, leg.rel);
        leg.lift = 9 * s;
      }
      return;
    }
    if (this.airborne) {
      // On the thread or mid-teleport: legs hang tucked toward the body.
      const tuck = this.mode === 'depart' ? 0.45 : 0.6;
      for (const leg of this.legs) {
        const tucked = sub(
          add(this.hip(leg, bodyDoc), fromAngle(this.heading + leg.side * leg.angle * 0.85, leg.home * tuck)),
          bodyDoc,
        );
        leg.rel = lerp(leg.rel ?? sub(leg.foot, bodyDoc), tucked, Math.min(1, dt * 16));
        leg.foot = add(bodyDoc, leg.rel);
        leg.t = -1;
        leg.lift = 6 * s;
        leg.grip = null;
      }
      return;
    }
    const m = PACE[this.look.pace] ?? 1;
    // Relative to the page: the body's own speed plus the page moving under it.
    const rel = add(this.vel, this.scrollVel);
    speed = Math.hypot(rel.x, rel.y);
    const threshold = (speed > 40 ? 16 : 10) * s;
    // Faster walk, quicker steps: a spider's stride rate climbs with speed.
    const dur = clamp(0.13 - speed / 5000, 0.05, 0.13) / Math.sqrt(m);
    const stepping = [0, 0];
    for (const leg of this.legs) if (leg.t >= 0) stepping[leg.group]++;

    for (const leg of this.legs) {
      const hip = this.hip(leg, bodyDoc);
      if (leg.t >= 0) {
        leg.t += dt / leg.dur;
        if (leg.t >= 1) {
          leg.t = -1;
          stepping[leg.group]--;
          const g = this.grip(leg.to);
          // Snapping to a word's edge must not push the foot past the leg either.
          leg.foot = clampLen(hip, g.p, this.reach(leg) * 0.99);
          leg.grip = g.rect;
          leg.lift = 0;
        } else {
          // The body keeps moving under a lifted foot: it stays within reach the whole swing.
          leg.foot = clampLen(hip, lerp(leg.from, leg.to, easeInOut(leg.t)), this.reach(leg) * 0.99);
          leg.lift = Math.sin(Math.PI * leg.t) * (speed > 300 ? 11 : 8) * s;
        }
        continue;
      }
      // A planted foot never ends up beyond the leg: on a page moving faster
      // than the gait it slips along at full reach until its next step.
      leg.foot = clampLen(hip, leg.foot, this.reach(leg) * 0.99);
      // Step a little ahead of the motion, capped: a decelerating body must not throw its feet forward.
      const lead = clampLen(vec(0, 0), mul(rel, 0.07), 14 * s);
      const ideal = add(this.idealFoot(leg, bodyDoc, 0), lead);
      const off = dist(leg.foot, ideal);
      const stretch = dist(leg.foot, hip) / this.reach(leg);
      const urgent = stretch > 0.95 || off > threshold * 2.4;
      const tidy = speed < 15 && off > 6 * s && now - leg.lastStep > 450 && stepping[0] + stepping[1] === 0;
      // Groups alternate; past a brisk walk they may overlap so the feet keep up.
      const turn = (stepping[1 - leg.group] === 0 || speed > 220 * s) && stepping[leg.group] < 4;
      if ((off > threshold && turn) || urgent || tidy) {
        if (leg.grip && this.look.marks === 'feet') this.released.push({ rect: leg.grip, born: now, hue: this.hue() });
        leg.grip = null;
        // Never start a step from a point the leg cannot reach.
        leg.from = clampLen(hip, leg.foot, this.reach(leg) * 0.98);
        leg.to = clampLen(hip, add(ideal, clampLen(vec(0, 0), mul(rel, dur), 10 * s)), this.reach(leg) * 0.95);
        leg.t = 0;
        leg.dur = dur;
        leg.lastStep = now;
        stepping[leg.group]++;
      }
    }
  }

  private stepHands(dt: number, now: number): void {
    const s = this.look.size;
    const f = fromAngle(this.heading);
    const rate = Math.min(1, dt * 20);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const lat = fromAngle(this.heading + side * (Math.PI / 2));
      const rest = add(this.body, add(mul(f, (HAND.along + 9) * s), mul(lat, 4.5 * s)));
      let goal: V;
      let r = rate;
      const hm = this.handMode;
      if (hm.kind === 'rest') {
        goal = rest;
      } else if (hm.kind === 'reach') {
        goal = add(hm.p, mul(lat, 2.5 * s));
      } else if (hm.kind === 'read') {
        // Feeling the text: one hand touches while the other lifts, in turns.
        const phase = Math.sin(now / 140 + (i ? Math.PI : 0));
        goal = add(add(hm.p, mul(lat, 3 * s)), mul(f, -Math.max(0, phase) * 4 * s));
      } else if (hm.kind === 'type') {
        const phase = this.reducedMotion ? 0 : Math.sin(now / 55 + (i ? Math.PI : 0));
        goal = add(add(hm.p, mul(lat, 3 * s)), mul(f, -Math.max(0, phase) * 5 * s));
      } else {
        // Tap: wind up (0–60 ms), jab to contact (60–100 ms), recoil (100–260 ms).
        const t = now - hm.born;
        const point = add(hm.p, mul(lat, 2 * s));
        if (t < 60) {
          goal = sub(rest, mul(f, 4 * s));
          r = Math.min(1, dt * 30);
        } else if (t < 100) {
          goal = point;
          r = Math.min(1, dt * 60);
        } else {
          goal = sub(point, mul(f, 3 * s));
          r = Math.min(1, dt * 14);
        }
        if (t >= 100 && this.tapResolve) {
          this.hands[i] = point;
          this.ring(hm.p, 360, 4, 22);
          this.dip = mul(unit(sub(hm.p, this.body)), 3.5 * s);
          this.log({ op: 'strike', point: { ...hm.p }, body: { ...this.body } });
          this.tapResolve();
        }
        if (t > 320) this.handMode = { kind: 'reach', p: hm.p };
      }
      this.hands[i] = lerp(this.hands[i], goal, r);
    }
  }

  /** Snap a document point to the edge of the word-sized element under it. */
  private grip(pDoc: V): { p: V; rect: SpiderRect | null } {
    const q = this.toView(pDoc);
    if (q.x < 0 || q.y < 0 || q.x >= innerWidth || q.y >= innerHeight) return { p: pDoc, rect: null };
    const el = document.elementFromPoint(q.x, q.y);
    if (!el || !GRIP_TAGS.has(el.tagName)) return { p: pDoc, rect: null };
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.width > 520 || r.height > 120) return { p: pDoc, rect: null };
    const rect = { x: r.x, y: r.y, width: r.width, height: r.height };
    const edge = nearestOnRectEdge(q, rect);
    const snapped = dist(edge, q) < 8 * this.look.size ? edge : q;
    return { p: this.toDoc(snapped), rect: this.toDocRect(rect) };
  }

  private ring(p: V, dur: number, from: number, to: number, inward = false): void {
    this.rings.push({ p: this.toDoc(p), born: performance.now(), dur, from, to, inward });
  }

  // ---------- geometry for drawing and for the pose ----------

  /** Legs as drawn: hip, knee, foot in view space. Feet are clamped to reach. */
  private solveLegs(): void {
    const s = this.look.size;
    const bodyDoc = this.toDoc(add(this.body, this.dip));
    const hipZ = HIP_Z * s * (1 - 0.35 * this.crouch);
    this.drawn = this.legs.map(leg => {
      const hip = this.toView(this.hip(leg, bodyDoc));
      const footView = this.toView(leg.foot);
      const toFoot = sub(footView, hip);
      const ground = Math.hypot(toFoot.x, toFoot.y);
      const dir = unit(toFoot, fromAngle(this.heading + leg.side * leg.angle));
      const k = kneeInPlane(ground, hipZ, leg.lift, leg.femur, leg.tibia);
      const footFlat = add(hip, mul(dir, Math.min(ground, k.reach)));
      const bowDir = rot90(dir, leg.bow * leg.side);
      const knee = add(add(add(hip, mul(dir, k.along)), mul(bowDir, k.height * 0.3)), vec(0, -k.height * LIFT));
      const foot = add(footFlat, vec(0, -leg.lift * LIFT));
      return { hip, knee, foot };
    });
  }

  private maxStretch(): number {
    const bodyDoc = this.toDoc(this.body);
    let max = 0;
    for (const leg of this.legs) max = Math.max(max, dist(leg.foot, this.hip(leg, bodyDoc)) / this.reach(leg));
    return max;
  }

  // ---------- rendering ----------

  private hue(): number {
    return (190 + performance.now() / 90) % 360;
  }

  private draw(): void {
    const ctx = this.ctx;
    if (!ctx || !this.canvas) return;
    if (this.lastBox) {
      const [x0, y0, x1, y1] = this.lastBox;
      ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    }
    this.lastBox = null;
    if (!this.visible || this.mode === 'gone') return;

    const now = performance.now();
    const s = this.look.size;
    const box = new Box();
    const h = this.hue();
    const line = `hsl(${h}, 100%, 62%)`;
    const joint = `hsl(${(h + 150) % 360}, 100%, 62%)`;
    const shade = 'rgba(8, 10, 20, 0.42)';
    const lw = Math.max(0.8, s);

    // Marks under everything.
    this.released = this.released.filter(m => now - m.born < 450);
    if (this.look.marks === 'feet' && this.scale > 0.5) {
      for (const leg of this.legs) if (leg.grip && leg.t < 0) this.drawMark(ctx, leg.grip, 1, h, box, true);
      for (const m of this.released) this.drawMark(ctx, m.rect, 1 - (now - m.born) / 450, m.hue, box, true);
    }
    if (this.targetMark) {
      const age = now - this.targetMark.born;
      const alpha = age < 600 ? 1 : 1 - (age - 600) / 600;
      if (alpha <= 0) this.targetMark = null;
      else this.drawMark(ctx, this.targetMark.rect, alpha, this.targetMark.hue, box, false);
    }

    // Rings: strike contact, teleport out (expanding), teleport in (closing).
    this.rings = this.rings.filter(r => now - r.born < r.dur);
    for (const r of this.rings) {
      const t = (now - r.born) / r.dur;
      const p = this.toView(r.p);
      const radius = (r.from + (r.to - r.from) * easeInOut(t)) * s;
      ctx.save();
      ctx.globalAlpha = r.inward ? t : 1 - t;
      ctx.strokeStyle = line;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      box.add(p, Math.max(r.from, r.to) * s + 4);
    }

    // Thread.
    if (this.thread) {
      ctx.save();
      ctx.globalAlpha = this.thread.alpha;
      ctx.strokeStyle = 'rgba(235, 240, 255, 0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.thread.anchor.x, this.thread.anchor.y);
      ctx.lineTo(this.body.x, this.body.y);
      ctx.stroke();
      ctx.restore();
      box.add(this.thread.anchor, 2);
      box.add(this.body, 2);
    }

    if (this.scale <= 0.01) {
      this.lastBox = box.clip(this.canvas.width / this.dpr, this.canvas.height / this.dpr);
      return;
    }

    this.solveLegs();
    const body = add(this.body, this.dip);
    const f = fromAngle(this.heading);
    const handSegs: Array<[V, V, V]> = [];
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const hip = add(
        add(body, mul(f, HAND.along * s)),
        mul(fromAngle(this.heading + side * (Math.PI / 2)), HAND.lat * s),
      );
      const reach = (HAND.femur + HAND.tibia) * s;
      // Hands stretch a little to touch the exact point, never into a line across the page.
      const tip = clampLen(hip, this.hands[i], reach * 1.25);
      const d = dist(hip, tip);
      const grow = Math.max(1, d / reach);
      const k = kneeInPlane(d, 4 * s, 0, HAND.femur * s * grow, HAND.tibia * s * grow);
      const dir = unit(sub(tip, hip), f);
      const knee = add(add(hip, mul(dir, k.along)), vec(0, -k.height * LIFT));
      handSegs.push([hip, knee, tip]);
    }

    ctx.save();
    // Global scale about the body: teleport in/out, and the pop on arrival.
    const drawScale = this.scale * this.leapScale;
    if (drawScale !== 1) {
      ctx.translate(body.x, body.y);
      ctx.scale(drawScale, drawScale);
      ctx.translate(-body.x, -body.y);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    // Legs: femur thicker than tibia, a dark under-stroke so they read on any page.
    const strokeLegs = (extra: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = (2.6 + extra) * lw;
      ctx.beginPath();
      for (const d of this.drawn) {
        ctx.moveTo(d.hip.x, d.hip.y);
        ctx.lineTo(d.knee.x, d.knee.y);
      }
      ctx.stroke();
      ctx.lineWidth = (1.8 + extra) * lw;
      ctx.beginPath();
      for (const d of this.drawn) {
        ctx.moveTo(d.knee.x, d.knee.y);
        ctx.lineTo(d.foot.x, d.foot.y);
      }
      for (const [a, b, c] of handSegs) {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(c.x, c.y);
      }
      ctx.stroke();
    };
    strokeLegs(2, shade);
    strokeLegs(0, line);
    for (const d of this.drawn) {
      box.add(d.knee, 8 * s);
      box.add(d.foot, 8 * s);
    }
    for (const [, , tip] of handSegs) box.add(tip, 8 * s);

    // Body: abdomen behind, pedicel, head with eyes. Squash on landing,
    // stretch along fast motion.
    const speed = Math.hypot(this.vel.x, this.vel.y);
    const sinceSquash = now - this.squashAt;
    const squash = sinceSquash < 140 ? Math.sin((sinceSquash / 140) * Math.PI) * 0.12 : 0;
    const stretch = Math.min(0.12, speed / 20000);
    const along = 1 + stretch - squash;
    const across = 1 / along;
    const abd = add(this.abdomen, this.dip);
    const abdAngle = Math.atan2(body.y - abd.y, body.x - abd.x);
    const ellipse = (c: V, angle: number, rx: number, ry: number) => {
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, rx, ry, angle, 0, Math.PI * 2);
    };
    const bodyFill = 'rgba(8, 10, 20, 0.45)';
    for (const [stroke, width] of [
      [shade, 4.2],
      [line, 2],
    ] as const) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width * lw;
      ctx.beginPath();
      ctx.moveTo(abd.x, abd.y);
      ctx.lineTo(body.x, body.y);
      ctx.stroke();
      ellipse(abd, abdAngle, ABDOMEN.rx * s * along, ABDOMEN.ry * s * across);
      if (stroke === shade) {
        ctx.fillStyle = bodyFill;
        ctx.fill();
      }
      ctx.stroke();
      ellipse(body, this.heading, HEAD.rx * s * along, HEAD.ry * s * across);
      if (stroke === shade) {
        ctx.fillStyle = bodyFill;
        ctx.fill();
      }
      ctx.stroke();
    }
    // Abdomen pattern: a spine and two chevrons.
    const af = fromAngle(abdAngle);
    const al = rot90(af, 1);
    ctx.strokeStyle = joint;
    ctx.lineWidth = 1.4 * lw;
    ctx.beginPath();
    ctx.moveTo(abd.x + af.x * 6 * s, abd.y + af.y * 6 * s);
    ctx.lineTo(abd.x - af.x * 7 * s, abd.y - af.y * 7 * s);
    for (const o of [1, -3]) {
      const c = add(abd, mul(af, o * s));
      ctx.moveTo(c.x + al.x * 4 * s - af.x * 3 * s, c.y + al.y * 4 * s - af.y * 3 * s);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(c.x - al.x * 4 * s - af.x * 3 * s, c.y - al.y * 4 * s - af.y * 3 * s);
    }
    ctx.stroke();
    box.add(abd, ABDOMEN.rx * s * 1.3);
    box.add(body, HEAD.rx * s * 1.3);

    // Eyes, knees, feet, hand tips.
    ctx.fillStyle = joint;
    ctx.beginPath();
    const fl = rot90(f, 1);
    for (const [a, l, r] of [
      [4.2, 1.8, 1.6],
      [4.2, -1.8, 1.6],
      [2.6, 3.6, 1.1],
      [2.6, -3.6, 1.1],
    ] as const) {
      const e = add(add(body, mul(f, a * s)), mul(fl, l * s));
      ctx.moveTo(e.x + r * s, e.y);
      ctx.arc(e.x, e.y, r * s, 0, Math.PI * 2);
    }
    for (const d of this.drawn) {
      ctx.moveTo(d.knee.x + 2.2 * s, d.knee.y);
      ctx.arc(d.knee.x, d.knee.y, 2.2 * s, 0, Math.PI * 2);
      ctx.moveTo(d.foot.x + 2.5 * s, d.foot.y);
      ctx.arc(d.foot.x, d.foot.y, 2.5 * s, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillStyle = line;
    ctx.beginPath();
    for (const [, , tip] of handSegs) {
      ctx.moveTo(tip.x + 2 * s, tip.y);
      ctx.arc(tip.x, tip.y, 2 * s, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();

    if (drawScale > 1) box.grow(body, drawScale);
    this.lastBox = box.clip(this.canvas.width / this.dpr, this.canvas.height / this.dpr);
  }

  private drawMark(
    ctx: CanvasRenderingContext2D,
    rectDoc: SpiderRect,
    alpha: number,
    hue: number,
    box: Box,
    filled: boolean,
  ): void {
    const o = this.toView({ x: rectDoc.x, y: rectDoc.y });
    const pad = filled ? 1 : 3;
    const x = o.x - pad;
    const y = o.y - pad;
    const w = rectDoc.width + pad * 2;
    const hgt = rectDoc.height + pad * 2;
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    if (filled) {
      ctx.fillStyle = `hsla(${hue}, 100%, 60%, 0.16)`;
      ctx.fillRect(x, y, w, hgt);
    }
    ctx.strokeStyle = `hsl(${hue}, 100%, 62%)`;
    ctx.lineWidth = filled ? 1.5 : 2;
    ctx.shadowColor = `hsla(${hue}, 100%, 60%, 0.6)`;
    ctx.shadowBlur = filled ? 0 : 8;
    ctx.beginPath();
    ctx.roundRect(x, y, w, hgt, 4);
    ctx.stroke();
    ctx.restore();
    box.add({ x, y }, 12);
    box.add({ x: x + w, y: y + hgt }, 12);
  }

  // ---------- plumbing ----------

  private toDoc(p: V): V {
    return { x: p.x + scrollX, y: p.y + scrollY };
  }

  private toView(p: V): V {
    return { x: p.x - scrollX, y: p.y - scrollY };
  }

  private toDocRect(r: SpiderRect): SpiderRect {
    return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
  }

  private onBeforeUnload = (): void => {
    const place = this.place();
    void this.depart();
    this.onUnload?.(place);
  };

  private mount(): void {
    if (this.host) return;
    const host = document.createElement('browd-spider');
    const important = [
      'position:fixed',
      'inset:0',
      'width:100vw',
      'height:100vh',
      'margin:0',
      'padding:0',
      'border:0',
      'background:transparent',
      'pointer-events:none',
      'z-index:2147483647',
      'display:block',
      'contain:strict',
      'opacity:1',
      'transform:none',
      'filter:none',
    ];
    host.setAttribute('style', important.map(d => `${d} !important`).join(';'));
    const root = host.attachShadow({ mode: 'closed' });
    const canvas = document.createElement('canvas');
    canvas.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;pointer-events:none;';
    root.appendChild(canvas);
    document.documentElement.appendChild(host);
    this.host = host;
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.resize();
    addEventListener('resize', this.resize);
    // The old page keeps painting until the next one commits: long enough to
    // show the spider leaving. beforeunload (unlike unload) keeps bfcache.
    addEventListener('beforeunload', this.onBeforeUnload);
  }

  private unmount(): void {
    this.mode = 'gone';
    this.thread = null;
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.departTimer);
    this.raf = 0;
    this.lastFrame = 0;
    removeEventListener('resize', this.resize);
    removeEventListener('beforeunload', this.onBeforeUnload);
    this.host?.remove();
    this.host = null;
    this.canvas = null;
    this.ctx = null;
    this.lastBox = null;
    this.log({ op: 'gone' });
  }

  private resize = (): void => {
    if (!this.canvas) return;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(innerWidth * this.dpr);
    this.canvas.height = Math.round(innerHeight * this.dpr);
    this.ctx?.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.lastBox = null;
  };

  private clearAll(): void {
    if (this.ctx && this.canvas) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.lastBox = null;
  }

  private start(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private settleWaiter(waiter: Waiter | null, ack: Omit<SpiderAck, 'visible'>): void {
    if (!waiter) return;
    waiter.timers.forEach(t => window.clearTimeout(t));
    if (waiter === this.approachWaiter) this.approachWaiter = null;
    if (waiter === this.hideWaiter) this.hideWaiter = null;
    if (waiter === this.departWaiter) this.departWaiter = null;
    waiter.resolve(this.ack(ack));
    waiter.resolve = () => {};
  }

  private ack(a: Omit<SpiderAck, 'visible'>): SpiderAck {
    return { ...a, visible: this.visible && this.mode !== 'gone' && this.mode !== 'departed', pose: this.pose() };
  }

  private pose(): SpiderPose {
    if (this.mode !== 'gone') {
      this.syncScroll(performance.now());
      this.solveLegs();
    }
    return {
      body: { x: round(this.body.x), y: round(this.body.y) },
      heading: round(this.heading),
      mode: (this.mode === 'idle' ? `idle:${this.idle.kind}` : this.mode) + (this.dashing ? ':leap' : ''),
      scale: round(this.scale),
      abdomenLag: round(
        angleDiff(this.heading, Math.atan2(this.body.y - this.abdomen.y, this.body.x - this.abdomen.x)),
      ),
      hands: [roundV(this.hands[0]), roundV(this.hands[1])],
      feet: this.drawn.map(d => roundV(d.foot)),
      hips: this.drawn.map(d => roundV(d.hip)),
      knees: this.drawn.map(d => roundV(d.knee)),
      maxStretch: this.mode === 'gone' ? 0 : Math.round(this.maxStretch() * 100) / 100,
      speed: round(Math.hypot(this.vel.x, this.vel.y)),
    };
  }

  private log(e: Omit<SpiderEvent, 't'>): void {
    this.events.push({ t: Date.now(), ...e });
    if (this.events.length > 300) this.events.shift();
  }
}

class Box {
  x0 = Infinity;
  y0 = Infinity;
  x1 = -Infinity;
  y1 = -Infinity;
  add(p: V, pad: number): void {
    this.x0 = Math.min(this.x0, p.x - pad);
    this.y0 = Math.min(this.y0, p.y - pad);
    this.x1 = Math.max(this.x1, p.x + pad);
    this.y1 = Math.max(this.y1, p.y + pad);
  }
  /** Scale the box about `c` (the drawing was scaled about the body). */
  grow(c: V, k: number): void {
    this.x0 = c.x + (this.x0 - c.x) * k;
    this.y0 = c.y + (this.y0 - c.y) * k;
    this.x1 = c.x + (this.x1 - c.x) * k;
    this.y1 = c.y + (this.y1 - c.y) * k;
  }
  clip(w: number, h: number): [number, number, number, number] | null {
    if (this.x0 === Infinity) return null;
    return [
      Math.max(0, Math.floor(this.x0)),
      Math.max(0, Math.floor(this.y0)),
      Math.min(w, Math.ceil(this.x1)),
      Math.min(h, Math.ceil(this.y1)),
    ];
  }
}

const round = (x: number): number => Math.round(x * 10) / 10;
const roundV = (p: V): V => ({ x: round(p.x), y: round(p.y) });
