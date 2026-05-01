/**
 * T2d — LangGraph.js ReAct agent (smoke-test scaffolding).
 *
 * This file is the seed for the unified-mode rewrite. The plan in
 * auto-docs/browd-agent-evolution.md (T2d) calls for `createReactAgent`
 * from @langchain/langgraph to replace the bespoke runUnifiedLoop. This
 * commit only verifies that the package imports + types resolve in MV3
 * SW and the bundle still builds. Wiring into Executor lands in T2d-4.
 *
 * Why we are here. Six iterations of hand-written ReAct loop (T2b →
 * T2c critical) closed one bug class each and opened another. The
 * 2026-05-02 independent review concluded that proper framework with
 * built-in termination contract + tool registry + streaming events
 * removes the fragility wholesale. See evolution doc for details.
 *
 * Critical risk this commit verifies: MV3 service workers are stricter
 * than Node — no `process.env`, no `Buffer`, no `fs`. If
 * `@langchain/langgraph` pulls any of those at module-load time the
 * background bundle explodes. We import the surface we plan to use and
 * let the bundler tell us.
 */
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { MemorySaver } from '@langchain/langgraph';
import { tool } from '@langchain/core/tools';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { z } from 'zod';

/** Re-exports so other modules import from one place during T2d-2..6. */
export { createReactAgent, MemorySaver, tool };
export type { BaseChatModel };

/**
 * T2d-1 sanity check — never executed, only ensures the types compose.
 * If `createReactAgent` signature changes in a future @langchain/langgraph
 * upgrade this fails at type-check time, not in production.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _typeProbe(llm: BaseChatModel) {
  const probeTool = tool(async ({ url }: { url: string }) => `fetched ${url}`, {
    name: 'probe',
    description: 'placeholder',
    schema: z.object({ url: z.string() }),
  });
  return createReactAgent({
    llm,
    tools: [probeTool],
    checkpointSaver: new MemorySaver(),
  });
}
