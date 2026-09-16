import { AIMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import type { RunnableConfig } from '@langchain/core/runnables';
import { ToolNode } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';

/** The graph's only terminal state. Text alone never establishes success. */
export const taskOutcomeSchema = z.object({
  status: z.enum(['completed', 'failed', 'cancelled']),
  response: z.string().refine(text => text.trim().length > 0, 'A terminal result must contain a response'),
});

export type TaskOutcome = z.infer<typeof taskOutcomeSchema>;

export class InvalidTaskToolBatchError extends Error {}

/** Only an executed terminal tool can supply a completion artifact. */
export function readTaskOutcome(messages: BaseMessage[]): TaskOutcome | null {
  for (const message of messages) {
    if (!(message instanceof ToolMessage) || message.name !== 'task_complete') continue;
    const parsed = taskOutcomeSchema.safeParse(message.artifact);
    if (message.status !== 'error' && parsed.success) return parsed.data;
    return { status: 'failed', response: 'The task completion tool failed to return a valid result.' };
  }
  return null;
}

/**
 * LangGraph dispatches sibling tool calls concurrently. Completion must be a
 * standalone call: reject a mixed batch before any browser side effect starts.
 */
export class TaskToolNode extends ToolNode<{ messages: BaseMessage[] }> {
  protected async run(input: { messages: BaseMessage[] }, config: RunnableConfig) {
    const last = input.messages[input.messages.length - 1];
    if (last instanceof AIMessage && last.tool_calls && last.tool_calls.length > 1) {
      if (last.tool_calls.some(call => call.name === 'task_complete')) {
        throw new InvalidTaskToolBatchError(
          'task_complete must be called alone, after all other tools have finished. No tools in the batch ran.',
        );
      }
    }
    return super.run(input, config);
  }
}
