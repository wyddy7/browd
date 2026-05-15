/**
 * T2v — `streamBridge` tests.
 *
 * Three load-bearing properties:
 *   1. token-stream throttle — 100 tokens in 50ms emits ≤ 5 live events
 *   2. event filter — surface `on_chat_model_*`, `on_tool_*`, and only
 *      the whitelisted node names from `on_chain_start/end`; drop graph
 *      internals like ChannelWrite / RunnableLambda / Branch.
 *   3. final-state extraction — the shape returned matches what
 *      `invoke()` would have returned (`{messages: BaseMessage[]}` and
 *      any StateGraph fields).
 */
import { describe, it, expect, vi } from 'vitest';
import { AIMessage, HumanMessage } from '@langchain/core/messages';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { bridgeStreamEvents, type LiveEvent } from '../agents/streamBridge';

interface StreamEvent {
  event: string;
  name?: string;
  run_id?: string;
  tags?: string[];
  metadata?: Record<string, unknown>;
  data?: {
    input?: unknown;
    output?: unknown;
    chunk?: unknown;
    error?: unknown;
  };
}

async function* iterate(events: StreamEvent[]): AsyncIterable<StreamEvent> {
  for (const e of events) yield e;
}

describe('bridgeStreamEvents (T2v)', () => {
  it('throttles 100 token events in 50ms to ≤ 5 live emits', async () => {
    const events: StreamEvent[] = [
      { event: 'on_chat_model_start', run_id: 'r1', name: 'ChatOpenAI', metadata: { ls_model_name: 'gpt-flash' } },
    ];
    for (let i = 0; i < 100; i++) {
      events.push({ event: 'on_chat_model_stream', run_id: 'r1', data: { chunk: 'tok' } });
    }
    const emitted: LiveEvent[] = [];
    await bridgeStreamEvents(iterate(events), msg => emitted.push(msg));
    const streamingEmits = emitted.filter(e => e.kind === 'llm_streaming');
    // 200ms throttle => no time-based emit fires inside a 50ms test
    // window. Token-count fallback fires at multiples of 50, so 100
    // tokens => 2 emits (at tokens=50 and tokens=100).
    expect(streamingEmits.length).toBeLessThanOrEqual(5);
    expect(streamingEmits.length).toBeGreaterThan(0);
  });

  it('surfaces on_chat_model_stream / on_tool_start / on_tool_end and drops graph internals', async () => {
    const events: StreamEvent[] = [
      { event: 'on_chain_start', name: 'ChannelWrite', run_id: 'c1' },
      { event: 'on_chain_start', name: 'RunnableLambda', run_id: 'c2' },
      { event: 'on_chain_start', name: 'Branch', run_id: 'c3' },
      { event: 'on_chain_start', name: 'planner', run_id: 'c4' },
      { event: 'on_chain_start', name: 'agent', run_id: 'c5' },
      { event: 'on_chat_model_start', run_id: 'r1', metadata: { ls_model_name: 'm' } },
      // 50 chunks triggers the token-count emit threshold exactly once
      ...Array.from({ length: 50 }, () => ({ event: 'on_chat_model_stream', run_id: 'r1' })),
      { event: 'on_chat_model_end', run_id: 'r1' },
      { event: 'on_tool_start', name: 'click_at', run_id: 't1', data: { input: { intent: 'Click Open Source' } } },
      { event: 'on_tool_end', name: 'click_at', run_id: 't1', data: { output: { ok: true } } },
      { event: 'on_chain_end', name: 'ChannelWrite', run_id: 'c1' },
    ];
    const emitted: LiveEvent[] = [];
    await bridgeStreamEvents(iterate(events), msg => emitted.push(msg));
    const kinds = emitted.map(e => e.kind);
    expect(kinds).toContain('llm_streaming');
    expect(kinds).toContain('tool_start');
    expect(kinds).toContain('tool_end');
    // node events whitelist: only 'planner' / 'agent' / 'replanner' surface
    const nodeEvents = emitted.filter(e => e.kind === 'node') as Extract<LiveEvent, { kind: 'node' }>[];
    const surfacedNames = nodeEvents.map(n => n.name);
    expect(surfacedNames).toContain('planner');
    expect(surfacedNames).toContain('agent');
    expect(surfacedNames).not.toContain('ChannelWrite');
    expect(surfacedNames).not.toContain('RunnableLambda');
    expect(surfacedNames).not.toContain('Branch');
  });

  it('returns the root StateGraph output detected by shape (pastSteps key), regardless of chain name', async () => {
    const fakeFinal = {
      messages: [new HumanMessage('hi'), new AIMessage('done')],
      response: 'all set',
      pastSteps: [['step', 'result']],
    };
    const events: StreamEvent[] = [
      // Inner node outputs do NOT carry pastSteps — must be ignored.
      { event: 'on_chain_start', name: 'planner', run_id: 'p1' },
      { event: 'on_chain_end', name: 'planner', run_id: 'p1', data: { output: { plan: ['x'] } } },
      { event: 'on_chain_start', name: 'replanner', run_id: 'r1' },
      { event: 'on_chain_end', name: 'replanner', run_id: 'r1', data: { output: { response: 'noise' } } },
      // Root output, whatever LangGraph names it.
      { event: 'on_chain_end', name: 'AnyRootNameLangGraphPicks', run_id: 'root', data: { output: fakeFinal } },
    ];
    const emitted: LiveEvent[] = [];
    const final = await bridgeStreamEvents<typeof fakeFinal>(iterate(events), msg => emitted.push(msg));
    expect(final.messages).toHaveLength(2);
    expect(final.response).toBe('all set');
    expect(final.pastSteps).toEqual([['step', 'result']]);
  });

  it('detects the latest root-shaped output even when LangGraph emits multiple nested ones', async () => {
    // Some LangGraph configurations emit intermediate state snapshots
    // that ALSO carry pastSteps (StateGraph aggregates each step). The
    // bridge must pick the LAST one so the user sees the final answer.
    const earlier = { pastSteps: [['s1', 'r1']], response: null };
    const final = {
      pastSteps: [
        ['s1', 'r1'],
        ['s2', 'r2'],
      ],
      response: 'final answer',
    };
    const events: StreamEvent[] = [
      { event: 'on_chain_end', name: 'intermediate', run_id: 'a', data: { output: earlier } },
      { event: 'on_chain_end', name: 'whatever', run_id: 'b', data: { output: final } },
    ];
    const result = await bridgeStreamEvents<typeof final>(iterate(events), () => undefined);
    expect(result.response).toBe('final answer');
    expect(result.pastSteps).toHaveLength(2);
  });

  it('returns empty {messages} when no chain output is observed (defensive fallback)', async () => {
    const events: StreamEvent[] = [{ event: 'on_chat_model_start', run_id: 'r1' }];
    const final = await bridgeStreamEvents(iterate(events), () => undefined);
    expect(final).toEqual({ messages: [] });
  });

  it('breaks out of the loop after the AbortSignal fires without processing further events', async () => {
    const controller = new AbortController();
    let yielded = 0;
    async function* iter(): AsyncIterable<StreamEvent> {
      yielded += 1;
      yield { event: 'on_chat_model_start', run_id: 'r1', metadata: { ls_model_name: 'm' } };
      controller.abort();
      // streamBridge checks signal at the top of the next iteration
      // and must break before doing anything with this event.
      yielded += 1;
      yield { event: 'on_tool_start', name: 'click_at', run_id: 't1', data: { input: {} } };
      // If the bridge kept iterating past abort it would pull this too.
      yielded += 1;
      yield { event: 'on_tool_end', name: 'click_at', run_id: 't1', data: { output: { ok: true } } };
    }
    const emitted: LiveEvent[] = [];
    await bridgeStreamEvents(iter(), msg => emitted.push(msg), controller.signal);
    expect(yielded).toBeLessThanOrEqual(2);
    // The tool_start event after abort must NOT have been surfaced.
    expect(emitted.filter(e => e.kind === 'tool_start')).toHaveLength(0);
  });
});
