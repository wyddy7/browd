/**
 * runReactAgent — LangGraph.js **Plan-and-Execute** agent with per-subgoal
 * ReAct inner loops. This is the unified-mode entry point. The naming
 * is historical: T2d (`833f84d`) shipped a solo `createReactAgent` that
 * terminated on the first no-tool-call AIMessage — even mid-task — and
 * T2f-replan (May 2026) wrapped it in a Plan-and-Execute StateGraph
 * because that failure mode is unrecoverable without an outer
 * orchestrator. The filename and `runReactAgent` symbol stayed for
 * stability; the architecture changed.
 *
 * Outer loop (StateGraph below): planner → agent → replanner ⇄ agent → END.
 *   - planner: structured-output decomposition into 1-7 subgoals plus
 *     `taskParameters` (urls/queries/names) captured verbatim from the
 *     user request — schema-enforced, so subgoal-abstraction drift cannot
 *     erase concrete inputs.
 *   - agent: invokes a fresh `createReactAgent` per subgoal via
 *     `runReactStep`. Subgoal scope = single createReactAgent.invoke()
 *     with its own `MemorySaver`. Inner `recursionLimit: 25`.
 *   - replanner: reads pastSteps, decides END (with final response) or
 *     continue (with rewritten remaining plan). Repeated-failure guard
 *     finishes honestly with partial result after N `failed:` subgoals.
 *
 * Inner loop (per subgoal, via `createReactAgent` from
 * `@langchain/langgraph/prebuilt`): standard ReAct — LLM call →
 * tool dispatch (`langGraphAdapter` wraps each `Action` as a LangChain
 * tool with budget caps + dupGuard) → state-message rebuild via
 * `stateModifier`, repeat until no-tool-call AIMessage (subgoal done)
 * or recursionLimit (subgoal aborts).
 *
 * Why Plan-and-Execute is provisional (slated for migration):
 *   - Industry 2026 has moved to single-loop `create_agent` +
 *     middleware + schema-forced terminal/replan tools — see
 *     `auto-docs/for-development/agents/multi-agent.md` and
 *     `auto-docs/browd-agent-evolution.md` active tier T2x.
 *   - Until that migration ships, P&E persists as the safety-net
 *     architecture: it works on weaker models (Gemini-flash class)
 *     where solo createReactAgent's no-tool-call exit is too eager.
 *
 * Stuck coverage (after T2x phase 0a/0b removed subgoal-level
 * guards — see anti-patterns.md §9):
 *   - dupGuard in `tools/langGraphAdapter.ts` — identical
 *     (tool, args) 3-in-5 → forcing error string to the LLM.
 *   - LangGraph `recursionLimit` (inner 25, outer ~50) — hard cap.
 *   - T2p-3 recursion-limit soft-fail — distinguishes inner-loop
 *     budget exhaustion with progress (→ `partial:` to replanner)
 *     from genuine stuck (→ rethrow → graceful TASK_FAIL).
 *   - Schema-forced terminal via `task_complete` action +
 *     `findTaskCompleteAnswer` scan covering ToolMessage prefix,
 *     LangChain-canonical tool_calls, and raw OpenAI tool_calls
 *     (T2x phase 0c).
 */
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { MemorySaver, StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { HumanMessage, AIMessage, SystemMessage, ToolMessage, BaseMessage } from '@langchain/core/messages';
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
import { computeStateFingerprint, isInnerRecursionLimitError } from '../guardrails/unifiedStuckDetector';
import { TabGoneError } from '@src/background/browser/views';
import { bridgeStreamEvents, type LiveEvent } from './streamBridge';

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
 * Extract the last AIMessage's text content as the final answer. LangGraph
 * terminates when the LLM emits an AIMessage without tool_calls; that
 * message's content is the natural-language answer.
 */
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

/**
 * T2x phase 0c — find a `task_complete(response=…)` call across the
 * three shapes a provider might leave it in. Returns the answer
 * wrapped in `TASK_COMPLETE: ` so the caller can pattern-match the
 * prefix exactly like the legacy ToolMessage path.
 *
 * Shape 1 — ToolMessage.content already prefixed (action handler's
 *   ActionResult.extractedContent path, normal LangChain.js flow).
 * Shape 2 — AIMessage.tool_calls (LangChain-canonical slot, populated
 *   when the provider's tool-call output is normalised).
 * Shape 3 — AIMessage.additional_kwargs.tool_calls[i].function
 *   (raw OpenAI/OpenRouter format, sometimes left un-normalised by
 *   provider adapters — Gemini-2.5-flash via OpenRouter does this).
 */
export function findTaskCompleteAnswer(messages: BaseMessage[]): string | null {
  for (const m of messages) {
    // Shape 1: ToolMessage with prefix.
    if (m instanceof ToolMessage) {
      const c = m.content;
      const text = typeof c === 'string' ? c : '';
      if (text.startsWith('TASK_COMPLETE: ')) return text;
    }
    if (!(m instanceof AIMessage)) continue;
    // Shape 2: AIMessage.tool_calls (LangChain-canonical).
    if (Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) {
        if (tc?.name === 'task_complete' && tc.args && typeof tc.args === 'object') {
          const r = (tc.args as { response?: unknown }).response;
          if (typeof r === 'string' && r.length > 0) return `TASK_COMPLETE: ${r}`;
        }
      }
    }
    // Shape 3: additional_kwargs.tool_calls[i].function (raw OpenAI shape).
    const kwargs = (m as { additional_kwargs?: { tool_calls?: unknown } }).additional_kwargs;
    if (kwargs && Array.isArray(kwargs.tool_calls)) {
      for (const tc of kwargs.tool_calls as Array<{ function?: { name?: string; arguments?: string } }>) {
        if (tc?.function?.name === 'task_complete' && typeof tc.function.arguments === 'string') {
          try {
            const parsed = JSON.parse(tc.function.arguments) as { response?: unknown };
            if (typeof parsed.response === 'string' && parsed.response.length > 0) {
              return `TASK_COMPLETE: ${parsed.response}`;
            }
          } catch {
            // fall through — malformed args, ignore this tool_call
          }
        }
      }
    }
  }
  return null;
}

function extractFinalAnswer(messages: BaseMessage[]): string | null {
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
  const checkpointer = new MemorySaver();
  const baseSystemPrompt = visionMode === 'off' ? reactSystemPromptTemplate : buildReactVisionPrompt();

  // T2f-plan — minimal Plan-and-Execute pattern from LangGraph docs
  // (https://langchain-ai.github.io/langgraphjs/tutorials/plan-and-execute/).
  // One structured-output LLM call BEFORE the ReAct loop produces a
  // 1-7 step plan; the plan is emitted to the side panel as a
  // Planner message and pinned to the system prompt so the ReAct
  // agent treats it as the spine of execution. We deliberately do
  // not run the full replan-loop variant yet — the up-front plan
  // alone closes the "thrashing past 30 steps" failure mode in the
  // 2026-05-02 LinkedIn trace.
  // T2f-final-fix-2 — accumulate token usage via LangChain callback so
  // every LLM end (planner / agent steps / replanner) feeds the ring.
  let cumulativeIn = 0;
  let cumulativeOut = 0;
  const usageCallback = {
    handleLLMEnd: (output: unknown) => {
      const o = output as {
        llmOutput?: {
          tokenUsage?: { promptTokens?: number; completionTokens?: number };
          usage?: { input_tokens?: number; output_tokens?: number };
        };
        generations?: Array<
          Array<{
            message?: {
              usage_metadata?: { input_tokens?: number; output_tokens?: number };
              response_metadata?: { usage?: { input_tokens?: number; output_tokens?: number } };
            };
          }>
        >;
      };
      const fromLlmOutput = o.llmOutput?.tokenUsage
        ? { input: o.llmOutput.tokenUsage.promptTokens ?? 0, output: o.llmOutput.tokenUsage.completionTokens ?? 0 }
        : o.llmOutput?.usage
          ? { input: o.llmOutput.usage.input_tokens ?? 0, output: o.llmOutput.usage.output_tokens ?? 0 }
          : null;
      let dIn = fromLlmOutput?.input ?? 0;
      let dOut = fromLlmOutput?.output ?? 0;
      if (!dIn && !dOut && Array.isArray(o.generations)) {
        for (const generation of o.generations) {
          for (const item of generation) {
            const u = item.message?.usage_metadata ?? item.message?.response_metadata?.usage;
            if (u) {
              dIn += u.input_tokens ?? 0;
              dOut += u.output_tokens ?? 0;
            }
          }
        }
      }
      if (dIn || dOut) {
        cumulativeIn += dIn;
        cumulativeOut += dOut;
        logger.info(`usage tick: +${dIn} in / +${dOut} out (cum ${cumulativeIn}/${cumulativeOut})`);
      }
    },
  };
  // T2m-observability — sibling handler that logs LLM/chain/tool
  // lifecycle events. Kept separate from `usageCallback` so token
  // accounting (cumulative ring telemetry) and lifecycle logging
  // (start/end/error/streaming progress + TRACE rows) stay
  // separable. Both are registered in the StateGraph and per-step
  // ReAct `callbacks:` arrays below.
  const observabilityCallback = createObservabilityCallback({ taskId: context.taskId });
  const emitUsage = () => {
    if (cumulativeIn || cumulativeOut) {
      context.emitEvent(
        Actors.SYSTEM,
        ExecutionState.TASK_USAGE,
        JSON.stringify({
          inputTokens: cumulativeIn,
          outputTokens: cumulativeOut,
          contextWindow: input.contextWindow ?? 100_000,
        }),
      );
    } else {
      logger.warning('no token usage observed — provider may not expose usage_metadata; ring will stay empty');
    }
  };

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
      .max(2000)
      .nullable()
      .describe(
        'final answer to the user (only when decision=finish, null when continue). Keep it under 2000 characters; do NOT repeat sentences.',
      ),
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
    return `${baseSystemPrompt}\n<original-user-task>\n${task}\n</original-user-task>${paramsBlock}\n<current-subgoal>\nFocus on this single subgoal of the larger user task:\n${currentStep}\n\nIf the subgoal text refers to "the provided URL" / "the requested term" / similar abstractions, ALWAYS resolve them by re-reading the original user task above and the <task-parameters> block. Do not invent parameters from memory or the current tab.\n\n${overlayNudge}\n\nFinish this subgoal with at most a few tool calls, then write a brief description of what you achieved. Do NOT solve the entire user task in one go — the orchestrator will pick the next subgoal.\n</current-subgoal>${completedBlock}`;
  };

  const runReactStep = async (
    currentStep: string,
    completed: Array<[string, string]>,
    stepIndex: number,
    params: PlanType['taskParameters'],
    fpStart: string | null,
  ): Promise<{ finalAnswer: string }> => {
    const stepSystemPrompt = buildSystemPromptForStep(currentStep, completed, params);
    const agent = createReactAgent({
      llm,
      tools,
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
              `Original user task:\n${task}\n\nCurrent subgoal:\n${currentStep}\n\nExecute the current subgoal only. Resolve any abstract reference in the subgoal text (e.g. "the provided URL", "the requested term") by re-reading the original user task above.`,
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
      // outer catch flips innerRecursionExhausted), different → real
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
      return { finalAnswer: `partial: ${summary}` };
    }
    // T2w (T2x phase 0c — robust) — scan for the `task_complete`
    // sentinel across THREE shapes the underlying provider might use:
    //   1. ToolMessage.content prefixed `TASK_COMPLETE: ` — what the
    //      action handler emits via ActionResult.extractedContent.
    //   2. AIMessage.tool_calls[i].name === 'task_complete' — the
    //      LangChain-canonical normalised slot.
    //   3. AIMessage.additional_kwargs.tool_calls[i].function — raw
    //      OpenAI/OpenRouter format that some providers populate
    //      without normalising to (2). Test25 (Gemini-2.5-flash via
    //      OpenRouter, 2026-05-16) showed the prefix scan alone is
    //      not enough — the model called `task_complete` twice with
    //      a valid `response` arg but the ToolMessage shape didn't
    //      trigger the prefix match, so the agent burned more rounds
    //      until the replanner forced a finish.
    // Whichever shape lands first wins. The returned `finalAnswer`
    // keeps the `TASK_COMPLETE: ` prefix so agentNode can route to
    // END via state.response, bypassing the replanner.
    const taskCompleteAnswer = findTaskCompleteAnswer(stepResult.messages);
    return {
      finalAnswer: taskCompleteAnswer ?? extractFinalAnswer(stepResult.messages) ?? 'no observable result',
    };
  };

  // ---- StateGraph definition (planner → agent → replanner) ----

  const PlanExecuteState = Annotation.Root({
    plan: Annotation<string[]>({ reducer: (_, n) => n, default: () => [] }),
    pastSteps: Annotation<Array<[string, string]>>({
      reducer: (cur, n) => [...cur, ...n],
      default: () => [],
    }),
    response: Annotation<string | null>({ reducer: (_, n) => n, default: () => null }),
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

  const agentNode = async (state: typeof PlanExecuteState.State) => {
    if (state.plan.length === 0) {
      return { response: 'no remaining plan steps' };
    }
    // T2u-runaway-loop — short-circuit the node body if the user
    // has already pressed Stop OR a previous probe noticed the
    // agent tab is gone. Without this, the `fpStart` and post-step
    // `fpNow` probes below kept calling `getState()` after abort,
    // which hammered a dead tab and generated tens of thousands of
    // log lines per second in the SW console. Returning a
    // `response` routes the StateGraph straight to END; the outer
    // catch in `runReactAgent` classifies the abort/dead-tab case
    // by inspecting `context.stopped` separately.
    if (context.controller.signal.aborted || context.stopped) {
      return { response: 'cancelled' };
    }
    if (context.browserContext.agentTabId() === null && state.pastSteps.length > 0) {
      // Once we've started a task, `agentTabId` becoming `null`
      // mid-run means `handleTabGone` evicted it — bail rather
      // than spin on a dead tab. Skipped at step 0 because the
      // tab is opened lazily on first navigation.
      return { response: 'agent tab is no longer reachable' };
    }
    const currentStep = state.plan[0];
    const remainingAfter = state.plan.slice(1);
    logger.info(`executing subgoal ${state.pastSteps.length + 1}: ${currentStep}`);
    // T2f-plan-pinned-live: emit IN-PROGRESS for the current step
    // BEFORE running it. Without this the checklist sits frozen
    // throughout the entire runReactStep (multiple LLM rounds + tool
    // calls), so the user sees no movement for 10–30 seconds.
    emitPlanChecklist([
      ...state.pastSteps.map(([s]) => ({ text: s, done: true })),
      { text: currentStep, done: false, inProgress: true },
      ...remainingAfter.map(s => ({ text: s, done: false })),
    ]);
    // T2p-3 — capture page fingerprint BEFORE entering the inner ReAct
    // loop. Passed through to runReactStep so its catch block can
    // compare against the post-exhaustion fingerprint and distinguish
    // "burned budget on a frozen page" (real stuck) from "burned budget
    // mid-progress" (soft-fail with partial). Wrapped in try/catch
    // because a probe failure must NOT abort the subgoal — we fall
    // back to `null` and the inner catch treats that as
    // conservative-stuck.
    let fpStart: string | null = null;
    let tabGoneOnFpStart = false;
    try {
      const liveState = await context.browserContext.getState(false);
      fpStart = computeStateFingerprint(liveState);
    } catch (err) {
      // T2u-runaway-loop — if the tab vanished before we even
      // entered the inner ReAct loop there is nothing left to do
      // for this subgoal. Set a flag so the post-step block below
      // short-circuits straight to a graceful "tab gone" response
      // rather than re-probing the dead tab.
      const msg = err instanceof Error ? err.message : String(err);
      if (err instanceof TabGoneError || /No tab with id|No frame with id/i.test(msg)) {
        logger.warning(`fp_start probe saw tab gone (${msg}); will end subgoal gracefully`);
        tabGoneOnFpStart = true;
      } else {
        logger.warning('fp_start probe failed; recursion-limit soft-fail will treat as stuck', err);
      }
      fpStart = null;
    }
    if (tabGoneOnFpStart) {
      emitPlanChecklist([
        ...state.pastSteps.map(([s]) => ({ text: s, done: true })),
        { text: currentStep, done: false },
        ...remainingAfter.map(s => ({ text: s, done: false })),
      ]);
      return {
        pastSteps: [[currentStep, 'failed: agent tab is no longer available'] as [string, string]],
        response: 'The agent tab is no longer available (closed or crashed). Run ended.',
      };
    }
    let stepResult: string;
    let innerRecursionExhausted = false;
    try {
      const stepOut = await runReactStep(
        currentStep,
        state.pastSteps,
        state.pastSteps.length,
        state.taskParameters,
        fpStart,
      );
      stepResult = stepOut.finalAnswer;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warning(`subgoal "${currentStep}" failed: ${msg}`);
      stepResult = `failed: ${msg}`;
      // T2p-2: when the inner createReactAgent exhausts its own
      // recursionLimit, the subgoal burned ~25 LLM rounds emitting
      // tool calls with no progress (typical: isTrusted=false antibot
      // wall on click_at). Treat it as a structural reasoning failure
      // and short-circuit the outer StateGraph immediately, BEFORE
      // the replanner takes another swing and burns another 25
      // rounds under a new subgoal description.
      if (isInnerRecursionLimitError(msg)) {
        innerRecursionExhausted = true;
      }
    }
    // Post-subgoal terminal-condition check. Two paths can force an
    // immediate stop here:
    //   1. T2p-2: the inner createReactAgent exhausted its recursion
    //      budget AND fp_start == fp_now (no progress) — surface as
    //      a clean "stuck inside one step" message to the user.
    //   2. T2u: user pressed Stop OR the agent tab is gone — short
    //      out before `getState()` re-triggers DOM probes on a dead
    //      tab. (Tab-gone is checked again below via a probe.)
    // The previous subgoal-level stuck detector (silent-step +
    // env-fingerprint) was deleted in T2x phase 0a/0b — see
    // `auto-docs/for-development/agents/anti-patterns.md` §9.
    // Remaining stuck coverage: dupGuard at the tool layer +
    // LangGraph recursionLimit + the schema-forced terminal
    // `task_complete` tool below.
    let stuckResponse: string | null = null;
    if (innerRecursionExhausted) {
      const partial = state.pastSteps.map(([s, r]) => `- ${s}: ${r}`).join('\n');
      stuckResponse = `I'm stopping because the agent got stuck inside one step: it burned the inner recursion budget on "${currentStep}" without making progress (usually means the target page silently blocks automated clicks).\n\nWhat I did so far:\n${partial || '(no completed subgoals)'}\n\nTry rephrasing the task, opening the target page yourself, or switching to legacy agent mode in Settings.`;
    } else if (context.controller.signal.aborted || context.stopped) {
      stuckResponse = 'cancelled';
    } else {
      // Tab-gone probe — `getState()` throws TabGoneError when the
      // agent tab has been closed/crashed. Surface a clean response
      // so `decide` routes to END instead of feeding the replanner
      // a dead tab.
      try {
        await context.browserContext.getState(false);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (err instanceof TabGoneError || /No tab with id|No frame with id/i.test(msg)) {
          logger.warning(`agentNode probe saw tab gone; ending run gracefully: ${msg}`);
          stuckResponse = 'The agent tab is no longer available (closed or crashed). Run ended.';
        } else {
          logger.warning('agentNode post-subgoal probe failed; continuing', err);
        }
      }
    }
    // After the step: flip current to done unless it came back as a
    // "failed:..." marker OR a "partial:..." marker (T2p-3 soft-fail
    // when the inner loop exhausted its recursion budget mid-progress).
    // In both cases the replanner picks up from the pastSteps entry and
    // decides END or CONTINUE. T2w — a `TASK_COMPLETE: ` prefix means
    // the agent explicitly called the sentinel termination action;
    // strip the prefix, mark the subgoal done, and short-circuit to
    // END via state.response (bypasses the replanner entirely).
    const taskCompleteMatch = stepResult.startsWith('TASK_COMPLETE: ')
      ? stepResult.slice('TASK_COMPLETE: '.length)
      : null;
    const stepIsDone =
      taskCompleteMatch !== null || (!stepResult.startsWith('failed:') && !stepResult.startsWith('partial:'));
    emitPlanChecklist([
      ...state.pastSteps.map(([s]) => ({ text: s, done: true })),
      { text: currentStep, done: stepIsDone },
      ...remainingAfter.map(s => ({ text: s, done: false })),
    ]);
    const update: { pastSteps: Array<[string, string]>; response?: string } = {
      pastSteps: [[currentStep, stepResult] as [string, string]],
    };
    if (taskCompleteMatch !== null) update.response = taskCompleteMatch;
    else if (stuckResponse !== null) update.response = stuckResponse;
    return update;
  };

  const replannerNode = async (state: typeof PlanExecuteState.State) => {
    const remaining = state.plan.slice(1);
    const completedBlock = state.pastSteps.map(([s, r]) => `- ${s} → ${r}`).join('\n');
    const remainingBlock = remaining.length ? remaining.join('\n') : '(none)';
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
      const finishedSubgoals = state.pastSteps.filter(([, r]) => !r.startsWith('failed:')).map(([s]) => s);
      const failedSubgoal = tail[0][0];
      emitPlanChecklist([
        ...finishedSubgoals.map(s => ({ text: s, done: true })),
        { text: `${failedSubgoal} (blocked)`, done: false },
      ]);
      return {
        response: `I made progress on the task but hit a wall on "${failedSubgoal}" — three consecutive attempts failed (likely blocked by the site's anti-automation behaviour, e.g. unresponsive buttons or rate-limiting).\n\nWhat I did manage:\n${partial || '(no completed subgoals)'}\n\nIf you want, I can try a different approach (constructing the URL directly, switching tabs, or simpler manual-style navigation).`,
      };
    }
    try {
      const result = (await replanner.invoke([
        new SystemMessage(
          `You are the replanner half of a browser-agent loop. After each executed subgoal, decide whether the user's task is now sufficiently answered (decision="finish" + response), or whether more subgoals are needed (decision="continue" + plan with the remaining steps, possibly rewritten). Keep the plan focused — do not invent new subgoals when the task is essentially done. If the executor reports a step "failed:", do not blindly retry — replan around the failure or finalise honestly.`,
        ),
        new HumanMessage(
          `User task:\n${task}\n\nCompleted so far:\n${completedBlock}\n\nRemaining plan:\n${remainingBlock}\n\nDecide: continue with new plan, or finish with a response to the user.`,
        ),
      ])) as z.infer<typeof replanSchema>;
      if (result.decision === 'finish' && result.response) {
        emitPlanChecklist(state.pastSteps.map(([s]) => ({ text: s, done: true })));
        return { response: result.response };
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
        ...state.pastSteps.map(([s]) => ({ text: s, done: true })),
        ...newPlan.map(s => ({ text: s, done: false })),
      ];
      emitPlanChecklist(items);
      if (newPlan.length === 0) {
        return { response: 'planner exhausted with no remaining steps' };
      }
      return { plan: newPlan };
    } catch (err) {
      logger.warning('replanner failed; defaulting to remaining plan or finishing', err);
      if (remaining.length === 0) {
        return { response: state.pastSteps.map(([, r]) => r).join('\n\n') || 'task complete' };
      }
      return { plan: remaining };
    }
  };

  const decide = (state: typeof PlanExecuteState.State): typeof END | 'agent' => {
    return state.response ? END : 'agent';
  };

  const graph = new StateGraph(PlanExecuteState)
    .addNode('planner', plannerNode)
    .addNode('agent', agentNode)
    .addNode('replanner', replannerNode)
    .addEdge(START, 'planner')
    .addEdge('planner', 'agent')
    .addEdge('agent', 'replanner')
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

  // T2v — `streamEvents(v2)` replaces batch `invoke()` so silence is a real abnormal signal.
  const emitLive = (msg: LiveEvent) => context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_LIVE, JSON.stringify(msg));
  try {
    const finalState = await bridgeStreamEvents<typeof PlanExecuteState.State>(
      compiled.streamEvents({}, { ...config, version: 'v2' }),
      emitLive,
      context.controller.signal,
    );
    emitLive({ kind: 'idle' });
    emitUsage();
    const finalAnswer =
      finalState.response ??
      (finalState.pastSteps.length > 0 ? finalState.pastSteps[finalState.pastSteps.length - 1][1] : null);
    if (finalAnswer) {
      context.finalAnswer = finalAnswer;
      context.emitEvent(Actors.PLANNER, ExecutionState.STEP_OK, finalAnswer);
      context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, finalAnswer);
      return { finalAnswer, error: null };
    }
    const msg = 'Agent terminated without producing an answer';
    context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, msg);
    return { finalAnswer: null, error: msg };
  } catch (err) {
    emitLive({ kind: 'idle' });
    emitUsage();
    const message = err instanceof Error ? err.message : String(err);
    if (context.stopped || message.includes('aborted')) {
      context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, 'Task cancelled');
      return { finalAnswer: null, error: 'cancelled' };
    }
    logger.error('runReactAgent failed', err);
    context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, message);
    return { finalAnswer: null, error: message };
  }
}
