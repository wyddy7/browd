import type { AgentContext } from '../types';
import type { ApprovalGate } from '../tools/langGraphAdapter';
import type { HITLRequest } from '../hitl/types';
import { checkApproval, mayNeedPageState } from './approvalPolicy';
import { classifyState } from '../state/classifier';
import { extractForms } from '@src/background/browser/dom/forms';
import { Actors, ExecutionState } from '../event/types';
import { createLogger } from '@src/background/log';

const logger = createLogger('ApprovalGate');

/**
 * T-hitl-unified — routes sensitive actions through HITL in unified mode.
 *
 * `checkApproval` used to be reachable only from the legacy Navigator, so the
 * default runtime executed form submits and credential fills with no prompt at
 * all. The gate is handed to `actionsToTools`, which calls it as the third
 * guard in the tool wrapper (after the call budget and the duplicate guard) —
 * that wrapper is the single seam every unified-mode action passes through.
 *
 * Built here rather than inline in `runReactAgent` so it can be unit-tested
 * against a stub context, and so the caller stays a thin wiring line.
 *
 * Known limitation: an `edit` decision comes back to the model as a rejection
 * carrying the corrected arguments. The wrapper can only allow or deny a call,
 * not rewrite its input, so the model has to reissue the action itself.
 */
export function createApprovalGate(context: AgentContext): ApprovalGate | undefined {
  if (!context.hitlController) return undefined;

  /**
   * Approval memory — one "yes" covers retries of the SAME intent for the rest
   * of this task. Without it the user is re-asked on every retry: the
   * 2026-08-06 run made someone press Approve three times for a single
   * password field while the underlying action kept failing.
   *
   * Lifetime is exactly one task because the Set lives in this closure. That
   * satisfies the privacy rule forbidding replay of consent across tasks
   * (T2q) and needs no eviction logic.
   */
  const approvalMemory = new Set<string>();

  /**
   * Key for the memory. Deliberately EXCLUDES `intent`, which the model writes
   * itself — caching on model-authored text would let a reworded new action
   * inherit an older approval. Action name + host + the remaining arguments is
   * what actually identifies "this same thing again".
   */
  const stableArgs = (args: Record<string, unknown>): string => {
    const { intent: _intent, ...rest } = args;
    return JSON.stringify(
      Object.keys(rest)
        .sort()
        .map(k => [k, rest[k]]),
    );
  };

  const currentHost = async (): Promise<string> => {
    try {
      const tabId = context.browserContext.agentTabId();
      if (!tabId) return '';
      const tab = await chrome.tabs.get(tabId);
      return tab.url ? new URL(tab.url).host : '';
    } catch {
      // Same channel as perception provenance: the tabs API stays truthful
      // even when the debugger cannot attach. If it fails we fall back to a
      // host-less key, which is stricter (more prompts), never looser.
      return '';
    }
  };

  return async (actionName, input) => {
    const args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;

    // Layers that need no page state run first — keeps read-only tools free of
    // an expensive state capture.
    let decision = checkApproval(actionName, args);
    if (!decision.requiresApproval && mayNeedPageState(actionName)) {
      try {
        const st = await context.browserContext.getState(false);
        const taskState = classifyState(st.url ?? '', extractForms(st), [st.title ?? '', st.url ?? '']);
        decision = checkApproval(actionName, args, taskState);
      } catch {
        // State unavailable (tab closing, navigation in flight). Fall through
        // on the state-free verdict rather than blocking the run — layers 1
        // and 3 already ran.
      }
    }
    if (!decision.requiresApproval) return { proceed: true };

    // Hand-off, not approval: credentials are something the agent must not do
    // at all, so there is nothing to ask. Refused before the prompt, and never
    // remembered — this is a standing rule, not a decision the user made.
    if (decision.handOff) {
      logger.info(`hand-off (agent will not perform): ${actionName}`);
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.TASK_HITL_ASK, decision.summary);
      return {
        proceed: false,
        message: `Refused: ${decision.summary} Do not retry this field with any tool. Tell the user what to type and where, then continue with the rest of the task.`,
      };
    }

    const hitl = context.hitlController;
    if (!hitl) return { proceed: true };

    const memoryKey = `${actionName}|${await currentHost()}|${stableArgs(args)}`;
    if (approvalMemory.has(memoryKey)) {
      // Visible, never silent: an auto-approval the user cannot see would be a
      // worse failure than asking twice.
      logger.info(`auto-approved (already approved this task): ${actionName}`);
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.TASK_HITL_APPROVE, `Auto-approved retry: ${decision.summary}`);
      return { proceed: true };
    }

    const request: HITLRequest = {
      id: `hitl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      reason: decision.reason,
      pendingAction: { [actionName]: args },
      context: { summary: decision.summary, risk: decision.risk, confidence: 0.8 },
    };
    context.emitEvent(Actors.NAVIGATOR, ExecutionState.TASK_HITL_APPROVE, decision.summary);

    let userDecision;
    try {
      userDecision = await hitl.requestDecision(request);
    } catch (err) {
      // Timeout or task cancellation — fail CLOSED. A sensitive action must
      // never run just because nobody answered.
      const msg = err instanceof Error ? err.message : String(err);
      return {
        proceed: false,
        message: `Error: approval for "${actionName}" was not granted (${msg}). Do not retry this action; ask the user what to do instead.`,
      };
    }
    context.messageManager.addHITLDecision(userDecision, request);

    switch (userDecision.type) {
      case 'approve':
        // Only approvals are remembered. A rejection is deliberately NOT
        // cached: the model is told why and must adapt, and a silently
        // remembered "no" would block later attempts with no explanation.
        approvalMemory.add(memoryKey);
        return { proceed: true };
      case 'reject':
        return {
          proceed: false,
          message: `Error: the user rejected "${actionName}": ${userDecision.message}. Do not repeat this action.`,
        };
      case 'edit':
        return {
          proceed: false,
          message: `Error: the user edited "${actionName}". Reissue the call with these arguments: ${JSON.stringify(userDecision.editedAction)}`,
        };
      case 'answer':
        return {
          proceed: false,
          message: `The user answered instead of approving "${actionName}": "${userDecision.answer}". Use that answer and continue.`,
        };
    }
  };
}
