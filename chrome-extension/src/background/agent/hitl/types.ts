/**
 * HITL (Human-in-the-Loop) types.
 * Interrupt-on-action pattern: pause the loop, surface a structured
 * decision request to the user, resume on user input.
 * Translated from LangGraph checkpointer model to chrome.runtime.message async model.
 */

export type HITLReason =
  | 'sensitive_action' // about to submit, delete, purchase
  | 'low_confidence' // skill mapping confidence < threshold
  | 'ambiguous_input' // field not found, goal unclear
  | 'repeated_failure' // multiple reasoning failures
  | 'real_user_click' // T2f-handover — antibot wall, ask the user to click manually
  | 'take_over_request'; // T2s-2 — agent wants to pin to one of the user's tabs

export type HITLRisk = 'low' | 'medium' | 'high';

export interface FieldSnapshot {
  label: string;
  value: string;
  required: boolean;
}

export interface HITLContext {
  /** Human-readable summary of what the agent is about to do. */
  summary: string;
  /** Filled form fields (shown to user for review before submit). */
  fields?: FieldSnapshot[];
  risk: HITLRisk;
  /** Agent's confidence in the pending action (0..1). */
  confidence: number;
  /**
   * T2f-handover: optional context for `real_user_click` requests.
   * imageThumb is a base64 JPEG (the same size we already ship via
   * the trace pipeline). x/y are image-pixel coordinates of the
   * spot the agent wants the user to click; the side panel renders
   * a marker over the thumb so the user knows where to look.
   */
  userClick?: {
    x: number;
    y: number;
    imageThumbBase64?: string;
    imageThumbMime?: string;
  };
  /**
   * T2s-2: optional context for `take_over_request`. Lets the side
   * panel render the prompt body without re-querying Chrome for the
   * target tab's title/url.
   */
  takeOverRequest?: {
    tabId: number;
    title: string;
    url: string;
    reason: string;
  };
}

/**
 * Payload sent from background to side-panel when HITL is needed.
 * Side-panel renders the approval/question UI based on this.
 */
export interface HITLRequest {
  /** UUID — must be passed back in the decision so background can resolve the right Promise. */
  id: string;
  reason: HITLReason;
  /** The action JSON that will be executed after approval (for display + optional edit). */
  pendingAction: Record<string, unknown>;
  context: HITLContext;
  /** Only present when reason is ambiguous_input — shown as the question text. */
  question?: string;
  /** Optional quick-pick answer options. */
  options?: string[];
}

/**
 * Decision from the user, sent back from side-panel to background.
 * Matches deepagents.md structure (approve / reject / edit / answer).
 */
export type HITLDecision =
  | { type: 'approve' }
  | { type: 'reject'; message: string }
  | { type: 'edit'; editedAction: Record<string, unknown> }
  | { type: 'answer'; answer: string };

export const HITL_REQUEST_MESSAGE = 'browd:hitl:request';
export const HITL_DECISION_MESSAGE = 'browd:hitl:decision';
