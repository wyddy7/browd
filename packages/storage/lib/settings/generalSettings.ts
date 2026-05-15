import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

// Interface for general settings configuration
export type AppearanceTheme = 'light' | 'dark';
export type InterfaceLanguage = 'system' | 'en' | 'ru' | 'es' | 'fr' | 'de' | 'pt_BR';
/**
 * Agent runtime topology.
 * - 'unified' (default): LangGraph Plan-and-Execute with per-subgoal
 *   ReAct inner loops, full tool surface, structured tracing,
 *   tool-call budgets, and chat-history re-seeding per task.
 * - 'legacy': inherited Planner+Navigator pipeline (two LLM calls per
 *   step). Safety net; kept available for users who hit a unified
 *   regression. Was called 'classic' before T2f-1.
 */
export type AgentMode = 'unified' | 'legacy';

/**
 * Vision mode for `agentMode='unified'`. Independent of the agentMode
 * toggle; the legacy pipeline ignores it.
 * - 'off': no screenshot in the agent message stream.
 * - 'always': screenshot injected into every state message as a
 *   multimodal HumanMessage (DOM text + image_url). Default when the
 *   selected Navigator model supports vision.
 * - 'fallback': screenshot exposed as a `screenshot()` tool the agent
 *   calls explicitly when DOM is insufficient.
 */
export type VisionMode = 'off' | 'always' | 'fallback';

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
  visionMode: VisionMode;
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
  // T2f-final-fix-6: 50 is the industry sweet spot for browser
  // agents (Anthropic Computer Use docs, Magentic-One, LangGraph
  // recursionLimit + 2x). Hitting it usually means the task needs
  // decomposition, not a higher limit. Power users can raise via UI.
  maxSteps: 50,
  maxActionsPerStep: 5,
  maxFailures: 3,
  useVision: false,
  useVisionForPlanner: false,
  planningInterval: 3,
  displayHighlights: true,
  minWaitPageLoad: 250,
  replayHistoricalTasks: false,
  launchShortcut: 'Ctrl+E',
  agentMode: 'unified',
  // T2f-1: 'always' is the recommended default. The Executor degrades
  // to effective 'off' at runtime when the chosen Navigator model
  // does not support vision input, so this default is safe for users
  // on text-only providers.
  visionMode: 'always',
};

const normalizeAgentMode = (mode: unknown): AgentMode => {
  if (mode === 'unified') return 'unified';
  if (mode === 'legacy') return 'legacy';
  // Pre-T2f-1 storage migration: rename the previous 'classic' value.
  if (mode === 'classic') return 'legacy';
  // Anything else (corrupt / first run) lands on the new default.
  return 'unified';
};

const normalizeVisionMode = (mode: unknown): VisionMode => {
  if (mode === 'off' || mode === 'always' || mode === 'fallback') return mode;
  // Pre-T2f-1 storage has no visionMode; fall back to the recommended
  // default. Executor degrades to off at runtime if the navigator
  // model can't accept images.
  return 'always';
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
    updatedSettings.visionMode = normalizeVisionMode(updatedSettings.visionMode);

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
      visionMode: normalizeVisionMode(settings?.visionMode),
    };
  },
  async resetToDefaults() {
    await storage.set(DEFAULT_GENERAL_SETTINGS);
  },
};
