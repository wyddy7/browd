import { describe, it, expect, vi } from 'vitest';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { ActionBuilder, Action } from '../builder';
import { taskCompleteActionSchema } from '../schemas';
import type { AgentContext } from '../../types';

// T2w — `task_complete` is the unified-mode termination sentinel.
// runReactAgent's `runReactStep` scans ToolMessage content for the
// `TASK_COMPLETE: ` prefix and surfaces it as the finalAnswer;
// agentNode strips the prefix and writes it to `state.response`,
// which the `decide` edge routes to END. End-to-end routing is
// covered indirectly by the StateGraph wiring in runReactAgent and
// would require an in-memory LangGraph harness to assert here. This
// file pins the contract at the action layer (schema + handler
// output shape) the wrapper depends on.

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
  it('schema rejects an empty response (Zod .min(1))', () => {
    const parse = taskCompleteActionSchema.schema.safeParse({ intent: '', response: '' });
    expect(parse.success).toBe(false);
  });

  it('schema accepts a non-empty response and defaults intent to ""', () => {
    const parse = taskCompleteActionSchema.schema.safeParse({ response: 'the answer is 42' });
    expect(parse.success).toBe(true);
    if (parse.success) {
      expect(parse.data.response).toBe('the answer is 42');
      expect(parse.data.intent).toBe('');
    }
  });

  it('handler returns extractedContent prefixed with `TASK_COMPLETE: ` + the response', async () => {
    const ctx = makeContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = new ActionBuilder(ctx, {} as any);
    const action = findAction(builder, 'task_complete');
    const result = await action.call({ intent: 'finish', response: 'Browd v0.1.13 ships task_complete' });
    expect(result.error).toBeFalsy();
    expect(result.extractedContent).toBe('TASK_COMPLETE: Browd v0.1.13 ships task_complete');
    expect(result.includeInMemory).toBe(true);
  });

  it('handler propagates the response verbatim (no truncation, preserves whitespace)', async () => {
    const ctx = makeContext();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = new ActionBuilder(ctx, {} as any);
    const action = findAction(builder, 'task_complete');
    const multiline = 'Line one.\n\nLine two with **markdown** and a [link](https://example.com).';
    const result = await action.call({ intent: '', response: multiline });
    expect(result.extractedContent).toBe(`TASK_COMPLETE: ${multiline}`);
  });
});
