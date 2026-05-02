/**
 * T2d-3 — runReactAgent: the LangGraph.js entry point that replaces
 * runUnifiedLoop in T2d-4.
 *
 * Contract:
 *   - Build a createReactAgent with the classic Browd Action set
 *     converted to LangGraph tools (via langGraphAdapter).
 *   - On each agent step LangGraph calls the LLM with the running
 *     message history; we inject the latest browser state as the most
 *     recent HumanMessage via `stateModifier` so the LLM sees fresh
 *     interactive elements / forms / page text.
 *   - Tool execution writes to the structured tracer automatically
 *     (Action.call already records, langGraphAdapter delegates to it).
 *   - Termination: LangGraph stops when the LLM emits an AIMessage
 *     with no tool_calls. That AIMessage's content is the final
 *     answer. We surface it as PLANNER+STEP_OK (so side panel renders
 *     it as a chat message, same as classic) and SYSTEM+TASK_OK.
 *   - Failure modes: recursion limit reached → TASK_FAIL with a
 *     "agent could not finish in N steps" summary.
 *
 * Why this beats T2c hand-written runUnifiedLoop:
 *   - No bespoke termination contract — done() and evidence-validation
 *     are deleted entirely. LangGraph's native "no more tool calls"
 *     is the answer signal.
 *   - No multi-action batching ambiguity — LangGraph runs one tool
 *     call at a time per step.
 *   - No JSON schema gymnastics — LLM uses native tool-calling.
 *   - Built-in checkpointer (MemorySaver) for free pause/resume.
 *
 * Read order: auto-docs/browd-agent-evolution.md (Tier 2d).
 */
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { MemorySaver, StateGraph, Annotation, START, END } from '@langchain/langgraph';
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';
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
 * T2f-3: vision routing. Independent of agentMode — only honoured when
 * agentMode='unified' (legacy ignores it). Executor is responsible for
 * runtime degradation when the chosen Navigator model has no vision
 * capability.
 */
export type RunReactAgentVisionMode = 'off' | 'always' | 'fallback';

export interface RunReactAgentInput {
  context: AgentContext;
  llm: BaseChatModel;
  actions: Action[];
  task: string;
  /** Conversation up to (but not including) the current task. Empty for the very first turn of a session. */
  priorMessages?: PriorMessage[];
  /**
   * Vision mode. 'off' (default) is the pre-T2f behaviour. 'always'
   * attaches a fresh screenshot to every state message. 'fallback'
   * leaves state messages text-only but exposes the screenshot()
   * tool so the agent can capture a frame when DOM is insufficient.
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
 * T2f-1.5: vision capture is now decoupled from `getState`. The caller
 * passes a pre-captured screenshot payload (from `screenshotAction.call()`)
 * when visionMode='always'. That keeps the screenshot on the Action.call
 * path so `globalTracer` sees it as a normal `screenshot` tool entry,
 * matching how `'fallback'` already worked. No separate event channel,
 * no second-class observability.
 */
async function buildBrowserStateMessage(
  context: AgentContext,
  screenshot: { base64: string; mime: string } | null,
): Promise<HumanMessage> {
  // Always pass useVision=false here — we either capture independently
  // through the screenshot Action (for visionMode='always') or skip
  // capture entirely (for 'off' / 'fallback'). Doing it both places
  // would double-pay the puppeteer screenshot cost.
  const browserState = await context.browserContext.getState(false);
  const elementsText = browserState.elementTree.clickableElementsToString(context.options.includeAttributes);
  const forms = extractForms(browserState);
  const formsSection = formatFormsForPrompt(forms);
  const pageTextSection = browserState.pageText ? `## Page readable text\n${browserState.pageText}\n` : '';
  const timeStr = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const otherTabs = browserState.tabs
    .filter(t => t.id !== browserState.tabId)
    .map(t => `- {id: ${t.id}, url: ${t.url}, title: ${t.title}}`)
    .join('\n');

  const wrapped = elementsText ? wrapUntrustedContent(elementsText) : '';

  const text = `[Browser state @ ${timeStr}]
Current tab: {id: ${browserState.tabId}, url: ${browserState.url}, title: ${browserState.title}}
Other tabs:
${otherTabs || '  (none)'}
${pageTextSection}Interactive elements:
${wrapped || '(empty page)'}
${formsSection ? `\n${formsSection}\n` : ''}
Current date: ${timeStr}
`;

  if (screenshot) {
    return new HumanMessage({
      content: [
        { type: 'text', text },
        { type: 'image_url', image_url: { url: `data:${screenshot.mime};base64,${screenshot.base64}` } },
      ],
    });
  }
  return new HumanMessage(text);
}

/**
 * Extract the last AIMessage's text content as the final answer. LangGraph
 * terminates when the LLM emits an AIMessage without tool_calls; that
 * message's content is the natural-language answer.
 */
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
  const dupGuard = { lastKey: null as string | null, consecutive: 0 };
  // T2f-3 / T2f-coords: gate vision-only tools on visionMode.
  //  - 'screenshot' belongs to 'fallback' only ('always' captures
  //    via stateModifier, 'off' never).
  //  - coordinate tools (click_at / type_at / scroll_at) belong to
  //    'always' and 'fallback' — they need a fresh screenshot to
  //    reason about, which is exactly what those modes provide.
  //    Without 'always'/'fallback' the LLM cannot see image pixels
  //    and would emit hallucinated coordinates.
  // T2f-handover: hitl_click_at sits next to the regular coord tools
  // — same gating, since the agent needs the screenshot context to
  // pick the (x,y) marker before handing off.
  const COORDINATE_TOOLS = new Set(['click_at', 'type_at', 'scroll_at', 'hitl_click_at']);
  // T2f-replan: in 'always' mode the user's intent is "act through
  // pixels". Physically remove DOM-interaction tools from the registry
  // so the model can't fall back to fragile DOM indices when it gets
  // stuck. Navigation / read-only / screenshot stay available.
  const DOM_INTERACTION_TOOLS = new Set(['click_element', 'input_text', 'fill_field_by_label']);
  const filteredActions = actions.filter(a => {
    const n = a.name();
    if (n === 'screenshot') return visionMode === 'fallback';
    if (COORDINATE_TOOLS.has(n)) return visionMode !== 'off';
    if (DOM_INTERACTION_TOOLS.has(n)) return visionMode !== 'always';
    return true;
  });
  const tools = actionsToTools(filteredActions, { counters, limits: DEFAULT_TOOL_BUDGETS }, dupGuard);
  const checkpointer = new MemorySaver();
  // T2f-1.5: in 'always' mode the agent calls the SAME screenshot
  // Action that 'fallback' exposes — just on its own behalf, every
  // step, before the LLM is invoked. Using Action.call keeps the
  // capture inside the regular tracer pipeline (one entry per step
  // in the trace UI, identical shape to a regular tool call,
  // thumbnail attached automatically).
  const screenshotAction = visionMode === 'always' ? actions.find(a => a.name() === 'screenshot') : undefined;
  const baseSystemPrompt = visionMode === 'off' ? reactSystemPromptTemplate : buildReactVisionPrompt(visionMode);

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
  const planSchema = z.object({
    reasoning: z.string().describe('one-sentence understanding of the task'),
    plan: z.array(z.string().min(3)).min(1).max(7).describe('1-7 concrete subgoals, each in imperative form'),
  });
  const replanSchema = z.object({
    decision: z
      .enum(['continue', 'finish'])
      .describe('"continue" if more subgoals are needed, "finish" if the user task is now sufficiently answered.'),
    plan: z
      .array(z.string().min(3))
      .max(7)
      .optional()
      .describe('updated remaining subgoals (only when decision=continue, omit when finish).'),
    response: z
      .string()
      .max(2000)
      .optional()
      .describe(
        'final answer to the user (only when decision=finish, omit when continue). Keep it under 2000 characters; do NOT repeat sentences.',
      ),
  });

  const planner = llm.withStructuredOutput(planSchema, { name: 'plan' });
  const replanner = llm.withStructuredOutput(replanSchema, { name: 'replan' });

  // emit a checklist update — the side panel renders this as a
  // live checkbox list rather than a static text plan.
  const emitPlanChecklist = (items: { text: string; done: boolean }[]) => {
    context.emitEvent(Actors.PLANNER, ExecutionState.STEP_OK, JSON.stringify({ type: 'plan', items }));
  };

  // The agent node delegates to a focused createReactAgent — one
  // subgoal per invocation, fresh thread each time so the inner
  // message context stays small (just enough to execute the single
  // step) and counters/dupGuard accumulate across the whole task.
  const buildSystemPromptForStep = (currentStep: string, completed: Array<[string, string]>) => {
    const completedBlock = completed.length
      ? `\n<completed-so-far>\n${completed.map(([s, r]) => `- ${s} → ${r}`).join('\n')}\n</completed-so-far>`
      : '';
    return `${baseSystemPrompt}\n<current-subgoal>\nFocus on this single subgoal of the larger user task:\n${currentStep}\n\nFinish this subgoal with at most a few tool calls, then write a brief description of what you achieved. Do NOT solve the entire user task in one go — the orchestrator will pick the next subgoal.\n</current-subgoal>${completedBlock}`;
  };

  const runReactStep = async (
    currentStep: string,
    completed: Array<[string, string]>,
    stepIndex: number,
  ): Promise<string> => {
    const stepSystemPrompt = buildSystemPromptForStep(currentStep, completed);
    const agent = createReactAgent({
      llm,
      tools,
      checkpointSaver: new MemorySaver(),
      stateModifier: async (state: { messages: BaseMessage[] }) => {
        try {
          let screenshotPayload: { base64: string; mime: string } | null = null;
          if (screenshotAction) {
            try {
              const captureResult = await screenshotAction.call({
                intent: 'auto-attach (visionMode=always)',
                gridOverlay: true,
              });
              if (captureResult.imageBase64) {
                screenshotPayload = {
                  base64: captureResult.imageBase64,
                  mime: captureResult.imageMime ?? 'image/jpeg',
                };
              }
            } catch (err) {
              logger.warning('auto screenshot capture failed; continuing without image', err);
            }
          }
          const fresh = await buildBrowserStateMessage(context, screenshotPayload);
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
      callbacks: [usageCallback],
    };
    const stepResult = await agent.invoke({ messages: [new HumanMessage(`Subgoal: ${currentStep}`)] }, stepConfig);
    return extractFinalAnswer(stepResult.messages) ?? 'no observable result';
  };

  // ---- StateGraph definition (planner → agent → replanner) ----

  const PlanExecuteState = Annotation.Root({
    plan: Annotation<string[]>({ reducer: (_, n) => n, default: () => [] }),
    pastSteps: Annotation<Array<[string, string]>>({
      reducer: (cur, n) => [...cur, ...n],
      default: () => [],
    }),
    response: Annotation<string | null>({ reducer: (_, n) => n, default: () => null }),
  });

  const plannerNode = async () => {
    const messages: BaseMessage[] = [
      new SystemMessage(
        `You are the planner half of a browser-agent loop. Read the user request and decompose it into 1-7 concrete subgoals that an executor with browser tools (click, type, scroll, screenshot, web_search, web_fetch_markdown) will walk in order. Subgoals should be observable steps — "open X", "find Y on the page", "compare Z". Avoid micro-actions like "wait" or "scroll a bit". If the request is trivial (1-2 actions) emit a short plan; do not pad. If the request is unclear, plan around the most plausible interpretation rather than asking the user.`,
      ),
      ...priorMessagesToBaseMessages(priorMessages ?? []),
      new HumanMessage(task),
    ];
    try {
      const result = (await planner.invoke(messages)) as z.infer<typeof planSchema>;
      logger.info(`plan ready: ${result.plan.length} subgoals`);
      emitPlanChecklist(result.plan.map(s => ({ text: s, done: false })));
      return { plan: result.plan };
    } catch (err) {
      logger.warning('planner step failed; degrading to single-step plan from raw task', err);
      const fallback = [task];
      emitPlanChecklist(fallback.map(s => ({ text: s, done: false })));
      return { plan: fallback };
    }
  };

  const agentNode = async (state: typeof PlanExecuteState.State) => {
    if (state.plan.length === 0) {
      return { response: 'no remaining plan steps' };
    }
    const currentStep = state.plan[0];
    logger.info(`executing subgoal ${state.pastSteps.length + 1}: ${currentStep}`);
    let stepResult: string;
    try {
      stepResult = await runReactStep(currentStep, state.pastSteps, state.pastSteps.length);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.warning(`subgoal "${currentStep}" failed: ${msg}`);
      stepResult = `failed: ${msg}`;
    }
    return { pastSteps: [[currentStep, stepResult] as [string, string]] };
  };

  const replannerNode = async (state: typeof PlanExecuteState.State) => {
    const remaining = state.plan.slice(1);
    const completedBlock = state.pastSteps.map(([s, r]) => `- ${s} → ${r}`).join('\n');
    const remainingBlock = remaining.length ? remaining.join('\n') : '(none)';
    // T2f-final-fix-7: repeated-failure guard. If the last 3 subgoals
    // all came back as "failed:", the page is fighting us — force
    // finish honestly with whatever partial result we have rather
    // than ask the LLM to keep replanning into the same wall.
    const tail = state.pastSteps.slice(-3);
    if (tail.length === 3 && tail.every(([, r]) => r.startsWith('failed:'))) {
      logger.warning('replanner guard: 3 consecutive failed subgoals — finishing with partial result');
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
      const newPlan = result.plan && result.plan.length > 0 ? result.plan : remaining;
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
    callbacks: [usageCallback],
  };

  try {
    const finalState = await compiled.invoke({}, config);
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
