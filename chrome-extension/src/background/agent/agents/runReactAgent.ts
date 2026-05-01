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
import { extractForms, formatFormsForPrompt } from '@src/background/browser/dom/forms';
import { wrapUntrustedContent } from '../messages/utils';
import { Actors, ExecutionState } from '../event/types';
import { createLogger } from '@src/background/log';

const logger = createLogger('runReactAgent');

export interface RunReactAgentInput {
  context: AgentContext;
  llm: BaseChatModel;
  actions: Action[];
  task: string;
}

export interface RunReactAgentResult {
  finalAnswer: string | null;
  error: string | null;
}

/**
 * Build a fresh "Page state" HumanMessage from the live browser. Called
 * by stateModifier on every agent step so the LLM always sees current
 * DOM/forms/page text rather than a stale snapshot from task start.
 */
async function buildBrowserStateMessage(context: AgentContext): Promise<HumanMessage> {
  const browserState = await context.browserContext.getState(context.options.useVision);
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
  const { context, llm, actions, task } = input;
  // T2g: per-task tool-call budgets. Counter map lives in this closure
  // so it resets to {} on every runReactAgent invocation; tools wrappers
  // increment before dispatch. Past the configured limit the wrapper
  // returns a forcing error and never calls Action.call. Default caps
  // are tuned for the read-only research tools that have historically
  // driven loop bugs; numbers can be overridden by editing
  // DEFAULT_TOOL_BUDGETS in langGraphAdapter (NOT via the system
  // prompt — that path is unenforceable, see T2e follow-up 77ea382).
  const counters: Record<string, number> = {};
  const tools = actionsToTools(actions, { counters, limits: DEFAULT_TOOL_BUDGETS });
  const checkpointer = new MemorySaver();

  const agent = createReactAgent({
    llm,
    tools,
    checkpointSaver: checkpointer,
    // Inject fresh browser state at the start of each LLM turn. The
    // SystemMessage carries our ReAct rules; the latest HumanMessage
    // carries live page state. Prior conversation messages stay intact.
    stateModifier: async (state: { messages: BaseMessage[] }) => {
      try {
        const fresh = await buildBrowserStateMessage(context);
        return [new SystemMessage(reactSystemPromptTemplate), ...state.messages, fresh];
      } catch (err) {
        logger.warning('buildBrowserStateMessage failed; running without fresh state', err);
        return [new SystemMessage(reactSystemPromptTemplate), ...state.messages];
      }
    },
  });

  // recursionLimit caps total LangGraph node invocations (each tool call
  // is ~2 nodes: agent reasoning + tool execution). 30 = up to ~15
  // tool calls per task. Above that the agent is almost certainly
  // looping; T2g per-tool budgets above stop research-tool loops well
  // before this hard cap fires. recursionLimit stays as the last-line
  // safety net for non-budgeted tools.
  const config = {
    configurable: { thread_id: context.taskId },
    recursionLimit: Math.min(context.options.maxSteps, 30),
    signal: context.controller.signal,
  };

  try {
    const result = await agent.invoke(
      {
        messages: [new HumanMessage(task)],
      },
      config,
    );
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
