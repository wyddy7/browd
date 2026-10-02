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
export const rot90 = (a: V, sign: number): V => ({ x: -a.y * sign, y: a.x * sign });

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

/** `p` pulled toward `origin` so it is at most `max` away. */
export function clampLen(origin: V, p: V, max: number): V {
  const d = dist(origin, p);
  return d <= max ? p : add(origin, mul(sub(p, origin), max / d));
}

/**
 * A leg in a vertical plane: the hip sits `hipZ` above the page, the foot
 * `footZ` above it (0 when planted), the knee always bends up. Returns how
 * far along the ground the knee is from the hip and how high it is. The
 * ground distance is clamped to what the bones can reach, so a leg can
 * never be drawn longer than it is.
 */
export function kneeInPlane(
  ground: number,
  hipZ: number,
  footZ: number,
  femur: number,
  tibia: number,
): { along: number; height: number; reach: number } {
  const dz = footZ - hipZ;
  const maxD = femur + tibia - 1e-3;
  const reach = Math.sqrt(Math.max(0, maxD * maxD - dz * dz));
  const d = Math.min(ground, reach);
  const D = clamp(Math.hypot(d, dz), Math.abs(femur - tibia) + 1e-3, maxD);
  const base = Math.atan2(dz, d);
  const bend = Math.acos(clamp((femur * femur + D * D - tibia * tibia) / (2 * femur * D), -1, 1));
  const a = base + bend; // the upper solution: knee above the hip–foot line
  return { along: Math.cos(a) * femur, height: hipZ + Math.sin(a) * femur, reach };
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

/** Damped spring step (semi-implicit Euler) for a 2D point, with a speed cap. */
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

export const easeInOut = (t: number): number => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
export const easeIn = (t: number): number => t * t * t;
/** Overshoots to about 1.1 before settling at 1. */
export const easeOutBack = (t: number): number => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};

export const rotate = (a: V, t: number): V => ({
  x: a.x * Math.cos(t) - a.y * Math.sin(t),
  y: a.x * Math.sin(t) + a.y * Math.cos(t),
});

/**
 * Two-bone leg in the page plane, the way a spider reads from above: the
 * knee bends to a fixed side of the hip→foot line (`bend` = +1 or -1), so it
 * can never flip. A foot out of reach straightens the leg toward it.
 */
export function knee2D(hip: V, foot: V, femur: number, tibia: number, bend: number): { knee: V; tip: V } {
  const span = foot.x - hip.x || foot.y - hip.y ? { x: foot.x - hip.x, y: foot.y - hip.y } : { x: 1, y: 0 };
  const raw = Math.hypot(span.x, span.y) || 1e-6;
  const dir = { x: span.x / raw, y: span.y / raw };
  const d = clamp(raw, Math.abs(femur - tibia) + 1e-3, femur + tibia - 1e-3);
  const a = Math.acos(clamp((femur * femur + d * d - tibia * tibia) / (2 * femur * d), -1, 1));
  const knee = add(hip, mul(rotate(dir, bend * a), femur));
  return { knee, tip: add(hip, mul(dir, d)) };
}
