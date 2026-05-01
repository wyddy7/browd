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
 * Read order: auto-docs/browd-agent-evolution.md (Tier 2d).
 */
import { tool } from '@langchain/core/tools';
import type { z } from 'zod';
import type { Action } from '../actions/builder';
import type { ActionResult } from '../types';
import { createLogger } from '@src/background/log';

const logger = createLogger('LangGraphAdapter');

/**
 * Render an ActionResult into a string the LLM can read on the next turn.
 * Errors propagate as the result text so the model can reason about them
 * (LangGraph wraps errors into ToolMessage(content)). Non-empty
 * `extractedContent` becomes the canonical observation; otherwise a
 * neutral acknowledgement.
 */
function renderResult(result: ActionResult): string {
  if (result.error) {
    return `Error: ${result.error}`;
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
 */
export function actionToTool(action: Action) {
  const schema = action.schema;
  return tool(
    async (input: unknown) => {
      try {
        const result = await action.call(input);
        return renderResult(result);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        logger.warning(`tool ${schema.name} threw`, msg);
        // Surface as plain string — LangGraph will wrap in ToolMessage.
        return `Error: ${msg}`;
      }
    },
    {
      name: schema.name,
      description: schema.description,
      schema: schema.schema as z.ZodType,
    },
  );
}

/**
 * Translate a list of Actions into a tool registry compatible with
 * createReactAgent. The classic `done` Action is filtered out because
 * the ReAct framework provides terminal semantics natively.
 */
export function actionsToTools(actions: Action[]) {
  return actions.filter(a => a.name() !== 'done').map(actionToTool);
}
