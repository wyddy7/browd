import type { SpiderPoint as V } from '@extension/shared';

export const vec = (x: number, y: number): V => ({ x, y });
export const add = (a: V, b: V): V => ({ x: a.x + b.x, y: a.y + b.y });
export const sub = (a: V, b: V): V => ({ x: a.x - b.x, y: a.y - b.y });
export const mul = (a: V, k: number): V => ({ x: a.x * k, y: a.y * k });
export const len = (a: V): number => Math.hypot(a.x, a.y);
export const dist = (a: V, b: V): number => Math.hypot(a.x - b.x, a.y - b.y);
export const lerp = (a: V, b: V, t: number): V => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
export const fromAngle = (angle: number, length = 1): V => ({
  x: Math.cos(angle) * length,
  y: Math.sin(angle) * length,
});
export const clamp = (x: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, x));

/** Shortest signed difference b - a, in (-PI, PI]. */
export function angleDiff(a: number, b: number): number {
  let d = (b - a) % (Math.PI * 2);
  if (d > Math.PI) d -= Math.PI * 2;
  if (d <= -Math.PI) d += Math.PI * 2;
  return d;
}

export function unit(a: V, fallback: V = { x: 1, y: 0 }): V {
  const l = len(a);
  return l < 1e-6 ? fallback : { x: a.x / l, y: a.y / l };
}

/**
 * Two-bone inverse kinematics in 2D. Returns the knee for a hip at `hip`,
 * a tip at `tip`, bone lengths `a` (hip→knee) and `b` (knee→tip). Of the
 * two mirror solutions, the one farther from `away` is chosen, so knees
 * bend outward from the body. A tip out of reach straightens the leg.
 */
export function solveKnee(hip: V, tip: V, a: number, b: number, away: V): V {
  const d = clamp(dist(hip, tip), Math.abs(a - b) + 1e-3, a + b - 1e-3);
  const base = Math.atan2(tip.y - hip.y, tip.x - hip.x);
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1);
  const bend = Math.acos(cosA);
  const k1 = add(hip, fromAngle(base + bend, a));
  const k2 = add(hip, fromAngle(base - bend, a));
  return dist(k1, away) >= dist(k2, away) ? k1 : k2;
}

/** Nearest point on the border of a rect to `p`. */
export function nearestOnRectEdge(p: V, r: { x: number; y: number; width: number; height: number }): V {
  const x = clamp(p.x, r.x, r.x + r.width);
  const y = clamp(p.y, r.y, r.y + r.height);
  const inside = p.x > r.x && p.x < r.x + r.width && p.y > r.y && p.y < r.y + r.height;
  if (!inside) return { x, y };
  const dl = p.x - r.x;
  const dr = r.x + r.width - p.x;
  const dt = p.y - r.y;
  const db = r.y + r.height - p.y;
  const m = Math.min(dl, dr, dt, db);
  if (m === dl) return { x: r.x, y: p.y };
  if (m === dr) return { x: r.x + r.width, y: p.y };
  if (m === dt) return { x: p.x, y: r.y };
  return { x: p.x, y: r.y + r.height };
}

/** Critically-ish damped spring step (semi-implicit Euler) for a 2D point. */
export function springStep(pos: V, vel: V, target: V, k: number, c: number, dt: number, vmax: number): void {
  const ax = k * (target.x - pos.x) - c * vel.x;
  const ay = k * (target.y - pos.y) - c * vel.y;
  vel.x += ax * dt;
  vel.y += ay * dt;
  const s = Math.hypot(vel.x, vel.y);
  if (s > vmax) {
    vel.x *= vmax / s;
    vel.y *= vmax / s;
  }
  pos.x += vel.x * dt;
  pos.y += vel.y * dt;
}
