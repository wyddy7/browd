/**
 * Provider-agnostic context-window resolver.
 *
 * Strategy (in order):
 *   1. OpenRouter live cache (`openrouterModels.ts`) — covers ~95% of
 *      cloud models with current data, refreshed every 24h. For ANY
 *      cloud provider (Anthropic direct, OpenAI direct, Google direct,
 *      DeepSeek, xAI, Mistral, Qwen, etc.) we look up the corresponding
 *      OpenRouter route. This is the primary path — no hardcoded list
 *      can keep up with OpenRouter's weekly model additions.
 *   2. Local-only hardcoded hints — Ollama models (and similar local
 *      runtimes) aren't in OpenRouter's catalog, so a tiny static map
 *      covers them.
 *   3. Default 32_000 — industry-conservative fallback. Below every
 *      modern cloud model; the UI ring will read "fuller than reality"
 *      rather than overestimate headroom.
 *
 * Why this beats a hardcoded table of cloud models:
 *   - OpenRouter is updated within hours of a model launch. Hardcoded
 *     tables drift in weeks (verified empirically — the previous
 *     hardcoded table claimed Sonnet 4.5 was 200K when OpenRouter
 *     showed 1M, and listed models that didn't exist).
 *   - Provider-prefix matching means `claude-sonnet-4-5` (Anthropic
 *     direct id) and `anthropic/claude-sonnet-4.5` (OpenRouter route
 *     id) resolve to the SAME live record. Single source of truth.
 *   - Cold-start fallback (Ollama hints + 32K default) is intentionally
 *     small — doesn't rot, doesn't lie.
 */

import { lookupOpenRouterContextWindow } from './openrouterModels';

const DEFAULT_CONTEXT_WINDOW_HINT = 32_000;

/**
 * Provider prefixes used in OpenRouter route ids. When a direct-style
 * model name (no slash) is passed, we try these prefixes to find a
 * matching live record.
 */
const OPENROUTER_PROVIDER_PREFIXES = [
  'anthropic',
  'openai',
  'google',
  'deepseek',
  'x-ai',
  'meta-llama',
  'mistralai',
  'qwen',
  'cohere',
  'nvidia',
  'amazon',
  'perplexity',
];

/**
 * Hardcoded ceilings for models OpenRouter doesn't list — i.e. local
 * runtimes (Ollama) and the rare edge case. Keep this list SHORT —
 * every entry that could be answered by OpenRouter live cache is
 * pure rot waiting to happen.
 */
const LOCAL_MODEL_HINTS: ReadonlyArray<{ pattern: string; window: number; note?: string }> = [
  // Ollama / local runtimes — these are NATIVE model ceilings.
  // Ollama's own num_ctx defaults to 2048 unless the user overrides
  // via Modelfile or `/set parameter num_ctx`. Sources: HuggingFace.
  { pattern: 'qwen3', window: 32_768, note: 'Native 32K (131K with YaRN)' },
  { pattern: 'qwen2.5-coder', window: 32_768, note: 'Native 32K (128K with YaRN)' },
  { pattern: 'qwen2.5', window: 32_768 },
  { pattern: 'falcon3', window: 32_768 },
  { pattern: 'mistral-small', window: 32_768 },
  { pattern: 'mistral-large', window: 131_072 },
  // Llama-via-Ollama or via Meta direct (when not also routed through OR).
  { pattern: 'llama-3.3', window: 131_072 },
  { pattern: 'llama-3.1', window: 131_072 },
];

/**
 * Generate normalization variants for a model name.
 * Handles the dot-vs-dash version separator difference between direct
 * provider IDs (claude-sonnet-4-5) and OpenRouter routes (anthropic/claude-sonnet-4.5).
 */
function modelNameVariants(name: string): string[] {
  const variants = new Set([name]);
  // Convert trailing "-X-Y" or "-X-Y-Z" version segments into "-X.Y" form
  const dotted = name.replace(/-(\d+)-(\d+)(-(\d+))?$/, (_, a, b, _full, c) => (c ? `-${a}.${b}.${c}` : `-${a}.${b}`));
  variants.add(dotted);
  // Convert any dots back to dashes (for the inverse case)
  variants.add(name.replace(/\./g, '-'));
  return [...variants];
}

/**
 * Try every normalization variant × provider prefix against the
 * OpenRouter live cache. O(1) lookups in a Map, ~24 attempts max.
 */
function findInOpenRouterCache(modelName: string): number | undefined {
  for (const variant of modelNameVariants(modelName)) {
    const direct = lookupOpenRouterContextWindow(variant);
    if (direct !== undefined) return direct;

    if (!variant.includes('/')) {
      for (const prefix of OPENROUTER_PROVIDER_PREFIXES) {
        const hit = lookupOpenRouterContextWindow(`${prefix}/${variant}`);
        if (hit !== undefined) return hit;
      }
    }
  }
  return undefined;
}

/**
 * Primary public resolver. Provider-agnostic — pass any model name from
 * any provider browd supports; gets the most accurate value available
 * given current cache state.
 */
export function resolveModelContextWindow(modelName: string): number {
  if (!modelName) return DEFAULT_CONTEXT_WINDOW_HINT;

  // 1. OpenRouter live cache — primary path for all cloud models.
  const live = findInOpenRouterCache(modelName);
  if (live !== undefined) return live;

  // 2. Local-only hardcoded fallback (Ollama and edge cases).
  const m = modelName.toLowerCase();
  for (const hint of LOCAL_MODEL_HINTS) {
    if (m.includes(hint.pattern.toLowerCase())) return hint.window;
  }

  // 3. Conservative default — UI ring reads "fuller than reality"
  //    rather than overestimating headroom for unknown models.
  return DEFAULT_CONTEXT_WINDOW_HINT;
}
