/**
 * T3 — LLM-as-judge grader.
 *
 * Used by the eval runner to grade scenario outputs against a rubric.
 * Wraps the user-configured judge model (`judgeModelStore`) into a
 * uniform `grade(input, rubric) => Verdict` function.
 *
 * Usage from a scenario:
 *
 * ```ts
 * const verdict = await grade({
 *   userTask: 'Find population of Berlin',
 *   finalResponse: result.response,
 *   rubric: 'Verdict pass iff response contains a numeric population in millions.',
 * });
 * if (verdict.verdict !== 'pass' || verdict.confidence < 0.7) throw ...;
 * ```
 *
 * Cost: one LLM call per `grade()` invocation. Use sparingly; prefer
 * scripted assertions where possible.
 */

import { z } from 'zod';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import {
  judgeModelStore,
  llmProviderStore,
  agentModelStore,
  AgentNameEnum,
  type ProviderConfig,
} from '@extension/storage';
import { createChatModel } from '../helper';
import { createLogger } from '@src/background/log';

const logger = createLogger('grader');

export interface GraderInput {
  userTask: string;
  finalResponse: string;
  rubric: string;
  /** Optional structured evidence to include in the grader prompt. */
  pastSteps?: Array<[string, string]>;
}

export interface GraderVerdict {
  verdict: 'pass' | 'fail';
  /** 0..1 — judge's calibration of its own answer. */
  confidence: number;
  reasoning: string;
}

const verdictSchema = z.object({
  verdict: z.enum(['pass', 'fail']),
  confidence: z.number().min(0).max(1),
  reasoning: z.string().max(400).describe('one sentence why pass / fail'),
});

/**
 * Grade a scenario output against a rubric.
 *
 * Throws if the user has not configured a judge model — eval runner
 * surfaces this as a setup error, not a test failure.
 */
export async function grade(input: GraderInput): Promise<GraderVerdict> {
  // T2f-clean-finish-2 — fallback to Navigator when Judge unset.
  // The picker exposes Judge as optional. If the user hasn't picked a
  // dedicated grader, reuse the Navigator's model (already configured
  // for the runtime). This makes evals zero-config out of the box;
  // power users still set a cheaper grader explicitly.
  let judgeConfig = await judgeModelStore.getJudgeModel();
  let usedFallback = false;
  if (!judgeConfig) {
    const agentModels = await agentModelStore.getAllAgentModels();
    const navigator = agentModels[AgentNameEnum.Navigator];
    if (!navigator) {
      throw new Error(
        'No judge model configured AND no Navigator model to fall back on. Configure at least Navigator in Settings, or pick a Judge in the in-chat picker.',
      );
    }
    judgeConfig = { provider: navigator.provider, modelName: navigator.modelName };
    usedFallback = true;
    logger.info(`Judge unset — falling back to Navigator (${navigator.provider}/${navigator.modelName})`);
  }
  const providers = await llmProviderStore.getAllProviders();
  const provider: ProviderConfig | undefined = providers[judgeConfig.provider];
  if (!provider) {
    throw new Error(
      `Judge provider "${judgeConfig.provider}" not found in configured providers${usedFallback ? ' (Navigator fallback)' : ''}.`,
    );
  }

  const llm = createChatModel(provider, {
    provider: judgeConfig.provider,
    modelName: judgeConfig.modelName,
    parameters: { temperature: 0, topP: 1 },
  });

  const judge = llm.withStructuredOutput(verdictSchema, { name: 'grade' });

  const pastStepsBlock = input.pastSteps
    ? `\n\nExecution trace:\n${input.pastSteps.map(([s, r]) => `- ${s} → ${r}`).join('\n')}`
    : '';

  const result = (await judge.invoke([
    new SystemMessage(
      `You are a grading judge for an autonomous browser agent's eval suite. Read the user's original task, the agent's final response, and the rubric. Decide pass/fail strictly per the rubric. Return: verdict ("pass"/"fail"), confidence 0..1, one sentence of reasoning.

Rules:
- Strict on the rubric. If the rubric requires X and X is absent, fail.
- Don't grade style or eloquence; only what the rubric asks.
- "confidence" is YOUR calibration. 0.5 = coin flip, 0.9+ = clear.`,
    ),
    new HumanMessage(
      `User task:\n${input.userTask}\n\nAgent final response:\n${input.finalResponse}${pastStepsBlock}\n\nRubric:\n${input.rubric}\n\nReturn the structured verdict.`,
    ),
  ])) as GraderVerdict;

  return result;
}
