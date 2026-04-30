import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

// Interface for general settings configuration
export type AppearanceTheme = 'light' | 'dark';

export interface GeneralSettingsConfig {
  appearanceTheme: AppearanceTheme;
  maxSteps: number;
  maxActionsPerStep: number;
  maxFailures: number;
  useVision: boolean;
  useVisionForPlanner: boolean;
  planningInterval: number;
  displayHighlights: boolean;
  minWaitPageLoad: number;
  replayHistoricalTasks: boolean;
  launchShortcut: string;
}

export type GeneralSettingsStorage = BaseStorage<GeneralSettingsConfig> & {
  updateSettings: (settings: Partial<GeneralSettingsConfig>) => Promise<void>;
  getSettings: () => Promise<GeneralSettingsConfig>;
  resetToDefaults: () => Promise<void>;
};

// Default settings
export const DEFAULT_GENERAL_SETTINGS: GeneralSettingsConfig = {
  appearanceTheme: 'light',
  maxSteps: 100,
  maxActionsPerStep: 5,
  maxFailures: 3,
  useVision: false,
  useVisionForPlanner: false,
  planningInterval: 3,
  displayHighlights: true,
  minWaitPageLoad: 250,
  replayHistoricalTasks: false,
  launchShortcut: 'Ctrl+E',
};

const storage = createStorage<GeneralSettingsConfig>('general-settings', DEFAULT_GENERAL_SETTINGS, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

const normalizeAppearanceTheme = (theme: unknown): AppearanceTheme => {
  if (theme === 'dark' || theme === 'graphite' || theme === 'mono' || theme === 'blue' || theme === 'ember') {
    return 'dark';
  }
  return 'light';
};

const normalizeShortcut = (shortcut: unknown): string => {
  if (typeof shortcut !== 'string') {
    return DEFAULT_GENERAL_SETTINGS.launchShortcut;
  }

  return shortcut.trim();
};

export const generalSettingsStore: GeneralSettingsStorage = {
  ...storage,
  async updateSettings(settings: Partial<GeneralSettingsConfig>) {
    const currentSettings = (await storage.get()) || DEFAULT_GENERAL_SETTINGS;
    const updatedSettings = {
      ...currentSettings,
      ...settings,
    };

    updatedSettings.appearanceTheme = normalizeAppearanceTheme(updatedSettings.appearanceTheme);
    updatedSettings.launchShortcut = normalizeShortcut(updatedSettings.launchShortcut);

    // If useVision is true, displayHighlights must also be true
    if (updatedSettings.useVision && !updatedSettings.displayHighlights) {
      updatedSettings.displayHighlights = true;
    }

    await storage.set(updatedSettings);
  },
  async getSettings() {
    const settings = await storage.get();
    return {
      ...DEFAULT_GENERAL_SETTINGS,
      ...settings,
      appearanceTheme: normalizeAppearanceTheme(settings?.appearanceTheme),
      launchShortcut: normalizeShortcut(settings?.launchShortcut),
    };
  },
  async resetToDefaults() {
    await storage.set(DEFAULT_GENERAL_SETTINGS);
  },
};
