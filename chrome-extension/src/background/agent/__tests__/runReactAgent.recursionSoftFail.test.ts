/**
 * T2p-3 — `extractPartialSummary` helper tests.
 *
 * The full soft-fail branch (fp_start vs fp_now comparison, getState
 * checkpoint read, rethrow vs partial:-return) lives inside the
 * `runReactStep` closure in `runReactAgent.ts` and is exercised by
 * the live extension under recursion-limit exhaustion. These tests
 * cover the small pure helper that stitches a 1-2 sentence partial
 * summary out of the agent step's accumulated messages — i.e. the
 * piece that determines what the replanner sees on the next round.
 *
 * Why no closure-level tests: the closure is built from `llm`,
 * `tools`, `context.browserContext` and `createReactAgent` — driving
 * a real LangGraph through a thrown GraphRecursionError to verify
 * the catch path is not worth the rathole. The helper is the
 * load-bearing piece; the dispatch logic around it is straight-line.
 */
import { describe, it, expect, vi } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage, SystemMessage } from '@langchain/core/messages';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { extractPartialSummary } from '../agents/runReactAgent';

describe('extractPartialSummary (T2p-3)', () => {
  it('returns a generic marker for an empty message array', () => {
    expect(extractPartialSummary([])).toBe('no observable progress before budget was exhausted');
  });

  it('returns just the AI reasoning when no tool calls have run yet', () => {
    const out = extractPartialSummary([
      new SystemMessage('system'),
      new HumanMessage('do the thing'),
      new AIMessage('I will navigate to the leaderboard next.'),
    ]);
    expect(out).toBe('I will navigate to the leaderboard next.');
  });

  it('combines last AI reasoning and last tool name when both are present', () => {
    const aiWithToolCall = new AIMessage({
      content: 'Searching for arena.ai leaderboard',
      tool_calls: [{ id: 't1', name: 'web_search', args: {} }],
    });
    const out = extractPartialSummary([
      new HumanMessage('find the open-source winner'),
      aiWithToolCall,
      new ToolMessage({ content: 'results...', tool_call_id: 't1', name: 'web_search' }),
      new AIMessage('Found the leaderboard URL; now applying the filter.'),
    ]);
    // Last AIMessage text wins for the reasoning slot; last tool name
    // wins for the action slot. Walking from the end means the most
    // recent of each is picked.
    expect(out).toBe('Found the leaderboard URL; now applying the filter. (last action: web_search)');
  });

  it('walks from the end and picks the most recent of each kind', () => {
    const out = extractPartialSummary([
      new AIMessage('old thinking'),
      new ToolMessage({ content: '...', tool_call_id: 't1', name: 'old_tool' }),
      new AIMessage('new thinking'),
      new ToolMessage({ content: '...', tool_call_id: 't2', name: 'new_tool' }),
    ]);
    expect(out).toBe('new thinking (last action: new_tool)');
  });

  it('handles multimodal AIMessage content (array of text parts)', () => {
    const ai = new AIMessage({
      content: [
        { type: 'text', text: 'Considering options' },
        { type: 'text', text: 'going with click_at next' },
      ],
    });
    const out = extractPartialSummary([ai]);
    expect(out).toContain('Considering options');
    expect(out).toContain('going with click_at next');
  });

  it('falls back to tool-only marker when no AIMessage has text', () => {
    // AIMessage with only tool calls, no text content.
    const aiToolOnly = new AIMessage({
      content: '',
      tool_calls: [{ id: 't1', name: 'screenshot', args: {} }],
    });
    const out = extractPartialSummary([
      aiToolOnly,
      new ToolMessage({ content: 'img', tool_call_id: 't1', name: 'screenshot' }),
    ]);
    expect(out).toBe('last action: screenshot');
  });
});
