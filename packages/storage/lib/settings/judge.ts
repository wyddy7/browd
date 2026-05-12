/**
 * T3-judge — model role used by the eval runner to grade scenario
 * outputs (LLM-as-judge pattern). Independent of Planner / Navigator
 * runtime roles: judge is invoked only by `__evals__/runner.ts`, never
 * during normal extension operation. Mirrors `speechToText.ts` storage
 * pattern so the in-chat picker and Settings page can treat it the
 * same way.
 *
 * Default judge: cheap, fast, calibrated text model. Recommendation in
 * UI is Haiku 4.5 / Gemini Flash / GPT-4.1-mini class.
 */

import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import type { ProviderConfig } from './llmProviders';
import { llmProviderModelNames, ProviderTypeEnum } from './types';

export interface JudgeModelConfig {
  provider: string;
  modelName: string;
}

export interface JudgeOption {
  provider: string;
  providerName: string;
  modelName: string;
}

/**
 * Almost any chat-completion-capable provider can grade. We exclude
 * providers that don't ship a usable text model (none currently
 * excluded — STT-only or vision-only providers would be).
 */
export function supportsJudgeProvider(config?: ProviderConfig): boolean {
  if (!config) return false;
  // Every currently-known provider has a text path. Future audio-only
  // or vision-only providers would be skipped here.
  return true;
}

export function getJudgeModelsForProvider(providerId: string, config: ProviderConfig): string[] {
  if (!supportsJudgeProvider(config)) return [];

  if (config.modelNames && config.modelNames.length > 0) {
    return config.modelNames;
  }

  // Fall back to built-in defaults for the provider type.
  // CustomOpenAI providers must supply their own modelNames; nothing
  // built-in to fall back on, hence the explicit type-check.
  if (config.type === ProviderTypeEnum.CustomOpenAI) return [];
  const builtin = llmProviderModelNames[config.type as Exclude<ProviderTypeEnum, ProviderTypeEnum.CustomOpenAI>];
  return builtin ? [...builtin] : [];
}

export function getJudgeOptions(providers: Record<string, ProviderConfig>): JudgeOption[] {
  const options: JudgeOption[] = [];

  for (const [providerId, config] of Object.entries(providers)) {
    if (!supportsJudgeProvider(config)) continue;
    const providerName = config.name || providerId;
    const models = getJudgeModelsForProvider(providerId, config);
    options.push(
      ...models.map(modelName => ({
        provider: providerId,
        providerName,
        modelName,
      })),
    );
  }

  return options;
}

export interface JudgeRecord {
  judgeModel?: JudgeModelConfig;
}

export type JudgeStorage = BaseStorage<JudgeRecord> & {
  setJudgeModel: (config: JudgeModelConfig) => Promise<void>;
  getJudgeModel: () => Promise<JudgeModelConfig | undefined>;
  resetJudgeModel: () => Promise<void>;
  hasJudgeModel: () => Promise<boolean>;
};

const storage = createStorage<JudgeRecord>(
  'judge-model',
  { judgeModel: undefined },
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

function validateJudgeModelConfig(config: JudgeModelConfig) {
  if (!config.provider || !config.modelName) {
    throw new Error('Provider and model name must be specified for judge');
  }
}

export const judgeModelStore: JudgeStorage = {
  ...storage,
  setJudgeModel: async (config: JudgeModelConfig) => {
    validateJudgeModelConfig(config);
    await storage.set({ judgeModel: config });
  },
  getJudgeModel: async () => {
    const data = await storage.get();
    return data.judgeModel;
  },
  resetJudgeModel: async () => {
    await storage.set({ judgeModel: undefined });
  },
  hasJudgeModel: async () => {
    const data = await storage.get();
    return data.judgeModel !== undefined;
  },
};
