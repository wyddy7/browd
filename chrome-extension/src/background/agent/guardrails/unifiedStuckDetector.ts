/**
 * T2p — unified-mode stuck detector.
 *
 * The legacy Navigator already has tool-call dedup (`LoopDetector`),
 * failure routing (`FailureClassifier`), and HITL handoff
 * (`HITLController`). The unified ReAct path
 * (`agents/runReactAgent.ts`, default since T2f-1) bypasses all
 * three: the only guard wired in unified mode is the tool-level
 * `dupGuard` (T2i-fix1) inside `tools/langGraphAdapter.ts`, which
 * returns a forcing error string to the LLM but never escalates
 * to HITL.
 *
 * test10.md (2026-05-15) demonstrates the gap: identical screenshot
 * + DOM 4× in a row (action varied, so dupGuard didn't trip; the
 * `screenshot` action is exempt anyway), swallowed `go_back` throw,
 * `no-toolCall` planner reply "Wait for X to load completely",
 * silent CPU burn with no termination.
 *
 * This file adds TWO subgoal-level guards on top of the existing
 * tool-level dupGuard:
 *
 *   1. **Env-fingerprint** — hash of the post-subgoal browser state
 *      (URL + interactive-element count + first 200 chars of page
 *      text). When the same fingerprint appears `fingerprintMaxRepeat`
 *      times within `fingerprintWindow` subgoals → stuck.
 *
 *   2. **Silent-step** — count consecutive subgoals that produced
 *      zero tool calls. ≥ `silentMaxConsecutive` → stuck.
 *
 * Both verdicts produce an `ActionError` of type `reasoning_failure`
 * that the caller routes through the existing `FailureClassifier` /
 * `HITLController` rails (FailureClassifier already maps
 * `reasoning_failure` to `hitl_handoff` on first occurrence).
 *
 * Caskad contract: ONE new file, ONE composite interface
 * (`recordSubgoal`), composes existing classes only. No new prompt
 * rules. The two checks share a `reset()` semantic — both reset
 * together on a planner-driven plan rewrite.
 *
 */

import { makeActionError, type ActionError } from '../agentErrors';
import type { BrowserState } from '@src/background/browser/views';

export interface SubgoalRecord {
  /** Stable hash of post-subgoal browser state. Use `computeStateFingerprint`. */
  fingerprint: string;
  /** Number of tool calls emitted by the agent inside this subgoal. */
  toolCallCount: number;
}

export interface StuckVerdict {
  kind: 'env-fingerprint' | 'silent-step';
  message: string;
  error: ActionError;
}

export interface UnifiedStuckDetectorOptions {
  /** Rolling window size for fingerprint dedup. Default 5. */
  fingerprintWindow?: number;
  /** Required identical fingerprints in the window to trigger. Default 3. */
  fingerprintMaxRepeat?: number;
  /** Required consecutive zero-tool-call subgoals to trigger. Default 2. */
  silentMaxConsecutive?: number;
}

export class UnifiedStuckDetector {
  private readonly fpWindowSize: number;
  private readonly fpMaxRepeat: number;
  private readonly silentMaxConsecutive: number;
  private fpWindow: string[] = [];
  private silentRun = 0;

  constructor(opts: UnifiedStuckDetectorOptions = {}) {
    this.fpWindowSize = opts.fingerprintWindow ?? 5;
    this.fpMaxRepeat = opts.fingerprintMaxRepeat ?? 3;
    this.silentMaxConsecutive = opts.silentMaxConsecutive ?? 2;
  }

  /**
   * Record one subgoal's outcome. Returns a `StuckVerdict` when the
   * detector wants the caller to abort the StateGraph; returns `null`
   * when the subgoal looks healthy.
   *
   * Order of checks is deliberate: env-fingerprint first because a
   * frozen page is the higher-confidence signal (silent steps can
   * legitimately happen mid-load and self-correct on the next round).
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

    if (rec.toolCallCount === 0) this.silentRun += 1;
    else this.silentRun = 0;

    if (this.silentRun >= this.silentMaxConsecutive) {
      const msg = `${this.silentRun} consecutive subgoals produced no tool calls — agent is stalling without acting.`;
      return {
        kind: 'silent-step',
        message: msg,
        error: makeActionError('reasoning_failure', msg),
      };
    }

    return null;
  }

  /** Reset both windows. Call when the planner rewrites the plan. */
  reset(): void {
    this.fpWindow = [];
    this.silentRun = 0;
  }

  /** Test-introspection. */
  getState(): Readonly<{ fpWindow: readonly string[]; silentRun: number }> {
    return { fpWindow: [...this.fpWindow], silentRun: this.silentRun };
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
