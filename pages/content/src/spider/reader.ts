/**
 * What the spider reads while the agent thinks: text blocks in the viewport
 * (paragraphs, list items, cards) and the line boxes of their text, found
 * from the page's own layout. Sampled every few seconds, never per frame.
 */
import type { SpiderPoint as V } from '@extension/shared';

export interface Line {
  x0: number;
  x1: number;
  y: number;
}

export interface Block {
  el: Element;
  rect: { x: number; y: number; width: number; height: number };
  lines: Line[];
}

const BLOCKISH = new Set(['block', 'list-item', 'flex', 'grid', 'table-cell', 'table-row', 'flow-root']);
const SKIP = new Set(['HTML', 'BODY', 'MAIN', 'BROWD-SPIDER', 'SCRIPT', 'STYLE', 'NAV', 'HEADER', 'FOOTER']);

function blockOf(start: Element | null, vw: number): Element | null {
  let el: Element | null = start;
  for (let depth = 0; depth < 7 && el; depth++) {
    const current: Element = el;
    el = current.parentElement;
    if (SKIP.has(current.tagName)) return null;
    const display = getComputedStyle(current).display;
    if (!BLOCKISH.has(display)) continue;
    const r = current.getBoundingClientRect();
    if (r.width < 100 || r.width > Math.min(940, vw * 0.96) || r.height < 14 || r.height > 420) continue;
    if ((current.textContent ?? '').trim().length < 12) continue;
    return current;
  }
  return null;
}

/** Line boxes of the block's own text (text nodes only), merged per visual line, top to bottom, on screen. */
export function linesOf(el: Element, vh: number, max = 3): Line[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const range = document.createRange();
  const lines: Array<Line & { h: number }> = [];
  let nodes = 0;
  for (let node = walker.nextNode(); node && nodes < 80; node = walker.nextNode()) {
    if (!node.nodeValue || !node.nodeValue.trim()) continue;
    nodes++;
    range.selectNodeContents(node);
    for (const r of Array.from(range.getClientRects())) {
      if (r.width < 4 || r.height < 6 || r.height > 64) continue;
      const y = r.y + r.height / 2;
      if (y < 40 || y > vh - 40) continue;
      const same = lines.find(l => Math.abs(l.y - y) < Math.min(l.h, r.height) * 0.5);
      if (same) {
        same.x0 = Math.min(same.x0, r.x);
        same.x1 = Math.max(same.x1, r.x + r.width);
      } else {
        lines.push({ x0: r.x, x1: r.x + r.width, y, h: r.height });
      }
    }
  }
  range.detach();
  return lines
    .filter(l => l.x1 - l.x0 >= 24)
    .sort((a, b) => a.y - b.y)
    .slice(0, max)
    .map(({ x0, x1, y }) => ({ x0, x1, y }));
}

/** Readable blocks under a sparse grid over the viewport. */
export function findBlocks(vw: number, vh: number): Block[] {
  const seen = new Set<Element>();
  const out: Block[] = [];
  const cols = 4;
  const rows = 6;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const x = 40 + ((c + 0.5) / cols) * (vw - 80) + (Math.random() - 0.5) * 30;
      const y = 60 + ((r + 0.5) / rows) * (vh - 100) + (Math.random() - 0.5) * 30;
      const el = blockOf(document.elementFromPoint(x, y), vw);
      if (!el || seen.has(el)) continue;
      seen.add(el);
      const lines = linesOf(el, vh);
      if (!lines.length) continue;
      const b = el.getBoundingClientRect();
      out.push({ el, rect: { x: b.x, y: b.y, width: b.width, height: b.height }, lines });
    }
  }
  return out;
}

/** Next block to read: unvisited, preferably just below in reading order, not far. */
export function pickNext(blocks: Block[], from: V, visited: WeakSet<Element>): Block | null {
  let best: Block | null = null;
  let bestScore = -Infinity;
  for (const b of blocks) {
    if (visited.has(b.el)) continue;
    const start = { x: b.lines[0].x0, y: b.lines[0].y };
    const dy = start.y - from.y;
    const d = Math.hypot(start.x - from.x, dy);
    const below = dy > -20 ? 1 : 0;
    const score = below * 1.5 - d / 400 + Math.random() * 0.6;
    if (score > bestScore) {
      bestScore = score;
      best = b;
    }
  }
  return best;
}
