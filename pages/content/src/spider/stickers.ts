/**
 * Words torn out of the page — drawn on the overlay only. The page's DOM is
 * never touched: the word's spot is covered with the solid colour behind it
 * (the hole), and a copy of the word is drawn on the canvas as a sticker the
 * spider pulls out with a front leg, lets hang tilted, then puts back. The
 * agent never sees any of it (the canvas is hidden for every capture) and a
 * new action takes them all back at once.
 */
import type { SpiderPoint as V, SpiderRect } from '@extension/shared';
import { add, clamp, lerp, springStep, sub, vec } from './geometry';
import type { Box } from './overlay';
import type { WordHit } from './reader';

type Phase = 'pull' | 'hang' | 'back';

interface Sticker {
  text: string;
  /** Document-space rect the word came from. */
  origin: SpiderRect;
  background: string;
  art: HTMLCanvasElement;
  artW: number;
  artH: number;
  /** Document-space centre. */
  pos: V;
  vel: V;
  angle: number;
  angleTo: number;
  scale: number;
  scaleTo: number;
  phase: Phase;
  phaseAt: number;
  /** While pulled: which front leg holds it (+1 right, -1 left). */
  side: 1 | -1;
  alpha: number;
}

const MAX_LIVE = 3;
const PULL_MS = 900;
const HANG_MS = 2200;

export class Stickers {
  private list: Sticker[] = [];
  private recent = new Map<string, number>();

  get live(): number {
    return this.list.length;
  }

  /** Tear `hit` out of the page; the given front leg pulls it. */
  tear(hit: WordHit, side: 1 | -1, now: number, fill: string, textColor: string, restyle: boolean): boolean {
    const key = `${Math.round(hit.rect.x + scrollX)}:${Math.round(hit.rect.y + scrollY)}`;
    if (this.list.length >= MAX_LIVE || (this.recent.get(key) ?? 0) > now - 8000) return false;
    this.recent.set(key, now);
    const origin = { x: hit.rect.x + scrollX, y: hit.rect.y + scrollY, width: hit.rect.width, height: hit.rect.height };
    const { art, w, h } = paintWord(hit, fill, textColor, restyle);
    this.list.push({
      text: hit.text,
      origin,
      background: hit.background,
      art,
      artW: w,
      artH: h,
      pos: { x: origin.x + origin.width / 2, y: origin.y + origin.height / 2 },
      vel: vec(0, 0),
      angle: 0,
      angleTo: (Math.random() < 0.5 ? -1 : 1) * (0.25 + Math.random() * 0.45),
      scale: 1,
      scaleTo: 1.35 + Math.random() * 0.35,
      phase: 'pull',
      phaseAt: now,
      side,
      alpha: 1,
    });
    return true;
  }

  /** A new action: every word goes straight back. */
  returnAll(now: number): void {
    for (const st of this.list) {
      if (st.phase !== 'back') {
        st.phase = 'back';
        st.phaseAt = now;
      }
    }
  }

  clear(): void {
    this.list = [];
  }

  /** Which front leg should be pulling, and where to (view space); null when none. */
  pulling(): { side: 1 | -1; to: V } | null {
    const st = this.list.find(x => x.phase === 'pull');
    if (!st) return null;
    return { side: st.side, to: { x: st.pos.x - scrollX, y: st.pos.y - scrollY } };
  }

  /**
   * `legTip(side)` is the pulling front foot in view space. While pulled the
   * word follows it; then it hangs where it was let go; then it springs home.
   */
  update(dt: number, now: number, legTip: (side: 1 | -1) => V, body: V): void {
    for (const st of this.list) {
      const age = now - st.phaseAt;
      if (st.phase === 'pull') {
        // The leg pulls the word away from the body's side, a little up.
        const tip = add(legTip(st.side), { x: scrollX, y: scrollY });
        const away = sub(tip, add(body, { x: scrollX, y: scrollY }));
        const target = add(tip, { x: away.x * 0.15, y: away.y * 0.15 - 6 });
        springStep(st.pos, st.vel, target, 140, 16, dt, 1500);
        if (age > PULL_MS) {
          st.phase = 'hang';
          st.phaseAt = now;
        }
      } else if (st.phase === 'hang') {
        st.vel = lerp(st.vel, vec(0, 0), Math.min(1, dt * 6));
        st.pos = add(st.pos, { x: st.vel.x * dt, y: st.vel.y * dt });
        st.angleTo += Math.sin(now / 300) * 0.002;
        if (age > HANG_MS) {
          st.phase = 'back';
          st.phaseAt = now;
        }
      } else {
        const home = { x: st.origin.x + st.origin.width / 2, y: st.origin.y + st.origin.height / 2 };
        springStep(st.pos, st.vel, home, 220, 24, dt, 2400);
        st.angleTo = 0;
        st.scaleTo = 1;
        if (Math.hypot(st.pos.x - home.x, st.pos.y - home.y) < 1.5 && Math.abs(st.angle) < 0.02) {
          st.alpha -= dt * 8;
        }
      }
      st.angle += (st.angleTo - st.angle) * Math.min(1, dt * 10);
      st.scale += (st.scaleTo - st.scale) * Math.min(1, dt * 10);
    }
    this.list = this.list.filter(st => st.alpha > 0);
  }

  draw(ctx: CanvasRenderingContext2D, box: Box): void {
    for (const st of this.list) {
      const o = { x: st.origin.x - scrollX, y: st.origin.y - scrollY };
      // The hole: the word's spot, painted over in the colour behind it.
      ctx.save();
      ctx.globalAlpha = clamp(st.alpha, 0, 1);
      ctx.fillStyle = st.background;
      ctx.fillRect(o.x - 1, o.y - 1, st.origin.width + 2, st.origin.height + 2);
      box.add(o, 2);
      box.add({ x: o.x + st.origin.width, y: o.y + st.origin.height }, 2);
      // The word itself, lifted.
      const c = { x: st.pos.x - scrollX, y: st.pos.y - scrollY };
      ctx.translate(c.x, c.y);
      ctx.rotate(st.angle);
      const k = (st.scale * st.origin.width) / st.artW;
      ctx.scale(k, k);
      ctx.drawImage(st.art, -st.artW / 2, -st.artH / 2, st.artW, st.artH);
      ctx.restore();
      const r = (Math.max(st.artW, st.artH) * k) / 2 + 6;
      box.add(c, r);
    }
  }

  snapshot(): Array<{ text: string; rect: SpiderRect; phase: string }> {
    return this.list.map(st => ({
      text: st.text,
      rect: { x: st.origin.x - scrollX, y: st.origin.y - scrollY, width: st.origin.width, height: st.origin.height },
      phase: st.phase,
    }));
  }
}

/**
 * The word on its own small canvas: either restyled the reference way — a
 * filled tag with monospace text — or in the page's own font with an outline.
 */
function paintWord(
  hit: WordHit,
  fill: string,
  textColor: string,
  restyle: boolean,
): {
  art: HTMLCanvasElement;
  w: number;
  h: number;
} {
  const dpr = window.devicePixelRatio || 1;
  const pad = restyle ? 4 : 2;
  const measure = document.createElement('canvas').getContext('2d')!;
  const fontPx = Math.max(10, Math.round(hit.rect.height * 0.72));
  const font = restyle ? `600 ${fontPx}px ui-monospace, SFMono-Regular, Menlo, monospace` : hit.font;
  measure.font = font;
  const textW = Math.ceil(measure.measureText(hit.text).width);
  const w = textW + pad * 2;
  const h = Math.ceil(hit.rect.height) + pad * 2;
  const art = document.createElement('canvas');
  art.width = Math.ceil(w * dpr);
  art.height = Math.ceil(h * dpr);
  const g = art.getContext('2d')!;
  g.scale(dpr, dpr);
  g.font = font;
  g.textBaseline = 'middle';
  if (restyle) {
    g.fillStyle = fill;
    g.fillRect(0, 0, w, h);
    g.fillStyle = textColor;
  } else {
    g.fillStyle = hit.background;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = fill;
    g.lineWidth = 1.5;
    g.strokeRect(0.75, 0.75, w - 1.5, h - 1.5);
    g.fillStyle = hit.color;
  }
  g.fillText(hit.text, pad, h / 2 + 0.5);
  return { art, w, h };
}
