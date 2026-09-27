import { verdictSchema, type GraderInput, type GraderVerdict } from './grader';

export interface HardAssertion {
  description: string;
  passed: boolean;
}

/** Judge can veto success, never override a failed deterministic requirement. */
export async function evaluateTask(
  input: GraderInput,
  assertions: HardAssertion[],
  judge: (input: GraderInput) => Promise<GraderVerdict>,
) {
  try {
    const graderVerdict = verdictSchema.parse(await judge(input));
    return {
      passed:
        assertions.length > 0 &&
        assertions.every(check => check.passed) &&
        graderVerdict.verdict === 'pass' &&
        graderVerdict.confidence >= 0.7,
      scriptedAssertions: assertions,
      graderVerdict,
    };
  } catch {
    // Provider exception text can include request headers/body. Do not persist it.
    return { passed: false, scriptedAssertions: assertions, error: 'Judge unavailable or returned an invalid verdict' };
  }
}
