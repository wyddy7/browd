/**
 * T2f-streaming-rep-guard — stream-side abort on degenerate generation.
 *
 * Schema-level `.max(N)` is post-hoc Zod validation; it does NOT cut the
 * LLM stream while it's looping. Some providers (notably Gemini Pro under
 * structured-output mode) ignore string-length hints and emit kilobytes of
 * the same sentence repeated, which streams to the side-panel UI in
 * real-time before any validation runs.
 *
 * This callback handler watches token streams per-run, accumulates the
 * last N chars, and aborts the run when a 60+ char substring appears 3+
 * times within the recent window. The signal is set on a shared
 * AbortController which the caller passes into invoke({ signal }).
 *
 * Detection heuristic: walk a sliding window of the most recent
 * `windowChars` characters. If any substring of length >= `minChunk` is
 * present at >= `maxRepeats` non-overlapping positions, we have a loop.
 *
 * False-positive mitigation: only checks substrings of length
 * `minChunk` (60 chars by default) — short n-grams like "the " repeat
 * naturally and aren't loops. 60+ char chunks repeating 3 times means
 * the model is restating a whole clause.
 */

import { BaseCallbackHandler } from '@langchain/core/callbacks/base';
import { createLogger } from '@src/background/log';

const logger = createLogger('streamingRepetitionGuard');

const DEFAULT_WINDOW_CHARS = 1500;
const DEFAULT_MIN_CHUNK = 60;
const DEFAULT_MAX_REPEATS = 3;

interface RunState {
  buffer: string;
  aborted: boolean;
}

export class StreamingRepetitionGuard extends BaseCallbackHandler {
  name = 'StreamingRepetitionGuard';

  private readonly runs = new Map<string, RunState>();

  constructor(
    private readonly controller: AbortController,
    private readonly windowChars = DEFAULT_WINDOW_CHARS,
    private readonly minChunk = DEFAULT_MIN_CHUNK,
    private readonly maxRepeats = DEFAULT_MAX_REPEATS,
  ) {
    super();
  }

  override handleLLMStart(): void {
    // run state is created lazily on first token
  }

  override handleLLMNewToken(token: string, _idx: unknown, runId: string): void {
    if (this.controller.signal.aborted) return;
    let state = this.runs.get(runId);
    if (!state) {
      state = { buffer: '', aborted: false };
      this.runs.set(runId, state);
    }
    if (state.aborted) return;
    state.buffer += token;
    // keep a sliding window — older content can't form repetitions with
    // the current tail anyway, so trim aggressively.
    if (state.buffer.length > this.windowChars) {
      state.buffer = state.buffer.slice(-this.windowChars);
    }
    if (this.detectsLoop(state.buffer)) {
      state.aborted = true;
      logger.warning(
        `streaming repetition detected (runId=${runId.slice(0, 8)}) — aborting LLM call. tail=${JSON.stringify(state.buffer.slice(-200))}`,
      );
      this.controller.abort(new Error('streaming repetition guard: degenerate output detected'));
    }
  }

  override handleLLMEnd(_output: unknown, runId: string): void {
    this.runs.delete(runId);
  }

  override handleLLMError(_err: unknown, runId: string): void {
    this.runs.delete(runId);
  }

  /**
   * Cheap substring-repetition check. Looks at the last `windowChars`
   * of buffered output; samples a few candidate chunks of length
   * `minChunk` from the most recent ~300 chars (where a loop, if
   * present, would have just repeated); for each candidate, counts
   * non-overlapping occurrences in the full window. >= maxRepeats wins.
   */
  private detectsLoop(buffer: string): boolean {
    if (buffer.length < this.minChunk * this.maxRepeats) return false;
    // candidate offsets: take the last `minChunk*2` chars and sample
    // every `minChunk/2` step. Cheap, deterministic.
    const tailStart = Math.max(0, buffer.length - this.minChunk * 2);
    const tail = buffer.slice(tailStart);
    const step = Math.max(8, Math.floor(this.minChunk / 4));
    for (let i = 0; i + this.minChunk <= tail.length; i += step) {
      const candidate = tail.slice(i, i + this.minChunk);
      if (this.countNonOverlapping(buffer, candidate) >= this.maxRepeats) {
        return true;
      }
    }
    return false;
  }

  private countNonOverlapping(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const idx = haystack.indexOf(needle, from);
      if (idx === -1) break;
      count += 1;
      from = idx + needle.length;
    }
    return count;
  }
}
