import type { SpiderColor } from '@extension/shared';

export interface Palette {
  line: string;
  joint: string;
  /** Under-stroke: dark under light colours, light under dark ones, so the spider reads on any page. */
  shade: string;
  fill: string;
  /** Fills for torn-out words, cycled. */
  stickers: string[];
  /** Text colour on a sticker fill. */
  stickerText: string;
}

const MONO: Record<Exclude<SpiderColor, 'rainbow'>, { h: number; s: number; l: number }> = {
  violet: { h: 258, s: 100, l: 72 },
  ink: { h: 240, s: 10, l: 14 },
  white: { h: 0, s: 0, l: 97 },
  cyan: { h: 188, s: 100, l: 58 },
  magenta: { h: 318, s: 100, l: 66 },
};

export function palette(color: SpiderColor, now: number): Palette {
  if (color === 'rainbow') {
    const h = (190 + now / 90) % 360;
    return {
      line: `hsl(${h}, 100%, 62%)`,
      joint: `hsl(${(h + 150) % 360}, 100%, 62%)`,
      shade: 'rgba(8, 10, 20, 0.42)',
      fill: 'rgba(8, 10, 20, 0.45)',
      stickers: ['hsl(188, 100%, 62%)', 'hsl(318, 100%, 66%)', 'hsl(48, 100%, 62%)', 'hsl(232, 100%, 70%)'],
      stickerText: '#0b0b12',
    };
  }
  const c = MONO[color];
  const dark = c.l < 40;
  return {
    line: `hsl(${c.h}, ${c.s}%, ${c.l}%)`,
    joint: `hsl(${c.h}, ${c.s}%, ${dark ? c.l + 26 : Math.min(96, c.l + 14)}%)`,
    shade: dark ? 'rgba(255, 255, 255, 0.6)' : 'rgba(8, 10, 20, 0.45)',
    fill: dark ? 'rgba(20, 20, 26, 0.6)' : 'rgba(8, 10, 20, 0.42)',
    stickers: [0, 10, -10, 18].map(
      dl => `hsl(${c.h}, ${c.s}%, ${Math.max(20, Math.min(90, (dark ? 40 : c.l) + dl))}%)`,
    ),
    stickerText: dark || c.l < 70 ? '#ffffff' : '#0b0b12',
  };
}
