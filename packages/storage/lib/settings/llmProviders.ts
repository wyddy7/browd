import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';
import { type AgentNameEnum, llmProviderModelNames, llmProviderParameters, ProviderTypeEnum } from './types';

const AZURE_API_VERSION = '2025-04-01-preview';
const INVISIBLE_HEADER_UNSAFE_CHARS = /[\u0000-\u001F\u007F-\u009F\u200B-\u200D\uFEFF]/g;

// Interface for a single provider configuration
export interface ProviderConfig {
  name?: string; // Display name in the options
  type?: ProviderTypeEnum; // Help to decide which LangChain ChatModel package to use
  apiKey: string; // Must be provided, but may be empty for local models
  baseUrl?: string; // Optional base URL if provided // For Azure: Endpoint
  modelNames?: string[]; // Chosen model names (NOT used for Azure OpenAI)
  createdAt?: number; // Timestamp in milliseconds when the provider was created
  // Azure Specific Fields:
  azureDeploymentNames?: string[]; // Azure deployment names array
  azureApiVersion?: string;
}

function stripInvisibleHeaderUnsafeChars(value: string): string {
  return value.replace(INVISIBLE_HEADER_UNSAFE_CHARS, '');
}

function hasNonLatin1Chars(value: string): boolean {
  return [...value].some(char => char.codePointAt(0)! > 255);
}

export function normalizeProviderApiKey(apiKey: string): string {
  return stripInvisibleHeaderUnsafeChars(apiKey).trim();
}

export function normalizeProviderBaseUrl(
  baseUrl: string | undefined,
  providerType: ProviderTypeEnum,
): string | undefined {
  if (!baseUrl) {
    return baseUrl;
  }

  let normalized = stripInvisibleHeaderUnsafeChars(baseUrl).trim();

  if (providerType === ProviderTypeEnum.OpenRouter) {
    normalized = normalized.replace(/\/chat\/completions\/?$/i, '');
    normalized = normalized.replace(/\/$/, '');
  }

  return normalized;
}

function validateProviderHeaderFields(providerId: string, providerType: ProviderTypeEnum, config: ProviderConfig) {
  if (config.apiKey && hasNonLatin1Chars(config.apiKey)) {
    throw new Error(
      `${getDefaultDisplayNameFromProviderId(providerId)} API key contains non-Latin-1 characters. Re-enter it manually instead of pasting rich text.`,
    );
  }

  if (config.name && hasNonLatin1Chars(config.name) && providerType === ProviderTypeEnum.OpenRouter) {
    throw new Error(
      `${getDefaultDisplayNameFromProviderId(providerId)} provider name contains characters that are unsafe for browser request headers.`,
    );
  }
}

// Interface for storing multiple LLM provider configurations
// The key is the provider id, which is the same as the provider type for built-in providers, but is custom for custom providers
export interface LLMKeyRecord {
  providers: Record<string, ProviderConfig>;
}

export type LLMProviderStorage = BaseStorage<LLMKeyRecord> & {
  setProvider: (providerId: string, config: ProviderConfig) => Promise<void>;
  getProvider: (providerId: string) => Promise<ProviderConfig | undefined>;
  removeProvider: (providerId: string) => Promise<void>;
  hasProvider: (providerId: string) => Promise<boolean>;
  getAllProviders: () => Promise<Record<string, ProviderConfig>>;
};

// Storage for LLM provider configurations
// use "llm-api-keys" as the key for the storage, for backward compatibility
const storage = createStorage<LLMKeyRecord>(
  'llm-api-keys',
  { providers: {} },
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

// Helper function to determine provider type from provider name
// Make sure to update this function if you add a new provider type
export function getProviderTypeByProviderId(providerId: string): ProviderTypeEnum {
  // Check if this is an Azure provider (either the main one or one with a custom ID)
  if (providerId === ProviderTypeEnum.AzureOpenAI) {
    return ProviderTypeEnum.AzureOpenAI;
  }

  // Handle custom Azure providers with IDs like azure_openai_2
  if (typeof providerId === 'string' && providerId.startsWith(`${ProviderTypeEnum.AzureOpenAI}_`)) {
    return ProviderTypeEnum.AzureOpenAI;
  }

  // Handle standard provider types
  switch (providerId) {
    case ProviderTypeEnum.OpenAI:
    case ProviderTypeEnum.Anthropic:
    case ProviderTypeEnum.DeepSeek:
    case ProviderTypeEnum.Gemini:
    case ProviderTypeEnum.Grok:
    case ProviderTypeEnum.Ollama:
    case ProviderTypeEnum.OpenRouter:
    case ProviderTypeEnum.Groq:
    case ProviderTypeEnum.Cerebras:
      return providerId;
    default:
      return ProviderTypeEnum.CustomOpenAI;
  }
}

// Helper function to get display name from provider id
// Make sure to update this function if you add a new provider type
export function getDefaultDisplayNameFromProviderId(providerId: string): string {
  switch (providerId) {
    case ProviderTypeEnum.OpenAI:
      return 'OpenAI';
    case ProviderTypeEnum.Anthropic:
      return 'Anthropic';
    case ProviderTypeEnum.DeepSeek:
      return 'DeepSeek';
    case ProviderTypeEnum.Gemini:
      return 'Gemini';
    case ProviderTypeEnum.Grok:
      return 'Grok';
    case ProviderTypeEnum.Ollama:
      return 'Ollama';
    case ProviderTypeEnum.AzureOpenAI:
      return 'Azure OpenAI';
    case ProviderTypeEnum.OpenRouter:
      return 'OpenRouter';
    case ProviderTypeEnum.Groq:
      return 'Groq';
    case ProviderTypeEnum.Cerebras:
      return 'Cerebras';
    case ProviderTypeEnum.Llama:
      return 'Llama';
    default:
      return providerId; // Use the provider id as display name for custom providers by default
  }
}

// Get default configuration for built-in providers
export function getDefaultProviderConfig(providerId: string): ProviderConfig {
  switch (providerId) {
    case ProviderTypeEnum.OpenAI:
    case ProviderTypeEnum.Anthropic:
    case ProviderTypeEnum.DeepSeek:
    case ProviderTypeEnum.Gemini:
    case ProviderTypeEnum.Grok:
    case ProviderTypeEnum.OpenRouter: // OpenRouter uses modelNames
    case ProviderTypeEnum.Groq: // Groq uses modelNames
    case ProviderTypeEnum.Cerebras: // Cerebras uses modelNames
    case ProviderTypeEnum.Llama: // Llama uses modelNames
      return {
        apiKey: '',
        name: getDefaultDisplayNameFromProviderId(providerId),
        type: providerId,
        baseUrl:
          providerId === ProviderTypeEnum.OpenRouter
            ? 'https://openrouter.ai/api/v1'
            : providerId === ProviderTypeEnum.Llama
              ? 'https://api.llama.com/v1'
              : undefined,
        modelNames: [...(llmProviderModelNames[providerId] || [])],
        createdAt: Date.now(),
      };

    case ProviderTypeEnum.Ollama:
      return {
        apiKey: 'ollama', // Set default API key for Ollama
        name: getDefaultDisplayNameFromProviderId(ProviderTypeEnum.Ollama),
        type: ProviderTypeEnum.Ollama,
        modelNames: llmProviderModelNames[providerId],
        baseUrl: 'http://localhost:11434',
        createdAt: Date.now(),
      };
    case ProviderTypeEnum.AzureOpenAI:
      return {
        apiKey: '', // User needs to provide API Key
        name: getDefaultDisplayNameFromProviderId(ProviderTypeEnum.AzureOpenAI),
        type: ProviderTypeEnum.AzureOpenAI,
        baseUrl: '', // User needs to provide Azure endpoint
        // modelNames: [], // Not used for Azure configuration
        azureDeploymentNames: [], // Azure deployment names
        azureApiVersion: AZURE_API_VERSION, // Provide a common default API version
        createdAt: Date.now(),
      };
    default: // Handles CustomOpenAI
      return {
        apiKey: '',
        name: getDefaultDisplayNameFromProviderId(providerId),
        type: ProviderTypeEnum.CustomOpenAI,
        baseUrl: '',
        modelNames: [], // Custom providers use modelNames
        createdAt: Date.now(),
      };
  }
}

export function getDefaultAgentModelParams(providerId: string, agentName: AgentNameEnum): Record<string, number> {
  const newParameters = llmProviderParameters[providerId as keyof typeof llmProviderParameters]?.[agentName] || {
    temperature: 0.1,
    topP: 0.1,
  };
  return newParameters;
}

// Helper function to ensure backward compatibility for provider configs
function ensureBackwardCompatibility(providerId: string, config: ProviderConfig): ProviderConfig {
  // Log input config
  // console.log(`[ensureBackwardCompatibility] Input for ${providerId}:`, JSON.stringify(config));

  const updatedConfig = { ...config };
  const providerType = updatedConfig.type || getProviderTypeByProviderId(providerId);

  // Ensure name exists
  if (!updatedConfig.name) {
    updatedConfig.name = getDefaultDisplayNameFromProviderId(providerId);
  }
  // Ensure type exists
  if (!updatedConfig.type) {
    updatedConfig.type = providerType;
  }

  updatedConfig.apiKey = normalizeProviderApiKey(updatedConfig.apiKey || '');
  updatedConfig.baseUrl = normalizeProviderBaseUrl(updatedConfig.baseUrl, providerType);

  // Handle Azure specifics
  if (providerType === ProviderTypeEnum.AzureOpenAI) {
    // Ensure Azure fields exist, provide defaults if missing
    if (updatedConfig.azureApiVersion === undefined) {
      // console.log(`[ensureBackwardCompatibility] Adding default azureApiVersion for ${providerId}`);
      updatedConfig.azureApiVersion = AZURE_API_VERSION;
    }

    // Initialize azureDeploymentNames array if it doesn't exist yet
    if (!updatedConfig.azureDeploymentNames) {
      updatedConfig.azureDeploymentNames = [];
    }

    // CRITICAL: Delete modelNames if it exists for Azure type to clean up old configs
    if (Object.prototype.hasOwnProperty.call(updatedConfig, 'modelNames')) {
      // console.log(`[ensureBackwardCompatibility] Deleting modelNames for Azure config ${providerId}`);
      delete updatedConfig.modelNames;
    }
  } else {
    // Ensure modelNames exists ONLY for non-Azure types
    if (!updatedConfig.modelNames) {
      // console.log(`[ensureBackwardCompatibility] Adding default modelNames for non-Azure ${providerId}`);
      updatedConfig.modelNames = llmProviderModelNames[providerId as keyof typeof llmProviderModelNames] || [];
    }
  }

  // Ensure createdAt exists
  if (!updatedConfig.createdAt) {
    updatedConfig.createdAt = new Date('03/04/2025').getTime();
  }

  validateProviderHeaderFields(providerId, providerType, updatedConfig);

  // Log output config
  // console.log(`[ensureBackwardCompatibility] Output for ${providerId}:`, JSON.stringify(updatedConfig));
  return updatedConfig;
}

export const llmProviderStore: LLMProviderStorage = {
  ...storage,
  async setProvider(providerId: string, config: ProviderConfig) {
    if (!providerId) {
      throw new Error('Provider id cannot be empty');
    }

    if (config.apiKey === undefined) {
      throw new Error('API key must be provided (can be empty for local models)');
    }

    const providerType = config.type || getProviderTypeByProviderId(providerId);
    const normalizedApiKey = normalizeProviderApiKey(config.apiKey || '');
    const normalizedBaseUrl = normalizeProviderBaseUrl(config.baseUrl, providerType);

    const normalizedConfig: ProviderConfig = {
      ...config,
      apiKey: normalizedApiKey,
      baseUrl: normalizedBaseUrl,
    };

    if (providerType === ProviderTypeEnum.AzureOpenAI) {
      if (!normalizedConfig.baseUrl?.trim()) {
        throw new Error('Azure Endpoint (baseUrl) is required');
      }
      if (!normalizedConfig.azureDeploymentNames || normalizedConfig.azureDeploymentNames.length === 0) {
        throw new Error('At least one Azure Deployment Name is required');
      }
      if (!normalizedConfig.azureApiVersion?.trim()) {
        throw new Error('Azure API Version is required');
      }
      if (!normalizedConfig.apiKey?.trim()) {
        throw new Error('API Key is required for Azure OpenAI');
      }
    } else if (providerType !== ProviderTypeEnum.CustomOpenAI && providerType !== ProviderTypeEnum.Ollama) {
      if (!normalizedConfig.apiKey?.trim()) {
        throw new Error(`API Key is required for ${getDefaultDisplayNameFromProviderId(providerId)}`);
      }
    }

    if (providerType !== ProviderTypeEnum.AzureOpenAI) {
      if (!normalizedConfig.modelNames || normalizedConfig.modelNames.length === 0) {
        console.warn(`Provider ${providerId} of type ${providerType} is being saved without model names.`);
      }
    }

    const completeConfig: ProviderConfig = {
      apiKey: normalizedConfig.apiKey || '',
      baseUrl: normalizedConfig.baseUrl,
      name: normalizedConfig.name || getDefaultDisplayNameFromProviderId(providerId),
      type: providerType,
      createdAt: normalizedConfig.createdAt || Date.now(),
      ...(providerType === ProviderTypeEnum.AzureOpenAI
        ? {
            azureDeploymentNames: normalizedConfig.azureDeploymentNames || [],
            azureApiVersion: normalizedConfig.azureApiVersion,
          }
        : {
            modelNames: normalizedConfig.modelNames || [],
          }),
    };
    validateProviderHeaderFields(providerId, providerType, completeConfig);

    const current = (await storage.get()) || { providers: {} };
    await storage.set({
      providers: {
        ...current.providers,
        [providerId]: completeConfig,
      },
    });
  },
  async getProvider(providerId: string) {
    const data = (await storage.get()) || { providers: {} };
    const config = data.providers[providerId];
    return config ? ensureBackwardCompatibility(providerId, config) : undefined;
  },
  async removeProvider(providerId: string) {
    const current = (await storage.get()) || { providers: {} };
    const newProviders = { ...current.providers };
    delete newProviders[providerId];
    await storage.set({ providers: newProviders });
  },
  async hasProvider(providerId: string) {
    const data = (await storage.get()) || { providers: {} };
    return providerId in data.providers;
  },

  async getAllProviders() {
    const data = await storage.get();
    const providers = { ...data.providers };

    // Add backward compatibility for all providers
    for (const [providerId, config] of Object.entries(providers)) {
      providers[providerId] = ensureBackwardCompatibility(providerId, config);
    }

    return providers;
  },
};
