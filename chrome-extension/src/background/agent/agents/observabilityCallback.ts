/**
 * T2m-observability — LLM call lifecycle logging.
 *
 * Background: prior to T2m the only LangChain callback wired on
 * `runReactAgent` was `handleLLMEnd` (for token-usage accounting). When
 * an LLM call hung, errored, or LangChain's built-in `maxRetries`
 * silently retried, the Service Worker produced ZERO log output and
 * the side panel showed no movement — indistinguishable from a
 * crashed extension. test6 captured a 9-minute silent burn caused by
 * exactly this gap.
 *
 * This module returns a `CallbackHandlerMethods` object that:
 *   - logs LLM start / end / error / streaming-progress to the SW console
 *   - logs chain (planner / agent step / replanner) start / end boundaries
 *   - logs raw tool errors (distinct from langGraphAdapter's dupGuard /
 *     ratelimit messages, which are application-level)
 *   - emits structured `kind:'meta'` entries to `globalTracer` so the
 *     side-panel TRACE row shows live progress and explicit error rows
 *     without needing devtools.
 *
 * Pure side-effect logging — never throws back into the caller, never
 * mutates agent state, never adds guards. The Caskad halt rule still
 * applies here: this is observability, not control flow.
 *
 * Acceptance: see `auto-docs/browd-agent-evolution.md` → T2m-observability.
 */
import type { CallbackHandlerMethods } from '@langchain/core/callbacks/base';
import type { LLMResult } from '@langchain/core/outputs';
import { createLogger } from '@src/background/log';
import { globalTracer } from '../tracing';

const logger = createLogger('observability');

/** Sample every Nth streaming token to avoid log spam on long generations. */
const TOKEN_SAMPLE_EVERY = 20;
/** Maximum input-message bytes summarised on llm-start — bound the log line size. */
const LAST_MESSAGE_BYTES_CAP = 200;

interface ObservabilityCallbackOptions {
  /**
   * Optional task identifier injected by the caller for log prefixing. The
   * tracer itself already knows the active task via `setContext`, this is
   * purely cosmetic for the console.
   */
  taskId?: string;
}

interface SerializedLike {
  id?: string[];
  name?: string;
  kwargs?: { model?: string; modelName?: string };
}

function extractModelName(serialized: unknown): string {
  const s = serialized as SerializedLike | undefined;
  if (!s) return 'unknown';
  return s.kwargs?.model ?? s.kwargs?.modelName ?? s.name ?? s.id?.[s.id.length - 1] ?? 'unknown';
}

function llmResultHasToolCalls(output: LLMResult | undefined): boolean {
  if (!output?.generations) return false;
  for (const generation of output.generations) {
    for (const item of generation) {
      const msg = (item as { message?: { tool_calls?: unknown[] } }).message;
      const toolCalls = msg?.tool_calls;
      if (Array.isArray(toolCalls) && toolCalls.length > 0) return true;
    }
  }
  return false;
}

interface ErrorLike {
  name?: string;
  message?: string;
  status?: number;
  // OpenAI-style error.response.status
  response?: { status?: number };
  code?: string | number;
}

function summariseError(err: unknown): { name: string; status: number | string | undefined; message: string } {
  const e = err as ErrorLike | undefined;
  return {
    name: e?.name ?? 'Error',
    status: e?.status ?? e?.response?.status ?? e?.code,
    message: typeof e?.message === 'string' ? e.message : String(err),
  };
}

/**
 * Build the observability callback handler. Closure-private state:
 *   - `runStart` maps `runId` → start timestamp so `handleLLMEnd` /
 *     `handleLLMError` can report elapsed ms.
 *   - `tokenCounts` maps `runId` → cumulative streaming token count so
 *     the sampled progress log shows total-so-far, not just per-fire.
 */
export function createObservabilityCallback(opts: ObservabilityCallbackOptions = {}): CallbackHandlerMethods {
  const runStart = new Map<string, number>();
  const tokenCounts = new Map<string, number>();
  const prefix = opts.taskId ? `[task=${opts.taskId}]` : '';

  return {
    handleLLMStart(llm, prompts, runId, _parentRunId, extraParams, _tags, _metadata, runName) {
      runStart.set(runId, Date.now());
      tokenCounts.set(runId, 0);
      const model = extractModelName(llm);
      const messageCount = Array.isArray(prompts) ? prompts.length : 0;
      const lastMessage = messageCount > 0 ? (prompts[messageCount - 1] ?? '') : '';
      const lastMessageBytes = Math.min(lastMessage.length, LAST_MESSAGE_BYTES_CAP);
      logger.info(
        `${prefix}llm call start (runId=${runId.slice(0, 8)} model=${model} messages=${messageCount} lastBytes=${lastMessageBytes}${runName ? ` name=${runName}` : ''})`,
      );
      // Side-panel TRACE row: 'llm_call' with state=start. The
      // companion 'end' / 'error' entry below uses the same tool name
      // so they group naturally in the trace view.
      try {
        globalTracer.record({
          tool: 'llm_call',
          args: { runId, model, state: 'start', messages: messageCount, name: runName ?? null },
          result: `calling ${model}…`,
          ok: true,
          durationMs: 0,
          kind: 'meta',
        });
      } catch (e) {
        logger.warning('tracer.record(llm_call start) threw', e);
      }
      // `extraParams` intentionally unused — would contain provider
      // request kwargs which can include API keys via headers.
      void extraParams;
    },

    handleLLMEnd(output, runId) {
      const start = runStart.get(runId);
      const elapsedMs = start ? Date.now() - start : -1;
      runStart.delete(runId);
      tokenCounts.delete(runId);
      const hasToolCalls = llmResultHasToolCalls(output);
      const usage = output?.llmOutput as
        | { tokenUsage?: { promptTokens?: number; completionTokens?: number } }
        | undefined;
      const inTokens = usage?.tokenUsage?.promptTokens ?? 0;
      const outTokens = usage?.tokenUsage?.completionTokens ?? 0;
      logger.info(
        `${prefix}llm call end (runId=${runId.slice(0, 8)} ms=${elapsedMs} in=${inTokens} out=${outTokens} toolCalls=${hasToolCalls})`,
      );
      try {
        globalTracer.record({
          tool: 'llm_call',
          args: { runId, state: 'end', elapsedMs, hasToolCalls },
          result: `done in ${elapsedMs}ms${hasToolCalls ? ' (tool calls emitted)' : ''}`,
          ok: true,
          durationMs: Math.max(0, elapsedMs),
          kind: 'meta',
        });
      } catch (e) {
        logger.warning('tracer.record(llm_call end) threw', e);
      }
    },

    handleLLMError(err, runId) {
      const start = runStart.get(runId);
      const elapsedMs = start ? Date.now() - start : -1;
      runStart.delete(runId);
      tokenCounts.delete(runId);
      const { name, status, message } = summariseError(err);
      // CRITICAL — this is the line that closes the silent-burn root
      // cause. Without it an HTTP 401 / timeout / network reset
      // produces no console output at all.
      logger.warning(
        `${prefix}llm call error (runId=${runId.slice(0, 8)} ms=${elapsedMs} ${name}${status !== undefined ? ` status=${status}` : ''}: ${message})`,
      );
      try {
        globalTracer.record({
          tool: 'llm_call',
          args: { runId, state: 'error', elapsedMs, errorName: name, status },
          result: `${name}${status !== undefined ? ` (${status})` : ''}: ${message}`,
          ok: false,
          durationMs: Math.max(0, elapsedMs),
          kind: 'meta',
        });
      } catch (e) {
        logger.warning('tracer.record(llm_call error) threw', e);
      }
    },

    handleLLMNewToken(_token, _idx, runId) {
      const next = (tokenCounts.get(runId) ?? 0) + 1;
      tokenCounts.set(runId, next);
      if (next % TOKEN_SAMPLE_EVERY !== 0) return;
      const start = runStart.get(runId) ?? Date.now();
      const elapsedMs = Date.now() - start;
      logger.info(`${prefix}llm streaming progress (runId=${runId.slice(0, 8)} tokens=${next} ms=${elapsedMs})`);
      // Deliberately NOT calling globalTracer here — the trace row
      // already shows the live 'llm_call start' entry; a per-N-token
      // ping would clutter the panel. The Service Worker log is the
      // higher-fidelity surface for streaming progress.
    },

    handleChainStart(chain, _inputs, runId, _parentRunId, _tags, _metadata, _runType, runName) {
      runStart.set(runId, Date.now());
      const name = runName ?? (chain as SerializedLike | undefined)?.name ?? 'chain';
      // T2r-observability-2 (2026-05-15): chain start/end events
      // are LangGraph internals (ChannelWrite, prompt, RunnableLambda,
      // Branch, __start__/__end__, StructuredOutputParser…) — they
      // describe HOW the graph is wired, not WHAT the agent did.
      // test12.md showed ~400 such rows in the side-panel TRACE pane
      // drowning the signal. Drop the tracer record entirely; the
      // user-visible trace now shows only:
      //   - tool calls (from actions/builder.ts via Action.call)
      //   - llm_call start/end (this file, below)
      //   - tool_error (this file, below)
      // Console line stays at debug so a dev build can still surface
      // graph internals when investigating LangGraph plumbing.
      logger.debug(`${prefix}chain start (runId=${runId.slice(0, 8)} name=${name})`);
    },

    handleChainEnd(_outputs, runId) {
      const start = runStart.get(runId);
      const elapsedMs = start ? Date.now() - start : -1;
      runStart.delete(runId);
      // T2r-observability-2: see handleChainStart comment.
      logger.debug(`${prefix}chain end (runId=${runId.slice(0, 8)} ms=${elapsedMs})`);
    },

    handleToolError(err, runId) {
      const { name, status, message } = summariseError(err);
      logger.warning(
        `${prefix}tool call error (runId=${runId.slice(0, 8)} ${name}${status !== undefined ? ` status=${status}` : ''}: ${message})`,
      );
      try {
        globalTracer.record({
          tool: 'tool_error',
          args: { runId, errorName: name, status },
          result: `${name}: ${message}`,
          ok: false,
          durationMs: 0,
          kind: 'meta',
        });
      } catch (e) {
        logger.warning('tracer.record(tool_error) threw', e);
      }
    },
  };
}
