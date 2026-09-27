/**
 * Unified Plan-and-Execute runtime. Nonterminal subgoal summaries go to the
 * replanner; a typed TaskOutcome ends the graph immediately. task_complete is
 * a returnDirect tool: from the last planned subgoal it ends the task; from an
 * earlier one it is a proposal the replanner confirms or sends back to work.
 * An accepted answer is delivered verbatim, never rewritten. Tool budgets and
 * recursion limits bound unfinished work.
 */
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { MemorySaver, StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { HumanMessage, AIMessage, SystemMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';
import type { AgentContext } from '../types';
import type { Action } from '../actions/builder';
import { actionsToTools, DEFAULT_TOOL_BUDGETS } from '../tools/langGraphAdapter';
import { reactSystemPromptTemplate } from '../prompts/react';
import { buildReactVisionPrompt } from '../prompts/reactVision';
import { extractForms, formatFormsForPrompt } from '@src/background/browser/dom/forms';
import { wrapUntrustedContent } from '../messages/utils';
import { Actors, ExecutionState } from '../event/types';
import { createLogger } from '@src/background/log';
import { createObservabilityCallback } from './observabilityCallback';
import { createUsageTracker } from './usageTracker';
import { computeStateFingerprint, isInnerRecursionLimitError } from '../guardrails/unifiedStuckDetector';
import { TabGoneError } from '@src/background/browser/views';
import { bridgeStreamEvents, type LiveEvent } from './streamBridge';
import { readTaskCompletion, TaskToolNode, InvalidTaskToolBatchError, type TaskOutcome } from '../taskOutcome';

const logger = createLogger('runReactAgent');

/**
 * T2h — chat-history persistence in unified state.
 *
 * `runReactAgent` builds a fresh `MemorySaver` on every invocation
 * (LangGraph's checkpointer is process-local and tied to this closure),
 * so cross-task memory has to be re-seeded explicitly. The side panel
 * already keeps a persistent transcript in `chatHistoryStore`; on each
 * `new_task` / `follow_up_task` it forwards the relevant prior turns as
 * `PriorMessage[]`. We convert them into `HumanMessage` / `AIMessage`
 * and prepend to the initial `messages` array so the LLM sees the
 * conversation up to this turn instead of starting blank.
 *
 * Tool messages from prior tasks are intentionally NOT included — the
 * DOM that produced them is gone, replaying them would mislead the
 * model. Only finalised user/assistant turns survive.
 */
export interface PriorMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * Convert side-panel chat-history entries into LangGraph
 * `BaseMessage[]`. Exported for unit testing — the real agent loop
 * simply spreads the result into `messages`.
 */
export function priorMessagesToBaseMessages(prior: PriorMessage[]): BaseMessage[] {
  const out: BaseMessage[] = [];
  for (const m of prior) {
    if (!m || typeof m.content !== 'string' || m.content.length === 0) continue;
    if (m.role === 'user') out.push(new HumanMessage(m.content));
    else if (m.role === 'assistant') out.push(new AIMessage(m.content));
  }
  return out;
}

/**
 * Vision routing. Independent of agentMode — only honoured when
 * agentMode='unified' (legacy ignores it). Executor is responsible for
 * runtime degradation when the chosen Navigator model has no vision
 * capability.
 *
 * - 'off' : screenshot tool and coordinate actions are stripped from
 *           the registry. DOM-only surface.
 * - 'on'  : full tool surface — DOM + coord + screenshot +
 *           take_over_user_tab. State messages stay text-only; the
 *           LLM calls `screenshot()` when it wants an image. The
 *           runtime never auto-attaches.
 */
export type RunReactAgentVisionMode = 'off' | 'on';

export interface RunReactAgentInput {
  context: AgentContext;
  llm: BaseChatModel;
  actions: Action[];
  task: string;
  /** Conversation up to (but not including) the current task. Empty for the very first turn of a session. */
  priorMessages?: PriorMessage[];
  /**
   * Vision mode. 'off' strips the screenshot tool and coordinate
   * actions from the registry (DOM-only surface). 'on' exposes the
   * full tool set including `screenshot()` — the LLM decides when an
   * image is worth the tokens. The runtime never auto-attaches.
   */
  visionMode?: RunReactAgentVisionMode;
  /**
   * T2f-final-2 — total context window of the Navigator model in
   * tokens. Forwarded into TASK_USAGE telemetry so the side panel
   * can render the live token ring against an accurate maximum.
   * Default 100_000 if omitted.
   */
  contextWindow?: number;
}

export interface RunReactAgentResult {
  finalAnswer: string | null;
  error: string | null;
}

/**
 * Build a fresh "Page state" HumanMessage from the live browser. Called
 * by stateModifier on every agent step so the LLM always sees current
 * DOM/forms/page text rather than a stale snapshot from task start.
 *
 * Always text-only. Image capture is the LLM's decision, made via the
 * `screenshot()` tool; the runtime no longer auto-attaches images to
 * state messages. Mirrors browser-use / Stagehand / computer-use which
 * all let the agent drive its own perception loop.
 */
async function buildBrowserStateMessage(context: AgentContext): Promise<HumanMessage> {
  // useVision=false: we never capture inside getState; the `screenshot`
  // Action handles all image acquisition and stays inside the regular
  // tracer pipeline for observability.
  const browserState = await context.browserContext.getState(false);
  const elementsText = browserState.elementTree.clickableElementsToString(context.options.includeAttributes);
  const forms = extractForms(browserState);
  const formsSection = formatFormsForPrompt(forms);
  // T2f-untrusted-wrap: page text is untrusted page content (could
  // contain "ignore previous instructions" prompt-injection bait
  // from any site). Wrap it so the LLM treats the contents as data,
  // not instructions. Same treatment as Interactive elements.
  const pageTextSection = browserState.pageText
    ? `## Page readable text\n${wrapUntrustedContent(browserState.pageText)}\n`
    : '';
  const timeStr = new Date().toISOString().slice(0, 16).replace('T', ' ');

  // T2f-tab-iso-1b — split tabs into <agent-tab> (full DOM, the
  // workspace where the agent acts) and <user-tabs> (URL+title only,
  // the user's parallel tabs that the agent must NOT touch unless
  // they call take_over_user_tab). When the agent has its own pinned
  // tab (set via openAgentTab in unified mode), the active tab in
  // browserState IS the agent tab; everything else is user space.
  // In legacy mode the active tab is the user's, so we render the
  // legacy "Current tab" / "Other tabs" sections for back-compat.
  //
  // T2f-tab-iso-1d — sensitive-domain hide: reuse the firewall
  // denyList as the single source of truth for "tabs the agent
  // must not see". Any URL that matches a deny entry is filtered
  // out of <user-tabs> entirely (not even metadata leaks). This
  // also keeps the user from having to maintain a second list.
  const cfg = context.browserContext.getConfig();
  const denyList: string[] = (cfg.deniedUrls ?? []) as string[];
  const isHidden = (url: string) => {
    if (!url) return false;
    const u = url.toLowerCase();
    return denyList.some(entry => entry && u.includes(entry.toLowerCase()));
  };
  const userTabsList = browserState.tabs
    .filter(t => t.id !== browserState.tabId)
    .filter(t => !isHidden(t.url ?? ''))
    .map(t => `- {id: ${t.id}, url: ${t.url}, title: ${t.title}}`);
  const userTabsBlock = userTabsList.length
    ? `<user-tabs note="The user has these tabs open. You may NOT navigate / click / read them without first calling take_over_user_tab(tabId) — doing so disrupts the user's parallel work.">\n${userTabsList.join('\n')}\n</user-tabs>`
    : '<user-tabs>(none)</user-tabs>';

  const wrapped = elementsText ? wrapUntrustedContent(elementsText) : '';
  const agentTabId = context.browserContext.agentTabId();
  const agentTabHeader = agentTabId
    ? `<agent-tab note="This is your dedicated workspace. You can read and interact with it freely.">
id: ${browserState.tabId}, url: ${browserState.url}, title: ${browserState.title}
</agent-tab>`
    : `<active-tab note="No dedicated agent tab — operating in the user's active tab (legacy mode).">
id: ${browserState.tabId}, url: ${browserState.url}, title: ${browserState.title}
</active-tab>`;

  const text = `[Browser state @ ${timeStr}]
${agentTabHeader}
${userTabsBlock}
${pageTextSection}Interactive elements (in your tab):
${wrapped || '(empty page)'}
${formsSection ? `\n${formsSection}\n` : ''}
Current date: ${timeStr}
`;

  return new HumanMessage(text);
}

/**
 * T2p-3 — soft-fail summary on inner-recursion exhaustion WITH progress.
 *
 * Walks `messages` from the end and stitches a 1-2 sentence partial
 * summary out of the last AIMessage text (the agent's most recent
 * reasoning) plus the last ToolMessage name (what it actually did).
 * Exported for unit testing. Does NOT call the LLM — the replanner
 * runs an LLM round next anyway, that's the polishing layer.
 *
 * Returned string is always non-empty; if neither component is present
 * it falls back to a generic "no observable progress" marker. The
 * caller is expected to prefix this with `partial: ` before handing
 * it back to the replanner.
 */
export function extractPartialSummary(messages: BaseMessage[]): string {
  let lastAiText = '';
  let lastToolName = '';
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!lastAiText && m instanceof AIMessage) {
      const content = m.content;
      let text = '';
      if (typeof content === 'string') {
        text = content;
      } else if (Array.isArray(content)) {
        text = content
          .filter(c => typeof c === 'object' && c !== null && 'type' in c && c.type === 'text')
          .map(c => (c as { text: string }).text)
          .join('\n');
      }
      if (text.trim().length > 0) lastAiText = text.trim();
    }
    if (!lastToolName && m instanceof ToolMessage) {
      // ToolMessage carries `.name` for the tool that produced it.
      const name = (m as ToolMessage & { name?: string }).name;
      if (typeof name === 'string' && name.length > 0) lastToolName = name;
    }
    if (lastAiText && lastToolName) break;
  }
  if (!lastAiText && !lastToolName) return 'no observable progress before budget was exhausted';
  if (lastAiText && lastToolName) return `${lastAiText} (last action: ${lastToolName})`;
  if (lastAiText) return lastAiText;
  return `last action: ${lastToolName}`;
}

function extractSubgoalSummary(messages: BaseMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m instanceof AIMessage) {
      // Skip messages that only contain tool calls.
      if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) continue;
      const content = m.content;
      if (typeof content === 'string') return content;
      // Multimodal content: concatenate text parts.
      if (Array.isArray(content)) {
        return content
          .filter(c => typeof c === 'object' && c !== null && 'type' in c && c.type === 'text')
          .map(c => (c as { text: string }).text)
          .join('\n');
      }
    }
  }
  return null;
}

export async function runReactAgent(input: RunReactAgentInput): Promise<RunReactAgentResult> {
  const { context, llm, actions, task, priorMessages } = input;
  const visionMode: RunReactAgentVisionMode = input.visionMode ?? 'off';
  // T2g: per-task tool-call budgets. Counter map lives in this closure
  // so it resets to {} on every runReactAgent invocation; tools wrappers
  // increment before dispatch. Past the configured limit the wrapper
  // returns a forcing error and never calls Action.call. Default caps
  // are tuned for the read-only research tools that have historically
  // driven loop bugs; numbers can be overridden by editing
  // DEFAULT_TOOL_BUDGETS in langGraphAdapter (NOT via the system
  // prompt — that path is unenforceable, see T2e follow-up 77ea382).
  const counters: Record<string, number> = {};
  // T2f-final-fix: consecutive-duplicate guard shared across all
  // tool wrappers — see langGraphAdapter for the threshold logic.
  const dupGuard = { recentKeys: [] as string[] };
  // Tool-gating on visionMode. Two modes:
  //  - 'off': no screenshot, no coordinate tools — pure DOM + read-only
  //    + navigation surface. Used when the Navigator model lacks vision
  //    capability or the user opts out.
  //  - 'on': everything — DOM tools, coordinate tools (which require a
  //    recent screenshot to reason on), the `screenshot()` tool itself,
  //    and `take_over_user_tab`. The LLM picks freely.
  //
  // Coordinate tools: pixel-grounded actions that need a screenshot
  // with grid overlay to target accurately. Off in 'off', on in 'on'.
  // `hitl_click_at` and `drag_at` are coord tools too — same gate.
  const COORDINATE_TOOLS = new Set(['click_at', 'type_at', 'scroll_at', 'hitl_click_at', 'drag_at']);
  // take_over_user_tab only makes sense in unified mode (it bridges
  // agent-tab → user-tab). runReactAgent is the unified entry point,
  // so the tool is always available here — keep the gate explicit
  // for clarity.
  const filteredActions = actions.filter(a => {
    const n = a.name();
    if (n === 'screenshot') return visionMode === 'on';
    if (COORDINATE_TOOLS.has(n)) return visionMode === 'on';
    if (n === 'take_over_user_tab') return true;
    // T2w — `task_complete` is the unified-mode sentinel; `done` is
    // the legacy-only equivalent. Mirror the existing visionMode
    // gate pattern for clarity: keep one, drop the other.
    if (n === 'task_complete') return true;
    if (n === 'done') return false;
    return true;
  });
  const tools = actionsToTools(filteredActions, { counters, limits: DEFAULT_TOOL_BUDGETS }, dupGuard);
  const baseSystemPrompt = visionMode === 'off' ? reactSystemPromptTemplate : buildReactVisionPrompt();

  const { usageCallback, emitUsage } = createUsageTracker(context, input.contextWindow);
  const observabilityCallback = createObservabilityCallback({ taskId: context.taskId });

  // T2f-replan — Plan-and-Execute via LangGraph StateGraph.
  // (https://langchain-ai.github.io/langgraphjs/tutorials/plan-and-execute/)
  //
  // Three nodes:
  //   - planner: produces an initial 1-7 step plan.
  //   - agent: a fresh-thread createReactAgent invocation focused on
  //     ONE subgoal at a time. Returns a short "what was done"
  //     summary, NOT the full message history.
  //   - replanner: looks at completed steps + remaining plan and
  //     either rewrites the plan or finalises the task with a
  //     response to the user.
  //
  // Together this fixes the "model said something and stopped" failure
  // mode of plain createReactAgent — when the agent emits a no-tool-
  // call AIMessage, the replanner gets to decide whether the user
  // task is actually answered or there are more subgoals to do.
  // T2f-task-params: planSchema now extracts a separate
  // taskParameters object so the executor can see concrete URLs /
  // queries / names structurally — not only inside subgoal text.
  // Belt #3 against subgoal-abstraction drift (along with the
  // <original-user-task> block and the HumanMessage echo). Even if
  // the LLM ignores the prompt rule and writes "the provided URL"
  // in a subgoal, the URL itself is still pinned in this object
  // and re-injected into every step's system prompt.
  const planSchema = z.object({
    reasoning: z.string().describe('one-sentence understanding of the task'),
    plan: z.array(z.string().min(3)).min(1).max(7).describe('1-7 concrete subgoals, each in imperative form'),
    taskParameters: z
      .object({
        urls: z.array(z.string()).default([]).describe('every full URL mentioned in the user task'),
        queries: z.array(z.string()).default([]).describe('every search query / keyword the user explicitly named'),
        names: z.array(z.string()).default([]).describe('every concrete name (person, product, repo, address)'),
      })
      .default({ urls: [], queries: [], names: [] })
      .describe('structured copy of the concrete parameters from the user task — extract before writing subgoals'),
  });
  type PlanType = z.infer<typeof planSchema>;
  const replanSchema = z.object({
    decision: z
      .enum(['continue', 'finish'])
      .describe('"continue" if more subgoals are needed, "finish" if the user task is now sufficiently answered.'),
    plan: z
      .array(z.string().min(3))
      .max(7)
      .nullable()
      .describe('updated remaining subgoals (only when decision=continue, null when finish).'),
    response: z
      .string()
      .nullable()
      .describe('the actual final answer, including requested data (only when decision=finish, null when continue)'),
    success: z
      .boolean()
      .nullable()
      .describe('true if the user task is completed, false if blocked/incomplete, null when continue'),
  });

  const planner = llm.withStructuredOutput(planSchema, { name: 'plan' });
  const replanner = llm.withStructuredOutput(replanSchema, { name: 'replan' });

  // emit a checklist update — the side panel renders this as a
  // live checkbox list rather than a static text plan. inProgress
  // is a third state for the currently-executing step (pulsing
  // ring while the executor is mid-step), since done/!done alone
  // hides activity during long single-step subgoals.
  const emitPlanChecklist = (items: { text: string; done: boolean; inProgress?: boolean }[]) => {
    context.emitEvent(Actors.PLANNER, ExecutionState.STEP_OK, JSON.stringify({ type: 'plan', items }));
  };

  // The agent node delegates to a focused createReactAgent — one
  // subgoal per invocation, fresh thread each time so the inner
  // message context stays small (just enough to execute the single
  // step) and counters/dupGuard accumulate across the whole task.
  const buildSystemPromptForStep = (
    currentStep: string,
    completed: Array<[string, string]>,
    params: PlanType['taskParameters'],
  ) => {
    const completedBlock = completed.length
      ? `\n<completed-so-far>\n${completed.map(([s, r]) => `- ${s} → ${r}`).join('\n')}\n</completed-so-far>`
      : '';
    const paramsBlock =
      params.urls.length || params.queries.length || params.names.length
        ? `\n<task-parameters>\nThese are the EXACT concrete parameters the user named in the original task. Use these verbatim — never substitute similar-looking values from training data, current tab state, or chat history.\n${params.urls.length ? `URLs: ${params.urls.map(u => `"${u}"`).join(', ')}\n` : ''}${params.queries.length ? `Queries: ${params.queries.map(q => `"${q}"`).join(', ')}\n` : ''}${params.names.length ? `Names: ${params.names.map(n => `"${n}"`).join(', ')}\n` : ''}</task-parameters>`
        : '';
    // T2n-overlay-handling — single-sentence nudge appended to every
    // per-step prompt. Prompt addition only (no runtime guard, no
    // detector). Caskad-compatible. Addresses the cookie-banner /
    // sign-in modal / paywall blocking content on first render of a
    // new tab or navigation target.
    const overlayNudge =
      'If a modal overlay (cookie banner, newsletter signup, sign-in prompt, paywall dialog) is blocking the content you need, dismiss it first via the available click tool before attempting to extract data from the page.';
    return `${baseSystemPrompt}\n<original-user-task>\n${task}\n</original-user-task>${paramsBlock}\n<current-subgoal>\nFocus on this subgoal of the larger user task:\n${currentStep}\n\nResolve abstract references using the original user task and task parameters above.\n\n${overlayNudge}\n\nIf the entire user task is complete, call task_complete with the actual answer. If only this subgoal is complete and more work remains, return a summary with the concrete findings needed by the next step.\n</current-subgoal>${completedBlock}`;
  };

  const runReactStep = async (
    currentStep: string,
    completed: Array<[string, string]>,
    stepIndex: number,
    params: PlanType['taskParameters'],
    fpStart: string | null,
  ): Promise<{ summary: string; outcome?: TaskOutcome; completion?: TaskOutcome }> => {
    const stepSystemPrompt = buildSystemPromptForStep(currentStep, completed, params);
    const agent = createReactAgent({
      llm,
      tools: new TaskToolNode(tools),
      checkpointSaver: new MemorySaver(),
      stateModifier: async (state: { messages: BaseMessage[] }) => {
        try {
          // The `pendingForceScreenshot` flag set by switchTab /
          // navigateTo is intentionally NOT consumed here. The runtime
          // no longer auto-attaches images — screenshot capture is the
          // LLM's call via the `screenshot()` tool. The flag is left
          // in BrowserContext for a future cookie-overlay / tab-settle
          // tier that may surface a hint to the model instead of
          // bypassing it. Nothing reads the flag for now; that's fine.
          const fresh = await buildBrowserStateMessage(context);
          return [new SystemMessage(stepSystemPrompt), ...state.messages, fresh];
        } catch (err) {
          logger.warning('buildBrowserStateMessage failed; running without fresh state', err);
          return [new SystemMessage(stepSystemPrompt), ...state.messages];
        }
      },
    });
    const stepConfig = {
      configurable: { thread_id: `${context.taskId}-step-${stepIndex}` },
      // Per-step caps: enough room for ~5-10 tool calls per subgoal.
      // Total task budget enforced by the outer StateGraph recursion.
      recursionLimit: 25,
      signal: context.controller.signal,
      callbacks: [usageCallback, observabilityCallback],
    };
    // T2f-plan-context-leak: ship the original task in the
    // HumanMessage so a model that ignores the system prompt's
    // <original-user-task> block still sees parameters in chat
    // context. Belt and braces against subgoal-abstraction drift.
    let stepResult: { messages: BaseMessage[] };
    try {
      stepResult = await agent.invoke(
        {
          messages: [
            new HumanMessage(
              `Original user task:\n${task}\n\nCurrent subgoal:\n${currentStep}\n\nWork on this subgoal. If the entire task is already answered, deliver the result through task_complete.`,
            ),
          ],
        },
        stepConfig,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // T2p-3 — distinguish BUDGET signal from STUCK signal. T2p-2 treated
      // every inner GraphRecursionError as a terminal stuck verdict, but
      // test20 showed the agent often makes real navigation progress and
      // exhausts the 25-round budget just before producing its answer.
      // Compare the page fingerprint captured at agentNode entry against
      // the fingerprint at exhaustion: same → real stuck (rethrow so the
      // outer catch reports a failure), different → observable
      // progress → soft-fail with a "partial:" summary so the replanner
      // can decide END or CONTINUE on the next round.
      if (!isInnerRecursionLimitError(msg)) throw err;
      let fpNow: string | null = null;
      try {
        const liveState = await context.browserContext.getState(false);
        fpNow = computeStateFingerprint(liveState);
      } catch (fpErr) {
        // T2u-runaway-loop — same logic as the fp_start probe. If
        // the tab is gone there is nothing to compare against, so
        // rethrow the original recursion-limit error and let the
        // outer agentNode catch turn it into a clean stop.
        const fpMsg = fpErr instanceof Error ? fpErr.message : String(fpErr);
        if (fpErr instanceof TabGoneError || /No tab with id|No frame with id/i.test(fpMsg)) {
          logger.warning(`fp_now probe saw tab gone (${fpMsg}); rethrowing recursion-limit error`);
          throw err;
        }
        logger.warning('fp_now probe failed during recursion-limit soft-fail check', fpErr);
        fpNow = null;
      }
      // Conservative-stuck path: any null fingerprint means we can't
      // confirm progress, so preserve T2p-2 terminal behaviour.
      if (fpStart === null || fpNow === null || fpNow === fpStart) {
        throw err;
      }
      // Progress confirmed: stitch a partial summary from the
      // checkpointer state. Rethrow if the snapshot is unreadable
      // (we cannot manufacture a useful soft-fail without messages).
      let snapshotMessages: BaseMessage[] = [];
      try {
        const snapshot = await agent.getState(stepConfig);
        const v = (snapshot as { values?: { messages?: BaseMessage[] } }).values;
        if (v && Array.isArray(v.messages)) snapshotMessages = v.messages;
      } catch (snapErr) {
        logger.warning('agent.getState() failed during recursion-limit soft-fail', snapErr);
        throw err;
      }
      const summary = extractPartialSummary(snapshotMessages);
      logger.info(`recursion-limit soft-fail with progress (fp_start≠fp_now) — handing partial to replanner`);
      return { summary: `partial: ${summary}` };
    }
    const read = readTaskCompletion(stepResult.messages);
    if (!read) return { summary: extractSubgoalSummary(stepResult.messages) ?? 'no observable result' };
    // An executed task_complete is the executor's claim that the whole task is
    // done; agentNode decides whether that claim ends the graph. A rejected or
    // malformed call is a terminal failure.
    return read.executed
      ? { summary: read.outcome.response, completion: read.outcome }
      : { summary: read.outcome.response, outcome: read.outcome };
  };

  // ---- StateGraph definition (planner → agent → replanner) ----

  const PlanExecuteState = Annotation.Root({
    plan: Annotation<string[]>({ reducer: (_, n) => n, default: () => [] }),
    pastSteps: Annotation<Array<[string, string]>>({
      reducer: (cur, n) => [...cur, ...n],
      default: () => [],
    }),
    outcome: Annotation<TaskOutcome | null>({ reducer: (current, next) => current ?? next, default: () => null }),
    // An executed task_complete from a subgoal that still had later subgoals
    // planned. Not terminal: the replanner reviews it. Reset by every agent step.
    proposal: Annotation<TaskOutcome | null>({ reducer: (_, next) => next, default: () => null }),
    // T2f-task-params: structured params from the user task, set by
    // the planner once and re-read by every executor step.
    taskParameters: Annotation<PlanType['taskParameters']>({
      reducer: (_, n) => n,
      default: () => ({ urls: [], queries: [], names: [] }),
    }),
  });

  const plannerNode = async () => {
    const messages: BaseMessage[] = [
      new SystemMessage(
        `You are the planner half of a browser-agent loop. Read the user request and decompose it into 1-7 concrete subgoals that an executor with browser tools (click, type, scroll, screenshot, web_search, web_fetch_markdown) will walk in order.

CRITICAL: each subgoal text must be SELF-CONTAINED. Inline every concrete parameter from the user request — full URLs, exact search queries, addresses, person names, file names. NEVER write "the provided URL", "the requested page", "the user's query"; write the actual URL / query / name. The executor sees ONLY the subgoal text on its turn — if you abstract away parameters they are lost and the executor will hallucinate replacements from memory.

Examples of good subgoals:
- "Open https://github.com/wyddy7/browd in a new tab"
- "Search for 'AI Engineer remote' jobs on linkedin.com/jobs"
- "Read the README at the repository root"

Examples of bad (DO NOT WRITE):
- "Open the provided URL" — URL is missing
- "Search the requested term" — term is missing
- "Read the README" without saying which repo

Subgoals should be observable steps — "open X", "find Y on the page", "compare Z". Avoid micro-actions like "wait" or "scroll a bit". If the request is trivial (1-2 actions) emit a short plan; do not pad. If the request is unclear, plan around the most plausible interpretation rather than asking the user.`,
      ),
      ...priorMessagesToBaseMessages(priorMessages ?? []),
      new HumanMessage(task),
    ];
    try {
      const result = (await planner.invoke(messages)) as PlanType;
      logger.info(
        `plan ready: ${result.plan.length} subgoals; params: urls=${result.taskParameters.urls.length}, queries=${result.taskParameters.queries.length}, names=${result.taskParameters.names.length}`,
      );
      emitPlanChecklist(result.plan.map(s => ({ text: s, done: false })));
      return { plan: result.plan, taskParameters: result.taskParameters };
    } catch (err) {
      logger.warning('planner step failed; degrading to single-step plan from raw task', err);
      const fallback = [task];
      emitPlanChecklist(fallback.map(s => ({ text: s, done: false })));
      return { plan: fallback, taskParameters: { urls: [], queries: [], names: [] } };
    }
  };

  const isCancelled = () => context.controller.signal.aborted || context.stopped;
  const cancelledOutcome: TaskOutcome = { status: 'cancelled', response: 'Task cancelled' };
  const failed = (response: string): { outcome: TaskOutcome } => ({ outcome: { status: 'failed', response } });
  const isTabGone = (err: unknown) =>
    err instanceof TabGoneError ||
    /No tab with id|No frame with id/i.test(err instanceof Error ? err.message : String(err));
  const stepSucceeded = (summary: string) => !summary.startsWith('failed:') && !summary.startsWith('partial:');

  const agentNode = async (state: typeof PlanExecuteState.State) => {
    if (isCancelled()) return { outcome: cancelledOutcome };
    if (state.plan.length === 0) return failed('No remaining plan steps and no completed task result.');
    // A tab can be opened lazily on the first step; later eviction is terminal.
    if (context.browserContext.agentTabId() === null && state.pastSteps.length > 0) {
      return failed('The agent tab is no longer reachable.');
    }
    const currentStep = state.plan[0];
    const remainingAfter = state.plan.slice(1);
    const previousItems = state.pastSteps.map(([text, summary]) => ({ text, done: stepSucceeded(summary) }));
    const emitStep = (done: boolean, inProgress = false) =>
      emitPlanChecklist([
        ...previousItems,
        { text: currentStep, done, inProgress },
        ...remainingAfter.map(text => ({ text, done: false })),
      ]);
    logger.info(`executing subgoal ${state.pastSteps.length + 1}: ${currentStep}`);
    emitStep(false, true);

    // Used only to distinguish progress at recursion-budget exhaustion.
    let fpStart: string | null = null;
    try {
      fpStart = computeStateFingerprint(await context.browserContext.getState(false));
    } catch (err) {
      if (isTabGone(err)) {
        emitStep(false);
        return failed('The agent tab is no longer available (closed or crashed). Run ended.');
      }
      logger.warning('Initial state probe failed; recursion exhaustion will fail closed', err);
    }

    let summary: string;
    let outcome: TaskOutcome | undefined;
    let completion: TaskOutcome | undefined;
    try {
      const step = await runReactStep(
        currentStep,
        state.pastSteps,
        state.pastSteps.length,
        state.taskParameters,
        fpStart,
      );
      summary = step.summary;
      outcome = step.outcome;
      completion = step.completion;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      summary = `failed: ${message}`;
      logger.warning(`subgoal "${currentStep}" failed: ${message}`);
      if (isInnerRecursionLimitError(message) || isTabGone(err) || err instanceof InvalidTaskToolBatchError) {
        outcome = { status: 'failed', response: message };
      }
    }

    // task_complete ends the task only from the last planned subgoal. With later
    // subgoals still planned it is a proposal for the replanner to review: in the
    // 2026-09-27 Online-Mind2Web run, subgoal agents called it after subgoal 1
    // with progress reports ("Subgoal complete… Next, …") and those reports
    // became the final answer.
    let proposal: TaskOutcome | null = null;
    if (completion && !outcome) {
      if (remainingAfter.length === 0) outcome = completion;
      else proposal = completion;
    }
    if (isCancelled()) outcome = cancelledOutcome;
    // Accepted completion is final: do not probe the browser or call another model.
    if (!outcome) {
      try {
        await context.browserContext.getState(false);
      } catch (err) {
        if (isTabGone(err)) {
          outcome = {
            status: 'failed',
            response: 'The agent tab is no longer available (closed or crashed). Run ended.',
          };
        } else {
          logger.warning('Post-subgoal state probe failed; continuing', err);
        }
      }
    }
    emitStep(outcome ? outcome.status === 'completed' : stepSucceeded(summary));
    return {
      pastSteps: [[currentStep, summary] as [string, string]],
      proposal: outcome ? null : proposal,
      ...(outcome ? { outcome } : {}),
    };
  };

  const replannerNode = async (state: typeof PlanExecuteState.State) => {
    if (isCancelled()) return { outcome: cancelledOutcome };
    const remaining = state.plan.slice(1);
    const completedBlock = state.pastSteps.map(([s, r]) => `- ${s} → ${r}`).join('\n');
    const remainingBlock = remaining.length ? remaining.join('\n') : '(none)';
    const proposal = state.proposal;
    const proposalBlock = proposal
      ? `\n\nThe executor of the last subgoal called task_complete (success=${proposal.status === 'completed'}) although the plan was not finished. Its proposed final answer:\n<proposed-final-answer>\n${proposal.response}\n</proposed-final-answer>\nIf it fully answers the user task, decide finish with success=true and it is delivered verbatim. If requested work is still undone, decide continue with the subgoals that remain.`
      : '';
    // T2f-final-fix-7 + T2i-fix1.5: repeated-failure guard. If the
    // last N subgoals all came back as "failed:", finish honestly with
    // partial result rather than replan into the same wall. N is
    // user-configurable via Options → General → Max Failures (was a
    // legacy-mode-only setting before T2i-fix1.5; now also gates the
    // unified replanner). Lower bound 2 to keep at least minimal
    // resilience; upper bound enforced by the user-input clamp.
    const failuresCap = Math.max(2, context.options.maxFailures ?? 3);
    const tail = state.pastSteps.slice(-failuresCap);
    if (tail.length === failuresCap && tail.every(([, r]) => r.startsWith('failed:'))) {
      logger.warning(`replanner guard: ${failuresCap} consecutive failed subgoals — finishing with partial result`);
      const partial = state.pastSteps
        .filter(([, r]) => !r.startsWith('failed:'))
        .map(([s, r]) => `- ${s}: ${r}`)
        .join('\n');
      const finishedSubgoals = state.pastSteps.filter(([, r]) => stepSucceeded(r)).map(([s]) => s);
      const failedSubgoal = tail[0][0];
      emitPlanChecklist([
        ...finishedSubgoals.map(s => ({ text: s, done: true })),
        { text: `${failedSubgoal} (blocked)`, done: false },
      ]);
      return failed(
        `The task is incomplete: ${failuresCap} consecutive subgoals failed at "${failedSubgoal}".\n\nPartial results:\n${partial || '(none)'}`,
      );
    }
    try {
      const result = (await replanner.invoke([
        new SystemMessage(
          `You are the replanner half of a browser-agent loop. After a nonterminal subgoal, decide whether more work is needed (decision="continue", plan, response=null, success=null), or deliver the final result (decision="finish", response, success). The response must contain the requested data, not a statement that you presented it elsewhere. Set success=true only when the user's task is completed; use success=false for blocked or incomplete work and explain what remains. Replan around failed steps rather than blindly retrying. When the executor proposes a final answer before the plan is finished, judge it against the user task: a progress report, a located page, or a note about a next step is not a final answer.`,
        ),
        new HumanMessage(
          `User task:\n${task}\n\nCompleted so far:\n${completedBlock}\n\nRemaining plan:\n${remainingBlock}${proposalBlock}\n\nDecide: continue with new plan, or finish with a response to the user.`,
        ),
      ])) as z.infer<typeof replanSchema>;
      if (result.decision === 'finish' && result.success === true && proposal?.status === 'completed') {
        // Confirmed early completion: deliver the executor's answer verbatim.
        emitPlanChecklist(state.pastSteps.map(([text, summary]) => ({ text, done: stepSucceeded(summary) })));
        return { outcome: proposal };
      }
      if (result.decision === 'finish') {
        if (!result.response?.trim() || typeof result.success !== 'boolean') {
          return failed('The replanner ended without a valid task result.');
        }
        emitPlanChecklist(state.pastSteps.map(([text, summary]) => ({ text, done: stepSucceeded(summary) })));
        const outcome: TaskOutcome = { status: result.success ? 'completed' : 'failed', response: result.response };
        return { outcome };
      }
      // T2f-plan-pinned-live: replanner LLM sometimes echoes
      // already-completed subgoals into the new plan ("p1, p2, p3"
      // when only "p2, p3" should remain). Filter out any item that
      // matches a pastSteps entry by exact text — cheap and avoids
      // the "checkbox unflips itself" UX bug.
      const rawNewPlan = result.plan && result.plan.length > 0 ? result.plan : remaining;
      const completedTexts = new Set(state.pastSteps.map(([s]) => s));
      const newPlan = rawNewPlan.filter(s => !completedTexts.has(s));
      const items = [
        ...state.pastSteps.map(([text, summary]) => ({ text, done: stepSucceeded(summary) })),
        ...newPlan.map(s => ({ text: s, done: false })),
      ];
      emitPlanChecklist(items);
      if (newPlan.length === 0) {
        return failed('The plan was exhausted without a completed task result.');
      }
      return { plan: newPlan };
    } catch (err) {
      logger.warning('replanner failed; defaulting to remaining plan or finishing', err);
      if (remaining.length === 0) {
        return failed(
          `The replanner failed before producing a final result.\n\nPartial results:\n${completedBlock || '(none)'}`,
        );
      }
      return { plan: remaining };
    }
  };

  const decide = (state: typeof PlanExecuteState.State): typeof END | 'agent' => {
    return state.outcome ? END : 'agent';
  };

  const graph = new StateGraph(PlanExecuteState)
    .addNode('planner', plannerNode)
    .addNode('agent', agentNode)
    .addNode('replanner', replannerNode)
    .addEdge(START, 'planner')
    .addEdge('planner', 'agent')
    .addConditionalEdges('agent', state => (state.outcome ? END : 'replanner'), { replanner: 'replanner', [END]: END })
    .addConditionalEdges('replanner', decide, { agent: 'agent', [END]: END });
  const compiled = graph.compile();

  const config = {
    // Outer recursion budget: each subgoal ≈ 3 nodes (agent +
    // replanner + edge). recursionLimit caps total node visits so
    // a runaway replan loop still terminates.
    recursionLimit: Math.min(context.options.maxSteps, 50),
    signal: context.controller.signal,
    callbacks: [usageCallback, observabilityCallback],
  };

  const emitLive = (msg: LiveEvent) => context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_LIVE, JSON.stringify(msg));
  const publishOutcome = (outcome: TaskOutcome): RunReactAgentResult => {
    // The pinned checklist describes active work, not proof of task success.
    // Retire it on every terminal path; never tick unexecuted future subgoals.
    emitPlanChecklist([]);
    if (outcome.status === 'completed') {
      context.finalAnswer = outcome.response;
      context.emitEvent(Actors.PLANNER, ExecutionState.STEP_OK, outcome.response);
      context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, outcome.response);
      return { finalAnswer: outcome.response, error: null };
    }
    context.finalAnswer = null;
    const event = outcome.status === 'cancelled' ? ExecutionState.TASK_CANCEL : ExecutionState.TASK_FAIL;
    context.emitEvent(Actors.SYSTEM, event, outcome.response);
    return { finalAnswer: null, error: outcome.status === 'cancelled' ? 'cancelled' : outcome.response };
  };
  try {
    if (isCancelled()) return publishOutcome(cancelledOutcome);
    const finalState = await bridgeStreamEvents<typeof PlanExecuteState.State>(
      compiled.streamEvents({}, { ...config, version: 'v2' }),
      emitLive,
      context.controller.signal,
    );
    return publishOutcome(
      isCancelled()
        ? cancelledOutcome
        : (finalState.outcome ?? {
            status: 'failed',
            response: 'Agent terminated without producing a task result',
          }),
    );
  } catch (err) {
    if (isCancelled()) return publishOutcome(cancelledOutcome);
    const message = err instanceof Error ? err.message : String(err);
    logger.error('runReactAgent failed', err);
    return publishOutcome({ status: 'failed', response: message });
  } finally {
    emitLive({ kind: 'idle' });
    emitUsage();
  }
}
