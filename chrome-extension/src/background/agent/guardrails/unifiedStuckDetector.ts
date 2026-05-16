/**
 * Unified-mode stuck detector.
 *
 * Single subgoal-level guard: **env-fingerprint**. Hash of the
 * post-subgoal browser state (URL + interactive-element count +
 * first 200 chars of page text). When the same fingerprint appears
 * `fingerprintMaxRepeat` times within `fingerprintWindow` subgoals
 * → real stall (page is frozen across multiple LLM rounds).
 *
 * **What this file no longer does (T2x phase 0, 2026-05-16).** The
 * silent-step guard ("≥N consecutive subgoals with zero tool calls")
 * was removed: a no-tool-call AIMessage is the natural exit signal
 * of `createReactAgent`, not a stall. Five surveyed production
 * systems (browser-use, Stagehand, OpenAI Operator, Anthropic
 * computer-use, Magentic-One) do NOT use that signal. The full
 * 4-day T2p arc was patching the wrong layer — see
 * `auto-docs/for-development/agents/anti-patterns.md` §9 for the
 * industry verdict and `auto-docs/browd-agent-evolution.md` for
 * the T2x migration plan.
 *
 * The verdict produces an `ActionError` of type `reasoning_failure`
 * that the caller routes through the existing `FailureClassifier` /
 * `HITLController` rails. dupGuard at the tool layer
 * (`tools/langGraphAdapter.ts`) plus the LangGraph `recursionLimit`
 * cover the remaining stall classes (identical-args repetition,
 * runaway inner loop).
 */

import { makeActionError, type ActionError } from '../agentErrors';
import type { BrowserState } from '@src/background/browser/views';

export interface SubgoalRecord {
  /** Stable hash of post-subgoal browser state. Use `computeStateFingerprint`. */
  fingerprint: string;
}

export interface StuckVerdict {
  kind: 'env-fingerprint';
  message: string;
  error: ActionError;
}

export interface UnifiedStuckDetectorOptions {
  /** Rolling window size for fingerprint dedup. Default 5. */
  fingerprintWindow?: number;
  /** Required identical fingerprints in the window to trigger. Default 3. */
  fingerprintMaxRepeat?: number;
}

export class UnifiedStuckDetector {
  private readonly fpWindowSize: number;
  private readonly fpMaxRepeat: number;
  private fpWindow: string[] = [];

  constructor(opts: UnifiedStuckDetectorOptions = {}) {
    this.fpWindowSize = opts.fingerprintWindow ?? 5;
    this.fpMaxRepeat = opts.fingerprintMaxRepeat ?? 3;
  }

  /**
   * Record one subgoal's post-step fingerprint. Returns a
   * `StuckVerdict` when the page state has frozen across the window;
   * `null` otherwise.
   */
  recordSubgoal(rec: SubgoalRecord): StuckVerdict | null {
    this.fpWindow.push(rec.fingerprint);
    if (this.fpWindow.length > this.fpWindowSize) this.fpWindow.shift();

    if (this.fpWindow.length >= this.fpMaxRepeat) {
      const counts = new Map<string, number>();
      for (const fp of this.fpWindow) {
        const c = (counts.get(fp) ?? 0) + 1;
        counts.set(fp, c);
        if (c >= this.fpMaxRepeat) {
          const msg = `Page state unchanged across ${c} of last ${this.fpWindow.length} subgoals — agent is not making progress.`;
          return {
            kind: 'env-fingerprint',
            message: msg,
            error: makeActionError('reasoning_failure', msg),
          };
        }
      }
    }

    return null;
  }

  /** Reset the fingerprint window. Call when the planner rewrites the plan. */
  reset(): void {
    this.fpWindow = [];
  }

  /** Test-introspection. */
  getState(): Readonly<{ fpWindow: readonly string[] }> {
    return { fpWindow: [...this.fpWindow] };
  }
}

/**
 * T2p-2 — detect LangGraph's inner `GraphRecursionError` thrown when
 * a single subgoal exhausts `recursionLimit` (default 25) inside
 * `createReactAgent` without landing on a terminal state. The
 * canonical message is *"Recursion limit of N reached without
 * hitting a stop condition"*. We match the generic shape so a future
 * LangGraph wording tweak still trips.
 *
 * Why this matters: the per-subgoal createReactAgent loop can run
 * tens of LLM rounds emitting tool calls that all silently no-op
 * (isTrusted=false antibot clicks on anti-automation pages). The
 * existing per-tool dupGuard is defeated when the LLM rephrases its
 * `intent` string slightly between rounds, so the recursion limit
 * fires AFTER ~25 wasted rounds. Without this detector the outer
 * replanner would then attempt the same approach again under a new
 * subgoal — burning another 25 rounds. Treating the inner-recursion
 * error as a structural failure (not a transient one) short-circuits
 * the StateGraph immediately.
 */
export function isInnerRecursionLimitError(message: string): boolean {
  if (typeof message !== 'string') return false;
  return /Recursion limit of \d+ reached/i.test(message);
}

/**
 * Build a stable fingerprint string from a `BrowserState`.
 *
 * Components chosen for the test10.md class of failures:
 *   - URL minus query/hash — survives same-page state churn from
 *     analytics & ad rotation that often append cache-busting query
 *     strings.
 *   - Interactive-element count — when DOM build fails (`No frame
 *     with id N`) this collapses to 0 and stays 0 across retries,
 *     which we want to detect.
 *   - First 200 chars of page text — coarse but distinguishes a
 *     blank page from a real one, and distinguishes "still loading"
 *     across navigations.
 *
 * Crypto-grade hashing is unnecessary; equality comparison on the
 * concatenated string is what the detector uses.
 */
export function computeStateFingerprint(state: BrowserState): string {
  const rawUrl = state.url ?? '';
  const url = rawUrl.split('#')[0].split('?')[0];
  const elemCount = state.selectorMap?.size ?? 0;
  const textSlice = (state.pageText ?? '').slice(0, 200);
  return `${url}|${elemCount}|${textSlice}`;
}
