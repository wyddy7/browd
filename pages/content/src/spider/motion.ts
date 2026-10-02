/**
 * Smooth moves for any character, independent of its body: a quintic from
 * where the body is, with the velocity it already has, to a goal reached at a
 * chosen velocity (usually at rest), optionally bowed into an arc.
 *
 * Position, velocity and acceleration are continuous at both ends — a move
 * starts and stops with zero acceleration, and a new move takes over from a
 * running one without a hitch. The body tracks the glide through a stiff
 * spring with the glide's velocity and acceleration fed forward, so it stays
 * on the path instead of lagging behind it and overshooting the end.
 */
import type { SpiderPoint as V } from '@extension/shared';
import { clamp, dist, vec } from './geometry';

export interface Glide {
  /** Document coordinates. */
  p0: V;
  p1: V;
  /** Velocities in px/s at the start and the end. */
  v0: V;
  v1: V;
  t0: number;
  /** Duration, ms. */
  T: number;
  /** Offset at the middle of the move, perpendicular to it (document px). */
  bow: V;
}

/**
 * A glide from `p0` (moving at `v0`) to `p1` (arriving at `v1`) in `T` ms;
 * `bowShare` bends it into an arc whose middle sits that share of the length
 * off the straight line (sign = which side).
 */
export function glide(p0: V, v0: V, p1: V, now: number, T: number, bowShare = 0, v1: V = vec(0, 0)): Glide {
  const d = vec(p1.x - p0.x, p1.y - p0.y);
  const len = Math.hypot(d.x, d.y);
  // A start speed far above what the move needs would swing past the goal and back.
  const sec = T / 1000;
  const v0Len = Math.hypot(v0.x, v0.y);
  const cap = Math.max(60, (2.2 * len) / Math.max(sec, 0.05));
  const k = v0Len > cap ? cap / v0Len : 1;
  const bow = len > 1 ? vec((-d.y / len) * len * bowShare, (d.x / len) * len * bowShare) : vec(0, 0);
  return { p0: { ...p0 }, p1: { ...p1 }, v0: vec(v0.x * k, v0.y * k), v1: { ...v1 }, t0: now, T, bow };
}

/** Where the glide is at `now`: position, velocity (px/s), acceleration (px/s²), and whether it has ended. */
export function glideAt(g: Glide, now: number): { p: V; v: V; a: V; done: boolean; tau: number } {
  const tau = clamp((now - g.t0) / g.T, 0, 1);
  const sec = g.T / 1000;
  const axis = (p0: number, p1: number, v0: number, v1: number) => {
    // Quintic with zero acceleration at both ends; velocities in τ units.
    const d = p1 - p0;
    const a = v0 * sec;
    const b = v1 * sec;
    const c3 = 10 * d - 6 * a - 4 * b;
    const c4 = -15 * d + 8 * a + 7 * b;
    const c5 = 6 * d - 3 * a - 3 * b;
    const t = tau;
    return {
      p: p0 + a * t + c3 * t ** 3 + c4 * t ** 4 + c5 * t ** 5,
      v: (a + 3 * c3 * t ** 2 + 4 * c4 * t ** 3 + 5 * c5 * t ** 4) / sec,
      a: tau >= 1 ? 0 : (6 * c3 * t + 12 * c4 * t ** 2 + 20 * c5 * t ** 3) / (sec * sec),
    };
  };
  const x = axis(g.p0.x, g.p1.x, g.v0.x, g.v1.x);
  const y = axis(g.p0.y, g.p1.y, g.v0.y, g.v1.y);
  // The arc: a bump with zero value and zero slope at both ends.
  const bump = 16 * tau * tau * (1 - tau) * (1 - tau);
  const slope = (32 * tau * (1 - tau) * (1 - 2 * tau)) / sec;
  const bend = tau >= 1 ? 0 : (32 * (1 - 6 * tau + 6 * tau * tau)) / (sec * sec);
  return {
    p: vec(x.p + g.bow.x * bump, y.p + g.bow.y * bump),
    v: vec(x.v + g.bow.x * slope, y.v + g.bow.y * slope),
    a: vec(x.a + g.bow.x * bend, y.a + g.bow.y * bend),
    done: tau >= 1,
    tau,
  };
}

/**
 * Ease out of whatever the body is doing: a glide that keeps its direction
 * and comes to rest in `T` ms (covering half of what the speed would carry,
 * which keeps the slowdown monotonic — no backing up).
 */
export function brake(p: V, v: V, now: number, T = 300): Glide {
  const sec = T / 1000;
  return glide(p, v, vec(p.x + v.x * sec * 0.5, p.y + v.y * sec * 0.5), now, T);
}

/** Duration for a move of `len` px: a base plus a rate, clamped (ms). */
export function moveTime(len: number, baseMs: number, pxPerS: number, minMs: number, maxMs: number): number {
  return clamp(baseMs + (len / pxPerS) * 1000, minMs, maxMs);
}

export const glideLength = (g: Glide): number => dist(g.p0, g.p1);
