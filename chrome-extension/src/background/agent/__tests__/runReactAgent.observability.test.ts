/**
 * T2m-observability tests — verify the observability callback handler
 * emits the right console logs AND TRACE entries for the LLM call
 * lifecycle. Tests the callback in isolation (no full agent run)
 * because driving a real LangGraph StateGraph through fake timers is
 * not worth the rathole — the actual integration is two simple
 * registrations in the `callbacks: [...]` arrays.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({
    warning: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock the tracer module BEFORE importing the SUT so the SUT picks
// up the spy. `vi.hoisted` keeps the spy reference available inside
// the hoisted `vi.mock` factory.
const { recordSpy } = vi.hoisted(() => ({ recordSpy: vi.fn() }));
vi.mock('../tracing', () => ({
  globalTracer: { record: recordSpy },
}));

import { createObservabilityCallback } from '../agents/observabilityCallback';
import type { LLMResult } from '@langchain/core/outputs';

describe('observabilityCallback (T2m)', () => {
  beforeEach(() => {
    recordSpy.mockClear();
  });

  it('fires callbacks in expected order (chainStart → llmStart → llmEnd → chainEnd) for one mocked agent step', () => {
    const cb = createObservabilityCallback({ taskId: 'task-1' });
    const orderedTools: string[] = [];
    const orderedStates: string[] = [];
    recordSpy.mockImplementation((entry: { tool: string; args: { state?: string } }) => {
      orderedTools.push(entry.tool);
      orderedStates.push(entry.args.state ?? '');
    });

    // Simulate the call order LangGraph would emit on one ReAct step:
    //   chain (agent) start → llm start → llm end → chain end.
    cb.handleChainStart?.(
      { id: ['langchain', 'agent'], name: 'agent', kwargs: {} } as never,
      {},
      'chain-1',
      undefined,
      undefined,
      undefined,
      undefined,
      'agent',
    );
    cb.handleLLMStart?.(
      { id: ['langchain', 'chat_models', 'openai'], name: 'ChatOpenAI', kwargs: { model: 'gpt-4o-mini' } } as never,
      ['hello'],
      'llm-1',
    );
    cb.handleLLMEnd?.(
      {
        generations: [[{ text: 'hi', message: { tool_calls: [] } as never } as never]],
        llmOutput: { tokenUsage: { promptTokens: 10, completionTokens: 5 } },
      } as LLMResult,
      'llm-1',
    );
    cb.handleChainEnd?.({}, 'chain-1');

    // Four trace records in the order: chain_node start, llm_call
    // start, llm_call end, chain_node end.
    expect(recordSpy).toHaveBeenCalledTimes(4);
    expect(orderedTools).toEqual(['chain_node', 'llm_call', 'llm_call', 'chain_node']);
    expect(orderedStates).toEqual(['start', 'start', 'end', 'end']);
  });

  it('handleLLMError logs an error TRACE row with state=error and the error message', () => {
    const cb = createObservabilityCallback({ taskId: 'task-2' });
    cb.handleLLMStart?.(
      { id: ['langchain', 'chat_models', 'openai'], name: 'ChatOpenAI', kwargs: { model: 'gpt-4o-mini' } } as never,
      ['ping'],
      'llm-err',
    );
    // OpenAI SDK shaped error — has both `status` and `message`.
    const err = Object.assign(new Error('HTTP 401: invalid api key'), { status: 401, name: 'AuthenticationError' });
    cb.handleLLMError?.(err, 'llm-err');

    // Find the error record (the second one — start was first).
    const errorCalls = recordSpy.mock.calls.filter(
      ([entry]) => entry.tool === 'llm_call' && entry.args?.state === 'error',
    );
    expect(errorCalls).toHaveLength(1);
    const errorEntry = errorCalls[0][0];
    expect(errorEntry.ok).toBe(false);
    expect(errorEntry.args.errorName).toBe('AuthenticationError');
    expect(errorEntry.args.status).toBe(401);
    expect(String(errorEntry.result)).toContain('invalid api key');
  });

  it('handleLLMError fires with a timeout-shaped error and surfaces the timeout message', () => {
    // Mocked-timeout scenario: instead of driving a real 90s hang
    // through fake timers (which would not reach this callback
    // without a full LangGraph harness), invoke `handleLLMError`
    // with the same shape `@langchain/openai` raises on a request
    // timeout. This is what the post-T2m-config ChatOpenAI emits
    // when its 90s budget elapses.
    const cb = createObservabilityCallback({ taskId: 'task-timeout' });
    cb.handleLLMStart?.(
      { id: ['langchain', 'chat_models', 'openai'], name: 'ChatOpenAI', kwargs: { model: 'gpt-4o-mini' } } as never,
      ['slow request'],
      'llm-timeout',
    );
    const timeoutErr = Object.assign(new Error('Request timed out after 90000ms'), {
      name: 'APIConnectionTimeoutError',
      code: 'ETIMEDOUT',
    });
    cb.handleLLMError?.(timeoutErr, 'llm-timeout');

    const errorCalls = recordSpy.mock.calls.filter(
      ([entry]) => entry.tool === 'llm_call' && entry.args?.state === 'error',
    );
    expect(errorCalls).toHaveLength(1);
    const errorEntry = errorCalls[0][0];
    expect(errorEntry.ok).toBe(false);
    expect(errorEntry.args.errorName).toBe('APIConnectionTimeoutError');
    expect(String(errorEntry.result)).toMatch(/timed out/i);
  });
});
