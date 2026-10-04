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

/** Sticker colour per spider colour: a hue far from the spider's, light enough for dark text. */
const STICKER: Record<Exclude<SpiderColor, 'rainbow'>, { h: number; s: number; l: number }> = {
  violet: { h: 46, s: 100, l: 60 }, // amber, a highlighter
  ink: { h: 46, s: 100, l: 60 },
  white: { h: 258, s: 100, l: 76 },
  cyan: { h: 318, s: 100, l: 74 },
  magenta: { h: 188, s: 100, l: 60 },
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
    // Torn words in a contrasting colour: in the spider's own hue they merged with the spider holding them.
    stickers: [0, 8, -6, 4].map(dl => {
      const k = STICKER[color as keyof typeof STICKER];
      return `hsl(${k.h}, ${k.s}%, ${k.l + dl}%)`;
    }),
    stickerText: '#0b0b12',
  };
}
