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
 *
 * Two modes only — the runtime never auto-attaches an image. Whether
 * a screenshot lands in the conversation is the LLM's call, made via
 * the regular `screenshot()` tool, the same way browser-use, Stagehand,
 * Operator and Anthropic computer-use let the model decide.
 *
 * - 'off': the `screenshot()` tool plus all coordinate actions are
 *   removed from the registry. Pure DOM + read-only + navigation
 *   surface. Used when the Navigator model has no vision capability
 *   or the user explicitly opts out.
 * - 'on': the agent has the full tool surface — DOM tools, coordinate
 *   actions (`click_at` / `type_at` / `scroll_at` / `drag_at` /
 *   `hitl_click_at`), `screenshot()` and `take_over_user_tab`. State
 *   messages stay text-only; the LLM calls `screenshot()` when it
 *   wants to see the rendered page.
 */
export type VisionMode = 'off' | 'on';

/**
 * Per-task permission posture for HITL approval gates. Modeled after
 * Codex's three-tier permission selector. Browd's HITL surface is
 * smaller (currently take_over_user_tab and hitl_click_at), so the
 * three modes map as follows:
 *
 * - 'default'  Every HITL gate prompts the user. Safest. Default.
 * - 'auto'     Skip approval for `take_over_user_tab` (agent freely
 *              cross-overs into background tabs it opened itself).
 *              `hitl_click_at` still prompts — that gate exists for
 *              isTrusted-blocked buttons where the user IS the only
 *              solution (no automation can bypass).
 * - 'full'     Same as 'auto' today. Reserved for future "auto-resolve
 *              capability prompts (camera / mic / file)" semantics
 *              once the runtime can intercept those. Today shown with
 *              a danger-coloured pill so users understand the intent.
 *
 * The selector lives in the side-panel input toolbar
 * (`PermissionModeSelector` component). HITL handlers in
 * `actions/builder.ts` read this and skip the approval flow accordingly.
 */
export type PermissionMode = 'default' | 'auto' | 'full';

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
  permissionMode: PermissionMode;
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
  // 'on' is the recommended default. The Executor degrades to
  // effective 'off' at runtime when the chosen Navigator model does
  // not support vision input, so this default is safe for users on
  // text-only providers.
  visionMode: 'on',
  // 'default' = every HITL approval prompts the user. Safest first
  // experience; users opt into looser modes from the input toolbar.
  permissionMode: 'default',
};

const normalizePermissionMode = (mode: unknown): PermissionMode => {
  if (mode === 'default' || mode === 'auto' || mode === 'full') return mode;
  return 'default';
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
  if (mode === 'off' || mode === 'on') return mode;
  // Migration: the three-mode era used 'always' and 'fallback'. Both
  // intents fold into the new single 'on' mode — runtime no longer
  // auto-attaches, the LLM decides. Anything else (corrupt / missing)
  // also lands on the recommended default. Executor degrades to off
  // at runtime if the navigator model can't accept images.
  if (mode === 'always' || mode === 'fallback') return 'on';
  return 'on';
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
    updatedSettings.permissionMode = normalizePermissionMode(updatedSettings.permissionMode);

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
      permissionMode: normalizePermissionMode(settings?.permissionMode),
    };
  },
  async resetToDefaults() {
    await storage.set(DEFAULT_GENERAL_SETTINGS);
  },
};
