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

  it('counts cached tokens once when the OpenAI-compatible stream fills both usage mirrors', () => {
    // Shape of the final chunk from @langchain/openai `_streamResponseChunks`
    // (OpenRouter): usage_metadata is derived from the raw usage, and
    // response_metadata.usage is the raw object itself.
    const emitEvent = vi.fn();
    const { usageCallback } = createUsageTracker({ emitEvent } as unknown as AgentContext);
    usageCallback.handleLLMEnd({
      llmOutput: { estimatedTokenUsage: { promptTokens: 9248, completionTokens: 88, totalTokens: 9336 } },
      generations: [
        [
          {
            message: {
              usage_metadata: {
                input_tokens: 9248,
                output_tokens: 88,
                total_tokens: 9336,
                input_token_details: { cache_read: 6337 },
              },
              response_metadata: {
                usage: {
                  prompt_tokens: 9248,
                  completion_tokens: 88,
                  total_tokens: 9336,
                  prompt_tokens_details: { cached_tokens: 6337, cache_write_tokens: 2908 },
                },
              },
            },
          },
        ],
      ],
    });
    expect(JSON.parse(emitEvent.mock.calls[0][2])).toMatchObject({
      inputTokens: 9248,
      outputTokens: 88,
      cacheReadTokens: 6337,
      cacheCreationTokens: 2908,
    });
  });

  it('counts Anthropic cache tokens once when llmOutput and the message both carry them', () => {
    // Shape of @langchain/anthropic non-streaming: llmOutput is the raw
    // response, the message carries usage_metadata and the same raw usage.
    const raw = {
      input_tokens: 500,
      output_tokens: 40,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 120,
    };
    const emitEvent = vi.fn();
    const { usageCallback } = createUsageTracker({ emitEvent } as unknown as AgentContext);
    usageCallback.handleLLMEnd({
      llmOutput: { usage: raw },
      generations: [
        [
          {
            message: {
              usage_metadata: {
                input_tokens: 500,
                output_tokens: 40,
                input_token_details: { cache_read: 300, cache_creation: 120 },
              },
              response_metadata: { usage: raw },
            },
          },
        ],
      ],
    });
    expect(JSON.parse(emitEvent.mock.calls[0][2])).toMatchObject({
      inputTokens: 500,
      outputTokens: 40,
      cacheReadTokens: 300,
      cacheCreationTokens: 120,
    });
  });

  it('falls back to raw Anthropic usage when the standard field is absent', () => {
    const emitEvent = vi.fn();
    const { usageCallback } = createUsageTracker({ emitEvent } as unknown as AgentContext);
    usageCallback.handleLLMEnd({
      llmOutput: {
        usage: { input_tokens: 500, output_tokens: 40, cache_read_input_tokens: 300, cache_creation_input_tokens: 120 },
      },
    });
    expect(JSON.parse(emitEvent.mock.calls[0][2])).toMatchObject({
      inputTokens: 500,
      outputTokens: 40,
      cacheReadTokens: 300,
      cacheCreationTokens: 120,
    });
  });
});
