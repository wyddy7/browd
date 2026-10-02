/**
 * The spider's body, legs and hands: motion and drawing, no behaviour.
 *
 * Proportions follow the reference: a small head and abdomen, long thin legs
 * (about 200 px span at size 1) that bend in the page plane, knees far out.
 * Each knee bends to a fixed side of its hip→foot line (front pairs toward
 * the tail, rear pairs toward the head), so it never flips. Feet are planted
 * in document space and never end up farther than the leg reaches; a big
 * scroll is a cut (feet re-grip, the page carries the body a little), small
 * scrolls are walked. Long darts are leaps: crouch, legs gathered in the air,
 * a squash on landing. Front legs can be lifted to feel or to pull a word.
 *
 * The brain tells the rig where to go and how (`Control`); the rig only moves.
 */
import type { SpiderPoint as V, SpiderPose, SpiderRect } from '@extension/shared';
import {
  add,
  angleDiff,
  clamp,
  clampLen,
  dist,
  easeInOut,
  fromAngle,
  knee2D,
  lerp,
  mul,
  nearestOnRectEdge,
  rot90,
  springStep,
  sub,
  unit,
  vec,
} from './geometry';
import type { Box } from './overlay';
import type { Palette } from './palette';

/** How the body should move this frame. */
export interface Control {
  target: V;
  /** The target's velocity (px/s) and acceleration (px/s²) when it moves along a glide. */
  tvel?: V;
  tacc?: V;
  k: number;
  c: number;
  vmax: number;
  /** Heading to turn to; null = face the motion. */
  face: number | null;
  /** Legs gathered under the body (a leap in progress). */
  leap: boolean;
  /** Stay put (spring held at the current spot). */
  hold: boolean;
  /** A quick turn on tiptoe: the feet turn with the body instead of stepping. */
  spin?: boolean;
}

export type HandMode =
  | { kind: 'rest' }
  | { kind: 'reach'; p: V }
  | { kind: 'type'; p: V }
  | { kind: 'read'; p: V }
  | { kind: 'wave' }
  | { kind: 'tap'; p: V; born: number };

interface Leg {
  side: 1 | -1;
  index: number;
  group: 0 | 1;
  hipAngle: number;
  angle: number;
  home: number;
  femur: number;
  tibia: number;
  /** Rest direction of the femur, from the heading (per side). */
  kneeAngle: number;
  /** Document coordinates. */
  foot: V;
  from: V;
  to: V;
  t: number;
  dur: number;
  lift: number;
  lastStep: number;
  grip: SpiderRect | null;
  /** In the air: the foot relative to the body. */
  rel: V | null;
  /** Lifted to feel or pull: a document-space point it reaches for. */
  feel: V | null;
}

interface Drawn {
  hip: V;
  knee: V;
  foot: V;
  /** Control point of the curved tibia. */
  bow: V;
}

// Leg pairs head to tail at size 1: hip position on the head rim, foot rest
// direction, knee direction, rest distance as a share of the length, bones.
// Seen from above a spider's femur leaves the body outward and the tibia
// bends from the knee toward the foot — so each femur keeps its own
// direction (a fan of knees, never landing on a neighbour's leg) and only
// follows the foot a little; the tibia reaches the foot.
const LEG_LAYOUT = [
  { hipAngle: 0.45, angle: 0.42, knee: 0.9, home: 0.82, femur: 44, tibia: 54 },
  { hipAngle: 1.1, angle: 1.12, knee: 1.42, home: 0.8, femur: 38, tibia: 46 },
  { hipAngle: 1.9, angle: 2.02, knee: 1.8, home: 0.8, femur: 36, tibia: 44 },
  { hipAngle: 2.55, angle: 2.72, knee: 2.3, home: 0.84, femur: 42, tibia: 56 },
] as const;

/** How far a femur may swing after its foot, radians either way. */
const FEMUR_FOLLOW = 0.24;
/**
 * Turning on planted feet: the legs step around as the body turns, so the
 * turn may not outrun them — a foot left behind pulls its tibia across the
 * neighbour's leg. Max rate (rad/s) and angular acceleration (rad/s²).
 */
const TURN_MAX = 2.6;
const TURN_ACC = 22;
/**
 * Each foot keeps to its own sector around its rest direction (rad either
 * way, from the current heading): a step never aims past it, and a planted
 * foot steps at once a little before it would drift past it (a swing starts
 * where the foot is). Neighbouring rests are 0.7–0.9 rad apart, so two feet
 * never share a direction.
 */
const FOOT_SECTOR = 0.25;
const FOOT_DRIFT = 0.21;

export const HEAD = { rx: 6.2, ry: 5.2, rim: 4.4 };
export const ABDOMEN = { rx: 9.5, ry: 7.2, gap: 13 };
const HAND = { along: 5, lat: 2.4, femur: 8, tibia: 8 };
export const HAND_TIP = 20;

export class Rig {
  size = 1;
  body = vec(0, 0);
  vel = vec(0, 0);
  heading = Math.PI / 2;
  private angVel = 0;
  abdomen = vec(0, 0);
  private abdVel = vec(0, 0);
  legs: Leg[] = [];
  private drawn: Drawn[] = [];
  hands: [V, V] = [vec(0, 0), vec(0, 0)];
  handMode: HandMode = { kind: 'rest' };
  /** Called once at the moment a tap touches its point. */
  onContact: ((p: V) => void) | null = null;

  airborne = true;
  dashing = false;
  /** On tiptoe for a quick turn (the done gesture). */
  spinning = false;
  scale = 1;
  crouch = 0;
  private leapScale = 1;
  squashAt = -Infinity;
  dip = vec(0, 0);
  thread: { anchor: V; alpha: number } | null = null;
  /** Document-space rects feet may snap to (the brain's current block); no page reads per step. */
  gripRects: SpiderRect[] = [];
  rings: Array<{ p: V; born: number; dur: number; from: number; to: number; inward: boolean }> = [];
  private lastScroll = vec(0, 0);
  private velScrollAt = vec(0, 0);
  private scrollVel = vec(0, 0);

  // ---------- setup ----------

  place(at: V, heading: number, size: number): void {
    this.size = size;
    this.body = { ...at };
    this.vel = vec(0, 0);
    this.heading = heading;
    this.angVel = 0;
    this.abdomen = add(at, fromAngle(heading + Math.PI, ABDOMEN.gap * size));
    this.abdVel = vec(0, 0);
    this.lastScroll = vec(scrollX, scrollY);
    this.velScrollAt = vec(scrollX, scrollY);
    this.scrollVel = vec(0, 0);
    this.legs = this.buildLegs();
    this.hands = [this.headTip(), this.headTip()];
    this.handMode = { kind: 'rest' };
    this.dip = vec(0, 0);
    this.rings = [];
  }

  /** Feet and abdomen relative to the body (view space): what a handoff carries to the next page. */
  limbs(): { feet: V[]; abdomen: V } {
    const body = this.toDoc(this.body);
    return { feet: this.legs.map(l => sub(l.foot, body)), abdomen: sub(this.abdomen, this.body) };
  }

  /** Stand exactly as on the previous page: feet and abdomen where they were relative to the body. */
  standAs(feet: V[] | undefined, abdomen: V | undefined): void {
    this.airborne = false;
    this.dashing = false;
    const body = this.toDoc(this.body);
    this.legs.forEach((leg, i) => {
      const rel = feet?.[i];
      leg.t = -1;
      leg.rel = null;
      leg.feel = null;
      leg.lift = 0;
      leg.grip = null;
      if (rel && Number.isFinite(rel.x) && Number.isFinite(rel.y)) {
        leg.foot = clampLen(this.hip(leg, body), add(body, rel), this.reach(leg) * 0.99);
      }
    });
    if (abdomen && Number.isFinite(abdomen.x) && Number.isFinite(abdomen.y)) this.abdomen = add(this.body, abdomen);
  }

  resize(size: number): void {
    this.size = size;
    this.legs = this.buildLegs();
    this.land();
  }

  private buildLegs(): Leg[] {
    const s = this.size;
    const legs: Leg[] = [];
    for (const side of [1, -1] as const) {
      LEG_LAYOUT.forEach((l, i) => {
        const leg: Leg = {
          side,
          index: i,
          // Alternating tetrapod gait: L1 R2 L3 R4 against R1 L2 R3 L4.
          group: ((i + (side === 1 ? 0 : 1)) % 2) as 0 | 1,
          hipAngle: l.hipAngle,
          angle: l.angle,
          home: l.home * (l.femur + l.tibia) * s,
          femur: l.femur * s,
          tibia: l.tibia * s,
          kneeAngle: l.knee,
          foot: vec(0, 0),
          from: vec(0, 0),
          to: vec(0, 0),
          t: -1,
          dur: 0.12,
          lift: 0,
          lastStep: 0,
          grip: null,
          rel: null,
          feel: null,
        };
        leg.foot = this.idealFoot(leg, this.toDoc(this.body));
        legs.push(leg);
      });
    }
    return legs;
  }

  /**
   * Plant every foot around `at` (where the body will settle). `unfold`: the
   * legs reach their spots in one quick step from wherever they are (after a
   * leap, a thread, a page jump) instead of appearing there.
   */
  land(at: V = this.body, unfold = false): void {
    this.airborne = false;
    this.dashing = false;
    const around = this.toDoc(at);
    const here = this.toDoc(this.body);
    for (const leg of this.legs) {
      const g = this.grip(this.idealFoot(leg, around));
      const spot = clampLen(this.hip(leg, here), g.p, this.reach(leg) * 0.99);
      leg.rel = null;
      leg.feel = null;
      if (unfold) {
        leg.from = clampLen(this.hip(leg, here), leg.foot, this.reach(leg) * 0.98);
        leg.foot = { ...leg.from };
        leg.to = spot;
        leg.t = 0;
        leg.dur = 0.14;
        leg.grip = null;
        continue;
      }
      leg.foot = spot;
      leg.grip = g.rect;
      leg.t = -1;
      leg.lift = 0;
    }
  }

  // ---------- geometry helpers ----------

  toDoc(p: V): V {
    return { x: p.x + scrollX, y: p.y + scrollY };
  }

  toView(p: V): V {
    return { x: p.x - scrollX, y: p.y - scrollY };
  }

  headTip(): V {
    return add(this.body, fromAngle(this.heading, HAND_TIP * this.size));
  }

  hip(leg: Leg, bodyDoc: V): V {
    return add(bodyDoc, fromAngle(this.heading + leg.side * leg.hipAngle, HEAD.rim * this.size));
  }

  reach(leg: Leg): number {
    return leg.femur + leg.tibia;
  }

  private idealFoot(leg: Leg, bodyDoc: V, heading = this.heading): V {
    const hip = add(bodyDoc, fromAngle(heading + leg.side * leg.hipAngle, HEAD.rim * this.size));
    return add(hip, fromAngle(heading + leg.side * leg.angle, leg.home));
  }

  /**
   * The rest spot of a foot `t` seconds ahead — body moved by its velocity,
   * heading turned by its rate, plus half a step of lead — so a foot that
   * lands mid-turn lands ahead of the turn, not behind it.
   */
  private footAhead(leg: Leg, bodyDoc: V, rel: V, t: number): V {
    const s = this.size;
    const ahead = t + leg.dur * 0.5;
    const heading = this.heading + clamp(this.angVel * ahead, -0.35, 0.35);
    const moved = clampLen(vec(0, 0), mul(rel, ahead), 16 * s);
    const aim = add(this.idealFoot(leg, add(bodyDoc, moved), heading), clampLen(vec(0, 0), mul(rel, 0.07), 16 * s));
    // Never past the foot's own sector, measured from where the hip is now,
    // and never pulled in under the body (walking sideways pulls the trailing
    // side's feet toward the body, onto the neighbours' knees).
    const hip = this.hip(leg, bodyDoc);
    const rest = this.heading + leg.side * leg.angle;
    const off = angleDiff(rest, Math.atan2(aim.y - hip.y, aim.x - hip.x));
    const dir = rest + clamp(off, -FOOT_SECTOR, FOOT_SECTOR);
    return add(hip, fromAngle(dir, Math.max(dist(hip, aim), leg.home * 0.85)));
  }

  /** Tip of a front leg (index 0), in view coordinates; side +1 = right. */
  frontFoot(side: 1 | -1): V {
    const leg = this.legs.find(l => l.index === 0 && l.side === side);
    return leg ? this.toView(leg.foot) : this.body;
  }

  /** Lift a front leg toward a view-space point (null puts it down again). */
  feel(side: 1 | -1, viewPoint: V | null): void {
    const leg = this.legs.find(l => l.index === 0 && l.side === side);
    if (!leg) return;
    if (viewPoint) {
      leg.feel = this.toDoc(viewPoint);
      leg.t = -1;
      leg.grip = null;
    } else if (leg.feel) {
      leg.feel = null;
      leg.lastStep = 0; // step down at the next chance
    }
  }

  ring(p: V, dur: number, from: number, to: number, inward = false): void {
    this.rings.push({ p: this.toDoc(p), born: performance.now(), dur, from, to, inward });
  }

  // ---------- simulation ----------

  /**
   * The page moved under the spider. Returns 'cut' for a jump (the agent's
   * instant scroll), 'walk' for a small move, null for none.
   */
  syncScroll(now: number): 'cut' | 'walk' | null {
    const dx = scrollX - this.lastScroll.x;
    const dy = scrollY - this.lastScroll.y;
    if (!dx && !dy) return null;
    this.lastScroll = vec(scrollX, scrollY);
    if (this.airborne) return 'walk';
    const s = this.size;
    if (Math.hypot(dx, dy) > 24 * s) {
      const carry = clampLen(vec(0, 0), vec(-dx, -dy), 56 * s);
      this.body = add(this.body, carry);
      this.abdomen = add(this.abdomen, mul(carry, 1.25));
      this.vel = add(this.vel, mul(carry, 3));
      for (const leg of this.legs) leg.feel = null;
      // A cut: the page jumped under the feet; they re-grip at once (an unfold
      // from wherever the page left them would sweep every leg the same way).
      this.land();
      this.squashAt = now;
      return 'cut';
    }
    // Walked: planted feet ride the page, slipping at full reach if it
    // outruns them; a foot in the air travels with the body.
    const bodyDoc = this.toDoc(this.body);
    for (const leg of this.legs) {
      if (this.dashing) continue;
      if (leg.t < 0 && !leg.feel) {
        leg.foot = clampLen(this.hip(leg, bodyDoc), leg.foot, this.reach(leg) * 0.99);
      } else {
        leg.from = add(leg.from, vec(dx, dy));
        leg.to = add(leg.to, vec(dx, dy));
        leg.foot = add(leg.foot, vec(dx, dy));
        if (leg.feel) leg.feel = add(leg.feel, vec(dx, dy));
      }
    }
    return 'walk';
  }

  step(dt: number, now: number, ctl: Control, frameDt: number): void {
    const s = this.size;
    if (ctl.hold) {
      // Held: kill the velocity quickly but without a jerk.
      this.vel = mul(this.vel, Math.max(0, 1 - dt * 18));
      this.body = add(this.body, mul(this.vel, dt));
    } else {
      springStep(this.body, this.vel, ctl.target, ctl.k, ctl.c, dt, ctl.vmax, ctl.tvel, ctl.tacc);
    }
    const speed = Math.hypot(this.vel.x, this.vel.y);
    const want = ctl.face ?? (speed > 30 ? Math.atan2(this.vel.y, this.vel.x) : this.heading);
    const torque = 70 * angleDiff(this.heading, want) - 15 * this.angVel;
    if (this.airborne || this.dashing || ctl.spin) {
      this.angVel += torque * dt;
    } else {
      // On planted feet: a gentle start and a rate the steps can keep up with.
      this.angVel = clamp(this.angVel + clamp(torque, -TURN_ACC, TURN_ACC) * dt, -TURN_MAX, TURN_MAX);
    }
    this.heading += this.angVel * dt;

    // Abdomen: its own looser spring behind the head, held at pedicel length.
    const gap = ABDOMEN.gap * s;
    springStep(this.abdomen, this.abdVel, add(this.body, fromAngle(this.heading + Math.PI, gap)), 260, 17, dt, 5000);
    this.abdomen = add(this.body, mul(unit(sub(this.abdomen, this.body)), gap));

    if (this.thread && this.thread.alpha < 1) {
      this.thread.alpha -= dt * 2;
      if (this.thread.alpha <= 0) this.thread = null;
    }
    this.dip = mul(this.dip, Math.max(0, 1 - dt * 12));
    this.leapScale += ((this.dashing ? 1.06 : 1) - this.leapScale) * Math.min(1, dt * 14);
    if (this.crouch > 0 && !ctl.leap) this.crouch = Math.max(0, this.crouch - dt * 6);

    void frameDt;
    this.stepLegs(dt, now, speed, ctl.leap, !!ctl.spin);
    this.stepHands(dt, now);
  }

  /** Page speed, sampled once per frame (pose reads also sync the scroll). */
  sampleScroll(frameDt: number): void {
    const moved = vec((scrollX - this.velScrollAt.x) / frameDt, (scrollY - this.velScrollAt.y) / frameDt);
    this.velScrollAt = vec(scrollX, scrollY);
    this.scrollVel =
      Math.hypot(moved.x, moved.y) * frameDt > 24 * this.size ? vec(0, 0) : lerp(this.scrollVel, moved, 0.35);
  }

  private stepLegs(dt: number, now: number, bodySpeed: number, leap: boolean, spin: boolean): void {
    const s = this.size;
    const bodyDoc = this.toDoc(this.body);
    if (spin && !this.airborne && !this.dashing) {
      // On tiptoe: every foot at its rest spot, turning with the body.
      this.spinning = true;
      for (const leg of this.legs) {
        const target = sub(this.idealFoot(leg, bodyDoc), bodyDoc);
        leg.rel = lerp(leg.rel ?? sub(leg.foot, bodyDoc), target, Math.min(1, dt * 40));
        leg.foot = add(bodyDoc, leg.rel);
        leg.lift = Math.min(5 * s, leg.lift + dt * 60);
        leg.t = -1;
        leg.grip = null;
        leg.feel = null;
      }
      return;
    }
    if (this.spinning) {
      // Down from tiptoe: the feet are already at their rest spots.
      this.spinning = false;
      for (const leg of this.legs) {
        leg.rel = null;
        leg.lastStep = now;
      }
    }
    if (!this.airborne) {
      if (!this.dashing && (leap || bodySpeed > 700 * s)) {
        this.dashing = true;
        for (const leg of this.legs) {
          leg.grip = null;
          leg.t = -1;
          leg.feel = null;
        }
      } else if (this.dashing && !leap && bodySpeed < 380 * s) {
        this.dashing = false;
        this.land(this.body, true);
        this.squashAt = now;
      }
    }
    if (this.dashing || this.airborne) {
      // In the air: legs gathered (leap) or hanging tucked (thread, teleport).
      const share = this.dashing ? 0.52 : 0.62;
      for (const leg of this.legs) {
        const fold = this.dashing
          ? leg.angle < Math.PI / 2
            ? leg.angle * 0.7
            : Math.PI - (Math.PI - leg.angle) * 0.7
          : leg.angle * 0.85;
        const target = sub(
          add(this.hip(leg, bodyDoc), fromAngle(this.heading + leg.side * fold, leg.home * share)),
          bodyDoc,
        );
        leg.rel = lerp(leg.rel ?? sub(leg.foot, bodyDoc), target, Math.min(1, dt * (this.dashing ? 30 : 16)));
        leg.foot = add(bodyDoc, leg.rel);
        leg.lift = 8 * s;
        leg.t = -1;
        leg.grip = null;
      }
      return;
    }

    const rel = add(this.vel, this.scrollVel);
    const speed = Math.hypot(rel.x, rel.y);
    const threshold = (speed > 40 ? 22 : 12) * s;
    const dur = clamp(0.12 - speed / 5000, 0.05, 0.12);
    const stepping = [0, 0];
    for (const leg of this.legs) if (leg.t >= 0) stepping[leg.group]++;

    for (const leg of this.legs) {
      const hip = this.hip(leg, bodyDoc);
      const reach = this.reach(leg);
      if (leg.feel) {
        // Lifted: the foot reaches for the point (within reach), in the air.
        const goal = clampLen(hip, leg.feel, reach * 0.95);
        leg.foot = lerp(leg.foot, goal, Math.min(1, dt * 12));
        leg.lift = 10 * s;
        leg.rel = null;
        continue;
      }
      if (leg.t >= 0) {
        // Where the foot belongs when it lands: the body keeps turning and
        // moving during the swing, so the target is re-aimed every substep.
        const left = (1 - leg.t) * leg.dur;
        leg.to = clampLen(hip, this.footAhead(leg, bodyDoc, rel, left), reach * 0.95);
        leg.t += dt / leg.dur;
        if (leg.t >= 1) {
          leg.t = -1;
          stepping[leg.group]--;
          const g = this.grip(leg.to);
          leg.foot = clampLen(hip, g.p, reach * 0.99);
          leg.grip = g.rect;
          leg.lift = 0;
        } else {
          // An arc around the hip, not a chord: a straight swing cuts in toward
          // the body and passes over the neighbour's knee.
          const e = easeInOut(leg.t);
          const a0 = Math.atan2(leg.from.y - hip.y, leg.from.x - hip.x);
          const a1 = Math.atan2(leg.to.y - hip.y, leg.to.x - hip.x);
          const r = dist(leg.from, hip) + (dist(leg.to, hip) - dist(leg.from, hip)) * e;
          leg.foot = clampLen(hip, add(hip, fromAngle(a0 + angleDiff(a0, a1) * e, r)), reach * 0.99);
          leg.lift = Math.sin(Math.PI * leg.t) * (speed > 300 ? 12 : 9) * s;
        }
        continue;
      }
      leg.foot = clampLen(hip, leg.foot, reach * 0.99);
      leg.lift = Math.max(0, leg.lift - dt * 80);
      const lead = clampLen(vec(0, 0), mul(rel, 0.07), 16 * s);
      const ideal = add(this.idealFoot(leg, bodyDoc), lead);
      const off = dist(leg.foot, ideal);
      const stretch = dist(leg.foot, hip) / reach;
      const footDir = Math.atan2(leg.foot.y - hip.y, leg.foot.x - hip.x);
      const drift = Math.abs(angleDiff(this.heading + leg.side * leg.angle, footDir));
      const urgent = stretch > 0.95 || off > threshold * 2.4 || drift > FOOT_DRIFT;
      // Tidying at rest is rare and only for a foot clearly out of place: no fidgeting.
      const tidy = speed < 15 && off > 14 * s && now - leg.lastStep > 800 && stepping[0] + stepping[1] === 0;
      const turn = (stepping[1 - leg.group] === 0 || speed > 220 * s) && stepping[leg.group] < 4;
      if ((off > threshold && turn) || urgent || tidy) {
        leg.grip = null;
        leg.from = clampLen(hip, leg.foot, reach * 0.98);
        leg.to = clampLen(hip, this.footAhead(leg, bodyDoc, rel, dur), reach * 0.95);
        leg.t = 0;
        leg.dur = dur;
        leg.lastStep = now;
        stepping[leg.group]++;
      }
    }
  }

  private stepHands(dt: number, now: number): void {
    const s = this.size;
    const f = fromAngle(this.heading);
    const rate = Math.min(1, dt * 20);
    for (let i = 0; i < 2; i++) {
      const side = i === 0 ? 1 : -1;
      const lat = fromAngle(this.heading + side * (Math.PI / 2));
      const rest = add(this.body, add(mul(f, (HAND.along + 8) * s), mul(lat, 4 * s)));
      let goal: V;
      let r = rate;
      const hm = this.handMode;
      if (hm.kind === 'rest') {
        goal = rest;
      } else if (hm.kind === 'reach') {
        goal = add(hm.p, mul(lat, 2.5 * s));
      } else if (hm.kind === 'read') {
        const phase = Math.sin(now / 260 + (i ? Math.PI : 0));
        goal = add(add(hm.p, mul(lat, 3 * s)), mul(f, -Math.max(0, phase) * 4 * s));
      } else if (hm.kind === 'type') {
        const phase = Math.sin(now / 55 + (i ? Math.PI : 0));
        goal = add(add(hm.p, mul(lat, 3 * s)), mul(f, -Math.max(0, phase) * 5 * s));
      } else if (hm.kind === 'wave') {
        const phase = Math.sin(now / 160 + (i ? Math.PI : 0));
        goal = add(add(this.body, mul(f, (HAND.along + 14) * s)), mul(lat, (5 + phase * 5) * s));
      } else {
        // Tap: wind up (0–60 ms), jab to contact (60–100 ms), recoil.
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
        if (t >= 100 && this.onContact) {
          this.hands[i] = point;
          const cb = this.onContact;
          this.onContact = null;
          this.ring(hm.p, 360, 4, 22);
          this.dip = mul(unit(sub(hm.p, this.body)), 3.5 * s);
          cb(hm.p);
        }
        if (t > 320) this.handMode = { kind: 'reach', p: hm.p };
      }
      this.hands[i] = lerp(this.hands[i], goal, r);
    }
  }

  /**
   * Snap a document point to the edge of a known word or line box under it.
   * The boxes come from the brain (read once per block): a step never asks
   * the page for layout, which on a heavy page would force a reflow.
   */
  private grip(pDoc: V): { p: V; rect: SpiderRect | null } {
    const pad = 4 * this.size;
    const rect = this.gripRects.find(
      r => pDoc.x > r.x - pad && pDoc.x < r.x + r.width + pad && pDoc.y > r.y - pad && pDoc.y < r.y + r.height + pad,
    );
    if (!rect) return { p: pDoc, rect: null };
    const edge = nearestOnRectEdge(pDoc, rect);
    return { p: dist(edge, pDoc) < 8 * this.size ? edge : pDoc, rect };
  }

  // ---------- drawing ----------

  private solveLegs(): void {
    const body = add(this.body, this.dip);
    const bodyDoc = this.toDoc(body);
    this.drawn = this.legs.map(leg => {
      const hip = this.toView(this.hip(leg, bodyDoc));
      // A lifted foot is nearer the viewer: drawn a little toward the hip.
      const foot0 = this.toView(leg.foot);
      const liftShare = clamp(leg.lift / (120 * this.size), 0, 0.1);
      const footRaw = lerp(foot0, hip, liftShare);
      // The femur keeps its own direction and follows the foot only a little.
      const rest = this.heading + leg.side * leg.kneeAngle;
      const restFoot = this.heading + leg.side * leg.angle;
      const footDir = Math.atan2(footRaw.y - hip.y, footRaw.x - hip.x);
      const follow = clamp(angleDiff(restFoot, footDir) * 0.5, -FEMUR_FOLLOW, FEMUR_FOLLOW);
      // Crouching folds the femur in a little.
      const femur = leg.femur * (1 - 0.1 * this.crouch);
      const knee = add(hip, fromAngle(rest + follow, femur));
      // The tibia reaches the foot, never longer than itself.
      const foot = clampLen(knee, footRaw, leg.tibia * 1.06);
      // It arcs outward, away from the body.
      const mid = lerp(knee, foot, 0.5);
      const along = sub(foot, knee);
      let perp = rot90(unit(along), 1);
      if (dist(add(mid, perp), body) < dist(mid, body)) perp = mul(perp, -1);
      const bow = add(mid, mul(perp, Math.hypot(along.x, along.y) * 0.1));
      return { hip, knee, foot, bow };
    });
  }

  maxStretch(): number {
    const bodyDoc = this.toDoc(this.body);
    let max = 0;
    for (const leg of this.legs) max = Math.max(max, dist(leg.foot, this.hip(leg, bodyDoc)) / this.reach(leg));
    return max;
  }

  draw(ctx: CanvasRenderingContext2D, box: Box, pal: Palette, now: number): void {
    const s = this.size;
    const lw = Math.max(0.8, s);

    // Rings: strike contact, teleport out (expanding), teleport in (closing).
    this.rings = this.rings.filter(r => now - r.born < r.dur);
    for (const r of this.rings) {
      const t = (now - r.born) / r.dur;
      const p = this.toView(r.p);
      const radius = (r.from + (r.to - r.from) * easeInOut(t)) * s;
      ctx.save();
      ctx.globalAlpha = r.inward ? t : 1 - t;
      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(p.x, p.y, radius, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
      box.add(p, Math.max(r.from, r.to) * s + 4);
    }

    if (this.thread) {
      ctx.save();
      ctx.globalAlpha = this.thread.alpha;
      ctx.strokeStyle = pal.line;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(this.thread.anchor.x, this.thread.anchor.y);
      ctx.lineTo(this.body.x, this.body.y);
      ctx.stroke();
      ctx.restore();
      box.add(this.thread.anchor, 2);
      box.add(this.body, 2);
    }

    if (this.scale <= 0.01) return;

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
      const tip = clampLen(hip, this.hands[i], reach * 1.25);
      const grow = Math.max(1, dist(hip, tip) / reach);
      const { knee, tip: end } = knee2D(hip, tip, HAND.femur * s * grow, HAND.tibia * s * grow, side);
      handSegs.push([hip, knee, end]);
    }

    ctx.save();
    const drawScale = this.scale * this.leapScale;
    if (drawScale !== 1) {
      ctx.translate(body.x, body.y);
      ctx.scale(drawScale, drawScale);
      ctx.translate(-body.x, -body.y);
    }
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    const strokeLegs = (extra: number, color: string) => {
      ctx.strokeStyle = color;
      ctx.lineWidth = (1.9 + extra) * lw;
      ctx.beginPath();
      for (const d of this.drawn) {
        ctx.moveTo(d.hip.x, d.hip.y);
        ctx.lineTo(d.knee.x, d.knee.y);
      }
      ctx.stroke();
      ctx.lineWidth = (1.3 + extra) * lw;
      ctx.beginPath();
      for (const d of this.drawn) {
        // The tibia arcs a little further the way the knee bends: a leg, not a zigzag.
        ctx.moveTo(d.knee.x, d.knee.y);
        ctx.quadraticCurveTo(d.bow.x, d.bow.y, d.foot.x, d.foot.y);
      }
      for (const [a, b, c] of handSegs) {
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.lineTo(c.x, c.y);
      }
      ctx.stroke();
    };
    strokeLegs(1.6, pal.shade);
    strokeLegs(0, pal.line);
    for (const d of this.drawn) {
      box.add(d.knee, 8 * s);
      box.add(d.foot, 8 * s);
    }
    for (const [, , tip] of handSegs) box.add(tip, 8 * s);

    // Body: abdomen behind, pedicel, head. Squash on landing, stretch on fast motion.
    const speed = Math.hypot(this.vel.x, this.vel.y);
    const sinceSquash = now - this.squashAt;
    const squash = sinceSquash < 140 ? Math.sin((sinceSquash / 140) * Math.PI) * 0.12 : 0;
    const along = 1 + Math.min(0.12, speed / 20000) - squash;
    const across = 1 / along;
    const abd = add(this.abdomen, this.dip);
    const abdAngle = Math.atan2(body.y - abd.y, body.x - abd.x);
    const ellipse = (c: V, angle: number, rx: number, ry: number) => {
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, rx, ry, angle, 0, Math.PI * 2);
    };
    for (const [stroke, width] of [
      [pal.shade, 3.6],
      [pal.line, 1.8],
    ] as const) {
      ctx.strokeStyle = stroke;
      ctx.lineWidth = width * lw;
      ctx.beginPath();
      ctx.moveTo(abd.x, abd.y);
      ctx.lineTo(body.x, body.y);
      ctx.stroke();
      ellipse(abd, abdAngle, ABDOMEN.rx * s * along, ABDOMEN.ry * s * across);
      if (stroke === pal.shade) {
        ctx.fillStyle = pal.fill;
        ctx.fill();
      }
      ctx.stroke();
      ellipse(body, this.heading, HEAD.rx * s * along, HEAD.ry * s * across);
      if (stroke === pal.shade) {
        ctx.fillStyle = pal.fill;
        ctx.fill();
      }
      ctx.stroke();
    }
    // Abdomen pattern: a spine and two chevrons.
    const af = fromAngle(abdAngle);
    const al = rot90(af, 1);
    ctx.strokeStyle = pal.joint;
    ctx.lineWidth = 1.2 * lw;
    ctx.beginPath();
    ctx.moveTo(abd.x + af.x * 5 * s, abd.y + af.y * 5 * s);
    ctx.lineTo(abd.x - af.x * 6 * s, abd.y - af.y * 6 * s);
    for (const o of [1, -2.5]) {
      const c = add(abd, mul(af, o * s));
      ctx.moveTo(c.x + al.x * 3.4 * s - af.x * 2.6 * s, c.y + al.y * 3.4 * s - af.y * 2.6 * s);
      ctx.lineTo(c.x, c.y);
      ctx.lineTo(c.x - al.x * 3.4 * s - af.x * 2.6 * s, c.y - al.y * 3.4 * s - af.y * 2.6 * s);
    }
    ctx.stroke();
    box.add(abd, ABDOMEN.rx * s * 1.3);
    box.add(body, HEAD.rx * s * 1.3);

    // Eyes, knees, feet, hand tips.
    ctx.fillStyle = pal.joint;
    ctx.beginPath();
    const fl = rot90(f, 1);
    for (const [a, l, r] of [
      [3.6, 1.6, 1.4],
      [3.6, -1.6, 1.4],
      [2.2, 3.1, 1],
      [2.2, -3.1, 1],
    ] as const) {
      const e = add(add(body, mul(f, a * s)), mul(fl, l * s));
      ctx.moveTo(e.x + r * s, e.y);
      ctx.arc(e.x, e.y, r * s, 0, Math.PI * 2);
    }
    for (const d of this.drawn) {
      // Small joints: a knee is a bend, not a node.
      ctx.moveTo(d.knee.x + 1.4 * s, d.knee.y);
      ctx.arc(d.knee.x, d.knee.y, 1.4 * s, 0, Math.PI * 2);
      ctx.moveTo(d.foot.x + 1.8 * s, d.foot.y);
      ctx.arc(d.foot.x, d.foot.y, 1.8 * s, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.fillStyle = pal.line;
    ctx.beginPath();
    for (const [, , tip] of handSegs) {
      ctx.moveTo(tip.x + 1.8 * s, tip.y);
      ctx.arc(tip.x, tip.y, 1.8 * s, 0, Math.PI * 2);
    }
    ctx.fill();
    ctx.restore();

    if (drawScale > 1) box.grow(body, drawScale);
  }

  pose(mode: string): SpiderPose {
    this.solveLegs();
    const round = (x: number) => Math.round(x * 10) / 10;
    const roundV = (p: V) => ({ x: round(p.x), y: round(p.y) });
    return {
      // Two decimals for the body: checks differentiate it twice (acceleration per frame).
      body: { x: Math.round(this.body.x * 100) / 100, y: Math.round(this.body.y * 100) / 100 },
      heading: round(this.heading),
      mode: mode + (this.dashing ? ':leap' : ''),
      scale: round(this.scale),
      abdomenLag: round(
        angleDiff(this.heading, Math.atan2(this.body.y - this.abdomen.y, this.body.x - this.abdomen.x)),
      ),
      hands: [roundV(this.hands[0]), roundV(this.hands[1])],
      feet: this.drawn.map(d => roundV(d.foot)),
      hips: this.drawn.map(d => roundV(d.hip)),
      knees: this.drawn.map(d => roundV(d.knee)),
      maxStretch: Math.round(this.maxStretch() * 100) / 100,
      speed: round(Math.hypot(this.vel.x, this.vel.y)),
    };
  }
}
