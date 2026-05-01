import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Tracer, InMemoryTraceStorage } from '../tracing';

describe('Tracer', () => {
  let storage: InMemoryTraceStorage;
  let tracer: Tracer;

  beforeEach(() => {
    storage = new InMemoryTraceStorage();
    tracer = new Tracer(storage);
  });

  it('drops entries when no active task is set', () => {
    tracer.record({ tool: 'click_element', args: {}, ok: true, durationMs: 5 });
    // No throw, no entry persisted.
    expect(storage['store'].size).toBe(0);
  });

  it('records entries against the active task and flushes to storage', async () => {
    tracer.setContext({ taskId: 'task-1', stepNumber: 0 });
    tracer.record({ tool: 'click_element', args: { index: 4 }, ok: true, durationMs: 12 });
    await tracer.flush();
    const entries = await storage.read('task-1');
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      taskId: 'task-1',
      stepNumber: 0,
      tool: 'click_element',
      ok: true,
      durationMs: 12,
    });
    expect(entries[0].args).toContain('"index":4');
  });

  it('truncates oversized args and result previews', async () => {
    tracer.setContext({ taskId: 'task-1', stepNumber: 0 });
    const longText = 'x'.repeat(500);
    tracer.record({
      tool: 'fill_field_by_label',
      args: { value: longText },
      result: longText,
      ok: true,
      durationMs: 1,
    });
    await tracer.flush();
    const [entry] = await storage.read('task-1');
    expect(entry.args.length).toBeLessThanOrEqual(202); // 200 + ellipsis
    expect(entry.resultSummary.length).toBeLessThanOrEqual(302);
    expect(entry.args.endsWith('…')).toBe(true);
    expect(entry.resultSummary.endsWith('…')).toBe(true);
  });

  it('keeps at most 200 entries per task (ring buffer)', async () => {
    tracer.setContext({ taskId: 'task-ring', stepNumber: 0 });
    for (let i = 0; i < 250; i++) {
      tracer.record({ tool: 'click_element', args: { index: i }, ok: true, durationMs: 0 });
    }
    await tracer.flush();
    const entries = await storage.read('task-ring');
    expect(entries).toHaveLength(200);
    expect(entries[0].args).toContain('"index":50');
    expect(entries[entries.length - 1].args).toContain('"index":249');
  });

  it('isolates entries by task — switching context flushes the previous buffer', async () => {
    tracer.setContext({ taskId: 'task-a', stepNumber: 0 });
    tracer.record({ tool: 'click_element', args: {}, ok: true, durationMs: 1 });
    tracer.setContext({ taskId: 'task-b', stepNumber: 0 });
    tracer.record({ tool: 'navigate', args: { url: 'https://example.com' }, ok: true, durationMs: 1 });
    await tracer.flush();
    // Previous buffer flushed via fire-and-forget; wait for promise queue.
    await new Promise(r => setTimeout(r, 10));
    const a = await storage.read('task-a');
    const b = await storage.read('task-b');
    expect(a).toHaveLength(1);
    expect(b).toHaveLength(1);
    expect(a[0].tool).toBe('click_element');
    expect(b[0].tool).toBe('navigate');
  });

  it('emits live entries to subscribers', () => {
    const seen: string[] = [];
    const unsubscribe = tracer.subscribe(e => seen.push(e.tool));
    tracer.setContext({ taskId: 't', stepNumber: 0 });
    tracer.record({ tool: 'click_element', args: {}, ok: true, durationMs: 0 });
    tracer.record({ tool: 'navigate', args: {}, ok: true, durationMs: 0 });
    unsubscribe();
    tracer.record({ tool: 'done', args: {}, ok: true, durationMs: 0 });
    expect(seen).toEqual(['click_element', 'navigate']);
  });

  it('listTaskIds reflects all persisted tasks', async () => {
    tracer.setContext({ taskId: 't1', stepNumber: 0 });
    tracer.record({ tool: 'a', args: {}, ok: true, durationMs: 0 });
    await tracer.flush();
    tracer.setContext({ taskId: 't2', stepNumber: 0 });
    tracer.record({ tool: 'b', args: {}, ok: true, durationMs: 0 });
    await tracer.flush();
    const ids = await tracer.listTaskIds();
    expect(ids.sort()).toEqual(['t1', 't2']);
  });

  it('clear removes a task and resets in-memory buffer if active', async () => {
    tracer.setContext({ taskId: 't', stepNumber: 0 });
    tracer.record({ tool: 'a', args: {}, ok: true, durationMs: 0 });
    await tracer.flush();
    await tracer.clear('t');
    expect(await storage.read('t')).toEqual([]);
  });
});

// Silence the no-op logger import in tests
vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
