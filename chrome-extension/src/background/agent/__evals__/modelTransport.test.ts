import { describe, expect, it, vi } from 'vitest';
import { HumanMessage } from '@langchain/core/messages';
import { createEvalModel } from './modelTransport';

describe('paid eval transport limits', () => {
  it('meters actual usage and prevents a second HTTP request after the cap', async () => {
    const transport = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            id: 'fixture',
            object: 'chat.completion',
            created: 1,
            model: 'fixture',
            choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0.001 },
          }),
          { headers: { 'content-type': 'application/json' } },
        ),
    );
    const controller = new AbortController();
    const model = createEvalModel('fixture', 'not-a-real-key', controller, 1, transport);
    await model.llm.invoke([new HumanMessage('hello')]);
    expect(model.summary()).toMatchObject({ requests: 1, inputTokens: 10, outputTokens: 2, costUsd: 0.001 });
    await expect(model.llm.invoke([new HumanMessage('again')])).rejects.toThrow();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(controller.signal.aborted).toBe(true);
  });
  it('does not leak provider response bodies on HTTP failure', async () => {
    const model = createEvalModel(
      'fixture',
      'not-a-real-key',
      new AbortController(),
      1,
      vi.fn(async () => new Response('sensitive-provider-body', { status: 401 })),
    );
    try {
      await model.llm.invoke([new HumanMessage('hello')]);
      throw new Error('expected failure');
    } catch (error) {
      expect(String(error)).not.toContain('sensitive-provider-body');
    }
    expect(model.summary().costUsd).toBeNull();
  });
});
