/**
 * T3 — Replanner sufficiency-gate eval.
 *
 * TODO: implement. Verifies the replannerSchema's evidence_assessment +
 * evidence_sufficient + decision flow:
 *
 *   - Given pastSteps with concrete data → replanner returns
 *     evidence_sufficient='yes', decision='finish', non-empty response.
 *   - Given pastSteps without concrete data ("I visited the page") →
 *     replanner returns evidence_sufficient='no', decision='continue',
 *     focused new plan.
 *   - Server-side override: if LLM returns yes+continue, runReactAgent
 *     forces finish (we test this by importing the override logic
 *     directly, not via the full StateGraph).
 *
 * Cost: 2-3 replanner LLM calls per run.
 */

import type { ScenarioReport } from '../runner';

export async function runReplannerSufficiencyGate(): Promise<ScenarioReport> {
  return {
    name: 'replanner-sufficiency-gate',
    passed: false,
    scriptedAssertions: [],
    error: 'TODO: implement sufficiency-gate scenario',
  };
}
