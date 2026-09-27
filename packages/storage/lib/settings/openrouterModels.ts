/**
 * Live capability lookup for OpenRouter models: context window and
 * whether the route accepts image input. The OpenRouter catalog is
 * large (~500+ routes) and changes weekly — hardcoding it rots fast.
 * The /api/v1/models endpoint is public (no auth), CORS-friendly, and
 * returns `context_length` and `architecture.input_modalities` for
 * every route.
 *
 * Strategy:
 *   1. On extension startup, fire-and-forget `preloadOpenRouterModels()`.
 *   2. It checks chrome.storage.local for a < 24h cache, uses it if fresh.
 *   3. If stale or absent, fetches once and writes back to storage.
 *   4. `lookupOpenRouterContextWindow(modelId)` and
 *      `lookupOpenRouterImageInput(modelId)` are sync reads from the
 *      in-memory cache — undefined if the catalog isn't loaded yet OR
 *      the model isn't in it (callers fall back to static hints in
 *      `types.ts` / `modelContextHints.ts`).
 *
 * Fail-soft on every path — extension stays functional even if the
 * endpoint is blocked, rate-limited, or returns malformed data.
 */

// v2 adds `imageInput`; a v1 entry is simply ignored and refetched.
const CACHE_KEY = 'browd_openrouter_models_cache_v2';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ENDPOINT = 'https://openrouter.ai/api/v1/models';

interface Catalog {
  models: Record<string, number>;
  imageInput: Record<string, boolean>;
}

interface CacheEntry extends Catalog {
  fetchedAt: number;
}

let inMemoryCache: Catalog | null = null;
let preloadPromise: Promise<void> | null = null;

async function loadFromStorage(): Promise<CacheEntry | null> {
  try {
    const result = await chrome.storage.local.get(CACHE_KEY);
    const entry = result[CACHE_KEY];
    if (
      entry &&
      typeof entry === 'object' &&
      typeof (entry as CacheEntry).fetchedAt === 'number' &&
      typeof (entry as CacheEntry).imageInput === 'object'
    ) {
      return entry as CacheEntry;
    }
    return null;
  } catch {
    return null;
  }
}

async function saveToStorage(entry: CacheEntry): Promise<void> {
  try {
    await chrome.storage.local.set({ [CACHE_KEY]: entry });
  } catch {
    // ignore — extension still works via static hint table
  }
}

async function fetchOpenRouterCatalog(): Promise<Catalog> {
  const res = await fetch(ENDPOINT);
  if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
  const data = (await res.json()) as {
    data?: Array<{ id?: string; context_length?: number; architecture?: { input_modalities?: unknown } }>;
  };
  const catalog: Catalog = { models: {}, imageInput: {} };
  if (Array.isArray(data.data)) {
    for (const m of data.data) {
      if (typeof m?.id !== 'string') continue;
      if (typeof m.context_length === 'number' && m.context_length > 0) {
        catalog.models[m.id] = m.context_length;
      }
      const inputs = m.architecture?.input_modalities;
      if (Array.isArray(inputs)) {
        catalog.imageInput[m.id] = inputs.includes('image');
      }
    }
  }
  return catalog;
}

/**
 * Preload the OpenRouter catalog. Safe to call at extension startup —
 * idempotent within a session, returns the same promise on repeated calls.
 */
export function preloadOpenRouterModels(): Promise<void> {
  if (preloadPromise) return preloadPromise;
  preloadPromise = (async () => {
    const cached = await loadFromStorage();
    const isStale = !cached || Date.now() - cached.fetchedAt > CACHE_TTL_MS;
    if (cached && !isStale) {
      inMemoryCache = cached;
      return;
    }
    try {
      const catalog = await fetchOpenRouterCatalog();
      inMemoryCache = catalog;
      await saveToStorage({ fetchedAt: Date.now(), ...catalog });
    } catch {
      // Stale-but-better-than-nothing if a previous fetch succeeded once.
      if (cached) inMemoryCache = cached;
    }
  })();
  return preloadPromise;
}

/**
 * Sync lookup. Returns context_length if cached, undefined otherwise.
 * Caller must fall back to the static hint table in `types.ts`.
 */
export function lookupOpenRouterContextWindow(modelName: string): number | undefined {
  return inMemoryCache?.models[modelName];
}

/**
 * Sync lookup. True/false if the route is cached, undefined otherwise.
 * Caller must fall back to the name hints in `types.ts`.
 */
export function lookupOpenRouterImageInput(modelName: string): boolean | undefined {
  return inMemoryCache?.imageInput[modelName];
}
