import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import type { ProviderConfig } from './llmProviders';
import { llmProviderModelNames, ProviderTypeEnum } from './types';

export interface SpeechToTextModelConfig {
  provider: string;
  modelName: string;
}

export interface SpeechToTextOption {
  provider: string;
  providerName: string;
  modelName: string;
}

export const GROK_SPEECH_TO_TEXT_MODEL = 'grok-speech-to-text';

function isOpenRouterChatAudioModel(modelName: string): boolean {
  const normalizedModelName = modelName.toLowerCase();
  return !normalizedModelName.includes('whisper') && !normalizedModelName.includes('transcribe');
}

export function supportsSpeechToTextProvider(config?: ProviderConfig): boolean {
  return (
    config?.type === ProviderTypeEnum.Gemini ||
    config?.type === ProviderTypeEnum.OpenRouter ||
    config?.type === ProviderTypeEnum.Grok
  );
}

export function getSpeechToTextModelsForProvider(providerId: string, config: ProviderConfig): string[] {
  if (!supportsSpeechToTextProvider(config)) {
    return [];
  }

  if (config.type === ProviderTypeEnum.Grok) {
    return [GROK_SPEECH_TO_TEXT_MODEL];
  }

  if (config.modelNames && config.modelNames.length > 0) {
    if (config.type === ProviderTypeEnum.OpenRouter) {
      return config.modelNames.filter(isOpenRouterChatAudioModel);
    }

    return config.modelNames;
  }

  if (config.type === ProviderTypeEnum.Gemini) {
    return [...(llmProviderModelNames[ProviderTypeEnum.Gemini] || [])];
  }

  return [];
}

export function getSpeechToTextOptions(providers: Record<string, ProviderConfig>): SpeechToTextOption[] {
  const options: SpeechToTextOption[] = [];

  for (const [providerId, config] of Object.entries(providers)) {
    if (!supportsSpeechToTextProvider(config)) {
      continue;
    }

    const providerName = config.name || providerId;
    const models = getSpeechToTextModelsForProvider(providerId, config);

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

export interface SpeechToTextRecord {
  speechToTextModel?: SpeechToTextModelConfig;
}

export type SpeechToTextStorage = BaseStorage<SpeechToTextRecord> & {
  setSpeechToTextModel: (config: SpeechToTextModelConfig) => Promise<void>;
  getSpeechToTextModel: () => Promise<SpeechToTextModelConfig | undefined>;
  resetSpeechToTextModel: () => Promise<void>;
  hasSpeechToTextModel: () => Promise<boolean>;
};

const storage = createStorage<SpeechToTextRecord>(
  'speech-to-text-model',
  { speechToTextModel: undefined },
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

function validateSpeechToTextModelConfig(config: SpeechToTextModelConfig) {
  if (!config.provider || !config.modelName) {
    throw new Error('Provider and model name must be specified for speech-to-text');
  }
}

export const speechToTextModelStore: SpeechToTextStorage = {
  ...storage,
  setSpeechToTextModel: async (config: SpeechToTextModelConfig) => {
    validateSpeechToTextModelConfig(config);
    await storage.set({ speechToTextModel: config });
  },
  getSpeechToTextModel: async () => {
    const data = await storage.get();
    return data.speechToTextModel;
  },
  resetSpeechToTextModel: async () => {
    await storage.set({ speechToTextModel: undefined });
  },
  hasSpeechToTextModel: async () => {
    const data = await storage.get();
    return data.speechToTextModel !== undefined;
  },
};
