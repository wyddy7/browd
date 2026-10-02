/**
 * Agent spider settings — the line-drawn spider that walks to whatever the
 * agent clicks or types into, drawn by the content script in the agent's
 * tab. Experimental; read live by the background, which forwards changes to
 * a spider already on screen.
 */
import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

export type SpiderPace = 'calm' | 'normal' | 'fast';

/**
 * - `off`: nothing but the spider.
 * - `target`: one outline around the element the agent acts on, fading.
 * - `feet`: every element under a planted foot is outlined while gripped
 *   (the look of the original reference video).
 */
export type SpiderMarks = 'off' | 'target' | 'feet';

/** One colour for the whole spider, or the slow hue drift of the reference video. */
export type SpiderColor = 'violet' | 'ink' | 'white' | 'cyan' | 'magenta' | 'rainbow';

export interface SpiderLook {
  /** Overall scale, 1 = default size (about 200 px leg span). */
  size: number;
  pace: SpiderPace;
  marks: SpiderMarks;
  color: SpiderColor;
  /** Tear the words the agent is looking for out of the page (drawn over it; the DOM is untouched). */
  tear: boolean;
}

export interface SpiderSettings extends SpiderLook {
  enabled: boolean;
}

export const DEFAULT_SPIDER_SETTINGS: SpiderSettings = {
  enabled: true,
  size: 1,
  pace: 'normal',
  marks: 'target',
  color: 'violet',
  tear: true,
};

const PACES: SpiderPace[] = ['calm', 'normal', 'fast'];
const MARKS: SpiderMarks[] = ['off', 'target', 'feet'];
const COLORS: SpiderColor[] = ['violet', 'ink', 'white', 'cyan', 'magenta', 'rainbow'];

export function normalizeSpiderSettings(raw: Partial<SpiderSettings> | null | undefined): SpiderSettings {
  const s = { ...DEFAULT_SPIDER_SETTINGS, ...(raw ?? {}) };
  return {
    enabled: s.enabled !== false,
    size: Number.isFinite(s.size) ? Math.min(1.8, Math.max(0.6, s.size)) : DEFAULT_SPIDER_SETTINGS.size,
    pace: PACES.includes(s.pace) ? s.pace : DEFAULT_SPIDER_SETTINGS.pace,
    marks: MARKS.includes(s.marks) ? s.marks : DEFAULT_SPIDER_SETTINGS.marks,
    color: COLORS.includes(s.color) ? s.color : DEFAULT_SPIDER_SETTINGS.color,
    tear: s.tear !== false,
  };
}

export type SpiderSettingsStorage = BaseStorage<SpiderSettings> & {
  getSettings: () => Promise<SpiderSettings>;
  updateSettings: (patch: Partial<SpiderSettings>) => Promise<void>;
};

const storage = createStorage<SpiderSettings>('spider-settings', DEFAULT_SPIDER_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

export const spiderSettingsStore: SpiderSettingsStorage = {
  ...storage,
  getSettings: async () => normalizeSpiderSettings(await storage.get()),
  updateSettings: async patch => {
    const current = normalizeSpiderSettings(await storage.get());
    await storage.set(normalizeSpiderSettings({ ...current, ...patch }));
  },
};
