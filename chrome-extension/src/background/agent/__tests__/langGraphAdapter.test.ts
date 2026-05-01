import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Action } from '../actions/builder';
import { ActionResult } from '../types';
import { actionToTool, actionsToTools } from '../tools/langGraphAdapter';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

function makeAction(name: string, handler: (input: unknown) => Promise<ActionResult>) {
  return new Action(handler, {
    name,
    description: `${name} test tool`,
    schema: z.object({ value: z.string() }),
  });
}

describe('langGraphAdapter', () => {
  it('wraps an Action as a LangChain tool with matching name + description + schema', () => {
    const action = makeAction('probe', async () => new ActionResult({ extractedContent: 'ok' }));
    const t = actionToTool(action);
    expect(t.name).toBe('probe');
    expect(t.description).toBe('probe test tool');
    // Schema is the original zod object reference.
    expect(t.schema).toBe(action.schema.schema);
  });

  it('renders ActionResult.extractedContent as the tool observation', async () => {
    const action = makeAction('echo', async input => {
      return new ActionResult({ extractedContent: `you said ${(input as { value: string }).value}` });
    });
    const t = actionToTool(action);
    const result = await t.invoke({ value: 'hello' });
    expect(result).toBe('you said hello');
  });

  it('renders ActionResult.error as Error: <msg> so the agent can reason about it', async () => {
    const action = makeAction('fail', async () => new ActionResult({ error: 'network timeout' }));
    const t = actionToTool(action);
    const result = await t.invoke({ value: 'x' });
    expect(result).toBe('Error: network timeout');
  });

  it('returns Error: <msg> when the underlying handler throws', async () => {
    const action = makeAction('throws', async () => {
      throw new Error('boom');
    });
    const t = actionToTool(action);
    const result = await t.invoke({ value: 'x' });
    expect(result).toBe('Error: boom');
  });

  it('returns "ok" when the action result has neither error nor extractedContent', async () => {
    const action = makeAction('silent', async () => new ActionResult({}));
    const t = actionToTool(action);
    const result = await t.invoke({ value: 'x' });
    expect(result).toBe('ok');
  });

  it('actionsToTools filters out the `done` action — termination is native in LangGraph', () => {
    const actions = [
      makeAction('done', async () => new ActionResult({ isDone: true })),
      makeAction('click_element', async () => new ActionResult({ extractedContent: 'clicked' })),
      makeAction('web_search', async () => new ActionResult({ extractedContent: 'results' })),
    ];
    const tools = actionsToTools(actions);
    const names = tools.map(t => t.name);
    expect(names).toEqual(['click_element', 'web_search']);
    expect(names.includes('done')).toBe(false);
  });

  it('actionsToTools preserves order for non-done tools', () => {
    const actions = ['a', 'b', 'c', 'done', 'e'].map(n =>
      makeAction(n, async () => new ActionResult({ extractedContent: n })),
    );
    const tools = actionsToTools(actions);
    expect(tools.map(t => t.name)).toEqual(['a', 'b', 'c', 'e']);
  });
});
