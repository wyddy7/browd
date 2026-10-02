/**
 * The agent spider: a line-drawn spider that lives in a closed shadow root
 * on top of the page while the agent works in this tab.
 *
 * - The body moves on springs in viewport coordinates; feet are planted in
 *   document coordinates, so when the agent scrolls the page the legs are
 *   dragged with the content and step — the spider walks instead of sliding.
 * - Feet grip what is under them: a step snaps to the edge of the word,
 *   link or button it lands on.
 * - Two short front appendages (pedipalps) are the hands: they tap the exact
 *   point the agent clicks, and drum on a field while the agent types.
 *
 * Contract with the page: the host element is appended once and never
 * touched again (the agent hashes `documentElement.outerHTML` around
 * coordinate clicks), everything is drawn on one canvas, nothing receives
 * pointer events, and the site's own DOM is never modified.
 */
import type { SpiderAck, SpiderEvent, SpiderLook, SpiderPoint as V, SpiderPose, SpiderRect } from '@extension/shared';
import {
  add,
  angleDiff,
  clamp,
  dist,
  fromAngle,
  lerp,
  mul,
  nearestOnRectEdge,
  solveKnee,
  springStep,
  sub,
  unit,
  vec,
} from './geometry';

type Mode = 'gone' | 'descend' | 'idle' | 'approach' | 'busy' | 'leave';

interface Leg {
  side: 1 | -1;
  group: 0 | 1;
  hipAlong: number;
  hipLat: number;
  homeAngle: number;
  homeDist: number;
  upper: number;
  lower: number;
  /** Document coordinates. */
  foot: V;
  from: V;
  to: V;
  /** Step progress 0..1, or -1 when planted. */
  t: number;
  dur: number;
  lastStep: number;
  /** Document-space rect of the element under the planted foot. */
  grip: SpiderRect | null;
}

interface Fading {
  rect: SpiderRect;
  born: number;
  hue: number;
}

interface Ripple {
  p: V;
  born: number;
}

interface Waiter {
  resolve: (ack: SpiderAck) => void;
  timers: number[];
}

const PACE = { calm: 0.7, normal: 1, fast: 1.45 } as const;
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
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'LI',
  'TD',
  'TH',
  'SELECT',
  'TEXTAREA',
  'svg',
]);

// Leg layout at size 1, front to back: hip offset along the body, rest angle
// from the heading, rest distance from the hip, bone lengths.
const LEG_LAYOUT = [
  { along: 7, angle: 0.62, home: 52, upper: 31, lower: 35 },
  { along: 3, angle: 1.28, home: 44, upper: 26, lower: 30 },
  { along: -1, angle: 1.95, home: 43, upper: 26, lower: 30 },
  { along: -5, angle: 2.55, home: 52, upper: 31, lower: 35 },
];

const HAND = { along: 13, lat: 3, upper: 8, lower: 9 };
const HAND_TIP = HAND.along + 14;

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
  private legs: Leg[] = [];
  private airborne = true;
  private thread: { anchor: V; alpha: number } | null = null;

  private hands: [V, V] = [vec(0, 0), vec(0, 0)];
  private handMode:
    | { kind: 'rest' }
    | { kind: 'reach'; p: V }
    | { kind: 'type'; p: V }
    | { kind: 'tap'; p: V; born: number } = { kind: 'rest' };
  private tapResolve: (() => void) | null = null;

  private targetMark: Fading | null = null;
  private released: Fading[] = [];
  private ripples: Ripple[] = [];

  private nextWander = 0;
  private busyUntil = 0;
  private approachWaiter: Waiter | null = null;
  private hideWaiter: Waiter | null = null;
  private events: SpiderEvent[] = [];

  constructor() {
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  get spawned(): boolean {
    return this.mode !== 'gone';
  }

  // ---------- commands ----------

  spawn(look: SpiderLook, at?: V): SpiderAck {
    this.look = { ...look };
    if (this.mode !== 'gone' && this.mode !== 'leave') {
      return this.ack({ ok: true });
    }
    this.mount();
    const vw = innerWidth;
    const vh = innerHeight;
    const x = clamp(at?.x ?? vw * 0.62, 60, vw - 60);
    const y = clamp(at?.y ?? vh * 0.38, 90, vh - 60);
    this.heading = Math.PI / 2;
    this.angVel = 0;
    this.vel = vec(0, 0);
    this.target = vec(x, y);
    this.faceTo = null;
    this.handMode = { kind: 'rest' };
    this.body = this.reducedMotion ? vec(x, y) : vec(x, -60 * this.look.size);
    this.legs = this.buildLegs();
    this.hands = [this.headTip(), this.headTip()];
    if (this.reducedMotion) {
      this.mode = 'idle';
      this.land();
    } else {
      this.mode = 'descend';
      this.airborne = true;
      this.thread = { anchor: vec(x, -20), alpha: 1 };
    }
    this.log({ op: 'spawn', body: { ...this.target } });
    this.start();
    return this.ack({ ok: true });
  }

  tune(look: SpiderLook): SpiderAck {
    const resized = look.size !== this.look.size;
    this.look = { ...look };
    if (resized && this.spawned) {
      const feet = this.legs.map(l => l.foot);
      this.legs = this.buildLegs();
      this.legs.forEach((l, i) => (l.foot = feet[i] ?? l.foot));
    }
    return this.ack({ ok: true });
  }

  approach(point: V, rect: SpiderRect | undefined, capMs: number): Promise<SpiderAck> {
    if (!this.spawned || this.mode === 'leave') {
      return Promise.resolve(this.ack({ ok: false, reason: 'not-spawned' }));
    }
    this.settleWaiter(this.approachWaiter, { ok: true, arrived: false, reason: 'cap' });
    const s = this.look.size;
    const from = this.body;
    const toPoint = sub(point, from);
    const dir = Math.hypot(toPoint.x, toPoint.y) < 30 * s ? fromAngle(this.heading) : unit(toPoint);
    const vw = innerWidth;
    const vh = innerHeight;
    const goal = sub(point, mul(dir, HAND_TIP * s));
    this.target = vec(clamp(goal.x, 16, vw - 16), clamp(goal.y, 16, vh - 16));
    this.faceTo = { ...point };
    this.mode = 'approach';
    this.handMode = { kind: 'rest' };
    this.thread = this.thread && { ...this.thread, alpha: Math.min(this.thread.alpha, 0.6) };
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
    if (this.arrived()) {
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
    this.mode = 'busy';
    this.busyUntil = performance.now() + 700;
    this.faceTo = { ...point };
    if (this.reducedMotion || document.hidden || !this.raf) {
      this.ripples.push({ p: this.toDoc(point), born: performance.now() });
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
      const fallback = window.setTimeout(done, 220);
      this.tapResolve = done;
      this.handMode = { kind: 'tap', p: { ...point }, born: performance.now() };
    });
  }

  typing(on: boolean): SpiderAck {
    if (!this.spawned) return this.ack({ ok: false, reason: 'not-spawned' });
    if (on) {
      const p = this.handMode.kind === 'rest' ? (this.faceTo ?? this.headTip()) : this.handMode.p;
      this.handMode = { kind: 'type', p: { ...p } };
      this.mode = 'busy';
      this.busyUntil = Infinity;
    } else {
      this.handMode = { kind: 'rest' };
      this.busyUntil = performance.now() + 500;
    }
    this.log({ op: on ? 'typing-on' : 'typing-off' });
    return this.ack({ ok: true });
  }

  scroll(dy: number): SpiderAck {
    if (!this.spawned) return this.ack({ ok: false, reason: 'not-spawned' });
    // Lean against the scroll; the planted feet do the rest as the page moves.
    this.vel.y += clamp(-dy, -600, 600) * 0.35;
    this.log({ op: 'scroll' });
    return this.ack({ ok: true });
  }

  hide(): Promise<SpiderAck> {
    this.visible = false;
    if (this.canvas) this.canvas.style.visibility = 'hidden';
    this.clearAll();
    this.log({ op: 'hide' });
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
    if (this.reducedMotion || document.hidden) {
      this.unmount();
      return this.ack({ ok: true });
    }
    this.mode = 'leave';
    this.handMode = { kind: 'rest' };
    this.airborne = true;
    this.thread = { anchor: vec(this.body.x, -20), alpha: 1 };
    this.target = vec(this.body.x, -140 * this.look.size);
    return this.ack({ ok: true });
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
        const foot = this.toDoc(add(this.body, fromAngle(this.heading + side * l.angle, l.home * s)));
        legs.push({
          side,
          // Alternating tetrapod gait: L1 R2 L3 R4 against R1 L2 R3 L4.
          group: ((i + (side === 1 ? 0 : 1)) % 2) as 0 | 1,
          hipAlong: l.along * s,
          hipLat: 4 * s,
          homeAngle: l.angle,
          homeDist: l.home * s,
          upper: l.upper * s,
          lower: l.lower * s,
          foot,
          from: foot,
          to: foot,
          t: -1,
          dur: 0.14,
          lastStep: 0,
          grip: null,
        });
      });
    }
    return legs;
  }

  private hip(leg: Leg, bodyDoc: V): V {
    const f = fromAngle(this.heading);
    const lat = fromAngle(this.heading + leg.side * (Math.PI / 2));
    return add(add(bodyDoc, mul(f, leg.hipAlong)), mul(lat, leg.hipLat));
  }

  private idealFoot(leg: Leg, bodyDoc: V, lead: number): V {
    const home = add(this.hip(leg, bodyDoc), fromAngle(this.heading + leg.side * leg.homeAngle, leg.homeDist));
    return add(home, mul(this.vel, lead));
  }

  private land(): void {
    this.airborne = false;
    const bodyDoc = this.toDoc(this.body);
    for (const leg of this.legs) {
      const p = this.grip(this.idealFoot(leg, bodyDoc, 0));
      leg.foot = p.p;
      leg.grip = p.rect;
      leg.t = -1;
    }
  }

  private teleport(): void {
    this.body = { ...this.target };
    this.vel = vec(0, 0);
    if (this.faceTo) this.heading = Math.atan2(this.faceTo.y - this.body.y, this.faceTo.x - this.body.x);
    this.thread = null;
    this.land();
    this.mode = 'busy';
    this.draw();
  }

  private arrived(): boolean {
    return dist(this.body, this.target) < 4 * this.look.size && Math.hypot(this.vel.x, this.vel.y) < 60;
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

    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let i = 0; i < steps; i++) this.step(dt / steps, now);
    this.draw();
  };

  private step(dt: number, now: number): void {
    const m = PACE[this.look.pace] ?? 1;
    const s = this.look.size;

    if (this.mode === 'idle' && now > this.nextWander && !this.reducedMotion) this.pickWander(now);
    if (this.mode === 'busy' && now > this.busyUntil && this.handMode.kind !== 'type') {
      this.mode = 'idle';
      this.faceTo = null;
      this.nextWander = now + 400 / m;
    }

    // Body spring. Approach: ~0.5 s flight (stiffness 150, damping 23).
    let k = 30 * m * m;
    let c = 10.5 * m;
    let vmax = 240 * m * s;
    if (this.mode === 'approach' || this.mode === 'busy') {
      k = 150 * m * m;
      c = 23 * m;
      vmax = 2400 * m;
    } else if (this.mode === 'descend' || this.mode === 'leave') {
      k = 55 * m * m;
      c = 13 * m;
      vmax = 1400 * m;
    }
    springStep(this.body, this.vel, this.target, k, c, dt, vmax);
    const speed = Math.hypot(this.vel.x, this.vel.y);

    // Heading: face the motion while moving, face the target point near it.
    let want = this.heading;
    const near = this.faceTo && dist(this.body, this.target) < 60 * s;
    if (this.faceTo && (near || this.mode === 'busy')) {
      want = Math.atan2(this.faceTo.y - this.body.y, this.faceTo.x - this.body.x);
    } else if (this.mode === 'descend' || this.mode === 'leave') {
      want = this.mode === 'descend' ? Math.PI / 2 : -Math.PI / 2;
    } else if (speed > 30) {
      want = Math.atan2(this.vel.y, this.vel.x);
    }
    const ka = 70 * m;
    const ca = 15 * Math.sqrt(m);
    this.angVel += (ka * angleDiff(this.heading, want) - ca * this.angVel) * dt;
    this.heading += this.angVel * dt;

    // Thread.
    if (this.mode === 'descend' && dist(this.body, this.target) < 6 * s && speed < 80) {
      this.mode = 'idle';
      this.nextWander = now + 900 / m;
      this.land();
      this.log({ op: 'landed', body: { ...this.body } });
    }
    if (this.thread && this.mode !== 'descend' && this.mode !== 'leave') {
      this.thread.alpha -= dt * 2;
      if (this.thread.alpha <= 0) this.thread = null;
    }
    if (this.mode === 'leave' && this.body.y < -90 * s) {
      this.unmount();
      return;
    }

    // Arrival of an approach.
    if (this.mode === 'approach' && this.arrived()) {
      this.mode = 'busy';
      this.busyUntil = now + 1500;
      this.handMode = this.faceTo ? { kind: 'reach', p: { ...this.faceTo } } : { kind: 'rest' };
      this.log({ op: 'arrive', arrived: true, body: { ...this.body } });
      this.settleWaiter(this.approachWaiter, { ok: true, arrived: true });
    }

    this.stepLegs(dt, now, speed);
    this.stepHands(dt, now);
  }

  private stepLegs(dt: number, now: number, speed: number): void {
    const s = this.look.size;
    const bodyDoc = this.toDoc(this.body);
    if (this.airborne) {
      // Dangling on the thread: legs hang tucked toward the body.
      for (const leg of this.legs) {
        const tucked = add(
          this.hip(leg, bodyDoc),
          fromAngle(this.heading + leg.side * (leg.homeAngle * 0.8), leg.homeDist * 0.62),
        );
        leg.foot = lerp(leg.foot, add(tucked, vec(0, 6 * s)), Math.min(1, dt * 14));
        leg.t = -1;
        leg.grip = null;
      }
      return;
    }
    const m = PACE[this.look.pace] ?? 1;
    const threshold = (speed > 40 ? 20 : 11) * s;
    const dur = clamp(0.15 - speed / 18000, 0.065, 0.15) / Math.sqrt(m);
    const stepping = [0, 0];
    for (const leg of this.legs) if (leg.t >= 0) stepping[leg.group]++;

    for (const leg of this.legs) {
      if (leg.t >= 0) {
        leg.t += dt / leg.dur;
        if (leg.t >= 1) {
          leg.t = -1;
          leg.foot = leg.to;
          stepping[leg.group]--;
          const g = this.grip(leg.to);
          leg.foot = g.p;
          leg.grip = g.rect;
        } else {
          leg.foot = lerp(leg.from, leg.to, easeInOut(leg.t));
        }
        continue;
      }
      const ideal = this.idealFoot(leg, bodyDoc, 0.1);
      const off = dist(leg.foot, ideal);
      const stretch = dist(leg.foot, this.hip(leg, bodyDoc));
      const urgent = stretch > (leg.upper + leg.lower) * 0.97 || off > threshold * 2.4;
      const tidy = speed < 15 && off > 6 * s && now - leg.lastStep > 450 && stepping[0] + stepping[1] === 0;
      const turn = stepping[1 - leg.group] === 0 && stepping[leg.group] < 4;
      if ((off > threshold && turn) || urgent || tidy) {
        if (leg.grip && this.look.marks === 'feet') this.released.push({ rect: leg.grip, born: now, hue: this.hue() });
        leg.grip = null;
        leg.from = leg.foot;
        leg.to = add(ideal, mul(this.vel, dur * 0.9));
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
    const rate = Math.min(1, dt * 22);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const lat = fromAngle(this.heading + side * (Math.PI / 2));
      let goal: V;
      const hm = this.handMode;
      if (hm.kind === 'rest') {
        goal = add(this.body, add(mul(f, (HAND.along + 9) * s), mul(lat, 5 * s)));
      } else if (hm.kind === 'reach') {
        goal = add(hm.p, mul(lat, 2.5 * s));
      } else if (hm.kind === 'type') {
        const phase = this.reducedMotion ? 0 : Math.sin(now / 55 + (i ? Math.PI : 0));
        goal = add(add(hm.p, mul(lat, 3 * s)), mul(f, -Math.max(0, phase) * 5 * s));
      } else {
        // Tap: lunge in, contact at 90 ms, back out by 200 ms.
        const t = (now - hm.born) / 1000;
        const pull = t < 0.09 ? 0 : Math.min(1, (t - 0.09) / 0.11) * 4 * s;
        goal = add(add(hm.p, mul(lat, 2 * s)), mul(f, -pull));
        if (t >= 0.09 && this.tapResolve) {
          this.ripples.push({ p: this.toDoc(hm.p), born: now });
          this.log({ op: 'strike', point: { ...hm.p }, body: { ...this.body } });
          this.tapResolve();
        }
        if (t > 0.3) this.handMode = { kind: 'reach', p: hm.p };
      }
      const r = hm.kind === 'tap' ? Math.min(1, dt * 40) : rate;
      this.hands[i] = lerp(this.hands[i], goal, r);
    }
  }

  private pickWander(now: number): void {
    const s = this.look.size;
    const m = PACE[this.look.pace] ?? 1;
    const vw = innerWidth;
    const vh = innerHeight;
    let best: V | null = null;
    let bestScore = -Infinity;
    for (let i = 0; i < 7; i++) {
      const a = this.heading + (Math.random() - 0.5) * Math.PI * 1.6;
      const d = (60 + Math.random() * 150) * s;
      const p = add(this.body, fromAngle(a, d));
      if (p.x < 50 || p.y < 50 || p.x > vw - 50 || p.y > vh - 50) continue;
      const el = document.elementFromPoint(p.x, p.y);
      const score = (el && GRIP_TAGS.has(el.tagName) ? 1 : 0) + 0.4 * Math.cos(angleDiff(this.heading, a));
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    // Boxed in near an edge: drift back toward the middle.
    this.target = best ?? lerp(this.body, vec(vw / 2, vh / 2), 0.3);
    this.nextWander = now + (1300 + Math.random() * 1500) / m;
  }

  /** Snap a document point to the edge of the element under it, when it is word-sized. */
  private grip(pDoc: V): { p: V; rect: SpiderRect | null } {
    const q = this.toView(pDoc);
    if (q.x < 0 || q.y < 0 || q.x >= innerWidth || q.y >= innerHeight) return { p: pDoc, rect: null };
    const el = document.elementFromPoint(q.x, q.y);
    if (!el || !GRIP_TAGS.has(el.tagName)) return { p: pDoc, rect: null };
    const r = el.getBoundingClientRect();
    if (r.width < 4 || r.width > 520 || r.height > 120) return { p: pDoc, rect: null };
    const rect = { x: r.x, y: r.y, width: r.width, height: r.height };
    const edge = nearestOnRectEdge(q, rect);
    const snapped = dist(edge, q) < 12 * this.look.size ? edge : q;
    return { p: this.toDoc(snapped), rect: this.toDocRect(rect) };
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
    const bodyView = this.body;

    // Marks under everything.
    this.released = this.released.filter(m => now - m.born < 450);
    if (this.look.marks === 'feet') {
      for (const leg of this.legs) if (leg.grip && leg.t < 0) this.drawMark(ctx, leg.grip, 1, h, box, true);
      for (const m of this.released) this.drawMark(ctx, m.rect, 1 - (now - m.born) / 450, m.hue, box, true);
    }
    if (this.targetMark) {
      const age = now - this.targetMark.born;
      const alpha = age < 600 ? 1 : 1 - (age - 600) / 600;
      if (alpha <= 0) this.targetMark = null;
      else this.drawMark(ctx, this.targetMark.rect, alpha, this.targetMark.hue, box, false);
    }

    // Thread.
    if (this.thread) {
      ctx.save();
      ctx.globalAlpha = this.thread.alpha;
      ctx.strokeStyle = 'rgba(235, 240, 255, 0.85)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.thread.anchor.x, this.thread.anchor.y);
      ctx.lineTo(bodyView.x, bodyView.y);
      ctx.stroke();
      ctx.restore();
      box.add(this.thread.anchor, 2);
      box.add(bodyView, 2);
    }

    // Legs: compute geometry in view space.
    const segs: Array<[V, V, V]> = [];
    const bodyDoc = this.toDoc(bodyView);
    for (const leg of this.legs) {
      const hip = this.toView(this.hip(leg, bodyDoc));
      let foot = this.toView(leg.foot);
      if (leg.t >= 0) foot = lerp(foot, hip, Math.sin(Math.PI * leg.t) * 0.14);
      const knee = solveKnee(hip, foot, leg.upper, leg.lower, bodyView);
      segs.push([hip, knee, foot]);
      box.add(hip, 6);
      box.add(knee, 6);
      box.add(foot, 6);
    }
    const f = fromAngle(this.heading);
    const handSegs: Array<[V, V, V]> = [];
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const hip = add(
        add(bodyView, mul(f, HAND.along * s)),
        mul(fromAngle(this.heading + side * (Math.PI / 2)), HAND.lat * s),
      );
      const tip = this.hands[i];
      const reach = (HAND.upper + HAND.lower) * s;
      // Hands may stretch past their rest length to touch the exact point.
      const stretch = Math.max(1, dist(hip, tip) / reach);
      const knee = solveKnee(hip, tip, HAND.upper * s * stretch, HAND.lower * s * stretch, bodyView);
      handSegs.push([hip, knee, tip]);
      box.add(knee, 6);
      box.add(tip, 6);
    }

    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const strokeAll = (width: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = width;
      ctx.beginPath();
      for (const [a, b, c] of [...segs, ...handSegs]) {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(c.x, c.y);
      }
      ctx.stroke();
    };
    strokeAll(4 * Math.max(0.8, s), shade);
    strokeAll(2 * Math.max(0.8, s), line);

    // Body: a long rectangle with an eye dot, as in the reference.
    ctx.save();
    ctx.translate(bodyView.x, bodyView.y);
    ctx.rotate(this.heading);
    const L = 28 * s;
    const W = 11 * s;
    ctx.fillStyle = 'rgba(8, 10, 20, 0.35)';
    ctx.fillRect(-L / 2, -W / 2, L, W);
    ctx.strokeStyle = shade;
    ctx.lineWidth = 4 * Math.max(0.8, s);
    ctx.strokeRect(-L / 2, -W / 2, L, W);
    ctx.strokeStyle = line;
    ctx.lineWidth = 2 * Math.max(0.8, s);
    ctx.strokeRect(-L / 2, -W / 2, L, W);
    ctx.fillStyle = joint;
    ctx.beginPath();
    ctx.arc(L / 2 - 4 * s, 0, 2.6 * s, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
    box.add(bodyView, L);

    // Joints and feet.
    ctx.fillStyle = joint;
    ctx.beginPath();
    for (const [, knee, foot] of segs) {
      ctx.moveTo(knee.x + 2.4 * s, knee.y);
      ctx.arc(knee.x, knee.y, 2.4 * s, 0, Math.PI * 2);
      ctx.moveTo(foot.x + 2.8 * s, foot.y);
      ctx.arc(foot.x, foot.y, 2.8 * s, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillStyle = line;
    ctx.beginPath();
    for (const [, , tip] of handSegs) {
      ctx.moveTo(tip.x + 2.2 * s, tip.y);
      ctx.arc(tip.x, tip.y, 2.2 * s, 0, Math.PI * 2);
    }
    ctx.fill();

    // Ripples where a hand struck.
    this.ripples = this.ripples.filter(r => now - r.born < 380);
    for (const r of this.ripples) {
      const t = (now - r.born) / 380;
      const p = this.toView(r.p);
      ctx.save();
      ctx.globalAlpha = 1 - t;
      ctx.strokeStyle = line;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, (4 + 20 * t) * s, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      box.add(p, 26 * s);
    }

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
  }

  private unmount(): void {
    this.mode = 'gone';
    this.thread = null;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
    this.lastFrame = 0;
    removeEventListener('resize', this.resize);
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
    waiter.resolve(this.ack(ack));
    waiter.resolve = () => {};
  }

  private ack(a: Omit<SpiderAck, 'visible'>): SpiderAck {
    return { ...a, visible: this.visible && this.mode !== 'gone', pose: this.pose() };
  }

  private pose(): SpiderPose {
    return {
      body: { x: round(this.body.x), y: round(this.body.y) },
      heading: round(this.heading),
      hands: [roundV(this.hands[0]), roundV(this.hands[1])],
      feet: this.legs.map(l => roundV(this.toView(l.foot))),
      speed: round(Math.hypot(this.vel.x, this.vel.y)),
    };
  }

  private log(e: Omit<SpiderEvent, 't'>): void {
    this.events.push({ t: Date.now(), ...e });
    if (this.events.length > 200) this.events.shift();
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

const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const round = (x: number): number => Math.round(x * 10) / 10;
const roundV = (p: V): V => ({ x: round(p.x), y: round(p.y) });
