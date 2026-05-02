import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Action } from '../actions/builder';
import { ActionResult } from '../types';
import { actionToTool, actionsToTools, DEFAULT_TOOL_BUDGETS } from '../tools/langGraphAdapter';

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

  describe('T2f-2 screenshot multimodal output', () => {
    it('renders ActionResult.imageBase64 as a multimodal text+image array', async () => {
      const action = makeAction('screenshot', async () => {
        return new ActionResult({
          extractedContent: 'screenshot captured',
          imageBase64: 'AAAA',
          imageMime: 'image/jpeg',
        });
      });
      const t = actionToTool(action);
      const result = await t.invoke({ value: 'x' });
      expect(Array.isArray(result)).toBe(true);
      const arr = result as Array<{ type: string; text?: string; image_url?: { url: string } }>;
      expect(arr).toHaveLength(2);
      expect(arr[0]).toEqual({ type: 'text', text: 'screenshot captured' });
      expect(arr[1].type).toBe('image_url');
      expect(arr[1].image_url?.url).toBe('data:image/jpeg;base64,AAAA');
    });

    it('falls back to image/jpeg when imageMime is missing', async () => {
      const action = makeAction('screenshot', async () => {
        return new ActionResult({ imageBase64: 'BBBB' });
      });
      const t = actionToTool(action);
      const result = await t.invoke({ value: 'x' });
      const arr = result as Array<{ type: string; text?: string; image_url?: { url: string } }>;
      expect(arr[1].image_url?.url).toBe('data:image/jpeg;base64,BBBB');
    });

    it('plain string result is unchanged when no image payload is present', async () => {
      const action = makeAction('plain', async () => new ActionResult({ extractedContent: 'hi' }));
      const t = actionToTool(action);
      const result = await t.invoke({ value: 'x' });
      expect(result).toBe('hi');
    });
  });

  describe('T2g per-task tool-call budgets', () => {
    it('exposes default budgets matching the production trace fix', () => {
      expect(DEFAULT_TOOL_BUDGETS).toMatchObject({
        web_search: 5,
        web_fetch_markdown: 5,
      });
    });

    it('increments the counter on each invocation when a budget is supplied', async () => {
      const calls: string[] = [];
      const action = makeAction('web_search', async input => {
        calls.push((input as { value: string }).value);
        return new ActionResult({ extractedContent: 'results' });
      });
      const counters: Record<string, number> = {};
      const t = actionToTool(action, { counters, limits: { web_search: 5 } });
      await t.invoke({ value: 'q1' });
      await t.invoke({ value: 'q2' });
      await t.invoke({ value: 'q3' });
      expect(counters.web_search).toBe(3);
      expect(calls).toEqual(['q1', 'q2', 'q3']);
    });

    it('blocks calls past the budget without invoking Action.call', async () => {
      let invocations = 0;
      const action = makeAction('web_search', async () => {
        invocations++;
        return new ActionResult({ extractedContent: 'results' });
      });
      const counters: Record<string, number> = {};
      const t = actionToTool(action, { counters, limits: { web_search: 2 } });
      const r1 = await t.invoke({ value: 'q1' });
      const r2 = await t.invoke({ value: 'q2' });
      const r3 = await t.invoke({ value: 'q3' });
      expect(r1).toBe('results');
      expect(r2).toBe('results');
      expect(r3).toMatch(/budget exhausted for web_search/);
      expect(r3).toMatch(/Stop calling this tool/);
      expect(invocations).toBe(2);
      // Counter still tracks the blocked attempt so repeated overflow
      // attempts keep returning the same forcing error rather than
      // silently re-allowing calls.
      expect(counters.web_search).toBe(3);
    });

    it('does not affect tools that have no configured limit', async () => {
      let invocations = 0;
      const action = makeAction('click_element', async () => {
        invocations++;
        return new ActionResult({ extractedContent: 'clicked' });
      });
      const counters: Record<string, number> = {};
      const t = actionToTool(action, { counters, limits: { web_search: 1 } });
      await t.invoke({ value: 'a' });
      await t.invoke({ value: 'b' });
      await t.invoke({ value: 'c' });
      expect(invocations).toBe(3);
      // Unbudgeted tools do not write to the counter map.
      expect(counters.click_element).toBeUndefined();
    });

    it('actionsToTools threads the budget through to every wrapped tool', async () => {
      const calls = { web_search: 0, click_element: 0 };
      const actions = [
        makeAction('web_search', async () => {
          calls.web_search++;
          return new ActionResult({ extractedContent: 'r' });
        }),
        makeAction('click_element', async () => {
          calls.click_element++;
          return new ActionResult({ extractedContent: 'c' });
        }),
      ];
      const counters: Record<string, number> = {};
      const tools = actionsToTools(actions, { counters, limits: { web_search: 1 } });
      const search = tools.find(t => t.name === 'web_search')!;
      const click = tools.find(t => t.name === 'click_element')!;
      await search.invoke({ value: 'q' });
      const blocked = await search.invoke({ value: 'q' });
      await click.invoke({ value: 'x' });
      await click.invoke({ value: 'y' });
      expect(blocked).toMatch(/budget exhausted/);
      expect(calls).toEqual({ web_search: 1, click_element: 2 });
    });
  });
});
