import { resolveModelContextWindow } from './modelContextHints';

// Agent name, used to identify the agent in the settings
export enum AgentNameEnum {
  Planner = 'planner',
  Navigator = 'navigator',
}

// Provider type, types before CustomOpenAI are built-in providers, CustomOpenAI is a custom provider
// For built-in providers, we will create ChatModel instances with its respective LangChain ChatModel classes
// For custom providers, we will create ChatModel instances with the ChatOpenAI class
export enum ProviderTypeEnum {
  OpenAI = 'openai',
  Anthropic = 'anthropic',
  DeepSeek = 'deepseek',
  Gemini = 'gemini',
  Grok = 'grok',
  Ollama = 'ollama',
  AzureOpenAI = 'azure_openai',
  OpenRouter = 'openrouter',
  Groq = 'groq',
  Cerebras = 'cerebras',
  Llama = 'llama',
  CustomOpenAI = 'custom_openai',
}

/**
 * T2f-1 — coarse capability check for vision (image input) support
 * keyed off `(provider, modelName)`. Used by the Settings UI to gate
 * the Vision Mode toggle and by the Executor to degrade to
 * `visionMode='off'` at runtime when the user's chosen Navigator model
 * cannot ingest images.
 *
 * The list is intentionally hint-based rather than exhaustive: model
 * IDs in OpenRouter / CustomOpenAI are user-supplied strings, so a
 * pattern match on well-known family tokens (gpt-4o, claude, gemini,
 * llama-4, qwen-vl, …) catches the long tail without us maintaining
 * a per-version registry. False positives surface only as a wasted
 * image upload that the provider will reject; we log and degrade.
 */
const VISION_CAPABLE_HINTS = [
  'gpt-4o',
  'gpt-4.1',
  'gpt-5',
  'claude-3',
  'claude-haiku-4',
  'claude-sonnet-4',
  'claude-opus-4',
  'gemini',
  'grok-4',
  'llama-4',
  'pixtral',
  '-vl-',
  '-vl:',
  'multimodal',
  'llava',
];

const NEVER_VISION_PROVIDERS = new Set<string>(['deepseek', 'groq', 'cerebras']);

/**
 * Context-window resolution is delegated to `modelContextHints.ts`,
 * which uses the OpenRouter live catalog as primary source-of-truth
 * (covers ~95% of cloud models with current data) and a tiny local
 * hardcoded fallback for Ollama. Avoid maintaining a large hardcoded
 * cloud-model table here — it rots within weeks of provider updates.
 */
export function getModelContextWindow(_provider: string, modelName: string): number {
  // Provider param kept for API stability; resolver is fully provider-
  // agnostic (uses OpenRouter live cache + Ollama-only static fallback).
  return resolveModelContextWindow(modelName);
}

export function modelSupportsVision(provider: string, modelName: string): boolean {
  if (!modelName) return false;
  if (NEVER_VISION_PROVIDERS.has(provider)) return false;
  const m = modelName.toLowerCase();
  if (provider === 'ollama') {
    // Local Ollama needs explicit multimodal weights (llava, qwen-vl, …).
    return m.includes('llava') || m.includes('-vl') || m.includes('multimodal');
  }
  return VISION_CAPABLE_HINTS.some(h => m.includes(h));
}

// Default supported models for each built-in provider
export const llmProviderModelNames = {
  [ProviderTypeEnum.OpenAI]: [
    'gpt-5.1',
    'gpt-5',
    'gpt-5-pro',
    'gpt-5-mini',
    'gpt-5-chat-latest',
    'gpt-4.1',
    'gpt-4.1-mini',
    'gpt-4o',
  ],
  [ProviderTypeEnum.Anthropic]: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'],
  [ProviderTypeEnum.DeepSeek]: ['deepseek-chat', 'deepseek-reasoner'],
  [ProviderTypeEnum.Gemini]: ['gemini-3-pro-preview', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  [ProviderTypeEnum.Grok]: ['grok-4', 'grok-4-fast-non-reasoning', 'grok-3', 'grok-3-fast'],
  [ProviderTypeEnum.Ollama]: ['qwen3:14b', 'falcon3:10b', 'qwen2.5-coder:14b', 'mistral-small:24b'],
  [ProviderTypeEnum.AzureOpenAI]: ['gpt-5', 'gpt-5-mini', 'gpt-4.1', 'gpt-4.1-mini', 'gpt-4o'],
  [ProviderTypeEnum.OpenRouter]: ['google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'openai/gpt-4o-2024-11-20'],
  [ProviderTypeEnum.Groq]: ['llama-3.3-70b-versatile'],
  [ProviderTypeEnum.Cerebras]: ['llama-3.3-70b'],
  [ProviderTypeEnum.Llama]: [
    'Llama-3.3-70B-Instruct',
    'Llama-3.3-8B-Instruct',
    'Llama-4-Maverick-17B-128E-Instruct-FP8',
    'Llama-4-Scout-17B-16E-Instruct-FP8',
  ],
  // Custom OpenAI providers don't have predefined models as they are user-defined
};

// Default parameters for each agent per provider, for providers not specified, use OpenAI parameters
export const llmProviderParameters = {
  [ProviderTypeEnum.OpenAI]: {
    [AgentNameEnum.Planner]: {
      temperature: 0.7,
      topP: 0.9,
    },
    [AgentNameEnum.Navigator]: {
      temperature: 0.3,
      topP: 0.85,
    },
  },
  [ProviderTypeEnum.Anthropic]: {
    [AgentNameEnum.Planner]: {
      temperature: 0.3,
      topP: 0.6,
    },
    [AgentNameEnum.Navigator]: {
      temperature: 0.2,
      topP: 0.5,
    },
  },
  [ProviderTypeEnum.Gemini]: {
    [AgentNameEnum.Planner]: {
      temperature: 0.7,
      topP: 0.9,
    },
    [AgentNameEnum.Navigator]: {
      temperature: 0.3,
      topP: 0.85,
    },
  },
  [ProviderTypeEnum.Grok]: {
    [AgentNameEnum.Planner]: {
      temperature: 0.7,
      topP: 0.9,
    },
    [AgentNameEnum.Navigator]: {
      temperature: 0.3,
      topP: 0.85,
    },
  },
  [ProviderTypeEnum.Ollama]: {
    [AgentNameEnum.Planner]: {
      temperature: 0.3,
      topP: 0.9,
    },
    [AgentNameEnum.Navigator]: {
      temperature: 0.1,
      topP: 0.85,
    },
  },
  [ProviderTypeEnum.AzureOpenAI]: {
    [AgentNameEnum.Planner]: {
      temperature: 0.7,
      topP: 0.9,
    },
    [AgentNameEnum.Navigator]: {
      temperature: 0.3,
      topP: 0.85,
    },
  },
  [ProviderTypeEnum.OpenRouter]: {
    [AgentNameEnum.Planner]: {
      temperature: 0.7,
      topP: 0.9,
    },
    [AgentNameEnum.Navigator]: {
      temperature: 0.3,
      topP: 0.85,
    },
  },
  [ProviderTypeEnum.Groq]: {
    [AgentNameEnum.Planner]: {
      temperature: 0.7,
      topP: 0.9,
    },
    [AgentNameEnum.Navigator]: {
      temperature: 0.3,
      topP: 0.85,
    },
  },
  [ProviderTypeEnum.Cerebras]: {
    [AgentNameEnum.Planner]: {
      temperature: 0.7,
      topP: 0.9,
    },
    [AgentNameEnum.Navigator]: {
      temperature: 0.3,
      topP: 0.85,
    },
  },
  [ProviderTypeEnum.Llama]: {
    [AgentNameEnum.Planner]: {
      temperature: 0.7,
      topP: 0.9,
    },
    [AgentNameEnum.Navigator]: {
      temperature: 0.3,
      topP: 0.85,
    },
  },
};
