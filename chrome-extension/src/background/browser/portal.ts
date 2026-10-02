/**
 * The seam between the page and the chat panel, so one spider can cross it —
 * half drawn by the page, half by the panel, at one physical size.
 *
 * Common frame: DIP (screen points). Each document converts with its own zoom:
 * the page's comes from `chrome.tabs.getZoom`, the panel's is derived from the
 * two `devicePixelRatio`s (same screen: dpr = screen scale × zoom).
 *
 * Layout: the page fills the window to its bottom edge and its side. The panel
 * is a card with one margin on every side (measured on Chrome 2026, 03.10:
 * 18 / 17 / 17 DIP left / right / bottom of a 35 DIP spare width), so that
 * margin is half of what the window's width leaves over after both viewports;
 * an old flat panel leaves only its handle, a couple of DIP. The panel has a
 * header of its own on top, hence alignment by the bottom. DevTools docked at
 * the bottom of the page breaks it.
 */
import type { SpiderPoint as V } from '@extension/shared';

export interface ViewMetrics {
  /** CSS px of that document. */
  width: number;
  height: number;
  dpr: number;
  /** Browser window width in DIP (the page reports it). */
  outerWidth?: number;
}

export interface Portal {
  /** Panel CSS px per page CSS px: a spider of size s on the page is s × k in the panel. */
  k: number;
  /** The panel's own zoom. */
  panelZoom: number;
  /** The panel card's margin (the same on every side), DIP. */
  margin: number;
  toPanel(p: V): V;
  toPage(q: V): V;
}

export function portal(page: ViewMetrics & { zoom: number }, panel: ViewMetrics, side: 'left' | 'right'): Portal {
  const screenScale = page.dpr / page.zoom;
  const panelZoom = panel.dpr / screenScale;
  const k = page.zoom / panelZoom;
  const pageW = page.width * page.zoom;
  const panelW = panel.width * panelZoom;
  const spare = page.outerWidth === undefined ? 0 : page.outerWidth - pageW - panelW;
  const margin = spare > 0 && spare < 80 ? spare / 2 : 0;
  // The panel's left edge in DIP from the page's left edge; its bottom `margin` above the page's.
  const panelLeft = side === 'right' ? pageW + margin : -(panelW + margin);
  return {
    k,
    panelZoom,
    margin,
    toPanel: p => ({
      x: (p.x * page.zoom - panelLeft) / panelZoom,
      y: panel.height - ((page.height - p.y) * page.zoom - margin) / panelZoom,
    }),
    toPage: q => ({
      x: (q.x * panelZoom + panelLeft) / page.zoom,
      y: page.height - ((panel.height - q.y) * panelZoom + margin) / page.zoom,
    }),
  };
}
