/**
 * The page ↔ chat-panel seam at different zooms and screens: a point on the
 * seam maps to the seam, distances from the window's bottom match in DIP, a
 * spider keeps its physical size, and the mapping round-trips.
 */
import { describe, it, expect } from 'vitest';
import { portal } from '../portal';

const CASES = [
  { name: 'retina, page 100 %, panel 100 %', dpr: 2, zoom: 1, panelDpr: 2 },
  { name: 'retina, page 150 %, panel 100 %', dpr: 3, zoom: 1.5, panelDpr: 2 },
  { name: 'retina, page 80 %, panel 125 %', dpr: 1.6, zoom: 0.8, panelDpr: 2.5 },
  { name: 'plain screen, page 125 %, panel 100 %', dpr: 1.25, zoom: 1.25, panelDpr: 1 },
];

describe('portal (page ↔ chat panel seam)', () => {
  for (const c of CASES) {
    it(`${c.name}: seam to seam, bottoms aligned, one physical size, round trip`, () => {
      const screenScale = c.dpr / c.zoom;
      const panelZoom = c.panelDpr / screenScale;
      // A 1400×880 DIP window as measured on Chrome 03.10: page 1005 DIP to the window's bottom, a panel
      // card 360 DIP wide with a 17.5 DIP margin on every side (35 DIP spare), panel header on top.
      const page = { width: 1005 / c.zoom, height: 741 / c.zoom, dpr: c.dpr, zoom: c.zoom, outerWidth: 1400 };
      const panel = { width: 360 / panelZoom, height: 689 / panelZoom, dpr: c.panelDpr };
      const p = portal(page, panel, 'right');
      expect(p.margin).toBeCloseTo(17.5, 6);
      expect(p.panelZoom).toBeCloseTo(panelZoom, 9);
      // The page's right edge plus the margin is the panel's left edge; its bottom is a margin up.
      const seam = p.toPanel({ x: page.width + 17.5 / c.zoom, y: page.height - 17.5 / c.zoom });
      expect(seam.x).toBeCloseTo(0, 6);
      expect(seam.y).toBeCloseTo(panel.height, 6);
      // 100 DIP above the window's bottom on the page is 100 − 17.5 DIP above the panel's bottom.
      const q = p.toPanel({ x: page.width, y: page.height - 100 / c.zoom });
      expect((panel.height - q.y) * panelZoom).toBeCloseTo(82.5, 6);
      // One physical size: s CSS px on the page cover the same device pixels as s·k in the panel.
      expect(1 * c.dpr).toBeCloseTo(p.k * c.panelDpr, 9);
      // Round trip.
      const back = p.toPage(p.toPanel({ x: 123, y: 456 }));
      expect(back.x).toBeCloseTo(123, 9);
      expect(back.y).toBeCloseTo(456, 9);
    });
  }

  it('a panel docked on the left meets the page at the page’s left edge', () => {
    const page = { width: 1000, height: 800, dpr: 2, zoom: 1, outerWidth: 1404 };
    const panel = { width: 400, height: 760, dpr: 2 };
    const p = portal(page, panel, 'left');
    expect(p.toPanel({ x: -2, y: 400 }).x).toBeCloseTo(400, 6);
    expect(p.toPage({ x: 400, y: 380 }).x).toBeCloseTo(-2, 6);
  });

  it('an old flat panel (only a handle between) is nearly bottom-aligned', () => {
    const p = portal(
      { width: 1000, height: 800, dpr: 2, zoom: 1, outerWidth: 1404 },
      { width: 400, height: 760, dpr: 2 },
      'right',
    );
    expect(p.margin).toBe(2);
  });

  it('implausible window metrics count as no margin', () => {
    const p = portal(
      { width: 1000, height: 800, dpr: 2, zoom: 1, outerWidth: 1600 },
      { width: 400, height: 760, dpr: 2 },
      'right',
    );
    expect(p.margin).toBe(0);
  });
});
