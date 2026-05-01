import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

// Interface for general settings configuration
export type AppearanceTheme = 'light' | 'dark';
export type InterfaceLanguage = 'system' | 'en' | 'ru' | 'es' | 'fr' | 'de' | 'pt_BR';
/**
 * Agent runtime topology.
 * - 'classic': inherited Planner+Navigator pipeline (two LLM calls per step).
 * - 'unified': single ReAct agent with full tool surface, evidence-required
 *   `done`, and structured tracing as the only feedback loop. Experimental
 *   until T3 evals confirm it wins. See auto-docs/browd-agent-evolution.md.
 */
export type AgentMode = 'classic' | 'unified';

export interface GeneralSettingsConfig {
  appearanceTheme: AppearanceTheme;
  interfaceLanguage: InterfaceLanguage;
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
  agentMode: AgentMode;
}

export type GeneralSettingsStorage = BaseStorage<GeneralSettingsConfig> & {
  updateSettings: (settings: Partial<GeneralSettingsConfig>) => Promise<void>;
  getSettings: () => Promise<GeneralSettingsConfig>;
  resetToDefaults: () => Promise<void>;
};

// Default settings
export const DEFAULT_GENERAL_SETTINGS: GeneralSettingsConfig = {
  appearanceTheme: 'light',
  interfaceLanguage: 'system',
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
  agentMode: 'classic',
};

const normalizeAgentMode = (mode: unknown): AgentMode => {
  return mode === 'unified' ? 'unified' : 'classic';
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

const normalizeInterfaceLanguage = (language: unknown): InterfaceLanguage => {
  if (
    language === 'en' ||
    language === 'ru' ||
    language === 'es' ||
    language === 'fr' ||
    language === 'de' ||
    language === 'pt_BR'
  ) {
    return language;
  }
  return 'system';
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
    updatedSettings.interfaceLanguage = normalizeInterfaceLanguage(updatedSettings.interfaceLanguage);
    updatedSettings.launchShortcut = normalizeShortcut(updatedSettings.launchShortcut);
    updatedSettings.agentMode = normalizeAgentMode(updatedSettings.agentMode);

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
      interfaceLanguage: normalizeInterfaceLanguage(settings?.interfaceLanguage),
      launchShortcut: normalizeShortcut(settings?.launchShortcut),
      agentMode: normalizeAgentMode(settings?.agentMode),
    };
  },
  async resetToDefaults() {
    await storage.set(DEFAULT_GENERAL_SETTINGS);
  },
};
