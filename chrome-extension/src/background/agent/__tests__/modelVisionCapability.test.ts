import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 2026-09-27 Online-Mind2Web run: `openai/gpt-6-luna` accepts images per the
// OpenRouter catalog, but the name-hint list did not know `gpt-6`, so the
// Executor degraded the user's visionMode='on' to 'off'.
const catalog = {
  data: [
    { id: 'openai/gpt-6-luna', context_length: 400_000, architecture: { input_modalities: ['file', 'image', 'text'] } },
    { id: 'inception/mercury-2.5', context_length: 260_000, architecture: { input_modalities: ['text'] } },
    {
      id: 'anthropic/claude-sonnet-5',
      context_length: 1_000_000,
      architecture: { input_modalities: ['text', 'image'] },
    },
  ],
};

async function loadWithCatalog() {
  vi.resetModules();
  const storage: Record<string, unknown> = {};
  vi.stubGlobal('chrome', {
    storage: {
      local: {
        get: vi.fn(async (key: string) => ({ [key]: storage[key] })),
        set: vi.fn(async (entry: Record<string, unknown>) => Object.assign(storage, entry)),
      },
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(catalog), { status: 200 })),
  );
  const models = await import('../../../../../packages/storage/lib/settings/openrouterModels');
  const types = await import('../../../../../packages/storage/lib/settings/types');
  await models.preloadOpenRouterModels();
  return types;
}

describe('modelSupportsVision', () => {
  beforeEach(() => vi.unstubAllGlobals());
  afterEach(() => vi.unstubAllGlobals());

  it('trusts the OpenRouter catalog over the name-hint list', async () => {
    const { modelSupportsVision } = await loadWithCatalog();
    expect(modelSupportsVision('openrouter', 'openai/gpt-6-luna')).toBe(true);
    expect(modelSupportsVision('openrouter', 'inception/mercury-2.5')).toBe(false);
  });

  it('resolves a direct-provider model id through its OpenRouter route', async () => {
    const { modelSupportsVision } = await loadWithCatalog();
    expect(modelSupportsVision('anthropic', 'claude-sonnet-5')).toBe(true);
  });

  it('falls back to name hints for models outside the catalog', async () => {
    const { modelSupportsVision } = await loadWithCatalog();
    expect(modelSupportsVision('ollama', 'llava:13b')).toBe(true);
    expect(modelSupportsVision('ollama', 'qwen3:8b')).toBe(false);
    expect(modelSupportsVision('custom', 'my-gpt-4o-proxy')).toBe(true);
    expect(modelSupportsVision('custom', 'some-unknown-model')).toBe(false);
  });

  it('still reports the context window from the same catalog', async () => {
    const { getModelContextWindow } = await loadWithCatalog();
    expect(getModelContextWindow('openrouter', 'openai/gpt-6-luna')).toBe(400_000);
  });
});
