/**
 * T3 — Eval test harness.
 *
 * Wraps each scenario as a vitest test. Skipped by default unless
 * `RUN_EVALS=1` is set in env, because evals call real LLMs and cost
 * real money.
 *
 * Run unit evals:
 *   pnpm -F chrome-extension test:eval
 *
 * (test:eval script in chrome-extension/package.json sets RUN_EVALS=1
 * and points vitest at this file's pattern.)
 */

import { describe, it, expect } from 'vitest';
import { runPlannerExtractsParameters } from './scenarios/plannerExtractsParameters';
import { runReplannerSufficiencyGate } from './scenarios/replannerSufficiencyGate';
import { runStreamingRepetitionGuardFires } from './scenarios/streamingRepetitionGuardFires';
import { runHitlSensitiveActionTrigger } from './scenarios/hitlSensitiveActionTrigger';
import { runFinalAnswerPlausibility } from './scenarios/finalAnswerPlausibility';
import type { ScenarioReport } from './runner';

const SHOULD_RUN = process.env.RUN_EVALS === '1';

const scenarios: Array<{ name: string; fn: () => Promise<ScenarioReport>; ready: boolean }> = [
  // T2f-clean-finish-3 — `planner-extracts-parameters` reads
  // chrome.storage via agentModelStore. vitest+happy-dom doesn't
  // mock chrome.storage, so this scenario is integration-only
  // until we add a mock setup or move it to the Playwright runner.
  // See `__evals__/integration/README.md`.
  { name: 'planner-extracts-parameters', fn: runPlannerExtractsParameters, ready: false },
  { name: 'replanner-sufficiency-gate', fn: runReplannerSufficiencyGate, ready: false },
  { name: 'streaming-repetition-guard-fires', fn: runStreamingRepetitionGuardFires, ready: true },
  { name: 'hitl-sensitive-action-trigger', fn: runHitlSensitiveActionTrigger, ready: true },
  { name: 'final-answer-plausibility', fn: runFinalAnswerPlausibility, ready: false },
];

// Pure-unit scenarios (no LLM cost) run unconditionally as part of the
// regular test suite — they're cheap and catch regressions in guards.
const pureUnitScenarios = scenarios.filter(s =>
  ['streaming-repetition-guard-fires', 'hitl-sensitive-action-trigger'].includes(s.name),
);
describe('T3 pure-unit evals (no LLM)', () => {
  for (const scenario of pureUnitScenarios) {
    it(scenario.name, async () => {
      const report = await scenario.fn();
      if (!report.passed) {
        const failedAsserts = report.scriptedAssertions.filter(a => !a.passed);
        const errSection = report.error ? `\n  runtime error: ${report.error}` : '';
        const assertSection = failedAsserts.length
          ? `\n  failed assertions:\n${failedAsserts
              .map(a => `    - ${a.description}${a.detail ? ` — ${a.detail}` : ''}`)
              .join('\n')}`
          : '';
        throw new Error(`${report.name} failed:${assertSection}${errSection}`);
      }
      expect(report.passed).toBe(true);
    });
  }
});

describe.skipIf(!SHOULD_RUN)('T3 unit evals', () => {
  for (const scenario of scenarios) {
    it.skipIf(!scenario.ready)(scenario.name, async () => {
      const report = await scenario.fn();
      if (!report.passed) {
        const failedAsserts = report.scriptedAssertions.filter(a => !a.passed);
        const grader = report.graderVerdict
          ? `\n  grader: ${report.graderVerdict.verdict} (conf ${report.graderVerdict.confidence}) — ${report.graderVerdict.reasoning}`
          : '';
        const errSection = report.error ? `\n  runtime error: ${report.error}` : '';
        const assertSection = failedAsserts.length
          ? `\n  failed assertions:\n${failedAsserts
              .map(a => `    - ${a.description}${a.detail ? ` — ${a.detail}` : ''}`)
              .join('\n')}`
          : '';
        throw new Error(`${report.name} failed:${assertSection}${grader}${errSection}`);
      }
      expect(report.passed).toBe(true);
    });
  }
});

describe('T3 eval harness self-check', () => {
  it('imports without error and lists scenarios', () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(5);
    // Pure-unit scenarios MUST be ready (no chrome.storage / no LLM).
    expect(scenarios.find(s => s.name === 'streaming-repetition-guard-fires')?.ready).toBe(true);
    expect(scenarios.find(s => s.name === 'hitl-sensitive-action-trigger')?.ready).toBe(true);
  });
});
