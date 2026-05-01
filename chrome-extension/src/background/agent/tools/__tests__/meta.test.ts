import { describe, it, expect, beforeEach, vi } from 'vitest';
import { handleUnifiedDone, validateEvidence } from '../meta';
import { Tracer, InMemoryTraceStorage } from '../../tracing';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

describe('meta-tools', () => {
  let storage: InMemoryTraceStorage;

  beforeEach(async () => {
    storage = new InMemoryTraceStorage();
    // Replace singleton's storage by re-instantiating Tracer
    const { globalTracer } = await import('../../tracing');
    // Cast to access the private store for test isolation
    (globalTracer as unknown as { storage: InMemoryTraceStorage }).storage = storage;
  });

  describe('validateEvidence', () => {
    it('rejects empty evidence', async () => {
      const unknown = await validateEvidence('t1', []);
      expect(unknown).toEqual(['no evidence provided']);
    });

    it('rejects evidence when no trace exists yet', async () => {
      const unknown = await validateEvidence('t1', ['0']);
      expect(unknown).toEqual(['no trace recorded yet']);
    });

    it('accepts numeric step refs that exist in trace', async () => {
      await storage.write('t1', [
        {
          taskId: 't1',
          stepNumber: 0,
          tool: 'web_search',
          args: '{}',
          resultSummary: 'ok',
          ok: true,
          durationMs: 5,
          ts: Date.now(),
        },
        {
          taskId: 't1',
          stepNumber: 1,
          tool: 'web_fetch_markdown',
          args: '{}',
          resultSummary: 'ok',
          ok: true,
          durationMs: 5,
          ts: Date.now(),
        },
      ]);
      const unknown = await validateEvidence('t1', ['0', '1']);
      expect(unknown).toEqual([]);
    });

    it('accepts step-N prefix variants', async () => {
      await storage.write('t1', [
        {
          taskId: 't1',
          stepNumber: 3,
          tool: 'web_search',
          args: '{}',
          resultSummary: 'ok',
          ok: true,
          durationMs: 5,
          ts: Date.now(),
        },
      ]);
      const unknown = await validateEvidence('t1', ['step-3']);
      expect(unknown).toEqual([]);
    });

    it('accepts tool-name references', async () => {
      await storage.write('t1', [
        {
          taskId: 't1',
          stepNumber: 0,
          tool: 'web_fetch_markdown',
          args: '{}',
          resultSummary: 'ok',
          ok: true,
          durationMs: 5,
          ts: Date.now(),
        },
      ]);
      const unknown = await validateEvidence('t1', ['web_fetch_markdown']);
      expect(unknown).toEqual([]);
    });

    it('flags unknown evidence ids', async () => {
      await storage.write('t1', [
        {
          taskId: 't1',
          stepNumber: 0,
          tool: 'web_search',
          args: '{}',
          resultSummary: 'ok',
          ok: true,
          durationMs: 5,
          ts: Date.now(),
        },
      ]);
      const unknown = await validateEvidence('t1', ['99', 'phantom-tool']);
      expect(unknown.sort()).toEqual(['99', 'phantom-tool']);
    });
  });

  describe('handleUnifiedDone', () => {
    function makeCtx(taskId = 'task-x'): { taskId: string; finalAnswer: string | null } {
      return { taskId, finalAnswer: null };
    }

    it('rejects empty evidence with a repair-loop error', async () => {
      const ctx = makeCtx();
      const result = await handleUnifiedDone(ctx as never, {
        text: 'I think the answer is X',
        success: true,
        evidence: [],
        confidence: 0.9,
      });
      expect(result.error).toBeTruthy();
      expect(result.error).toContain('evidence required');
      expect(result.isDone).toBe(false);
    });

    it('rejects unknown evidence references', async () => {
      const ctx = makeCtx('t-unknown');
      await storage.write('t-unknown', [
        {
          taskId: 't-unknown',
          stepNumber: 0,
          tool: 'web_search',
          args: '{}',
          resultSummary: 'ok',
          ok: true,
          durationMs: 5,
          ts: Date.now(),
        },
      ]);
      const result = await handleUnifiedDone(ctx as never, {
        text: 'X',
        success: true,
        evidence: ['42'],
        confidence: 0.9,
      });
      expect(result.error).toBeTruthy();
      expect(result.error).toContain('42');
      expect(result.isDone).toBe(false);
    });

    it('accepts done with valid evidence and sets finalAnswer', async () => {
      const ctx = makeCtx('t-ok');
      await storage.write('t-ok', [
        {
          taskId: 't-ok',
          stepNumber: 0,
          tool: 'web_search',
          args: '{}',
          resultSummary: 'ok',
          ok: true,
          durationMs: 5,
          ts: Date.now(),
        },
      ]);
      const result = await handleUnifiedDone(ctx as never, {
        text: 'DeepSeek-V4 is a leading open-source coding LLM.',
        success: true,
        evidence: ['0'],
        confidence: 0.9,
      });
      expect(result.error).toBeNull();
      expect(result.isDone).toBe(true);
      expect(result.success).toBe(true);
      expect(ctx.finalAnswer).toBe('DeepSeek-V4 is a leading open-source coding LLM.');
    });
  });
});
