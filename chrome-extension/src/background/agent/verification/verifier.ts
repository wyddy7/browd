import { makeActionError, type ActionError } from '../agentErrors';

export interface VerificationResult {
  ok: boolean;
  reason: string;
  confidence: number; // 0..1
  evidence: string[];
}

/** Injectable browser accessor — can be swapped for a mock in tests. */
export type FieldValueReader = (xpath: string, tabId: number) => Promise<string | null>;
export type ScrollYReader = (tabId: number) => Promise<number>;
export type DomHashReader = (tabId: number) => Promise<string>;

export interface VerifierDeps {
  readFieldValue: FieldValueReader;
  readScrollY: ScrollYReader;
  readDomHash: DomHashReader;
}

export interface VerifyInput {
  actionName: string;
  actionArgs: Record<string, unknown>;
  tabId: number;
  /** DOM hash captured immediately before the action (for click verification). */
  domHashBefore?: string;
  /** DOM hash captured immediately after the action. */
  domHashAfter?: string;
  /** scrollY before the action. */
  scrollYBefore?: number;
}

/**
 * Per-action result verifier.
 * Plain code — no LLM calls. From agents/multi-agent.md: "verifier — plain code, not LLM".
 *
 * Strategies:
 *   fill_field / input_text / fill_field_by_label → read DOM field value, compare to expected
 *   click_element → confirm DOM hash changed
 *   scroll_* → confirm scrollY changed
 *   done / navigate → always ok
 */
export class Verifier {
  constructor(private readonly deps: VerifierDeps) {}

  async verify(input: VerifyInput): Promise<VerificationResult> {
    const { actionName, actionArgs, tabId, domHashBefore, domHashAfter, scrollYBefore } = input;

    try {
      switch (actionName) {
        case 'fill_field_by_label':
        case 'input_text': {
          const expectedValue = String(actionArgs.expectedValue ?? actionArgs.value ?? actionArgs.text ?? '');
          const xpath = actionArgs.xpath as string | undefined;

          if (!xpath) {
            // No xpath — we can't verify. Trust it succeeded.
            return { ok: true, reason: 'no xpath to verify against, trusting action', confidence: 0.5, evidence: [] };
          }

          const actualValue = await this.deps.readFieldValue(xpath, tabId);

          if (actualValue === null) {
            return {
              ok: false,
              reason: 'field not found at xpath after fill',
              confidence: 0.9,
              evidence: [`xpath: ${xpath}`],
            };
          }

          // Check that expected value is contained in actual (some inputs trim/format)
          const ok = actualValue.includes(expectedValue) || expectedValue.includes(actualValue);
          return {
            ok,
            reason: ok
              ? 'field value matches expected'
              : `field value mismatch: got "${actualValue}", expected "${expectedValue}"`,
            confidence: ok ? 0.95 : 0.9,
            evidence: [`expected: "${expectedValue}"`, `actual: "${actualValue}"`],
          };
        }

        case 'click_element': {
          if (!domHashBefore || !domHashAfter) {
            return { ok: true, reason: 'no DOM hash available for click verification', confidence: 0.4, evidence: [] };
          }
          const ok = domHashBefore !== domHashAfter;
          return {
            ok,
            reason: ok ? 'DOM changed after click' : 'DOM unchanged after click — possible no-op',
            confidence: ok ? 0.85 : 0.75,
            evidence: [`hash_before: ${domHashBefore.slice(0, 8)}`, `hash_after: ${domHashAfter.slice(0, 8)}`],
          };
        }

        case 'scroll_to_bottom':
        case 'scroll_to_top':
        case 'next_page':
        case 'previous_page':
        case 'scroll_to_percent': {
          if (scrollYBefore === undefined) {
            return { ok: true, reason: 'no scrollY baseline, trusting scroll', confidence: 0.5, evidence: [] };
          }
          const scrollYAfter = await this.deps.readScrollY(tabId);
          const ok = Math.abs(scrollYAfter - scrollYBefore) > 5;
          return {
            ok,
            reason: ok
              ? `page scrolled (Δ${scrollYAfter - scrollYBefore}px)`
              : 'scroll position unchanged — already at boundary or stuck',
            confidence: ok ? 0.9 : 0.6, // Not-scrolled at boundary is acceptable
            evidence: [`before: ${scrollYBefore}`, `after: ${scrollYAfter}`],
          };
        }

        // Navigation & low-risk actions: always ok
        case 'go_to_url':
        case 'go_back':
        case 'search_google':
        case 'open_tab':
        case 'switch_tab':
        case 'close_tab':
        case 'send_keys':
        case 'select_dropdown_option':
        case 'get_dropdown_options':
        case 'wait':
        case 'cache_content':
        case 'scroll_to_text':
        case 'done':
          return { ok: true, reason: `${actionName} is trusted without verification`, confidence: 1.0, evidence: [] };

        default:
          return { ok: true, reason: `unknown action "${actionName}" — trusting`, confidence: 0.5, evidence: [] };
      }
    } catch (error) {
      return {
        ok: false,
        reason: `verification threw: ${error instanceof Error ? error.message : String(error)}`,
        confidence: 0.9,
        evidence: [],
      };
    }
  }

  /** Convert a failed VerificationResult to ActionError for FailureClassifier. */
  static toActionError(result: VerificationResult, actionName: string): ActionError {
    if (result.confidence >= 0.8) {
      // High-confidence failure = reasoning failure (agent chose the wrong thing)
      return makeActionError('reasoning_failure', `Verification failed for ${actionName}: ${result.reason}`);
    }
    // Low-confidence failure = might be transient (DOM not settled yet)
    return makeActionError('transient', `Verification uncertain for ${actionName}: ${result.reason}`);
  }
}
