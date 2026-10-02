/**
 * The one element the spider adds to a page: a host on <html> with a closed
 * shadow root holding a full-viewport canvas. Appended once, never touched
 * again (the agent hashes `documentElement.outerHTML` around coordinate
 * clicks), removed when the spider leaves. Nothing in it takes pointer events.
 */
import type { SpiderPoint as V } from '@extension/shared';

export class Box {
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
  /** Scale the box about `c` (the drawing was scaled about it). */
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

const HOST_STYLE = [
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
]
  .map(d => `${d} !important`)
  .join(';');

export class Overlay {
  private host: HTMLElement | null = null;
  private canvas: HTMLCanvasElement | null = null;
  ctx: CanvasRenderingContext2D | null = null;
  private dpr = 1;
  private lastBox: [number, number, number, number] | null = null;

  constructor(private readonly onUnload: () => void) {}

  get mounted(): boolean {
    return this.host !== null;
  }

  mount(): void {
    if (this.host) return;
    const host = document.createElement('browd-spider');
    host.setAttribute('style', HOST_STYLE);
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
    addEventListener('beforeunload', this.onUnload);
  }

  unmount(): void {
    removeEventListener('resize', this.resize);
    removeEventListener('beforeunload', this.onUnload);
    this.host?.remove();
    this.host = null;
    this.canvas = null;
    this.ctx = null;
    this.lastBox = null;
  }

  setVisible(on: boolean): void {
    if (this.canvas) this.canvas.style.visibility = on ? 'visible' : 'hidden';
    if (!on) this.clearAll();
  }

  /** Clear what the previous frame drew; returns the context for this frame. */
  begin(): CanvasRenderingContext2D | null {
    if (!this.ctx) return null;
    if (this.lastBox) {
      const [x0, y0, x1, y1] = this.lastBox;
      this.ctx.clearRect(x0, y0, x1 - x0, y1 - y0);
    }
    this.lastBox = null;
    return this.ctx;
  }

  /** Remember what this frame covered, so the next one clears only that. */
  end(box: Box): void {
    this.lastBox = box.clip(innerWidth, innerHeight);
  }

  clearAll(): void {
    if (this.ctx && this.canvas) this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.lastBox = null;
  }

  private resize = (): void => {
    if (!this.canvas) return;
    this.dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(innerWidth * this.dpr);
    this.canvas.height = Math.round(innerHeight * this.dpr);
    this.ctx?.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.lastBox = null;
  };
}
