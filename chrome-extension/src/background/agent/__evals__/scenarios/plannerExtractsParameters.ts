/**
 * T3 — Planner correctness eval.
 *
 * Verifies the planner schema's three-belt defense against subgoal-
 * abstraction drift via schema-level enforcement (a `withStructuredOutput`
 * required field), prompt-level repetition, and per-step HumanMessage echo:
 *
 * Given a user task that contains a concrete URL and a concrete query
 * string, the planner MUST:
 *   - return `taskParameters.urls` containing the URL
 *   - return `taskParameters.queries` containing the query
 *   - emit at least 1 subgoal with the literal URL/query inlined
 *
 * Failure mode this catches: planner abstracts to "open the provided
 * URL" without the URL itself, executor hallucinates substitute.
 *
 * Cost: one planner LLM call (~$0.001 with Gemini Flash / Haiku class).
 */

import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import { agentModelStore, llmProviderStore, AgentNameEnum } from '@extension/storage';
import { createChatModel } from '../../helper';
import { assertion, type ScenarioReport } from '../runner';

const planSchema = z.object({
  reasoning: z.string().max(500),
  plan: z.array(z.string().min(3)).min(1).max(7),
  taskParameters: z
    .object({
      urls: z.array(z.string()).default([]),
      queries: z.array(z.string()).default([]),
      names: z.array(z.string()).default([]),
    })
    .default({ urls: [], queries: [], names: [] }),
});

const PLANNER_SYSTEM_PROMPT = `You are the planner half of a browser-agent loop. Read the user request and decompose it into 1-7 concrete subgoals that an executor with browser tools will walk in order.

CRITICAL: each subgoal text must be SELF-CONTAINED. Inline every concrete parameter from the user request — full URLs, exact search queries, addresses, person names. NEVER write "the provided URL" or "the requested term"; write the actual URL / query / name. The executor sees ONLY the subgoal text on its turn.

Subgoals should be observable steps. If the request is trivial emit a short plan; do not pad.`;

const TEST_TASK =
  'Open https://github.com/wyddy7/browd and search the README for "LangGraph". Tell me what frameworks the agent uses.';
const EXPECTED_URL = 'https://github.com/wyddy7/browd';
const EXPECTED_QUERY = 'LangGraph';

export async function runPlannerExtractsParameters(): Promise<ScenarioReport> {
  const name = 'planner-extracts-parameters';
  const start = Date.now();
  const scriptedAssertions: ScenarioReport['scriptedAssertions'] = [];

  try {
    const agentModels = await agentModelStore.getAllAgentModels();
    const plannerModel = agentModels[AgentNameEnum.Planner] ?? agentModels[AgentNameEnum.Navigator];
    if (!plannerModel) {
      return {
        name,
        passed: false,
        scriptedAssertions: [],
        durationMs: Date.now() - start,
        error: 'No Planner / Navigator model configured. Set one in Settings → Models.',
      };
    }
    const providers = await llmProviderStore.getAllProviders();
    const providerConfig = providers[plannerModel.provider];
    if (!providerConfig) {
      return {
        name,
        passed: false,
        scriptedAssertions: [],
        durationMs: Date.now() - start,
        error: `Planner provider "${plannerModel.provider}" not found in configured providers.`,
      };
    }
    const llm = createChatModel(providerConfig, plannerModel);
    const planner = llm.withStructuredOutput(planSchema, { name: 'plan' });

    const result = (await planner.invoke([
      new SystemMessage(PLANNER_SYSTEM_PROMPT),
      new HumanMessage(TEST_TASK),
    ])) as z.infer<typeof planSchema>;

    scriptedAssertions.push(
      assertion(
        'taskParameters.urls contains the test URL',
        result.taskParameters.urls.some(u => u.includes('github.com/wyddy7/browd')),
        `urls=${JSON.stringify(result.taskParameters.urls)}`,
      ),
      assertion(
        'taskParameters.queries contains the test query',
        result.taskParameters.queries.some(q => q.toLowerCase().includes('langgraph')),
        `queries=${JSON.stringify(result.taskParameters.queries)}`,
      ),
      assertion(
        'plan has 1-7 subgoals',
        result.plan.length >= 1 && result.plan.length <= 7,
        `plan length=${result.plan.length}`,
      ),
      assertion(
        'at least one subgoal inlines the URL OR the query (no abstraction)',
        result.plan.some(s => s.includes(EXPECTED_URL) || s.toLowerCase().includes(EXPECTED_QUERY.toLowerCase())),
        `plan=${JSON.stringify(result.plan)}`,
      ),
      assertion(
        'reasoning under 500 chars (schema cap)',
        result.reasoning.length <= 500,
        `reasoning length=${result.reasoning.length}`,
      ),
    );

    const passed = scriptedAssertions.every(a => a.passed);

    return {
      name,
      passed,
      scriptedAssertions,
      durationMs: Date.now() - start,
    };
  } catch (err) {
    return {
      name,
      passed: false,
      scriptedAssertions,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
