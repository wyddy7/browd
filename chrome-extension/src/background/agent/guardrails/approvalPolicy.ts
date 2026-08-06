import type { TaskState } from '../state/classifier';
import type { HITLReason, HITLRisk } from '../hitl/types';

/**
 * Determines whether an action requires human approval before execution.
 * Pattern: medium risk → HITL approve, high risk → HITL approve, low risk → auto.
 *
 * Plain code — no LLM. From agents/hitl.md:
 *   "low risk + high confidence → continue automatically"
 *   "medium risk OR medium confidence → ask for approval"
 *   "high risk OR repeated failure → hand off with summary"
 *
 * Three layers, in order of how hard they are for the model to walk past:
 *   1. action name + args — the model cannot talk its way around these
 *      (`send_keys` with Enter submits a form no matter how the intent reads);
 *   2. page state — any interaction while a form is ready to submit;
 *   3. the `intent` regex — supplementary only. `intent` is authored by the
 *      LLM itself, so a gate that rests on it alone is bypassed the moment the
 *      model words its plan differently. It stays as a widener, never as the
 *      only belt.
 *
 * Every action name below is asserted against the real registry in
 * `__tests__/approvalPolicy.test.ts` — a phantom name (the old `submit_form`)
 * makes that test fail rather than silently disabling a gate.
 */

/** Intent keywords that signal a destructive or irreversible action. */
const SENSITIVE_INTENT_RE =
  /submit|отправ|send.*appl|apply|confirm|delete|удал|purchase|оплат|payment|checkout|buy|order|finalize/i;

/**
 * Actions that mutate the page or the outside world. Any of these while the
 * page is in a high-risk state needs approval — including the coordinate-based
 * variants, which previously walked past the gate because it only ever looked
 * at `click_element`.
 */
export const INTERACTION_ACTIONS = new Set([
  'click_element',
  'click_at',
  'type_at',
  'drag_at',
  'input_text',
  'send_keys',
  'fill_field_by_label',
  'select_dropdown_option',
]);

/** Actions that already run their own HITL prompt inside `actions/builder.ts`. */
export const SELF_GATED_ACTIONS = new Set(['ask_user', 'hitl_click_at', 'take_over_user_tab']);

/** States where any interaction is high-risk (a form is about to be submitted). */
const HIGH_RISK_STATES: Set<TaskState> = new Set(['ready_to_submit', 'apply_modal']);

/** Field labels whose content must never be typed without the user seeing it. */
const SENSITIVE_FIELD_RE = /password|пароль|card.*number|номер.*карт|cvv|cvc|pin|passport|паспорт|ssn/i;

/** Keys that submit a form on their own, regardless of what the intent says. */
const SUBMITTING_KEYS_RE = /\b(enter|return|numpadenter)\b/i;

export interface ApprovalDecision {
  requiresApproval: boolean;
  reason: HITLReason;
  risk: HITLRisk;
  summary: string;
  /**
   * The agent must NOT do this at all — hand it to the owner instead of asking
   * for permission.
   *
   * Credentials are the case: an agent typing a password, CVV or PIN is not a
   * thing to approve, it is a thing not to do. Refusing also removes a real
   * failure mode — focusing a credential field makes password-manager
   * extensions inject their own `chrome-extension://` iframe, which Chrome
   * treats as grounds to force-detach the debugger from the whole tab (see
   * CLAUDE.md § Debugger-binding lifecycle). We were fighting to enable
   * something we should never have been doing.
   *
   * Same shape as the existing `hitl_click_at` handoff: state plainly that the
   * agent cannot do it, and let the human take those ten seconds.
   */
  handOff?: boolean;
}

/** Pull a field label out of whichever arg shape the action uses. */
function labelOf(actionArgs: Record<string, unknown>): string {
  return String(actionArgs.label ?? actionArgs.fieldLabel ?? actionArgs.placeholder ?? '');
}

/**
 * Check if an action requires HITL approval.
 *
 * @param actionName - The action type (e.g. "click_element", "fill_field_by_label")
 * @param actionArgs - The action arguments
 * @param currentState - Current classified task state. Optional: callers that
 *   cannot cheaply classify the page (the unified-mode tool wrapper) may omit
 *   it, in which case layers 1 and 3 still apply.
 * @returns ApprovalDecision — if requiresApproval=false, agent continues automatically
 */
export function checkApproval(
  actionName: string,
  actionArgs: Record<string, unknown>,
  currentState: TaskState = 'unknown',
): ApprovalDecision {
  const noApproval: ApprovalDecision = {
    requiresApproval: false,
    reason: 'sensitive_action',
    risk: 'low',
    summary: '',
  };

  // Actions that prompt on their own path — do not double-prompt.
  if (SELF_GATED_ACTIONS.has(actionName)) return noApproval;

  // --- Layer 1: name + args. Not reachable by rewording the intent. ---

  // Enter/Return submits the focused form.
  if (actionName === 'send_keys' && SUBMITTING_KEYS_RE.test(String(actionArgs.keys ?? ''))) {
    return {
      requiresApproval: true,
      reason: 'sensitive_action',
      risk: 'high',
      summary: `Pressing "${String(actionArgs.keys)}" — this submits the focused form.`,
    };
  }

  // Typing into a credential / payment / identity field.
  if (actionName === 'fill_field_by_label' || actionName === 'input_text' || actionName === 'type_at') {
    const label = labelOf(actionArgs);
    if (SENSITIVE_FIELD_RE.test(label)) {
      return {
        requiresApproval: true,
        handOff: true,
        reason: 'sensitive_action',
        risk: 'high',
        summary: `"${label}" is a credential field — the agent does not type credentials. Ask the owner to fill it.`,
      };
    }
  }

  // --- Layer 2: page state. Covers coordinate actions, not just click_element. ---

  if (INTERACTION_ACTIONS.has(actionName) && HIGH_RISK_STATES.has(currentState)) {
    return {
      requiresApproval: true,
      reason: 'sensitive_action',
      risk: 'high',
      summary: `"${actionName}" while the form is ready to submit (state: ${currentState}).`,
    };
  }

  // --- Layer 3: the LLM's own words. Widens coverage, never the only belt. ---

  const intent = String(actionArgs.intent ?? '');
  if (SENSITIVE_INTENT_RE.test(intent)) {
    return {
      requiresApproval: true,
      reason: 'sensitive_action',
      risk: HIGH_RISK_STATES.has(currentState) ? 'high' : 'medium',
      summary: `Action has sensitive intent: "${intent}"`,
    };
  }

  return noApproval;
}

/**
 * True when classifying the page could change the verdict for this action.
 * Lets the unified-mode gate skip the cost of a `getState()` round-trip for
 * read-only tools (`web_search`, `scroll_*`, …) that no page state can make
 * dangerous.
 */
export function mayNeedPageState(actionName: string): boolean {
  return INTERACTION_ACTIONS.has(actionName);
}
