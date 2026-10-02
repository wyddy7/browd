/**
 * A box (position, size, corner radius) on a spring, integrated per frame so a
 * new goal can be set mid-flight (auto-docs/for-frontend/motion-morph.md:
 * springs in JS, re-reading the target, never CSS keyframes).
 */
export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
  r: number;
}

export interface Spring {
  k: number;
  c: number;
}

/** motion-morph tokens: expand overshoots ~8 %, fold barely undershoots. */
export const EXPAND: Spring = { k: 310, c: 21 };
export const FOLD: Spring = { k: 420, c: 30 };

const KEYS = ['x', 'y', 'w', 'h', 'r'] as const;

export class SpringBox {
  box: Box;
  private vel: Box = { x: 0, y: 0, w: 0, h: 0, r: 0 };
  private goal: Box;
  private spring: Spring = EXPAND;
  private raf = 0;
  private last = 0;
  private onRest: (() => void) | null = null;

  constructor(
    start: Box,
    private readonly onFrame: (box: Box) => void,
  ) {
    this.box = { ...start };
    this.goal = { ...start };
  }

  /** Spring toward `goal`; `onRest` runs once it settles. */
  to(goal: Box, spring: Spring, onRest?: () => void): void {
    this.goal = { ...goal };
    this.spring = spring;
    this.onRest = onRest ?? null;
    // A hidden panel gets no frames: land at once instead of waiting for the user to come back.
    if (document.hidden) {
      this.box = { ...goal };
      this.onFrame(this.box);
      this.rest();
      return;
    }
    if (!this.raf) {
      this.last = 0;
      this.raf = requestAnimationFrame(this.step);
    }
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }

  private step = (now: number): void => {
    const dt = this.last ? Math.min(0.032, (now - this.last) / 1000) : 1 / 60;
    this.last = now;
    let moving = false;
    for (const key of KEYS) {
      const a = this.spring.k * (this.goal[key] - this.box[key]) - this.spring.c * this.vel[key];
      this.vel[key] += a * dt;
      this.box[key] += this.vel[key] * dt;
      if (Math.abs(this.goal[key] - this.box[key]) > 0.3 || Math.abs(this.vel[key]) > 2) moving = true;
    }
    if (moving) {
      this.onFrame(this.box);
      this.raf = requestAnimationFrame(this.step);
      return;
    }
    this.box = { ...this.goal };
    this.onFrame(this.box);
    this.raf = 0;
    this.rest();
  };

  private rest(): void {
    const rest = this.onRest;
    this.onRest = null;
    rest?.();
  }
}
