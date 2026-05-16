/**
 * Helpers for the unified ReAct path.
 *
 * **What this file is now (T2x phase 0b, 2026-05-16).** Pure helper
 * functions for the recursion-limit soft-fail in `runReactAgent.ts`.
 * No subgoal-level stuck-detector class. The previous detector
 * (silent-step + env-fingerprint guards) measured framework-natural
 * behaviour as "stuck" and killed correctly-working agents — see
 * `auto-docs/for-development/agents/anti-patterns.md` §9 for the
 * industry verdict (browser-use, Anthropic CUA, OpenAI Operator,
 * Stagehand, Magentic-One — none use subgoal-level stuck signals).
 *
 * Remaining coverage:
 *   - `dupGuard` in `tools/langGraphAdapter.ts` — identical
 *     `(tool, args)` 3-in-5 → forcing error to LLM.
 *   - LangGraph `recursionLimit` (inner 25, outer ~50) — hard cap.
 *   - `isInnerRecursionLimitError` (below) — distinguishes inner
 *     budget exhaustion from real errors so the T2p-3 soft-fail can
 *     hand a partial summary to the replanner.
 *   - `computeStateFingerprint` (below) — used by T2p-3 to compare
 *     entry-vs-exhaustion page state and decide soft-fail vs rethrow.
 */

import type { BrowserState } from '@src/background/browser/views';

/**
 * Detect LangGraph's inner `GraphRecursionError` thrown when a single
 * subgoal exhausts `recursionLimit` (default 25) inside
 * `createReactAgent`. Canonical message: *"Recursion limit of N
 * reached without hitting a stop condition"*. Pattern-matched so a
 * future LangGraph wording tweak still trips.
 *
 * Used by `runReactStep` in `runReactAgent.ts` for the T2p-3
 * progress-vs-stuck split.
 */
export function isInnerRecursionLimitError(message: string): boolean {
  if (typeof message !== 'string') return false;
  return /Recursion limit of \d+ reached/i.test(message);
}

/**
 * Stable fingerprint string from a `BrowserState`. Used by the
 * recursion-limit soft-fail to compare entry-vs-exhaustion state —
 * different fingerprint means the agent made real progress before
 * burning the budget, so we hand a partial to the replanner rather
 * than rethrowing.
 *
 * Components: URL minus query/hash, interactive-element count, first
 * 200 chars of page text. Crypto-grade hashing is unnecessary —
 * string equality is the consumer.
 */
export function computeStateFingerprint(state: BrowserState): string {
  const rawUrl = state.url ?? '';
  const url = rawUrl.split('#')[0].split('?')[0];
  const elemCount = state.selectorMap?.size ?? 0;
  const textSlice = (state.pageText ?? '').slice(0, 200);
  return `${url}|${elemCount}|${textSlice}`;
}
