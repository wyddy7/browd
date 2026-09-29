import type { AgentContext } from '../types';
import { Actors, ExecutionState } from '../event/types';
import { createLogger } from '@src/background/log';

const logger = createLogger('usageTracker');

/** Per-run accounting, separate from task control flow. */
export function createUsageTracker(context: AgentContext, contextWindow = 100_000) {
  // T2f-final-fix-2 — accumulate token usage via LangChain callback so
  // every LLM end (planner / agent steps / replanner) feeds the ring.
  let cumulativeIn = 0;
  let cumulativeOut = 0;
  let cumulativeCacheRead = 0;
  let cumulativeCacheCreation = 0;
  let cacheTelemetrySeen = false;
  // Track last-emitted totals so emitUsage() sends DELTAS (the side-panel
  // accumulates across invokes via setTokenUsage(prev => prev + parsed)).
  let lastEmittedIn = 0;
  let lastEmittedOut = 0;
  let lastEmittedCacheRead = 0;
  let lastEmittedCacheCreation = 0;
  const usageCallback = {
    handleLLMEnd: (output: unknown) => {
      const o = output as {
        llmOutput?: {
          tokenUsage?: { promptTokens?: number; completionTokens?: number };
          usage?: {
            input_tokens?: number;
            output_tokens?: number;
            cache_read_input_tokens?: number;
            cache_creation_input_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
          };
        };
        generations?: Array<
          Array<{
            message?: {
              usage_metadata?: {
                input_tokens?: number;
                output_tokens?: number;
                input_token_details?: { cache_read?: number; cache_creation?: number; cached_tokens?: number };
              };
              response_metadata?: {
                usage?: {
                  input_tokens?: number;
                  output_tokens?: number;
                  cache_read_input_tokens?: number;
                  cache_creation_input_tokens?: number;
                  prompt_tokens_details?: { cached_tokens?: number; cache_write_tokens?: number };
                };
              };
            };
          }>
        >;
      };
      const fromLlmOutput = o.llmOutput?.tokenUsage
        ? { input: o.llmOutput.tokenUsage.promptTokens ?? 0, output: o.llmOutput.tokenUsage.completionTokens ?? 0 }
        : o.llmOutput?.usage
          ? { input: o.llmOutput.usage.input_tokens ?? 0, output: o.llmOutput.usage.output_tokens ?? 0 }
          : null;
      let dIn = fromLlmOutput?.input ?? 0;
      let dOut = fromLlmOutput?.output ?? 0;
      let dCacheRead = 0;
      let dCacheCreation = 0;
      // Cache-token extraction — provider-agnostic, parses every nesting
      // location populated by LangChain JS ChatAnthropic / ChatOpenAI /
      // ChatGoogleGenerativeAI / ChatVertexAI / OpenRouter (OpenAI-compat).
      // Field name catalogue (verified empirically 2026-05-16 against
      // OpenRouter+Gemini-2.5-Flash; documented in agent research report):
      //   - usage_metadata.input_token_details.cache_read         ← LangChain cross-provider standard
      //   - usage_metadata.input_token_details.cache_creation     ← same
      //   - usage_metadata.input_token_details.cached_tokens      ← upstream alias (some PRs)
      //   - llmOutput.usage.cache_read_input_tokens               ← Anthropic raw
      //   - llmOutput.usage.cache_creation_input_tokens           ← Anthropic raw
      //   - llmOutput.usage.prompt_tokens_details.cached_tokens   ← OpenAI / OpenRouter reads
      //   - llmOutput.usage.prompt_tokens_details.cache_write_tokens ← OpenRouter explicit writes
      //   - response_metadata.usage.* mirrors of the above
      // Adding a new provider rarely needs new code — start by trusting
      // usage_metadata.input_token_details (the LangChain standard).
      // The locations above mirror one another for the same call, so each
      // counter takes ONE source: standard → response_metadata.usage →
      // llmOutput.usage. Summing them double-counted OpenAI-compatible
      // streams and triple-counted Anthropic non-streaming responses.
      let cacheReadSeen = false;
      let cacheCreationSeen = false;
      if (Array.isArray(o.generations)) {
        for (const generation of o.generations) {
          for (const item of generation) {
            const u = item.message?.usage_metadata ?? item.message?.response_metadata?.usage;
            if (u) {
              if (!dIn && !dOut) {
                dIn += u.input_tokens ?? 0;
                dOut += u.output_tokens ?? 0;
              }
              const um = item.message?.usage_metadata?.input_token_details;
              const ur = item.message?.response_metadata?.usage;
              const read =
                um?.cache_read ??
                um?.cached_tokens ??
                ur?.cache_read_input_tokens ??
                ur?.prompt_tokens_details?.cached_tokens;
              const creation =
                um?.cache_creation ?? ur?.cache_creation_input_tokens ?? ur?.prompt_tokens_details?.cache_write_tokens;
              if (read != null) {
                dCacheRead += read;
                cacheReadSeen = true;
              }
              if (creation != null) {
                dCacheCreation += creation;
                cacheCreationSeen = true;
              }
            }
          }
        }
      }
      const u0 = o.llmOutput?.usage;
      if (u0) {
        if (!cacheReadSeen) dCacheRead += u0.cache_read_input_tokens ?? u0.prompt_tokens_details?.cached_tokens ?? 0;
        if (!cacheCreationSeen) {
          dCacheCreation += u0.cache_creation_input_tokens ?? u0.prompt_tokens_details?.cache_write_tokens ?? 0;
        }
      }
      if (dIn || dOut) {
        cumulativeIn += dIn;
        cumulativeOut += dOut;
        cumulativeCacheRead += dCacheRead;
        cumulativeCacheCreation += dCacheCreation;
        const cacheSuffix =
          dCacheRead || dCacheCreation || cacheTelemetrySeen
            ? ` | cache: +${dCacheRead} read / +${dCacheCreation} write (cum ${cumulativeCacheRead}/${cumulativeCacheCreation})`
            : '';
        if (dCacheRead || dCacheCreation) cacheTelemetrySeen = true;
        logger.info(`usage tick: +${dIn} in / +${dOut} out (cum ${cumulativeIn}/${cumulativeOut})${cacheSuffix}`);
        // Live-emit so the side-panel TokenRing grows in real time
        // instead of jumping once at task-end. emitUsage is idempotent
        // (sends only unreported deltas), so the final flush does not
        // count tokens a second time.
        emitUsage();
      }
    },
  };
  const emitUsage = () => {
    const dIn = cumulativeIn - lastEmittedIn;
    const dOut = cumulativeOut - lastEmittedOut;
    const dCacheRead = cumulativeCacheRead - lastEmittedCacheRead;
    const dCacheCreation = cumulativeCacheCreation - lastEmittedCacheCreation;
    if (dIn || dOut || dCacheRead || dCacheCreation) {
      context.emitEvent(
        Actors.SYSTEM,
        ExecutionState.TASK_USAGE,
        JSON.stringify({
          inputTokens: dIn,
          outputTokens: dOut,
          cacheReadTokens: dCacheRead,
          cacheCreationTokens: dCacheCreation,
          contextWindow: contextWindow,
        }),
      );
      lastEmittedIn = cumulativeIn;
      lastEmittedOut = cumulativeOut;
      lastEmittedCacheRead = cumulativeCacheRead;
      lastEmittedCacheCreation = cumulativeCacheCreation;
    } else if (cumulativeIn === 0 && cumulativeOut === 0) {
      logger.warning('no token usage observed — provider may not expose usage_metadata; ring will stay empty');
    }
  };
  return { usageCallback, emitUsage };
}
