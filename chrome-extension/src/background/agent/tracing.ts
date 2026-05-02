/**
 * Browd agent tracing — T0 Observability.
 *
 * Goal: every tool invocation produces a structured record so traces are
 * diffable and post-hoc debuggable. Free-form `STEP_TRACE` strings are kept
 * for legacy events but new code should write through this Tracer.
 *
 * Storage: chrome.storage.local (`browd:trace:<taskId>` key, ring buffer of
 * up to MAX_ENTRIES_PER_TASK records). The extension already requests
 * `unlimitedStorage`, so this is safe.
 *
 * Read order before editing: auto-docs/browd-agent-evolution.md (Tier 0).
 */
import { createLogger } from '@src/background/log';

const logger = createLogger('Tracer');

const STORAGE_PREFIX = 'browd:trace:';
const MAX_ENTRIES_PER_TASK = 200;
const ARGS_PREVIEW_LIMIT = 200;
const RESULT_PREVIEW_LIMIT = 300;

export interface TraceEntry {
  taskId: string;
  stepNumber: number;
  /** Tool name from the action schema (e.g. 'click_element'). */
  tool: string;
  /** Compact JSON preview of the input args, truncated. */
  args: string;
  /** Compact preview of the tool result or error, truncated. */
  resultSummary: string;
  ok: boolean;
  durationMs: number;
  /** Wall-clock timestamp (epoch ms). */
  ts: number;
  /** Optional sub-categorisation for trace UI rendering. */
  kind?: 'browser' | 'web' | 'meta';
  /**
   * T2f-1.5: optional downscaled image payload (base64 JPEG, ≈ 256×144,
   * q=0.6, ~5-10 KB). Set by the screenshot tool. Side panel renders
   * it inline as a chat thumbnail and clicking opens the same
   * thumbnail in a new tab via `data:` URL. Persisting in the trace
   * ring buffer is intentional — the user's whole reason for asking
   * was self-hosted observability of every captured frame.
   */
  imageThumbBase64?: string;
  imageThumbMime?: string;
}

export interface TraceStorage {
  read(taskId: string): Promise<TraceEntry[]>;
  write(taskId: string, entries: TraceEntry[]): Promise<void>;
  clear(taskId: string): Promise<void>;
  listTaskIds(): Promise<string[]>;
}

/** chrome.storage.local backend. Used by the extension at runtime. */
export class ChromeTraceStorage implements TraceStorage {
  async read(taskId: string): Promise<TraceEntry[]> {
    const key = STORAGE_PREFIX + taskId;
    const result = await chrome.storage.local.get(key);
    const value = result[key];
    return Array.isArray(value) ? (value as TraceEntry[]) : [];
  }

  async write(taskId: string, entries: TraceEntry[]): Promise<void> {
    const key = STORAGE_PREFIX + taskId;
    await chrome.storage.local.set({ [key]: entries });
  }

  async clear(taskId: string): Promise<void> {
    const key = STORAGE_PREFIX + taskId;
    await chrome.storage.local.remove(key);
  }

  async listTaskIds(): Promise<string[]> {
    const all = await chrome.storage.local.get(null);
    return Object.keys(all)
      .filter(k => k.startsWith(STORAGE_PREFIX))
      .map(k => k.slice(STORAGE_PREFIX.length));
  }
}

/** Test-only in-memory backend. */
export class InMemoryTraceStorage implements TraceStorage {
  private store = new Map<string, TraceEntry[]>();

  async read(taskId: string): Promise<TraceEntry[]> {
    return this.store.get(taskId) ?? [];
  }
  async write(taskId: string, entries: TraceEntry[]): Promise<void> {
    this.store.set(taskId, entries);
  }
  async clear(taskId: string): Promise<void> {
    this.store.delete(taskId);
  }
  async listTaskIds(): Promise<string[]> {
    return Array.from(this.store.keys());
  }
}

function previewArgs(args: unknown): string {
  try {
    const json = JSON.stringify(args);
    if (!json) return '';
    return json.length > ARGS_PREVIEW_LIMIT ? `${json.slice(0, ARGS_PREVIEW_LIMIT)}…` : json;
  } catch {
    return '<unserialisable>';
  }
}

function previewResult(value: unknown): string {
  let text: string;
  if (value == null) {
    text = '';
  } else if (typeof value === 'string') {
    text = value;
  } else if (typeof value === 'object') {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  } else {
    text = String(value);
  }
  return text.length > RESULT_PREVIEW_LIMIT ? `${text.slice(0, RESULT_PREVIEW_LIMIT)}…` : text;
}

/**
 * Per-task tracer. The agent runtime keeps one global instance and switches
 * its active task at the start of each task via `setContext`.
 *
 * Recording is fire-and-forget: `record()` updates the in-memory buffer
 * synchronously and triggers a debounced flush so the agent loop never
 * waits on storage. Final `flush()` is best-effort at task end.
 */
export class Tracer {
  private buffer: TraceEntry[] = [];
  private activeTaskId: string | null = null;
  private activeStepNumber = 0;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private flushDelayMs = 500;
  private listeners = new Set<(entry: TraceEntry) => void>();

  constructor(private readonly storage: TraceStorage = new ChromeTraceStorage()) {}

  /** Bind subsequent `record()` calls to this task. Resets the in-memory buffer. */
  setContext(ctx: { taskId: string; stepNumber: number }): void {
    if (this.activeTaskId !== ctx.taskId) {
      this.flushSync();
      this.buffer = [];
    }
    this.activeTaskId = ctx.taskId;
    this.activeStepNumber = ctx.stepNumber;
  }

  setStep(stepNumber: number): void {
    this.activeStepNumber = stepNumber;
  }

  /** Subscribe to live trace entries (for the side-panel TracePanel). */
  subscribe(listener: (entry: TraceEntry) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Record one structured tool invocation. Non-blocking. */
  record(input: {
    tool: string;
    args: unknown;
    result?: unknown;
    ok: boolean;
    durationMs: number;
    kind?: TraceEntry['kind'];
    /** T2f-1.5: optional thumbnail base64 attached to the entry. */
    imageThumbBase64?: string;
    imageThumbMime?: string;
  }): void {
    if (!this.activeTaskId) {
      // Drop silently — nothing to attribute it to. Caller forgot setContext.
      logger.warning('Tracer.record called without active task context, dropping entry');
      return;
    }
    const entry: TraceEntry = {
      taskId: this.activeTaskId,
      stepNumber: this.activeStepNumber,
      tool: input.tool,
      args: previewArgs(input.args),
      resultSummary: previewResult(input.result),
      ok: input.ok,
      durationMs: Math.max(0, Math.round(input.durationMs)),
      ts: Date.now(),
      kind: input.kind,
      imageThumbBase64: input.imageThumbBase64,
      imageThumbMime: input.imageThumbMime,
    };
    this.buffer.push(entry);
    if (this.buffer.length > MAX_ENTRIES_PER_TASK) {
      this.buffer = this.buffer.slice(-MAX_ENTRIES_PER_TASK);
    }
    for (const listener of this.listeners) {
      try {
        listener(entry);
      } catch (err) {
        logger.warning('trace listener threw', err);
      }
    }
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      void this.flush();
    }, this.flushDelayMs);
  }

  /** Persist the in-memory buffer to storage. Safe to call multiple times. */
  async flush(): Promise<void> {
    if (!this.activeTaskId || this.buffer.length === 0) return;
    try {
      await this.storage.write(this.activeTaskId, [...this.buffer]);
    } catch (err) {
      logger.error('Failed to flush trace buffer', err);
    }
  }

  private flushSync(): void {
    // Best-effort fire-and-forget for context switches.
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.activeTaskId && this.buffer.length > 0) {
      void this.flush();
    }
  }

  async read(taskId: string): Promise<TraceEntry[]> {
    return this.storage.read(taskId);
  }

  async listTaskIds(): Promise<string[]> {
    return this.storage.listTaskIds();
  }

  async clear(taskId: string): Promise<void> {
    if (this.activeTaskId === taskId) {
      this.buffer = [];
    }
    await this.storage.clear(taskId);
  }
}

/** Singleton used across the background runtime. */
export const globalTracer = new Tracer();
