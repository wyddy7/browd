import { describe, it, expect, vi } from 'vitest';
import { HumanMessage, AIMessage } from '@langchain/core/messages';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { priorMessagesToBaseMessages } from '../agents/runReactAgent';

describe('priorMessagesToBaseMessages (T2h)', () => {
  it('returns an empty array for an empty seed', () => {
    expect(priorMessagesToBaseMessages([])).toEqual([]);
  });

  it('maps user → HumanMessage and assistant → AIMessage in order', () => {
    const out = priorMessagesToBaseMessages([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'user', content: 'follow up' },
    ]);
    expect(out).toHaveLength(3);
    expect(out[0]).toBeInstanceOf(HumanMessage);
    expect(out[0].content).toBe('hi');
    expect(out[1]).toBeInstanceOf(AIMessage);
    expect(out[1].content).toBe('hello');
    expect(out[2]).toBeInstanceOf(HumanMessage);
    expect(out[2].content).toBe('follow up');
  });

  it('skips entries with empty or non-string content', () => {
    const out = priorMessagesToBaseMessages([
      { role: 'user', content: '' },
      // simulate a corrupt store row that lost its content field
      { role: 'assistant', content: undefined as unknown as string },
      { role: 'user', content: 'kept' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].content).toBe('kept');
  });
});
