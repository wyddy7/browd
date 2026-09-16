import { describe, expect, it, vi } from 'vitest';
import { createUsageTracker } from '../agents/usageTracker';
import type { AgentContext } from '../types';
import { Actors, ExecutionState } from '../event/types';

describe('per-run usage accounting', () => {
  it('emits only new token deltas and does not double-count the final flush', () => {
    const emitEvent = vi.fn();
    const { usageCallback, emitUsage } = createUsageTracker({ emitEvent } as unknown as AgentContext, 32000);
    usageCallback.handleLLMEnd({ llmOutput: { tokenUsage: { promptTokens: 100, completionTokens: 10 } } });
    usageCallback.handleLLMEnd({ llmOutput: { tokenUsage: { promptTokens: 200, completionTokens: 20 } } });
    emitUsage();
    expect(emitEvent).toHaveBeenCalledTimes(2);
    expect(emitEvent.mock.calls.map(([actor, state, body]) => ({ actor, state, ...JSON.parse(body) }))).toEqual([
      {
        actor: Actors.SYSTEM,
        state: ExecutionState.TASK_USAGE,
        inputTokens: 100,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: 32000,
      },
      {
        actor: Actors.SYSTEM,
        state: ExecutionState.TASK_USAGE,
        inputTokens: 200,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: 32000,
      },
    ]);
  });

  it('retains normalized provider cache metadata', () => {
    const emitEvent = vi.fn();
    const { usageCallback } = createUsageTracker({ emitEvent } as unknown as AgentContext);
    usageCallback.handleLLMEnd({
      generations: [
        [
          {
            message: {
              usage_metadata: {
                input_tokens: 150,
                output_tokens: 20,
                input_token_details: { cache_read: 80, cache_creation: 30 },
              },
            },
          },
        ],
      ],
    });
    expect(JSON.parse(emitEvent.mock.calls[0][2])).toMatchObject({
      inputTokens: 150,
      outputTokens: 20,
      cacheReadTokens: 80,
      cacheCreationTokens: 30,
    });
  });
});
