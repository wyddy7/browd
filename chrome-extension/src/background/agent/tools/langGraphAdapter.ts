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
 * T2f-final-fix → T2i-fix1 — duplicate-action guard.
 *
 * Production trace 2026-05-02 (LinkedIn): agent called `input_text`
 * with same args 5× because the click silently failed. Fix shipped
 * as a consecutive-3 guard. test1.md/test2.md (2026-05-06) showed
 * the next failure mode it doesn't catch:
 *
 *   click_at "Click on the first image result" (467,235) → fail
 *   screenshot
 *   click_at "Click on the first image result" (156,235) → fail
 *   screenshot, screenshot
 *   click_at "Click on the first image result" (467,892) → fail
 *
 * Same logical action, three different coordinates, intent text
 * varies in JSON.stringify keys — guard never trips. Root cause is
 * isTrusted=false antibot block (Google Images, LinkedIn, CF), not
 * coordinate aim.
 *
 * T2i-fix1 changes:
 *  - Key by *logical action* per tool family, not raw args:
 *    click-class (click_at/drag_at/type_at/hitl_click_at/click_element/send_keys)
 *      → key on `intent` text only (the LLM's plan).
 *    others → strip `intent`, JSON.stringify the rest.
 *  - Widen window from "consecutive 3" to "3 in last 5" — survives
 *    interleaved screenshots (already exempt from key tracking) AND
 *    one-off corrective clicks between repeated bad ones.
 *  - Tool-family error messages (click → suggest hitl_click_at,
 *    go_back → suggest navigate, fill → suggest fresh state).
 *  - Screenshot still exempt (auto-attach repeats are normal).
 */
export interface DuplicateGuardState {
  recentKeys: string[];
}

const DUPLICATE_WINDOW = 5;
const DUPLICATE_THRESHOLD = 3;

const CLICK_CLASS_TOOLS = new Set(['click_at', 'drag_at', 'type_at', 'hitl_click_at', 'click_element', 'send_keys']);

const FILL_CLASS_TOOLS = new Set(['fill_field_by_label', 'input_text', 'select_dropdown_option']);

function canonicaliseArgsForGuard(name: string, input: unknown): string {
  if (input === null || typeof input !== 'object') {
    try {
      return JSON.stringify(input ?? {});
    } catch {
      return '<unserialisable>';
    }
  }
  const obj = input as Record<string, unknown>;
  if (CLICK_CLASS_TOOLS.has(name)) {
    // The LLM's `intent` text is the plan; nudging coords ±N px is
    // the same plan being retried. Key on intent only.
    const intent = typeof obj.intent === 'string' ? obj.intent.trim() : '';
    return `intent=${intent}`;
  }
  // Default: strip intent, stringify the rest.
  const { intent: _intent, ...rest } = obj;
  try {
    return JSON.stringify(rest);
  } catch {
    return '<unserialisable>';
  }
}

function dupGuardErrorMessage(name: string, count: number): string {
  if (CLICK_CLASS_TOOLS.has(name)) {
    return (
      `Error: ${name} has been attempted ${count} times for the same logical action with no useful state change. ` +
      `On modern sites this is usually the isTrusted=false antibot block — CDP-driven clicks are silently ignored ` +
      `on Google Images, LinkedIn /jobs filters, Cloudflare-protected pages, and similar. ` +
      `Choose ONE of: ` +
      `(a) call hitl_click_at to ask the user to perform the click; ` +
      `(b) navigate(url) directly to a page that achieves the same goal; ` +
      `(c) finalise with what you have. ` +
      `Do NOT retry ${name} on this region.`
    );
  }
  if (name === 'go_back') {
    return (
      `Error: go_back called ${count} times — the tab's history is unavailable or the back action is not advancing. ` +
      `Use navigate(url) to a known URL instead. Do NOT call go_back again.`
    );
  }
  if (FILL_CLASS_TOOLS.has(name)) {
    return (
      `Error: ${name} called ${count} times for the same field with no observable progress. ` +
      `The field may have moved, the page may have re-rendered, or the value may not be accepted. ` +
      `Either: (a) call screenshot or extract_page_as_markdown to refresh state, ` +
      `(b) try a different field index/label, ` +
      `(c) finalise with what you have. ` +
      `Do NOT retry the same fill.`
    );
  }
  return (
    `Error: ${name} has been called ${count} times in a 5-call window with similar arguments and made no observable progress. ` +
    `Pick a different approach, switch tools, or finalise with what you have.`
  );
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
export function actionToTool(action: Action, budget?: ToolBudgetOptions, dupGuard?: DuplicateGuardState) {
  const schema = action.schema;
  const name = schema.name;
  const limit = budget?.limits?.[name];
  return tool(
    async (input: unknown) => {
      // T2r-observability: one log line per call summarising args.
      // For click-class tools that is the LLM's `intent` (the plan);
      // for others, the JSON minus intent (kept ≤120 chars).
      // The same canonical form drives the dupGuard, so debugging
      // a "BLOCKED-dup" line and the prior calls reads consistently.
      const argSummary = canonicaliseArgsForGuard(name, input).slice(0, 120);
      const callStart = Date.now();
      if (budget && limit !== undefined) {
        const next = (budget.counters[name] ?? 0) + 1;
        budget.counters[name] = next;
        if (next > limit) {
          logger.info(`[tool] ${name} ${argSummary} → BLOCKED-budget ${next}/${limit}`);
          return `Error: budget exhausted for ${name} (${next - 1}/${limit}). Stop calling this tool. Write a final answer with what you have.`;
        }
      }
      // T2i-fix1: tool-family-aware duplicate guard, 3-in-last-5 window.
      // The autocapture `screenshot` Action runs every step regardless of
      // LLM choices (visionMode='always'), so we explicitly skip it —
      // repeats are normal and expected.
      if (dupGuard && name !== 'screenshot') {
        const key = `${name}:${canonicaliseArgsForGuard(name, input)}`;
        dupGuard.recentKeys.push(key);
        if (dupGuard.recentKeys.length > DUPLICATE_WINDOW) {
          dupGuard.recentKeys.shift();
        }
        const count = dupGuard.recentKeys.filter(k => k === key).length;
        if (count >= DUPLICATE_THRESHOLD) {
          logger.info(`[tool] ${name} ${argSummary} → BLOCKED-dup ${count}× in last ${dupGuard.recentKeys.length}`);
          return dupGuardErrorMessage(name, count);
        }
      }
      try {
        const result = await action.call(input);
        const ms = Date.now() - callStart;
        if (result.error) {
          // Action.call may resolve with an error result (vs throwing).
          // Surface that consistently in the log line.
          logger.info(`[tool] ${name} ${argSummary} → error ${ms}ms msg="${String(result.error).slice(0, 120)}"`);
        } else {
          logger.info(`[tool] ${name} ${argSummary} → ok ${ms}ms`);
        }
        return renderResult(result);
      } catch (err) {
        const ms = Date.now() - callStart;
        const msg = err instanceof Error ? err.message : String(err);
        logger.info(`[tool] ${name} ${argSummary} → error ${ms}ms msg="${msg.slice(0, 120)}"`);
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
 * Pass `budget` to enforce per-task caps (T2g). Pass `dupGuard` to
 * trip after 3 consecutive identical tool calls (T2f-final-fix).
 * Without either, the wrappers behave as in T2d: plain Action.call
 * passthrough.
 */
export function actionsToTools(actions: Action[], budget?: ToolBudgetOptions, dupGuard?: DuplicateGuardState) {
  return actions.filter(a => a.name() !== 'done').map(a => actionToTool(a, budget, dupGuard));
}
