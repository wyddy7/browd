import type { HITLDecision, HITLRequest } from './types';
import { HITL_DECISION_MESSAGE, HITL_REQUEST_MESSAGE } from './types';
import { createLogger } from '@src/background/log';

const logger = createLogger('HITLController');

const HITL_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export type SendMessage = (msg: unknown) => void;

/**
 * Manages Human-in-the-Loop pause/resume for sensitive agent actions.
 *
 * Background → side-panel: sends HITLRequest via chrome.runtime.sendMessage
 * Side-panel → background:  sends HITLDecision via chrome.runtime.sendMessage
 *
 * requestDecision() returns a Promise that resolves when the user decides.
 * The agent loop calls await requestDecision(...) and then acts on the decision.
 *
 * chrome.runtime.sendMessage is injected as a dependency for testability.
 */
export class HITLController {
  private pending = new Map<
    string,
    { resolve: (d: HITLDecision) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(private readonly sendMessage: SendMessage) {}

  /**
   * Pause the agent and ask the user for a decision.
   * Returns a Promise that resolves when the user responds.
   */
  async requestDecision(request: HITLRequest): Promise<HITLDecision> {
    return new Promise<HITLDecision>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(request.id);
        reject(new Error(`HITL timeout after ${HITL_TIMEOUT_MS / 1000}s for request ${request.id}`));
      }, HITL_TIMEOUT_MS);

      this.pending.set(request.id, { resolve, reject, timer });

      logger.info(`HITL request sent: ${request.id} (${request.reason})`);
      this.sendMessage({ type: HITL_REQUEST_MESSAGE, payload: request });
    });
  }

  /**
   * Called when the side-panel sends back a decision.
   * Resolves the pending Promise for the matching request ID.
   */
  submitDecision(id: string, decision: HITLDecision): boolean {
    const pending = this.pending.get(id);
    if (!pending) {
      logger.warning(`No pending HITL request for id: ${id}`);
      return false;
    }
    clearTimeout(pending.timer);
    this.pending.delete(id);
    logger.info(`HITL decision received: ${id} → ${decision.type}`);
    pending.resolve(decision);
    return true;
  }

  /** Returns true if there is at least one pending HITL request (agent is paused). */
  isWaiting(): boolean {
    return this.pending.size > 0;
  }

  /** Cancel all pending requests (e.g. on task cancel). */
  cancelAll(): void {
    for (const [id, { reject, timer }] of this.pending) {
      clearTimeout(timer);
      reject(new Error(`HITL cancelled for request ${id}`));
    }
    this.pending.clear();
  }

  /** Format an approved action for agent memory injection. */
  static formatDecisionForMemory(decision: HITLDecision, request: HITLRequest): string {
    const actionName = Object.keys(request.pendingAction)[0] ?? 'action';
    switch (decision.type) {
      case 'approve':
        return `[HITL] User approved: ${actionName}`;
      case 'reject':
        return `[HITL] User rejected ${actionName} with reason: "${decision.message}"`;
      case 'edit':
        return `[HITL] User edited ${actionName} to: ${JSON.stringify(decision.editedAction)}`;
      case 'answer':
        return `[HITL] User answered: "${decision.answer}"`;
    }
  }
}

/**
 * Parse an incoming chrome.runtime message and route to the controller.
 * Call this from background/index.ts chrome.runtime.onMessage handler.
 */
export function handleIncomingHITLMessage(controller: HITLController, message: unknown): boolean {
  if (
    message &&
    typeof message === 'object' &&
    'type' in message &&
    (message as { type: string }).type === HITL_DECISION_MESSAGE
  ) {
    const msg = message as { type: string; id: string; decision: HITLDecision };
    return controller.submitDecision(msg.id, msg.decision);
  }
  return false;
}
