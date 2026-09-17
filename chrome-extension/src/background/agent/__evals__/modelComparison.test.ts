import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { runReactAgent } from '../agents/runReactAgent';
import { taskFixtures, createTaskFixture } from './taskFixtures';
import { gradeWithModel } from './grader';
import { evaluateTask } from './taskEvaluation';
import { createEvalModel } from './modelTransport';

// Keep provider exception payloads out of terminal logs. Reports retain only
// sanitized failures and the synthetic task evidence.
vi.mock('@src/background/log', () => ({ createLogger: () => ({ info() {}, warning() {}, error() {}, debug() {} }) }));

const enabled = process.env.RUN_MODEL_EVALS === '1';
const config = enabled
  ? z
      .object({
        key: z.string().min(1),
        models: z
          .array(z.string().min(1))
          .min(2)
          .max(3)
          .refine(values => new Set(values).size === values.length, 'Use distinct candidate models'),
        judge: z.string().min(1),
        repeats: z.coerce.number().int().min(1).max(3),
        requests: z.coerce.number().int().min(3).max(12),
      })
      .parse({
        key: process.env.OPENROUTER_API_KEY,
        models: process.env.EVAL_MODELS?.split(',').map(x => x.trim()),
        judge: process.env.EVAL_JUDGE_MODEL,
        repeats: process.env.EVAL_REPEATS ?? 1,
        requests: process.env.EVAL_MAX_REQUESTS ?? 8,
      })
  : null;

const reports: Array<{ model: string; passed: boolean; [key: string]: unknown }> = [];
beforeAll(() => {
  if (enabled) vi.stubGlobal('localStorage', { getItem: () => 'en' });
});
if (!enabled) it.skip('model comparison requires explicit paid opt-in');
afterAll(async () => {
  vi.unstubAllGlobals();
  if (!enabled) return;
  const directory = resolve(process.cwd(), '../test-runs');
  await mkdir(directory, { recursive: true });
  const path = resolve(directory, `model-evals-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  const summary = config?.models.map(model => {
    const runs = reports.filter(report => report.model === model);
    return { model, passed: runs.filter(report => report.passed).length, total: runs.length };
  });
  await writeFile(
    path,
    JSON.stringify(
      {
        mode: 'real-models-fixture-browser',
        judgeModel: config?.judge,
        repeats: config?.repeats,
        maxRequestsPerCandidate: config?.requests,
        summary,
        reports,
      },
      null,
      2,
    ),
  );
  console.info(`Evaluation report: ${path}`);
});

describe.skipIf(!enabled)('paid model comparison — real graph, fixture browser', () => {
  for (const model of config?.models ?? []) {
    for (let repeat = 1; repeat <= (config?.repeats ?? 1); repeat++) {
      for (const scenario of taskFixtures) {
        it(`${model} / ${scenario.name} / repeat ${repeat}`, async () => {
          if (!config) throw new Error('Model evaluation is not configured');
          const start = Date.now();
          const candidateController = new AbortController();
          const candidate = createEvalModel(model, config.key, candidateController, config.requests);
          const fixture = createTaskFixture(scenario, candidate.llm);
          candidateController.signal.addEventListener('abort', () => fixture.context.controller.abort(), {
            once: true,
          });
          const judgeController = new AbortController();
          const judge = createEvalModel(config.judge, config.key, judgeController, 1);
          const timeout = setTimeout(() => {
            candidateController.abort();
            judgeController.abort();
          }, 120_000);
          let recorded = false;
          try {
            const result = await runReactAgent({
              context: fixture.context,
              llm: candidate.llm,
              actions: fixture.actions,
              task: scenario.task,
            });
            const answer = result.finalAnswer ?? result.error ?? '';
            const evaluation = await evaluateTask(
              { userTask: scenario.task, finalResponse: answer, rubric: scenario.rubric, pastSteps: fixture.evidence },
              fixture.assertions(answer, result.error),
              input => gradeWithModel(input, judge.llm),
            );
            const report = {
              model,
              judgeModel: config.judge,
              scenario: scenario.name,
              repeat,
              durationMs: Date.now() - start,
              ...evaluation,
              candidateUsage: candidate.summary(),
              judgeUsage: judge.summary(),
              finalResponse: answer,
              evidence: fixture.evidence,
            };
            reports.push(report);
            recorded = true;
            expect(evaluation.passed, JSON.stringify(report, null, 2)).toBe(true);
          } catch (error) {
            if (recorded) throw error;
            reports.push({
              model,
              judgeModel: config.judge,
              scenario: scenario.name,
              repeat,
              passed: false,
              error: 'Scenario execution failed',
              durationMs: Date.now() - start,
              candidateUsage: candidate.summary(),
              judgeUsage: judge.summary(),
            });
            throw new Error('Scenario execution failed; see the evaluation report');
          } finally {
            clearTimeout(timeout);
            candidateController.abort();
            judgeController.abort();
          }
        }, 135_000);
      }
    }
  }
});
