import type { AgentContext } from '../types';
import type { ApprovalGate } from '../tools/langGraphAdapter';
import type { HITLRequest } from '../hitl/types';
import { checkApproval, mayNeedPageState } from './approvalPolicy';
import { classifyState } from '../state/classifier';
import { extractForms } from '@src/background/browser/dom/forms';
import { findFieldByLabel } from '@src/background/browser/dom/fieldFinder';
import { generalSettingsStore } from '@extension/storage';
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

  /**
   * The element an action is aimed at, read from the PAGE, never from text the
   * model wrote. Three ways in, one per tool family:
   *  - by index (`input_text`, `select_dropdown_option`, `click_element`): the
   *    model sends only an index; the live self-test (selftest-gate.mjs,
   *    2026-11-24) typed "hunter2" into `type=password` because of that;
   *  - by label (`fill_field_by_label`): the label is the model's, so the field
   *    the action will actually fill is looked up the same way the action does;
   *  - by coordinate (`type_at`, `click_at`, `drag_at`): the element under the
   *    point.
   * `signature` identifies the element for approval memory: indices are
   * rebuilt on every state read, so an index-keyed memory could auto-approve a
   * different button that took the same number.
   */
  type Target = { label: string; signature: string; submits: boolean; name: string };
  const FIELD_ATTRS = ['type', 'name', 'id', 'aria-label', 'placeholder', 'autocomplete'];
  const INDEX_ACTIONS = new Set(['input_text', 'select_dropdown_option', 'click_element']);
  const COORD_ACTIONS = new Set(['type_at', 'click_at', 'drag_at']);
  /** Actions that put text into a field: if their target cannot be read, ask instead of guessing. */
  const FIELD_WRITE_ACTIONS = new Set(['input_text', 'type_at', 'fill_field_by_label', 'select_dropdown_option']);

  /**
   * Does clicking this element submit a form? Read from the element, not from
   * the model's intent: the live self-test showed a neutral "click Create
   * account" passing every layer and the form reaching the server. A search
   * box's button is the one exemption, or every search would need approval.
   */
  const SEARCH_RE = /\b(search|find|go|filter|поиск|найти|искать)\b/i;
  const submitsForm = (tag: string, attrs: Record<string, string>, path: string, text: string): boolean => {
    const t = tag.toLowerCase();
    const type = (attrs.type ?? '').toLowerCase();
    const inForm = /(^|\/)form\b/i.test(path);
    const isSubmit = ((t === 'button' || t === 'input') && type === 'submit') || (t === 'button' && !type && inForm);
    if (!isSubmit) return false;
    const words = [text, attrs['aria-label'], attrs.name, attrs.id, attrs.value].filter(Boolean).join(' ');
    return !SEARCH_RE.test(words);
  };

  const fromAttrs = (tag: string, attrs: Record<string, string>, path: string, text: string): Target => ({
    label: FIELD_ATTRS.map(a => attrs[a])
      .filter(Boolean)
      .join(' '),
    signature: [tag, path, ...FIELD_ATTRS.map(a => attrs[a] ?? ''), text.slice(0, 60)].join('|'),
    submits: submitsForm(tag, attrs, path, text),
    name: (text || attrs['aria-label'] || attrs.value || tag).slice(0, 60),
  });

  /** undefined = the action has no element target; null = it has one but it could not be read. */
  const resolveTarget = async (
    actionName: string,
    args: Record<string, unknown>,
  ): Promise<Target | null | undefined> => {
    const byIndex = INDEX_ACTIONS.has(actionName);
    const byLabel = actionName === 'fill_field_by_label';
    const byCoord = COORD_ACTIONS.has(actionName);
    if (!byIndex && !byLabel && !byCoord) return undefined;
    try {
      if (byCoord) {
        const x = Number(args.x ?? args.from_x);
        const y = Number(args.y ?? args.from_y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
        const page = await context.browserContext.getCurrentPage();
        const el = await page.describeElementAtImageCoord(x, y);
        return el ? fromAttrs(el.tag, el.attributes, el.path, el.text) : null;
      }
      const st = await context.browserContext.getState(false);
      const node = byIndex
        ? typeof args.index === 'number'
          ? st.selectorMap?.get(args.index)
          : undefined
        : findFieldByLabel(st, String(args.label ?? ''), Number(args.nth ?? 1));
      if (!node) return null;
      const text = actionName === 'click_element' ? (node.getAllTextTillNextClickableElement?.(2) ?? '') : '';
      return fromAttrs(node.tagName ?? '', node.attributes ?? {}, node.xpath ?? '', text);
    } catch {
      return null;
    }
  };

  /** Arguments that are positions, not meaning: replaced by the element signature in the memory key. */
  const POSITIONAL = new Set([
    'intent',
    'index',
    'x',
    'y',
    'from_x',
    'from_y',
    'to_x',
    'to_y',
    'label',
    'nth',
    'xpath',
  ]);
  const meaningArgs = (args: Record<string, unknown>): string =>
    JSON.stringify(
      Object.keys(args)
        .filter(k => !POSITIONAL.has(k))
        .sort()
        .map(k => [k, args[k]]),
    );

  return async (actionName, input) => {
    let args = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
    const target = await resolveTarget(actionName, args);
    if (target) {
      // The model's own label (fill_field_by_label) is kept next to the
      // element's attributes, so either one can trip the credential rule.
      const modelLabel = typeof args.label === 'string' ? args.label : '';
      args = { ...args, label: [modelLabel, target.label].filter(Boolean).join(' ') };
    }

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
    if (
      !decision.requiresApproval &&
      target?.submits &&
      (actionName === 'click_element' || actionName === 'click_at')
    ) {
      decision = {
        requiresApproval: true,
        reason: 'sensitive_action',
        risk: 'high',
        summary: `Clicking "${target.name}" submits a form.`,
      };
    }
    if (!decision.requiresApproval && target === null && FIELD_WRITE_ACTIONS.has(actionName)) {
      // Could not see which field this types into: ask, never assume it is harmless.
      decision = {
        requiresApproval: true,
        reason: 'sensitive_action',
        risk: 'medium',
        summary: `Could not identify the field "${actionName}" would type into. Approve only if it is not a password, card or ID field.`,
      };
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

    // Permission posture (CLAUDE.md § Permission posture): «Full access» skips
    // approval prompts. It never lifts the credential refusal above — that is
    // a hand-off, not a question.
    const permissionMode = (await generalSettingsStore.getSettings()).permissionMode;
    if (permissionMode === 'full') {
      logger.info(`approval skipped (permissionMode=full): ${actionName}`);
      return { proceed: true };
    }

    const memoryKey = `${actionName}|${await currentHost()}|${target ? target.signature : ''}|${meaningArgs(args)}`;
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
