/**
 * The last turn of a subgoal that used up its step budget (issue #10).
 *
 * The inner ReAct graph runs with a recursion limit. Reaching it used to throw
 * LangGraph's own error text at the user. Instead, the model gets one more turn
 * with task_complete as its only tool, so the subgoal ends with the agent's own
 * outcome and report. The result follows the normal completion rules: from the
 * last planned subgoal it ends the task, from an earlier one it is a proposal
 * for the replanner.
 */
import { AIMessage, HumanMessage, SystemMessage, type BaseMessage, type ToolMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { RunnableConfig } from '@langchain/core/runnables';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { createLogger } from '@src/background/log';
import { readTaskCompletion, TaskToolNode, type TaskOutcome } from '../taskOutcome';

const logger = createLogger('finalTurn');

export const FINAL_TURN_INSTRUCTION =
  'You have used every step allowed for this subgoal. No tool other than task_complete is available now: call it. ' +
  'Choose the outcome first — answered only if the response contains everything the user asked for — then report ' +
  'what you tried, what you found, and what is still missing.';

/**
 * The step limit can stop the graph between a tool call and its result. A
 * provider rejects a transcript with an unanswered tool call, so cut it at the
 * first assistant message whose calls did not all get a result.
 */
export function closeDanglingToolCalls(messages: BaseMessage[]): BaseMessage[] {
  // By type, not class: a streamed graph keeps AIMessageChunk in its state, which is not an AIMessage
  // (2026-10-01: «No tool output found for function call …» on every final turn).
  const answered = new Set(messages.filter(m => m._getType() === 'tool').map(m => (m as ToolMessage).tool_call_id));
  const cut = messages.findIndex(
    m => m._getType() === 'ai' && ((m as AIMessage).tool_calls ?? []).some(call => !call.id || !answered.has(call.id)),
  );
  return cut === -1 ? messages : messages.slice(0, cut);
}

/** The task_complete outcome of the final turn, or null when the model did not deliver one. */
export async function runFinalTurn(args: {
  llm: BaseChatModel;
  systemPrompt: string;
  messages: BaseMessage[];
  taskComplete: StructuredToolInterface;
  config: RunnableConfig;
}): Promise<{ outcome: TaskOutcome; executed: boolean } | null> {
  const { llm, systemPrompt, messages, taskComplete, config } = args;
  if (!llm.bindTools) return null;
  const input = [
    new SystemMessage(systemPrompt),
    ...closeDanglingToolCalls(messages),
    new HumanMessage(FINAL_TURN_INSTRUCTION),
  ];
  let reply: AIMessage;
  try {
    reply = await llm.bindTools([taskComplete], { tool_choice: taskComplete.name }).invoke(input, config);
  } catch (err) {
    // Some providers reject a forced tool choice (Claude on Bedrock, Qwen — 2026-10-02); OpenRouter wraps the
    // reason in a generic «Provider returned error». With task_complete as the only tool, «auto» still ends in it.
    logger.warning(
      `final turn: forced tool choice rejected, retrying with tool_choice auto: ${JSON.stringify((err as { error?: unknown })?.error ?? String(err)).slice(0, 300)}`,
    );
    reply = await llm.bindTools([taskComplete], { tool_choice: 'auto' }).invoke(input, config);
  }
  const call = reply.tool_calls?.find(c => c.name === taskComplete.name);
  if (!call) return null;
  const single = new AIMessage({ content: reply.content, tool_calls: [call] });
  const result = await new TaskToolNode([taskComplete]).invoke({ messages: [single] }, config);
  return readTaskCompletion((result as { messages: BaseMessage[] }).messages);
}
