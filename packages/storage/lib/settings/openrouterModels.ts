/**
 * Live context-window lookup for OpenRouter models. The OpenRouter
 * catalog is large (~500+ routes) and changes weekly — hardcoding it
 * rots fast. The /api/v1/models endpoint is public (no auth), CORS-
 * friendly, and returns `context_length` for every route.
 *
 * Strategy:
 *   1. On extension startup, fire-and-forget `preloadOpenRouterModels()`.
 *   2. It checks chrome.storage.local for a < 24h cache, uses it if fresh.
 *   3. If stale or absent, fetches once and writes back to storage.
 *   4. `lookupOpenRouterContextWindow(modelId)` is a sync read from
 *      in-memory cache — undefined if catalog isn't loaded yet OR the
 *      model isn't in it (caller falls back to the static hint table
 *      in `types.ts`).
 *
 * Fail-soft on every path — extension stays functional even if the
 * endpoint is blocked, rate-limited, or returns malformed data.
 */

const CACHE_KEY = 'browd_openrouter_models_cache_v1';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const ENDPOINT = 'https://openrouter.ai/api/v1/models';

interface CacheEntry {
  fetchedAt: number;
  models: Record<string, number>;
}

let inMemoryCache: Record<string, number> | null = null;
let preloadPromise: Promise<void> | null = null;

async function loadFromStorage(): Promise<CacheEntry | null> {
  try {
    const result = await chrome.storage.local.get(CACHE_KEY);
    const entry = result[CACHE_KEY];
    if (entry && typeof entry === 'object' && typeof (entry as CacheEntry).fetchedAt === 'number') {
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

async function fetchOpenRouterCatalog(): Promise<Record<string, number>> {
  const res = await fetch(ENDPOINT);
  if (!res.ok) throw new Error(`OpenRouter /models returned ${res.status}`);
  const data = (await res.json()) as { data?: Array<{ id?: string; context_length?: number }> };
  const map: Record<string, number> = {};
  if (Array.isArray(data.data)) {
    for (const m of data.data) {
      if (typeof m?.id === 'string' && typeof m?.context_length === 'number' && m.context_length > 0) {
        map[m.id] = m.context_length;
      }
    }
  }
  return map;
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
      inMemoryCache = cached.models;
      return;
    }
    try {
      const models = await fetchOpenRouterCatalog();
      inMemoryCache = models;
      await saveToStorage({ fetchedAt: Date.now(), models });
    } catch {
      // Stale-but-better-than-nothing if a previous fetch succeeded once.
      if (cached) inMemoryCache = cached.models;
    }
  })();
  return preloadPromise;
}

/**
 * Sync lookup. Returns context_length if cached, undefined otherwise.
 * Caller must fall back to the static hint table in `types.ts`.
 */
export function lookupOpenRouterContextWindow(modelName: string): number | undefined {
  return inMemoryCache?.[modelName];
}
