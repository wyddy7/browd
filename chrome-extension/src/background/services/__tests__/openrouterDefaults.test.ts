import { describe, expect, it } from 'vitest';
import {
  hasOutdatedOpenRouterDefaults,
  llmProviderModelNames,
  previousOpenRouterDefaults,
  ProviderTypeEnum,
  withCurrentOpenRouterDefaults,
} from '@extension/storage';

// Issue #22: a provider saved before 0.1.17 keeps the old default list; Options offers
// «Use current defaults», which must not drop what the user added or what an agent runs on.
const current = llmProviderModelNames[ProviderTypeEnum.OpenRouter];
const old = ['google/gemini-2.5-pro', 'google/gemini-2.5-flash', 'openai/gpt-4o-2024-11-20'];

describe('OpenRouter default models', () => {
  it('offers the update only to a list that still holds old defaults', () => {
    expect(hasOutdatedOpenRouterDefaults([...old, 'moonshotai/kimi-k3'], [])).toBe(true);
    expect(hasOutdatedOpenRouterDefaults([...current], [])).toBe(false);
    // The user's own list without any old default: left alone, even if a current default is missing.
    expect(hasOutdatedOpenRouterDefaults(['moonshotai/kimi-k3'], [])).toBe(false);
    // A 0.1.17 list: every current default, plus qwen nobody uses.
    expect(hasOutdatedOpenRouterDefaults([...current, 'qwen/qwen3.8-flash'], [])).toBe(true);
    // The only old default is the agents' model and the current ones are missing: still offered.
    expect(hasOutdatedOpenRouterDefaults(['google/gemini-2.5-flash'], ['google/gemini-2.5-flash'])).toBe(true);
  });

  it('makes no second offer after the update', () => {
    const inUse = ['google/gemini-2.5-flash'];
    const updated = withCurrentOpenRouterDefaults([...old, 'moonshotai/kimi-k3'], inUse);
    expect(hasOutdatedOpenRouterDefaults(updated, inUse)).toBe(false);
  });

  it('puts the current defaults first and keeps the models the user added', () => {
    expect(withCurrentOpenRouterDefaults([...old, 'moonshotai/kimi-k3'], [])).toEqual([
      ...current,
      'moonshotai/kimi-k3',
    ]);
  });

  it('keeps an old default an agent still uses', () => {
    expect(
      withCurrentOpenRouterDefaults([...old, 'moonshotai/kimi-k3'], ['google/gemini-2.5-flash', 'openai/gpt-6-luna']),
    ).toEqual([...current, 'moonshotai/kimi-k3', 'google/gemini-2.5-flash']);
  });

  it('drops qwen3.8-flash, a default of 0.1.17', () => {
    expect(current).not.toContain('qwen/qwen3.8-flash');
    expect(previousOpenRouterDefaults).toContain('qwen/qwen3.8-flash');
    expect(withCurrentOpenRouterDefaults([...current, 'qwen/qwen3.8-flash'], [])).toEqual(current);
  });

  it('never lists a model twice', () => {
    const merged = withCurrentOpenRouterDefaults([current[1], 'moonshotai/kimi-k3', current[0]], []);
    expect(new Set(merged).size).toBe(merged.length);
  });
});
