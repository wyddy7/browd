/**
 * T2d-2 — adapter between Browd's existing `Action` instances and
 * LangChain's `tool()` API. Lets the same tool implementations
 * (web_search, click_element, fill_field_by_label, …) drive both:
 *
 *   - the legacy classic Planner+Navigator loop (via Action.call), and
 *   - the new LangGraph.js ReAct agent (via tool() wrappers).
 *
 * The handler delegates to `Action.call` so:
 *   - Zod input validation runs (already inside Action.call).
 *   - The structured Tracer record fires for every invocation
 *     (handled by Action.call).
 *   - Failures classified as `transient` etc. surface as plain Error
 *     to the LangGraph runtime, which serialises them as ToolMessage
 *     content; the agent's next reasoning turn sees the error.
 *
 * T2g — per-task tool-call budgets. `createReactAgent` (prebuilt) does
 * not expose conditional edges, so we enforce caps at the wrapper
 * layer: a `counters` map (closure-owned by `runReactAgent`) is
 * incremented before dispatch; on overflow the wrapper returns a
 * forcing error string and skips `Action.call` entirely. The LLM
 * observes a `ToolMessage` "Error: budget exhausted… write a final
 * answer now" and the existing ReAct prompt directs it to terminate.
 * Counters live in JS, not in prompt — prompt manipulation cannot
 * bypass them.
 *
 * Read order: auto-docs/browd-agent-evolution.md (Tier 2d, Tier 2g).
 */
import { tool } from '@langchain/core/tools';
import type { z } from 'zod';
import type { Action } from '../actions/builder';
import type { ActionResult } from '../types';
import { createLogger } from '@src/background/log';

const logger = createLogger('LangGraphAdapter');

/**
 * Default per-task budgets for read-only research tools that have
 * historically driven loop bugs (production trace 2026-05-02:
 * 20× `web_search` on a single task). Numbers chosen so that a
 * well-behaved agent comfortably fits, and a pathological one is
 * forced to finalise within recursionLimit. Overridable per
 * `runReactAgent` invocation.
 */
export const DEFAULT_TOOL_BUDGETS: Readonly<Record<string, number>> = Object.freeze({
  web_search: 5,
  web_fetch_markdown: 5,
});

export interface ToolBudgetOptions {
  /** Mutable counter map; the wrapper increments per invocation. */
  counters: Record<string, number>;
  /**
   * Hard caps per tool name. Tools not present in this map are
   * unbudgeted (counter not even tracked). When a tool's count
   * reaches its limit, further calls are blocked at the wrapper
   * layer and never reach `Action.call`.
   */
  limits: Readonly<Record<string, number>>;
}

/**
 * Render an ActionResult into a value the LLM can read on the next
 * turn. Errors propagate as the result text so the model can reason
 * about them (LangGraph wraps errors into ToolMessage(content)).
 * Non-empty `extractedContent` becomes the canonical observation;
 * otherwise a neutral acknowledgement.
 *
 * T2f-2: when the result carries an `imageBase64` payload (screenshot
 * tool), return a multimodal content array — text caption plus an
 * `image_url` part — so the next reasoning turn sees the captured
 * pixels, not a base64 blob in text. Anthropic / OpenAI / Gemini all
 * accept this shape inside ToolMessage content via @langchain/core.
 */
type ToolReturn = string | Array<{ type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }>;

function renderResult(result: ActionResult): ToolReturn {
  if (result.error) {
    return `Error: ${result.error}`;
  }
  if (result.imageBase64) {
    const mime = result.imageMime ?? 'image/jpeg';
    const caption = result.extractedContent ?? 'screenshot captured';
    return [
      { type: 'text', text: caption },
      { type: 'image_url', image_url: { url: `data:${mime};base64,${result.imageBase64}` } },
    ];
  }
  if (result.extractedContent) {
    return result.extractedContent;
  }
  return 'ok';
}

/**
 * Wrap a single Browd `Action` as a LangChain tool. The schema is reused
 * verbatim — same Zod object that classic mode uses — so the LLM sees
 * identical parameter contracts in both modes.
 *
 * `done` is special: the agent finishes naturally when the LLM produces
 * an AIMessage with no tool calls, so we do NOT register `done` as a
 * tool here. The LLM just writes the final answer to `messages` and
 * LangGraph terminates. That removes the entire evidence-validation
 * code path that caused false-positive rejections in T2c production.
 *
 * Optional `budget` enforces per-task caps: when supplied and the tool
 * name has a configured limit, the wrapper increments its counter and
 * blocks past the limit without invoking the underlying action.
 */
export function actionToTool(action: Action, budget?: ToolBudgetOptions) {
  const schema = action.schema;
  const name = schema.name;
  const limit = budget?.limits?.[name];
  return tool(
    async (input: unknown) => {
      if (budget && limit !== undefined) {
        const next = (budget.counters[name] ?? 0) + 1;
        budget.counters[name] = next;
        if (next > limit) {
          logger.warning(`tool ${name} budget exhausted (${next}/${limit}) — blocking call`);
          return `Error: budget exhausted for ${name} (${next - 1}/${limit}). Stop calling this tool. Write a final answer with what you have.`;
        }
      }
      try {
        const result = await action.call(input);
        return renderResult(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warning(`tool ${name} threw`, msg);
        // Surface as plain string — LangGraph will wrap in ToolMessage.
        return `Error: ${msg}`;
      }
    },
    {
      name,
      description: schema.description,
      schema: schema.schema as z.ZodType,
    },
  );
}

/**
 * Translate a list of Actions into a tool registry compatible with
 * createReactAgent. The classic `done` Action is filtered out because
 * the ReAct framework provides terminal semantics natively.
 *
 * Pass `budget` to enforce per-task caps (T2g). Without it the
 * wrappers behave as in T2d: plain Action.call passthrough.
 */
export function actionsToTools(actions: Action[], budget?: ToolBudgetOptions) {
  return actions.filter(a => a.name() !== 'done').map(a => actionToTool(a, budget));
}
