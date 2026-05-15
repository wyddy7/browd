/**
 * T3 — Unit eval runner.
 *
 * Runs component-level evals on the agent runtime. Each scenario is a
 * self-contained module exporting `runScenario(): Promise<ScenarioResult>`
 * that:
 *
 *   1. Sets up minimal context (real LLM, mocked or stubbed dependencies).
 *   2. Invokes the unit under test (planner, replanner, guardrail, etc).
 *   3. Runs scripted assertions on the output.
 *   4. Optionally calls `grade()` for subjective rubric checks.
 *   5. Reports `pass | fail`, scripted-assertion details, token cost,
 *      and grader verdict.
 *
 * The runner aggregates per-scenario results into a suite report.
 *
 * Triggered via `pnpm -F chrome-extension test:eval` (vitest config in
 * `vite.config.mts`). Real LLM cost is billed to the user's configured
 * planner/replanner/judge models — keep scenarios cheap (small models,
 * short prompts) and rare (manual run, not CI by default).
 *
 * Component-level scope (NOT full-loop with real browser): unit
 * evals exercise pure deterministic logic; integration evals
 * exercise the full LLM + browser pipeline and live behind a flag.
 */

import { describe, it, expect } from 'vitest';
import type { GraderVerdict } from './grader';

export interface ScenarioReport {
  name: string;
  passed: boolean;
  scriptedAssertions: Array<{ description: string; passed: boolean; detail?: string }>;
  graderVerdict?: GraderVerdict;
  costEstimateUsd?: number;
  durationMs?: number;
  error?: string;
}

export type ScenarioFn = () => Promise<ScenarioReport>;

interface ScenarioRegistration {
  name: string;
  category: 'planner' | 'replanner' | 'guardrail' | 'hitl' | 'integration';
  /** Skip this scenario unless `RUN_EVAL_<CATEGORY>=true` is set in env. */
  category_env?: string;
  fn: ScenarioFn;
}

const registry: ScenarioRegistration[] = [];

export function registerScenario(reg: ScenarioRegistration) {
  registry.push(reg);
}

/**
 * Aggregate runner. Iterates the registry, runs each scenario, prints
 * a summary at the end. Used by the vitest harness in
 * `__evals__/runEvals.test.ts` (created next to this file).
 */
export async function runAll(): Promise<{ pass: number; fail: number; reports: ScenarioReport[] }> {
  const reports: ScenarioReport[] = [];
  for (const reg of registry) {
    const start = Date.now();
    try {
      const r = await reg.fn();
      r.durationMs ??= Date.now() - start;
      reports.push(r);
    } catch (err) {
      reports.push({
        name: reg.name,
        passed: false,
        scriptedAssertions: [],
        durationMs: Date.now() - start,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const pass = reports.filter(r => r.passed).length;
  const fail = reports.length - pass;
  return { pass, fail, reports };
}

/**
 * Helper: shape a scripted assertion that doesn't throw — collect into
 * the report instead, so a single fail doesn't abort the rest.
 */
export function assertion(description: string, passed: boolean, detail?: string) {
  return { description, passed, detail };
}

/**
 * Vitest test wrapper — a scenario module imports this and converts
 * its `runScenario()` into a vitest `it()` test that surfaces the
 * report nicely on failure.
 */
export function describeScenario(name: string, fn: ScenarioFn) {
  describe(`eval: ${name}`, () => {
    it('passes scripted + grader', async () => {
      const report = await fn();
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
  });
}
