/**
 * T2m-observability tests — verify the observability callback handler
 * emits the right console logs AND TRACE entries for the LLM call
 * lifecycle. Tests the callback in isolation (no full agent run)
 * because driving a real LangGraph StateGraph through fake timers is
 * not worth the rathole — the actual integration is two simple
 * registrations in the `callbacks: [...]` arrays.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { infoSpy } = vi.hoisted(() => ({ infoSpy: vi.fn() }));
vi.mock('@src/background/log', () => ({
  createLogger: () => ({
    warning: vi.fn(),
    error: vi.fn(),
    info: infoSpy,
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
    infoSpy.mockClear();
  });

  it('emits TRACE rows only for LLM calls — chain start/end are LangGraph internals and stay out of the user-visible trace (T2r-observability-2)', () => {
    const cb = createObservabilityCallback({ taskId: 'task-1' });
    const orderedTools: string[] = [];
    const orderedStates: string[] = [];
    recordSpy.mockImplementation((entry: { tool: string; args: { state?: string } }) => {
      orderedTools.push(entry.tool);
      orderedStates.push(entry.args.state ?? '');
    });

    // Simulate the call order LangGraph would emit on one ReAct step:
    //   chain (agent) start → llm start → llm end → chain end.
    // Pre-T2r-observability-2 this produced 4 trace rows (2× chain_node,
    // 2× llm_call). The chain_node rows describe HOW the graph is wired,
    // not WHAT the agent did, and dominated the panel — see test12.md.
    // The contract is now: chain start/end produce NO trace record;
    // only llm_call rows survive.
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

    expect(recordSpy).toHaveBeenCalledTimes(2);
    expect(orderedTools).toEqual(['llm_call', 'llm_call']);
    expect(orderedStates).toEqual(['start', 'end']);
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

  describe('T2r-reasoning: assistant text in handleLLMEnd', () => {
    it('logs a reasoning preview when the generation has text', () => {
      const cb = createObservabilityCallback({ taskId: 'task-r1' });
      cb.handleLLMStart?.(
        { id: ['langchain', 'chat_models', 'openai'], name: 'ChatOpenAI', kwargs: { model: 'gpt-4o-mini' } } as never,
        ['hi'],
        'llm-r1',
      );
      cb.handleLLMEnd?.(
        {
          generations: [
            [
              {
                text: 'I will click on the Chatbot Arena Graduated link to find the leaderboard.',
                message: { tool_calls: [{ name: 'click_at' }] } as never,
              } as never,
            ],
          ],
          llmOutput: { tokenUsage: { promptTokens: 100, completionTokens: 20 } },
        } as LLMResult,
        'llm-r1',
      );
      const reasoningLogs = infoSpy.mock.calls.filter(c => String(c[0]).includes('llm reasoning'));
      expect(reasoningLogs).toHaveLength(1);
      expect(String(reasoningLogs[0][0])).toContain('Chatbot Arena Graduated');
    });

    it('truncates long reasoning to 200 chars + ellipsis', () => {
      const cb = createObservabilityCallback({ taskId: 'task-r2' });
      const longText = 'A'.repeat(500);
      cb.handleLLMStart?.(
        { id: ['langchain', 'chat_models', 'openai'], name: 'ChatOpenAI', kwargs: { model: 'gpt-4o-mini' } } as never,
        ['hi'],
        'llm-r2',
      );
      cb.handleLLMEnd?.(
        {
          generations: [[{ text: longText, message: { tool_calls: [] } as never } as never]],
          llmOutput: { tokenUsage: {} },
        } as LLMResult,
        'llm-r2',
      );
      const reasoningLogs = infoSpy.mock.calls.filter(c => String(c[0]).includes('llm reasoning'));
      expect(reasoningLogs).toHaveLength(1);
      const msg = String(reasoningLogs[0][0]);
      expect(msg).toContain('…');
      // 200 As + ellipsis; total length is ~"<prefix>llm reasoning (runId=...): " + 200 + 1
      expect(msg).toMatch(/A{200}…/);
    });

    it('stays silent when the round had no narration (pure tool-call)', () => {
      const cb = createObservabilityCallback({ taskId: 'task-r3' });
      cb.handleLLMStart?.(
        { id: ['langchain', 'chat_models', 'openai'], name: 'ChatOpenAI', kwargs: { model: 'gpt-4o-mini' } } as never,
        ['hi'],
        'llm-r3',
      );
      cb.handleLLMEnd?.(
        {
          generations: [[{ text: '', message: { tool_calls: [{ name: 'screenshot' }] } as never } as never]],
          llmOutput: { tokenUsage: {} },
        } as LLMResult,
        'llm-r3',
      );
      const reasoningLogs = infoSpy.mock.calls.filter(c => String(c[0]).includes('llm reasoning'));
      expect(reasoningLogs).toHaveLength(0);
    });

    it('handles Anthropic-style multimodal content array', () => {
      const cb = createObservabilityCallback({ taskId: 'task-r4' });
      cb.handleLLMStart?.(
        { id: ['langchain', 'chat_models', 'anthropic'], name: 'ChatAnthropic', kwargs: { model: 'claude' } } as never,
        ['hi'],
        'llm-r4',
      );
      cb.handleLLMEnd?.(
        {
          generations: [
            [
              {
                text: '',
                message: {
                  content: [
                    { type: 'text', text: 'Now I will scroll to find the leaderboard.' },
                    { type: 'tool_use', name: 'scroll_to_percent' },
                  ],
                  tool_calls: [{ name: 'scroll_to_percent' }],
                } as never,
              } as never,
            ],
          ],
          llmOutput: { tokenUsage: {} },
        } as LLMResult,
        'llm-r4',
      );
      const reasoningLogs = infoSpy.mock.calls.filter(c => String(c[0]).includes('llm reasoning'));
      expect(reasoningLogs).toHaveLength(1);
      expect(String(reasoningLogs[0][0])).toContain('scroll to find the leaderboard');
    });
  });
});
