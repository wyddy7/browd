import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import { ScriptedChatModel } from '../__tests__/support/scriptedChatModel';
import { runReactAgent } from '../agents/runReactAgent';
import { createTaskFixture, taskFixtures } from './taskFixtures';
import { evaluateTask } from './taskEvaluation';
import { gradeWithModel } from './grader';

vi.mock('@src/background/log', () => ({ createLogger: () => ({ info() {}, warning() {}, error() {}, debug() {} }) }));
beforeAll(() => vi.stubGlobal('localStorage', { getItem: () => 'en' }));
afterAll(() => vi.unstubAllGlobals());
const call = (name: string, args: Record<string, unknown>) =>
  new AIMessage({ content: '', tool_calls: [{ id: name, name, args }] });
const answers = [
  'Example Domain. Reserved for documentation examples. https://example.test/help/example-domains',
  'Домены для примеров в документации; зарегистрировать или передать нельзя. https://example.test/help/example-domains',
  'Example domains — https://example.test/help/example-domains',
  'Pocket Thermometer — $9 USD — https://shop.example.test/pocket',
  'Please clarify the shop URL and device category. Which website and type of device do you mean?',
];

describe('model-comparison fixtures use the real graph', () => {
  it.each(taskFixtures.map((fixture, index) => [fixture.name, index] as const))(
    '%s reaches hard assertions and invokes Judge',
    async (_, index) => {
      const scenario = taskFixtures[index];
      const messages = [call('extract_page_as_markdown', {})];
      if (scenario.expectedUrl !== scenario.startUrl) {
        messages.unshift(call(scenario.expectedNewTabs ? 'open_tab' : 'go_to_url', { url: scenario.expectedUrl }));
      }
      messages.push(call('task_complete', { response: answers[index], success: !scenario.expectedFailure }));
      const llm = new ScriptedChatModel(messages, [
        {
          reasoning: 'Read and answer',
          plan: ['Read the requested page'],
          taskParameters: { urls: [], queries: [], names: [] },
        },
      ]);
      const fixture = createTaskFixture(scenario, llm);
      const result = await runReactAgent({
        context: fixture.context,
        llm,
        actions: fixture.actions,
        task: scenario.task,
      });
      const judge = new ScriptedChatModel([], [{ verdict: 'pass', confidence: 0.9, reasoning: 'Matches the fixture' }]);
      const answer = result.finalAnswer ?? result.error ?? '';
      const evaluation = await evaluateTask(
        { userTask: scenario.task, finalResponse: answer, rubric: scenario.rubric, pastSteps: fixture.evidence },
        fixture.assertions(answer, result.error),
        input => gradeWithModel(input, judge),
      );
      expect(evaluation.passed, JSON.stringify(evaluation)).toBe(true);
      expect(judge.structuredInvocations).toBe(1);
    },
  );

  it('detects duplicate creation even if the final answer is plausible', async () => {
    const scenario = taskFixtures[2];
    const llm = new ScriptedChatModel([], []);
    const fixture = createTaskFixture(scenario, llm);
    const open = fixture.actions.find(action => action.name() === 'open_tab')!;
    await open.call({ url: scenario.expectedUrl });
    await open.call({ url: scenario.expectedUrl });
    expect(
      fixture.assertions(answers[2], null).find(check => check.description === 'Exact requested number of new tabs')
        ?.passed,
    ).toBe(false);
  });
});
