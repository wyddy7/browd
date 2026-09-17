import { describe, expect, it } from 'vitest';
import { evaluateTask } from './taskEvaluation';

const input = { userTask: 'Return the source URL', finalResponse: 'Done', rubric: 'Must contain the source URL.' };
describe('task evaluation verdict composition', () => {
  it('cannot pass a missing hard requirement even when Judge approves', async () => {
    const result = await evaluateTask(input, [{ description: 'source present', passed: false }], async () => ({
      verdict: 'pass',
      confidence: 1,
      reasoning: 'Looks good',
    }));
    expect(result.passed).toBe(false);
    expect(result.graderVerdict?.verdict).toBe('pass');
  });
  it('requires a valid, confident Judge pass as well as hard assertions', async () => {
    for (const confidence of [0.5, 2]) {
      const result = await evaluateTask(input, [{ description: 'source present', passed: true }], async () => ({
        verdict: 'pass',
        confidence,
        reasoning: 'Looks good',
      }));
      expect(result.passed).toBe(false);
    }
  });
  it('records Judge failure instead of treating it as a skipped pass', async () => {
    const result = await evaluateTask(input, [{ description: 'source present', passed: true }], async () => {
      throw new Error('provider unavailable');
    });
    expect(result.passed).toBe(false);
    expect(result.error).toBeDefined();
  });
  it('passes only when both sources agree and assertions are nonempty', async () => {
    const judge = async () => ({ verdict: 'pass' as const, confidence: 0.9, reasoning: 'Supported by evidence' });
    expect((await evaluateTask(input, [{ description: 'source present', passed: true }], judge)).passed).toBe(true);
    expect((await evaluateTask(input, [], judge)).passed).toBe(false);
  });
});
