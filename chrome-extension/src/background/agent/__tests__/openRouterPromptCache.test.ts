import { describe, expect, it } from 'vitest';
import type { ChatOpenAI } from '@langchain/openai';
import { type ModelConfig, type ProviderConfig, ProviderTypeEnum } from '@extension/storage';
import { createChatModel } from '../helper';

// 2026-10-03: a Sonnet 5.5 agent run on OpenRouter read nothing from the prompt cache — 316k input
// tokens at full price. OpenRouter caches Claude only when the request carries `cache_control`.
const openRouter = {
  apiKey: 'sk-or-test',
  name: 'OpenRouter',
  type: ProviderTypeEnum.OpenRouter,
  baseUrl: 'https://openrouter.ai/api/v1',
} as ProviderConfig;

const paramsFor = (modelName: string) =>
  (createChatModel(openRouter, { provider: 'openrouter', modelName } as ModelConfig) as ChatOpenAI).invocationParams();

describe('OpenRouter prompt cache', () => {
  it('asks OpenRouter to cache Claude', () => {
    expect(paramsFor('anthropic/claude-sonnet-5.5')).toMatchObject({ cache_control: { type: 'ephemeral' } });
  });

  it('leaves models that cache on their own as they are', () => {
    for (const model of ['openai/gpt-6-luna', 'google/gemini-3.8-flash', 'deepseek/deepseek-v4.1-flash']) {
      expect(paramsFor(model)).not.toHaveProperty('cache_control');
    }
  });

  it('keeps the rest of the request as it was', () => {
    const rest: Record<string, unknown> = { ...paramsFor('anthropic/claude-sonnet-5.5') };
    delete rest.cache_control;
    expect(rest).toEqual({ ...paramsFor('openai/gpt-6-luna'), model: 'anthropic/claude-sonnet-5.5' });
  });
});
