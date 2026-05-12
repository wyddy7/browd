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
 */

/** Intent keywords that signal a destructive or irreversible action. */
const SENSITIVE_INTENT_RE =
  /submit|отправ|send.*appl|apply|confirm|delete|удал|purchase|оплат|payment|checkout|buy|order|finalize/i;

/** Action names that are always sensitive regardless of intent text. */
const ALWAYS_SENSITIVE_ACTIONS = new Set([
  'submit_form', // hypothetical future action
]);

/** States where any click is considered high-risk (form about to be submitted). */
const HIGH_RISK_STATES: Set<TaskState> = new Set(['ready_to_submit', 'apply_modal']);

export interface ApprovalDecision {
  requiresApproval: boolean;
  reason: HITLReason;
  risk: HITLRisk;
  summary: string;
}

/**
 * Check if an action requires HITL approval.
 *
 * @param actionName - The action type (e.g. "click_element", "fill_field_by_label")
 * @param actionArgs - The action arguments
 * @param currentState - Current classified task state
 * @returns ApprovalDecision — if requiresApproval=false, agent continues automatically
 */
export function checkApproval(
  actionName: string,
  actionArgs: Record<string, unknown>,
  currentState: TaskState,
): ApprovalDecision {
  const noApproval: ApprovalDecision = {
    requiresApproval: false,
    reason: 'sensitive_action',
    risk: 'low',
    summary: '',
  };

  // Always-sensitive actions
  if (ALWAYS_SENSITIVE_ACTIONS.has(actionName)) {
    return {
      requiresApproval: true,
      reason: 'sensitive_action',
      risk: 'high',
      summary: `Action "${actionName}" is always sensitive.`,
    };
  }

  // click_element in high-risk page state
  if (actionName === 'click_element' && HIGH_RISK_STATES.has(currentState)) {
    return {
      requiresApproval: true,
      reason: 'sensitive_action',
      risk: 'high',
      summary: `Clicking a button while form is ready to submit (state: ${currentState}).`,
    };
  }

  // Any action with sensitive intent
  const intent = String(actionArgs.intent ?? '');
  if (SENSITIVE_INTENT_RE.test(intent)) {
    const risk: HITLRisk = HIGH_RISK_STATES.has(currentState) ? 'high' : 'medium';
    return {
      requiresApproval: true,
      reason: 'sensitive_action',
      risk,
      summary: `Action has sensitive intent: "${intent}"`,
    };
  }

  // fill_field_by_label with sensitive text content
  if (actionName === 'fill_field_by_label') {
    const label = String(actionArgs.label ?? '');
    const value = String(actionArgs.value ?? '');
    // Card numbers, passwords — flag as sensitive
    if (/password|пароль|card.*number|CVV|pin/i.test(label)) {
      return {
        requiresApproval: true,
        reason: 'sensitive_action',
        risk: 'high',
        summary: `Filling sensitive field "${label}" with a value.`,
      };
    }
    void value; // value itself is not inspected for privacy
  }

  return noApproval;
}
