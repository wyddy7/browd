import { describe, it, expect, vi } from 'vitest';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { ActionBuilder, type Action } from '../builder';
import { taskCompleteActionSchema } from '../schemas';
import type { AgentContext } from '../../types';

// task_complete is the unified-mode terminal action. The adapter turns this
// ActionResult into a typed ToolMessage artifact; this file pins the action
// contract before that adapter boundary. End-to-end routing lives in the
// runReactAgent completion regressions.

function makeContext() {
  return {
    browserContext: {},
    emitEvent: vi.fn().mockResolvedValue(undefined),
    options: { useVision: false },
  } as unknown as AgentContext;
}

function findAction(builder: ActionBuilder, name: string): Action {
  const actions = builder.buildDefaultActions();
  const found = actions.find(a => a.name() === name);
  if (!found) throw new Error(`action ${name} not built`);
  return found;
}

describe('task_complete — T2w sentinel termination action', () => {
  it('schema rejects an empty or whitespace-only response', () => {
    const parse = taskCompleteActionSchema.schema.safeParse({ intent: '', response: '' });
    expect(parse.success).toBe(false);
    expect(taskCompleteActionSchema.schema.safeParse({ response: '  \n\t ' }).success).toBe(false);
  });

  it('schema accepts a non-empty response with an outcome and defaults intent', () => {
    const parse = taskCompleteActionSchema.schema.safeParse({ outcome: 'answered', response: 'the answer is 42' });
    expect(parse.success).toBe(true);
    if (parse.success) {
      expect(parse.data.response).toBe('the answer is 42');
      expect(parse.data.intent).toBe('');
      expect(parse.data.outcome).toBe('answered');
    }
  });

  // 2026-10-01 robustness eval: a boolean `success` that defaulted to true and
  // came after `response` produced success=true with «I couldn't verify…» in 6
  // of 6 calls. The outcome is now required, has no default, and is decided
  // before the response is written.
  it('schema requires an outcome and offers no default', () => {
    expect(taskCompleteActionSchema.schema.safeParse({ response: 'the answer is 42' }).success).toBe(false);
    expect(taskCompleteActionSchema.schema.safeParse({ response: 'the answer is 42', outcome: 'done' }).success).toBe(
      false,
    );
  });

  it('schema has no success flag and puts the outcome before the response', () => {
    const keys = Object.keys((taskCompleteActionSchema.schema as unknown as { shape: Record<string, unknown> }).shape);
    expect(keys).not.toContain('success');
    expect(keys.indexOf('outcome')).toBeGreaterThanOrEqual(0);
    expect(keys.indexOf('outcome')).toBeLessThan(keys.indexOf('response'));
  });

  it.each([
    ['answered', true],
    ['not_on_site', false],
    ['blocked', false],
  ] as const)('handler maps outcome %s to success=%s', async (outcome, success) => {
    const ctx = makeContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = new ActionBuilder(ctx, {} as any);
    const action = findAction(builder, 'task_complete');
    const result = await action.call({ intent: '', outcome, response: 'report' });
    expect(result.error).toBeFalsy();
    expect(result.isDone).toBe(true);
    expect(result.success).toBe(success);
  });

  it('handler returns a successful terminal ActionResult with the response verbatim', async () => {
    const ctx = makeContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = new ActionBuilder(ctx, {} as any);
    const action = findAction(builder, 'task_complete');
    const result = await action.call({
      intent: 'finish',
      outcome: 'answered',
      response: 'Browd v0.1.13 ships task_complete',
    });
    expect(result.error).toBeFalsy();
    expect(result.isDone).toBe(true);
    expect(result.success).toBe(true);
    expect(result.extractedContent).toBe('Browd v0.1.13 ships task_complete');
    expect(result.includeInMemory).toBe(true);
  });

  it('handler propagates the response verbatim (no truncation, preserves whitespace)', async () => {
    const ctx = makeContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = new ActionBuilder(ctx, {} as any);
    const action = findAction(builder, 'task_complete');
    const multiline = 'Line one.\n\nLine two with **markdown** and a [link](https://example.com).';
    const result = await action.call({ intent: '', outcome: 'answered', response: multiline });
    expect(result.extractedContent).toBe(multiline);
  });

  it('preserves an explicit unsuccessful terminal status for the adapter', async () => {
    const ctx = makeContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = new ActionBuilder(ctx, {} as any);
    const action = findAction(builder, 'task_complete');
    const result = await action.call({
      intent: 'report that the page blocked extraction',
      outcome: 'blocked',
      response: 'The page blocked access before I could extract the data.',
    });
    expect(result.isDone).toBe(true);
    expect(result.success).toBe(false);
    expect(result.extractedContent).toBe('The page blocked access before I could extract the data.');
  });
});
