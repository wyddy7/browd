/**
 * T3 — HITL sensitive-action trigger eval.
 *
 * Pure unit — no LLM, no real browser. Verifies ApprovalPolicy correctly
 * routes sensitive actions to HITL approval and benign actions through.
 *
 * Catches regressions in the policy's intent regex and high-risk-state
 * classifier. Free; runs instantly.
 */

import { checkApproval } from '../../guardrails/approvalPolicy';
import { assertion, type ScenarioReport } from '../runner';

export async function runHitlSensitiveActionTrigger(): Promise<ScenarioReport> {
  const name = 'hitl-sensitive-action-trigger';
  const start = Date.now();
  const scriptedAssertions: ScenarioReport['scriptedAssertions'] = [];

  try {
    // Case 1 — click_element in ready_to_submit state must require approval (high risk).
    const submitClick = checkApproval('click_element', { intent: 'submit the application' }, 'ready_to_submit');
    scriptedAssertions.push(
      assertion(
        'click_element in ready_to_submit triggers HITL',
        submitClick.requiresApproval,
        `decision=${JSON.stringify(submitClick)}`,
      ),
      assertion('risk is high for submit-state click', submitClick.risk === 'high'),
    );

    // Case 2 — sensitive intent string ("отправить") triggers HITL even on benign action.
    const sensitiveIntent = checkApproval('click_element', { intent: 'отправить отклик' }, 'questionnaire');
    scriptedAssertions.push(
      assertion(
        'sensitive intent ("отправить") triggers HITL on click_element',
        sensitiveIntent.requiresApproval,
        `decision=${JSON.stringify(sensitiveIntent)}`,
      ),
    );

    // Case 3 — benign navigation must NOT trigger HITL.
    const benignNavigate = checkApproval(
      'go_to_url',
      { intent: 'open the wikipedia page', url: 'https://wikipedia.org' },
      'content_page',
    );
    scriptedAssertions.push(
      assertion(
        'benign go_to_url does NOT trigger HITL',
        !benignNavigate.requiresApproval,
        `decision=${JSON.stringify(benignNavigate)}`,
      ),
    );

    // Case 4 — benign fill action in benign state must NOT trigger HITL.
    const benignFill = checkApproval(
      'fill_field_by_label',
      { intent: 'fill name field', label: 'name', value: 'Daniel' },
      'questionnaire',
    );
    scriptedAssertions.push(
      assertion(
        'benign fill_field_by_label does NOT trigger HITL',
        !benignFill.requiresApproval,
        `decision=${JSON.stringify(benignFill)}`,
      ),
    );

    // Case 5 — payment-keyword intent must trigger HITL with high risk.
    const paymentIntent = checkApproval('click_element', { intent: 'оплатить заказ' }, 'content_page');
    scriptedAssertions.push(
      assertion(
        'payment intent ("оплатить") triggers HITL',
        paymentIntent.requiresApproval,
        `decision=${JSON.stringify(paymentIntent)}`,
      ),
    );

    const passed = scriptedAssertions.every(a => a.passed);
    return { name, passed, scriptedAssertions, durationMs: Date.now() - start };
  } catch (err) {
    return {
      name,
      passed: false,
      scriptedAssertions,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
