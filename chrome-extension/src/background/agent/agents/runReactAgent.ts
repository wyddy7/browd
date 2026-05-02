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
import { MemorySaver } from '@langchain/langgraph';
import { HumanMessage, AIMessage, SystemMessage, BaseMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
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
  const COORDINATE_TOOLS = new Set(['click_at', 'type_at', 'scroll_at']);
  const filteredActions = actions.filter(a => {
    const n = a.name();
    if (n === 'screenshot') return visionMode === 'fallback';
    if (COORDINATE_TOOLS.has(n)) return visionMode !== 'off';
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
  const systemPromptText = visionMode === 'off' ? reactSystemPromptTemplate : buildReactVisionPrompt(visionMode);

  const agent = createReactAgent({
    llm,
    tools,
    checkpointSaver: checkpointer,
    // Inject fresh browser state at the start of each LLM turn. The
    // SystemMessage carries our ReAct rules; the latest HumanMessage
    // carries live page state. Prior conversation messages stay intact.
    stateModifier: async (state: { messages: BaseMessage[] }) => {
      try {
        let screenshotPayload: { base64: string; mime: string } | null = null;
        if (screenshotAction) {
          try {
            // T2f-coords: autocapture always carries a coordinate
            // grid so the agent can fall back to click_at / type_at
            // / scroll_at without an explicit second screenshot. The
            // grid is unobtrusive on text-heavy pages and a
            // significant accuracy lift on canvas / custom UI.
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
        return [new SystemMessage(systemPromptText), ...state.messages, fresh];
      } catch (err) {
        logger.warning('buildBrowserStateMessage failed; running without fresh state', err);
        return [new SystemMessage(systemPromptText), ...state.messages];
      }
    },
  });

  const seededHistory = priorMessages ? priorMessagesToBaseMessages(priorMessages) : [];
  if (seededHistory.length > 0) {
    logger.info(`seeded ${seededHistory.length} prior message(s) from chat history`);
  }
  logger.info(`runReactAgent visionMode=${visionMode} (tools=${tools.length})`);

  // T2f-final-fix-2 — accumulate token usage via LangChain's callback
  // hook rather than parsing result.messages at the end. invoke() can
  // throw mid-task (puppeteer frame errors, captcha redirects, etc.);
  // callbacks fire on every LLM end so we still see the totals when
  // we land in the catch block. We accept three usage shapes —
  // standard usage_metadata + Anthropic streaming + OpenAI legacy —
  // because OpenRouter routes to multiple back-ends and each surfaces
  // it differently.
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

  // recursionLimit caps total LangGraph node invocations (each tool
  // call ≈ 2 nodes: agent reasoning + tool execution). Industry
  // consensus for browser agents:
  //   - WebVoyager / SeeAct (research): 20-30 steps
  //   - Anthropic Computer Use docs: 50 steps recommended
  //   - LangGraph default: 25 (recursionLimit)
  //   - Browser-Use default: 100 (but with multi-action batching)
  //   - Magentic-One: ~40-50
  // Sweet spot for a single-action ReAct loop is 50 steps =
  // recursionLimit 100. Pathologies (loops, dead-ends) are caught
  // earlier by T2g per-tool budgets and the duplicate-call guard;
  // this is the "give up and tell the user" cap, not a working
  // budget. Hitting it usually means the task needs decomposition.
  const config = {
    configurable: { thread_id: context.taskId },
    recursionLimit: Math.min(context.options.maxSteps * 2, 100),
    signal: context.controller.signal,
    callbacks: [usageCallback],
  };

  try {
    const result = await agent.invoke(
      {
        messages: [...seededHistory, new HumanMessage(task)],
      },
      config,
    );
    emitUsage();
    const finalAnswer = extractFinalAnswer(result.messages);
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
    // T2f-final-fix-2: even when invoke() throws mid-task, the LLM
    // has already produced some turns — emit cumulative usage we
    // gathered through the callback so the ring updates instead of
    // staying empty.
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
