/**
 * T2v — `streamBridge` consumes `compiled.streamEvents()` from
 * LangGraph (`version: 'v2'`) and turns selected events into typed
 * `LiveEvent` messages so the side panel can render a live status
 * strip during long LLM rounds. Returns the final `{messages}` state
 * the existing `invoke()` consumer already expects.
 *
 * Why a separate module: keeps `runReactAgent.ts` under its 985-line
 * post-fix ceiling and centralises the throttle / filter / final-state
 * extraction logic in one place that is straightforward to unit-test.
 *
 * Throttle policy: token-stream events fire at the LLM's chunk rate
 * (often >100/s on streaming providers). Emitting one IPC per chunk
 * floods the side-panel port. We sample at most one emit per
 * `TOKEN_EMIT_THROTTLE_MS` per run OR every `TOKEN_EMIT_EVERY_N`
 * tokens — whichever fires later. This gives a smooth refresh rate
 * (~5/s) without per-token cost.
 *
 * Final-state extraction: `streamEvents` does not return state like
 * `invoke()` does. The StateGraph root emits an `on_chain_end` whose
 * `data.output` carries the full Annotation.Root shape — for
 * runReactAgent that means `pastSteps` plus `plan` / `taskParameters`
 * / `response`. We detect the root by SHAPE (not by name), which is
 * stable across LangGraph version renames: any chain-end output that
 * has `pastSteps` (the marker key set by the agent node every round)
 * is our root. Additional defensive fallback: last seen object-typed
 * chain-end output, in case a future schema change drops `pastSteps`.
 */

import type { BaseMessage } from '@langchain/core/messages';

/** Discriminated union the side panel decodes. */
export type LiveEvent =
  | { kind: 'llm_streaming'; runId: string; model: string; tokensSoFar: number; msElapsed: number; ratePerSec: number }
  | { kind: 'tool_start'; runId: string; name: string; argsPreview: string }
  | { kind: 'tool_end'; runId: string; name: string; ok: boolean; ms: number }
  | { kind: 'node'; name: string; state: 'start' | 'end' }
  | { kind: 'idle' };

const TOKEN_EMIT_THROTTLE_MS = 200;
const TOKEN_EMIT_EVERY_N = 50;
/** Graph nodes worth surfacing as "now running: planner" pills. */
const SURFACED_NODE_NAMES = new Set(['planner', 'agent', 'replanner']);

/**
 * Shape-based detection of the root StateGraph output. The runReactAgent
 * StateGraph annotation always carries `pastSteps` (assigned by the
 * agent node every round); inner node outputs (planner emits
 * `{plan, taskParameters}`, replanner emits `{plan}` or `{response}`)
 * do NOT carry it. This avoids hard-coding `'LangGraph'` as the root
 * name, which the advisor flagged as a silent-break risk if LangGraph
 * ever renames it.
 */
function looksLikeRootStateOutput(output: unknown): boolean {
  if (!output || typeof output !== 'object') return false;
  const o = output as Record<string, unknown>;
  return Array.isArray(o.pastSteps);
}

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

function previewArgs(input: unknown): string {
  try {
    const s = typeof input === 'string' ? input : JSON.stringify(input);
    if (!s) return '';
    return s.length > 80 ? `${s.slice(0, 80)}…` : s;
  } catch {
    return '';
  }
}

/** Extract a printable model id from a `on_chat_model_start` event. */
function extractModelName(ev: StreamEvent): string {
  const meta = ev.metadata as { ls_model_name?: string; ls_provider?: string } | undefined;
  return meta?.ls_model_name ?? meta?.ls_provider ?? ev.name ?? 'model';
}

/**
 * Consume a LangGraph `streamEvents` iterable, emit filtered live
 * events via `emit`, and return the final `{messages}` state for the
 * caller. The caller can throw / propagate AbortError as it would
 * for `invoke()`. `signal` is optional but recommended: it is checked
 * at the top of every iteration so a hung provider's read does not
 * keep the iterator alive after Stop.
 */
export async function bridgeStreamEvents<T = { messages: BaseMessage[] }>(
  iterable: AsyncIterable<StreamEvent>,
  emit: (msg: LiveEvent) => void,
  signal?: AbortSignal,
): Promise<T> {
  const tokenCounts = new Map<string, { count: number; lastEmitAt: number; startAt: number; model: string }>();
  const toolStarts = new Map<string, number>();
  let rootOutput: unknown = null;
  let lastChainOutput: unknown = null;

  for await (const ev of iterable) {
    if (signal?.aborted) {
      // Drop further iteration; caller will surface the AbortError.
      break;
    }
    switch (ev.event) {
      case 'on_chat_model_start': {
        const runId = ev.run_id ?? '';
        tokenCounts.set(runId, { count: 0, lastEmitAt: 0, startAt: Date.now(), model: extractModelName(ev) });
        break;
      }
      case 'on_chat_model_stream': {
        const runId = ev.run_id ?? '';
        const entry = tokenCounts.get(runId);
        if (!entry) break;
        entry.count += 1;
        const now = Date.now();
        const sinceLast = now - entry.lastEmitAt;
        if (sinceLast < TOKEN_EMIT_THROTTLE_MS && entry.count % TOKEN_EMIT_EVERY_N !== 0) break;
        entry.lastEmitAt = now;
        const msElapsed = now - entry.startAt;
        const ratePerSec = msElapsed > 0 ? Math.round((entry.count * 1000) / msElapsed) : 0;
        emit({ kind: 'llm_streaming', runId, model: entry.model, tokensSoFar: entry.count, msElapsed, ratePerSec });
        break;
      }
      case 'on_chat_model_end': {
        tokenCounts.delete(ev.run_id ?? '');
        emit({ kind: 'idle' });
        break;
      }
      case 'on_tool_start': {
        const runId = ev.run_id ?? '';
        toolStarts.set(runId, Date.now());
        emit({ kind: 'tool_start', runId, name: ev.name ?? 'tool', argsPreview: previewArgs(ev.data?.input) });
        break;
      }
      case 'on_tool_end': {
        const runId = ev.run_id ?? '';
        const start = toolStarts.get(runId) ?? Date.now();
        toolStarts.delete(runId);
        const out = ev.data?.output as { ok?: boolean } | undefined;
        const ok = out?.ok !== false;
        emit({ kind: 'tool_end', runId, name: ev.name ?? 'tool', ok, ms: Date.now() - start });
        emit({ kind: 'idle' });
        break;
      }
      case 'on_chain_start': {
        if (ev.name && SURFACED_NODE_NAMES.has(ev.name)) emit({ kind: 'node', name: ev.name, state: 'start' });
        break;
      }
      case 'on_chain_end': {
        if (ev.name && SURFACED_NODE_NAMES.has(ev.name)) emit({ kind: 'node', name: ev.name, state: 'end' });
        const out = ev.data?.output;
        // Shape-based root detection (see module header) — robust to
        // future LangGraph renames. Always pick the LATEST root-shaped
        // output so the final state reflects the last replanner write.
        if (looksLikeRootStateOutput(out)) rootOutput = out;
        if (out && typeof out === 'object') lastChainOutput = out;
        break;
      }
      default:
        break;
    }
  }

  const final = (rootOutput ?? lastChainOutput) as unknown;
  if (final && typeof final === 'object') {
    return final as T;
  }
  return { messages: [] as BaseMessage[] } as unknown as T;
}
