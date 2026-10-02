/**
 * The agent spider, as the content script sees it: the command API the
 * background calls, the mode machine (enter, free, approach, busy, depart,
 * leave) and the frame loop. The body is `Rig`, the behaviour between
 * commands is `Brain`, torn-out words are `Stickers`, the canvas is
 * `Overlay` — this file only wires them.
 *
 * Contract with the page: one host element on <html>, appended once and
 * never touched again; everything drawn on one canvas; nothing takes pointer
 * events; the site's DOM is never modified.
 */
import type {
  SpiderAck,
  SpiderArrival,
  SpiderEvent,
  SpiderLook,
  SpiderMood,
  SpiderPlace,
  SpiderPoint as V,
  SpiderRect,
} from '@extension/shared';
import { Brain } from './brain';
import { clamp, dist, easeIn, easeOutBack, fromAngle, mul, sub, unit, vec } from './geometry';
import { Box, Overlay } from './overlay';
import { palette } from './palette';
import { type Control, HAND_TIP, Rig } from './rig';
import { Stickers } from './stickers';

type Mode = 'gone' | 'descend' | 'arrive' | 'free' | 'approach' | 'busy' | 'depart' | 'departed' | 'leave';

interface Waiter {
  resolve: (ack: SpiderAck) => void;
  timers: number[];
}

const PACE = { calm: 0.72, normal: 1, fast: 1.4 } as const;

export class Spider {
  private readonly overlay = new Overlay(() => this.onBeforeUnload());
  private readonly rig = new Rig();
  private readonly stickers = new Stickers();
  private readonly brain: Brain;
  private readonly reducedMotion: boolean;

  private look: SpiderLook = { size: 1, pace: 'normal', marks: 'target', color: 'violet', tear: true };
  private mode: Mode = 'gone';
  private modeAt = 0;
  private visible = true;
  private raf = 0;
  private lastFrame = 0;
  private frameCount = 0;
  private frames: number[] = [];

  private target = vec(0, 0);
  private faceTo: V | null = null;
  private dartFrom = vec(0, 0);
  private dartAnticipate = false;
  private busyUntil = 0;
  private leavePending = false;
  private departTimer = 0;

  private targetMark: { rect: SpiderRect; born: number } | null = null;
  private approachWaiter: Waiter | null = null;
  private departWaiter: Waiter | null = null;
  private tapResolve: (() => void) | null = null;
  private events: SpiderEvent[] = [];

  /** Called with the spider's place when the page starts to unload. */
  onUnload: ((place: SpiderPlace) => void) | null = null;

  constructor() {
    this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.brain = new Brain(this.rig, this.stickers, e => this.log(e), this.reducedMotion);
  }

  get spawned(): boolean {
    return this.mode !== 'gone';
  }

  place(): SpiderPlace {
    const r = (x: number) => Math.round(x * 10) / 10;
    return { x: r(this.rig.body.x), y: r(this.rig.body.y), heading: r(this.rig.heading) };
  }

  // ---------- commands ----------

  spawn(look: SpiderLook, at?: SpiderPlace, arrive: SpiderArrival = 'descend'): SpiderAck {
    this.applyLook(look);
    if (this.mode !== 'gone' && this.mode !== 'leave' && this.mode !== 'departed') return this.ack({ ok: true });
    this.overlay.mount();
    const x = clamp(at?.x ?? innerWidth * 0.62, 50, innerWidth - 50);
    const y = clamp(at?.y ?? innerHeight * 0.4, 70, innerHeight - 50);
    const teleport = arrive === 'teleport';
    const heading = teleport && at ? at.heading : Math.PI / 2;
    const start = this.reducedMotion || teleport ? vec(x, y) : vec(x, -80 * this.look.size);
    this.rig.place(start, heading, this.look.size);
    this.rig.scale = 1;
    this.rig.crouch = 0;
    this.target = vec(x, y);
    this.faceTo = null;
    this.leavePending = false;
    this.stickers.clear();
    window.clearTimeout(this.departTimer);
    this.brain.interrupt(performance.now());
    if (this.reducedMotion) {
      this.setMode('free');
      this.rig.land();
    } else if (teleport) {
      this.setMode('arrive');
      this.rig.scale = 0;
      this.rig.airborne = true;
      this.rig.thread = null;
      this.rig.ring(this.rig.body, 140, 30, 4, true);
    } else {
      this.setMode('descend');
      this.rig.airborne = true;
      this.rig.thread = { anchor: vec(x, -20), alpha: 1 };
    }
    this.log({ op: teleport ? 'spawn-teleport' : 'spawn', body: { x, y } });
    this.start();
    return this.ack({ ok: true });
  }

  tune(look: SpiderLook): SpiderAck {
    const resized = look.size !== this.look.size;
    this.applyLook(look);
    if (resized && this.spawned) this.rig.resize(look.size);
    return this.ack({ ok: true });
  }

  mood(mood: SpiderMood): SpiderAck {
    this.brain.setMood(mood, performance.now());
    return this.ack({ ok: true });
  }

  focus(words: string[]): SpiderAck {
    this.brain.setFocus(words);
    return this.ack({ ok: true });
  }

  approach(point: V, rect: SpiderRect | undefined, capMs: number): Promise<SpiderAck> {
    if (!this.spawned || this.mode === 'leave') return Promise.resolve(this.ack({ ok: false, reason: 'not-spawned' }));
    if (this.mode === 'departed' || this.mode === 'depart') this.reappear();
    this.settleWaiter(this.approachWaiter, { ok: true, arrived: false, reason: 'cap' });
    const now = performance.now();
    this.brain.interrupt(now);
    const s = this.look.size;
    const body = this.rig.body;
    const far = dist(point, body);
    const dir = far < 30 * s ? fromAngle(this.rig.heading) : unit(sub(point, body));
    const goal = sub(point, mul(dir, HAND_TIP * s));
    this.target = vec(clamp(goal.x, 16, innerWidth - 16), clamp(goal.y, 16, innerHeight - 16));
    this.faceTo = { ...point };
    if (this.mode !== 'arrive') this.setMode('approach');
    this.dartFrom = { ...body };
    this.dartAnticipate = far > 120 * s && !this.rig.airborne;
    this.rig.handMode = { kind: 'rest' };
    if (this.rig.thread) this.rig.thread.alpha = Math.min(this.rig.thread.alpha, 0.6);
    if (rect && this.look.marks === 'target') this.targetMark = { rect: this.docRect(rect), born: Infinity };
    this.log({ op: 'approach', point: { ...point }, body: { ...body } });

    if (this.reducedMotion || document.hidden) {
      this.jump();
      this.log({ op: 'arrive', arrived: false, body: { ...this.rig.body } });
      const reason = this.reducedMotion ? 'reduced-motion' : 'hidden';
      return Promise.resolve(this.ack({ ok: true, arrived: false, reason }));
    }
    if (this.mode === 'approach' && this.arrived()) {
      this.setMode('busy');
      this.busyUntil = now + 1500;
      this.log({ op: 'arrive', arrived: true, body: { ...this.rig.body } });
      return Promise.resolve(this.ack({ ok: true, arrived: true }));
    }
    return new Promise(resolve => {
      const framesAtStart = this.frameCount;
      const waiter: Waiter = { resolve, timers: [] };
      waiter.timers.push(
        window.setTimeout(() => {
          // No animation frame within 150 ms: the tab is throttled. Jump.
          if (this.frameCount === framesAtStart) {
            this.jump();
            this.log({ op: 'arrive', arrived: false, body: { ...this.rig.body } });
            this.settleWaiter(waiter, { ok: true, arrived: false, reason: 'no-frames' });
          }
        }, 150),
        window.setTimeout(() => {
          this.log({ op: 'arrive', arrived: false, body: { ...this.rig.body } });
          this.settleWaiter(waiter, { ok: true, arrived: false, reason: 'cap' });
        }, capMs),
      );
      this.approachWaiter = waiter;
    });
  }

  strike(point: V, rect?: SpiderRect): Promise<SpiderAck> {
    if (!this.spawned) return Promise.resolve(this.ack({ ok: false, reason: 'not-spawned' }));
    const now = performance.now();
    if (rect && this.look.marks === 'target') this.targetMark = { rect: this.docRect(rect), born: now };
    else if (this.targetMark) this.targetMark.born = now;
    if (this.mode !== 'arrive') this.setMode('busy');
    this.busyUntil = now + 800;
    this.faceTo = { ...point };
    if (this.reducedMotion || document.hidden || !this.raf) {
      this.rig.ring(point, 260, 4, 22);
      this.log({ op: 'strike', point: { ...point }, body: { ...this.rig.body } });
      this.draw();
      return Promise.resolve(this.ack({ ok: true }));
    }
    return new Promise(resolve => {
      const done = () => {
        window.clearTimeout(fallback);
        this.tapResolve = null;
        this.rig.onContact = null;
        resolve(this.ack({ ok: true }));
      };
      const fallback = window.setTimeout(done, 260);
      this.tapResolve = done;
      this.rig.onContact = p => {
        this.log({ op: 'strike', point: { ...p }, body: { ...this.rig.body } });
        this.tapResolve?.();
      };
      this.rig.handMode = { kind: 'tap', p: { ...point }, born: now };
    });
  }

  typing(on: boolean): SpiderAck {
    if (!this.spawned) return this.ack({ ok: false, reason: 'not-spawned' });
    if (on) {
      const hm = this.rig.handMode;
      const p = 'p' in hm ? hm.p : (this.faceTo ?? this.rig.headTip());
      this.rig.handMode = { kind: 'type', p: { ...p } };
      this.setMode('busy');
      this.busyUntil = Infinity;
    } else {
      this.rig.handMode = this.faceTo ? { kind: 'reach', p: this.faceTo } : { kind: 'rest' };
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
    this.overlay.setVisible(false);
    this.log({ op: 'hide', body: { ...this.rig.body } });
    if (!this.raf || document.hidden) return Promise.resolve(this.ack({ ok: true }));
    // Resolve after two presented frames so the cleared canvas is on screen
    // before the background captures it.
    return new Promise(resolve => {
      let n = 0;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(this.ack({ ok: true }));
      };
      const step = () => {
        if (++n >= 2) finish();
        else requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
      window.setTimeout(finish, 80);
    });
  }

  show(): SpiderAck {
    this.visible = true;
    this.overlay.setVisible(true);
    this.log({ op: 'show' });
    return this.ack({ ok: true });
  }

  leave(): SpiderAck {
    if (!this.spawned) return this.ack({ ok: true });
    this.settleWaiter(this.approachWaiter, { ok: true, arrived: false, reason: 'not-spawned' });
    // Let the done/failed gesture finish first.
    const now = performance.now();
    if (!this.brain.gestureDone(now) && this.mode === 'free' && !this.reducedMotion && !document.hidden) {
      this.leavePending = true;
      window.setTimeout(() => this.leaveNow(), 900);
      return this.ack({ ok: true });
    }
    this.leaveNow();
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
    this.brain.interrupt(performance.now());
    this.stickers.clear();
    this.log({ op: 'depart', body: { ...this.rig.body } });
    if (this.reducedMotion || document.hidden || !this.raf) {
      this.setMode('departed');
      this.rig.scale = 0;
      this.draw();
      this.armReappear();
      return Promise.resolve(this.ack({ ok: true }));
    }
    this.setMode('depart');
    this.rig.handMode = { kind: 'rest' };
    return new Promise(resolve => {
      const waiter: Waiter = { resolve, timers: [] };
      waiter.timers.push(window.setTimeout(() => this.settleWaiter(waiter, { ok: true }), 320));
      this.departWaiter = waiter;
    });
  }

  state(): SpiderAck {
    const frameMs =
      this.frames.length > 1 ? (this.frames[this.frames.length - 1] - this.frames[0]) / (this.frames.length - 1) : 0;
    return {
      ...this.ack({ ok: true }),
      events: [...this.events],
      frameMs,
      stickers: this.stickers.snapshot(),
      mood: this.brain.mood ?? undefined,
    };
  }

  // ---------- modes ----------

  private leaveNow(): void {
    if (this.mode === 'gone' || this.mode === 'leave') return;
    this.leavePending = false;
    this.log({ op: 'leave', body: { ...this.rig.body } });
    this.stickers.returnAll(performance.now());
    if (this.reducedMotion || document.hidden || this.mode === 'departed') {
      this.unmount();
      return;
    }
    this.setMode('leave');
    this.rig.scale = 1;
    this.rig.handMode = { kind: 'rest' };
    this.rig.airborne = true;
    this.rig.thread = { anchor: vec(this.rig.body.x, -20), alpha: 1 };
    this.target = vec(this.rig.body.x, -160 * this.look.size);
  }

  private setMode(mode: Mode): void {
    this.mode = mode;
    this.modeAt = performance.now();
  }

  private applyLook(look: SpiderLook): void {
    // A message boundary: fill what an older sender may not know about.
    this.look = { ...look, color: look.color ?? 'violet', tear: look.tear ?? true };
    this.brain.pace = look.pace;
    this.brain.tear = look.tear && !this.reducedMotion;
    if (!this.brain.tear) this.stickers.returnAll(performance.now());
  }

  private arrived(): boolean {
    return dist(this.rig.body, this.target) < 3.5 * this.look.size && Math.hypot(this.rig.vel.x, this.rig.vel.y) < 50;
  }

  /** Straight to the target, no flight (reduced motion, throttled tab). */
  private jump(): void {
    const t = this.target;
    const heading = this.faceTo ? Math.atan2(this.faceTo.y - t.y, this.faceTo.x - t.x) : this.rig.heading;
    this.rig.place(t, heading, this.look.size);
    this.rig.thread = null;
    this.rig.scale = 1;
    this.rig.land();
    this.setMode('busy');
    this.busyUntil = performance.now() + 800;
    this.draw();
  }

  /** The navigation did not happen (or the tab came back): pop back in where it was. */
  private reappear(): void {
    window.clearTimeout(this.departTimer);
    this.settleWaiter(this.departWaiter, { ok: true });
    this.setMode('arrive');
    this.rig.airborne = true;
    this.rig.scale = 0;
    this.rig.ring(this.rig.body, 140, 30, 4, true);
    this.log({ op: 'reappear', body: { ...this.rig.body } });
  }

  private armReappear(): void {
    window.clearTimeout(this.departTimer);
    this.departTimer = window.setTimeout(() => {
      if (this.mode === 'departed') this.reappear();
    }, 1500);
  }

  /** The command-driven motion for this substep; free mode asks the brain. */
  private control(now: number): Control {
    const m = PACE[this.look.pace] ?? 1;
    const s = this.look.size;
    const since = now - this.modeAt;
    const body = this.rig.body;
    const faceTarget = this.faceTo ? Math.atan2(this.faceTo.y - body.y, this.faceTo.x - body.x) : null;
    const hold: Control = { target: body, k: 0, c: 0, vmax: 0, face: null, leap: false, hold: true };
    switch (this.mode) {
      case 'free':
        return this.brain.control(now, palette(this.look.color, now));
      case 'descend':
      case 'leave': {
        const face = this.mode === 'descend' ? Math.PI / 2 : -Math.PI / 2;
        return { target: this.target, k: 55 * m * m, c: 13 * m, vmax: 1400 * m, face, leap: false, hold: false };
      }
      case 'approach': {
        if (this.dartAnticipate && since < 75) {
          // Anticipation: crouch and pull back a little before the leap.
          this.rig.crouch = Math.min(1, this.rig.crouch + 0.14);
          const back = sub(this.dartFrom, mul(unit(sub(this.target, this.dartFrom)), 6 * s));
          return { target: back, k: 320, c: 32, vmax: 2400, face: faceTarget, leap: false, hold: false };
        }
        const left = dist(body, this.target);
        const leap = this.dartAnticipate && left > 20 * s;
        const face = left < 60 * s ? faceTarget : null;
        return { target: this.target, k: 170 * m * m, c: 20 * m, vmax: 2400 * m, face, leap, hold: false };
      }
      case 'busy':
        return {
          target: this.target,
          k: 170 * m * m,
          c: 20 * m,
          vmax: 2400 * m,
          face: faceTarget,
          leap: false,
          hold: false,
        };
      default:
        return hold;
    }
  }

  // ---------- frame loop ----------

  private tick = (now: number): void => {
    this.raf = requestAnimationFrame(this.tick);
    const dt = this.lastFrame ? Math.min(0.05, (now - this.lastFrame) / 1000) : 1 / 60;
    this.lastFrame = now;
    this.frameCount++;
    this.frames.push(now);
    while (this.frames.length && now - this.frames[0] > 1000) this.frames.shift();

    this.rig.sampleScroll(dt);
    this.syncScroll(now);
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let i = 0; i < steps && this.mode !== 'gone'; i++) this.step(dt / steps, now);
    this.draw();
  };

  private syncScroll(now: number): void {
    const scrolled = this.rig.syncScroll(now);
    if (!scrolled) return;
    this.brain.onScroll(scrolled, now);
    if (scrolled === 'cut') this.log({ op: 'scroll-cut', body: { ...this.rig.body } });
  }

  private step(dt: number, now: number): void {
    const since = now - this.modeAt;
    const s = this.look.size;
    if (this.mode === 'busy' && now > this.busyUntil && this.rig.handMode.kind !== 'type') {
      this.setMode('free');
      this.faceTo = null;
      this.rig.handMode = { kind: 'rest' };
    }

    this.rig.step(dt, now, this.control(now), dt);
    this.stickers.update(dt, now, side => this.rig.frontFoot(side), this.rig.body);

    const speed = Math.hypot(this.rig.vel.x, this.rig.vel.y);
    if (this.mode === 'descend' && dist(this.rig.body, this.target) < 5 * s && speed < 80) {
      this.setMode('free');
      this.rig.land();
      this.rig.squashAt = now;
      if (this.rig.thread) this.rig.thread.alpha = 0.99;
      this.log({ op: 'landed', body: { ...this.rig.body } });
    } else if (this.mode === 'arrive') {
      // Ring closes in (0–140 ms), the spider pops out of the point with an
      // overshoot (140–420 ms), legs unfold and grip.
      this.rig.scale = since < 140 ? 0 : easeOutBack(clamp((since - 140) / 280, 0, 1));
      if (this.rig.airborne && since > 300) {
        this.rig.land();
        this.rig.squashAt = now;
      }
      if (since > 440) {
        this.rig.scale = 1;
        this.log({ op: 'arrived-teleport', body: { ...this.rig.body } });
        if (this.faceTo) {
          this.setMode('approach');
          this.dartAnticipate = false;
        } else {
          // Just arrived: look around a moment before reading on.
          this.setMode('free');
          this.brain.interrupt(now, 700);
        }
      }
    } else if (this.mode === 'depart') {
      // Tuck and crouch (0–90 ms), then collapse into the point (90–200 ms).
      this.rig.airborne = true;
      this.rig.crouch = Math.min(1, since / 90);
      this.rig.scale = since < 90 ? 1 - 0.1 * (since / 90) : 0.9 * (1 - easeIn(clamp((since - 90) / 110, 0, 1)));
      if (since >= 90 && !this.rig.rings.some(r => !r.inward && now - r.born < 300)) {
        this.rig.ring(this.rig.body, 260, 4, 30);
      }
      if (since >= 200) {
        this.setMode('departed');
        this.rig.scale = 0;
        this.rig.crouch = 0;
        this.settleWaiter(this.departWaiter, { ok: true });
        this.armReappear();
      }
    } else if (this.mode === 'leave' && this.rig.body.y < -110 * s) {
      this.unmount();
      return;
    } else if (this.mode === 'approach' && since > 75 && this.arrived()) {
      this.setMode('busy');
      this.busyUntil = now + 1500;
      this.rig.squashAt = now;
      this.rig.handMode = this.faceTo ? { kind: 'reach', p: { ...this.faceTo } } : { kind: 'rest' };
      this.log({ op: 'arrive', arrived: true, body: { ...this.rig.body } });
      this.settleWaiter(this.approachWaiter, { ok: true, arrived: true });
    }
    if (this.leavePending && this.brain.gestureDone(now)) this.leaveNow();
  }

  private draw(): void {
    const ctx = this.overlay.begin();
    if (!ctx) return;
    const box = new Box();
    if (this.visible && this.mode !== 'gone') {
      const now = performance.now();
      const pal = palette(this.look.color, now);
      if (this.look.marks === 'target' && this.targetMark) {
        const age = now - this.targetMark.born;
        const alpha = age < 600 ? 1 : 1 - (age - 600) / 600;
        if (alpha <= 0) this.targetMark = null;
        else this.drawMark(ctx, this.targetMark.rect, alpha, pal.line, box);
      }
      this.stickers.draw(ctx, box);
      this.rig.draw(ctx, box, pal, now);
    }
    this.overlay.end(box);
  }

  private drawMark(ctx: CanvasRenderingContext2D, r: SpiderRect, alpha: number, color: string, box: Box): void {
    const x = r.x - scrollX - 3;
    const y = r.y - scrollY - 3;
    const w = r.width + 6;
    const h = r.height + 6;
    ctx.save();
    ctx.globalAlpha = clamp(alpha, 0, 1);
    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.shadowColor = color;
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.roundRect(x, y, w, h, 4);
    ctx.stroke();
    ctx.restore();
    box.add({ x, y }, 12);
    box.add({ x: x + w, y: y + h }, 12);
  }

  // ---------- plumbing ----------

  private docRect(r: SpiderRect): SpiderRect {
    return { x: r.x + scrollX, y: r.y + scrollY, width: r.width, height: r.height };
  }

  private onBeforeUnload(): void {
    const place = this.place();
    void this.depart();
    this.onUnload?.(place);
  }

  private unmount(): void {
    this.mode = 'gone';
    cancelAnimationFrame(this.raf);
    window.clearTimeout(this.departTimer);
    this.raf = 0;
    this.lastFrame = 0;
    this.stickers.clear();
    this.overlay.unmount();
    this.log({ op: 'gone' });
  }

  private start(): void {
    if (!this.raf) this.raf = requestAnimationFrame(this.tick);
  }

  private settleWaiter(waiter: Waiter | null, ack: Omit<SpiderAck, 'visible'>): void {
    if (!waiter) return;
    waiter.timers.forEach(t => window.clearTimeout(t));
    if (waiter === this.approachWaiter) this.approachWaiter = null;
    if (waiter === this.departWaiter) this.departWaiter = null;
    waiter.resolve(this.ack(ack));
    waiter.resolve = () => {};
  }

  private modeName(): string {
    return this.mode === 'free' ? `idle:${this.brain.mood ?? 'thinking'}` : this.mode;
  }

  private ack(a: Omit<SpiderAck, 'visible'>): SpiderAck {
    if (this.mode !== 'gone') this.syncScroll(performance.now());
    return {
      ...a,
      visible: this.visible && this.mode !== 'gone' && this.mode !== 'departed',
      pose: this.rig.pose(this.modeName()),
    };
  }

  private log(e: Omit<SpiderEvent, 't'>): void {
    this.events.push({ t: Date.now(), ...e });
    if (this.events.length > 400) this.events.shift();
  }
}
