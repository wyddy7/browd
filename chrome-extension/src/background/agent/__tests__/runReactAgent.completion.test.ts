import { describe, expect, it, vi } from 'vitest';
import { AIMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { ScriptedChatModel } from './support/scriptedChatModel';
import { z } from 'zod';
import { ActionBuilder, Action } from '../actions/builder';
import { taskCompleteActionSchema } from '../actions/schemas';
import { ActionResult, type AgentContext } from '../types';
import { type Actors, ExecutionState } from '../event/types';
import { runReactAgent } from '../agents/runReactAgent';
import { TabGoneError } from '@src/background/browser/views';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

type RecordedEvent = { actor: Actors; state: ExecutionState; details: string };

function makeContext(options: { tabGone?: boolean; stopped?: boolean; abortSignal?: boolean } = {}) {
  const events: RecordedEvent[] = [];
  const state = {
    tabId: 41,
    url: 'https://example.test/',
    title: 'Example',
    tabs: [],
    pageText: '',
    elementTree: { clickableElementsToString: () => '' },
  };
  const context = {
    taskId: 'completion-regression',
    controller: new AbortController(),
    stopped: options.stopped ?? false,
    finalAnswer: null,
    options: {
      maxSteps: 20,
      maxFailures: 3,
      includeAttributes: [],
    },
    browserContext: {
      getState: vi.fn(async () => {
        if (options.tabGone) throw new TabGoneError(41);
        return state;
      }),
      getConfig: () => ({ deniedUrls: [] }),
      agentTabId: () => 41,
    },
    emitEvent: vi.fn(async (actor: Actors, eventState: ExecutionState, details: string) => {
      events.push({ actor, state: eventState, details });
    }),
  } as unknown as AgentContext;
  if (options.abortSignal) context.controller.abort();
  return { context, events };
}

function plan(step = 'Collect the requested result') {
  return {
    reasoning: 'The task has one concrete step.',
    plan: [step],
    taskParameters: { urls: [], queries: [], names: [] },
  };
}

function realTaskComplete(context: AgentContext): Action {
  const actions = new ActionBuilder(context, {} as BaseChatModel).buildDefaultActions();
  const action = actions.find(candidate => candidate.name() === 'task_complete');
  if (!action) throw new Error('task_complete was not registered');
  return action;
}

function failedTaskComplete(): Action {
  return new Action(async () => new ActionResult({ error: 'terminal action was rejected' }), taskCompleteActionSchema);
}

function terminalStates(events: RecordedEvent[]) {
  return events.filter(event =>
    [ExecutionState.TASK_OK, ExecutionState.TASK_FAIL, ExecutionState.TASK_CANCEL].includes(event.state),
  );
}

describe('runReactAgent authoritative completion', () => {
  // 2026-09-16: red on c1fc521 for answer overwrite, rejected completion,
  // dead-tab success and a side effect dispatched alongside completion.
  it('uses a task_complete on the last subgoal verbatim, ends the inner loop, and never calls the replanner', async () => {
    const { context, events } = makeContext();
    const answer = '# Extracted result\n\n' + 'Evidence preserved verbatim. '.repeat(120);
    const llm = new ScriptedChatModel(
      [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'complete-1', name: 'task_complete', args: { outcome: 'answered', response: answer } }],
        }),
        // If this is consumed, task_complete did not actually stop ReAct.
        new AIMessage('This extra LLM round must never run.'),
      ],
      [plan(), { decision: 'finish', success: true, plan: null, response: 'REPLANNER MUST NOT RUN.' }],
    );

    const result = await runReactAgent({
      context,
      llm: llm as BaseChatModel,
      actions: [realTaskComplete(context)],
      task: 'Return the extracted value.',
    });

    expect(result).toEqual({ finalAnswer: answer, error: null });
    expect(context.finalAnswer).toBe(answer);
    expect(llm.chatInvocations).toBe(1);
    expect(llm.structuredInvocations).toBe(1);
    expect(terminalStates(events)).toEqual([
      expect.objectContaining({ state: ExecutionState.TASK_OK, details: answer }),
    ]);
  });

  it('publishes an early task_complete verbatim once the replanner confirms it, never the replanner text', async () => {
    const { context, events } = makeContext();
    const answer = '# Extracted result\n\n' + 'Evidence preserved verbatim. '.repeat(120);
    const llm = new ScriptedChatModel(
      [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'complete-1', name: 'task_complete', args: { outcome: 'answered', response: answer } }],
        }),
        // If this is consumed, task_complete did not actually stop ReAct.
        new AIMessage('This extra LLM round must never run.'),
      ],
      [
        { ...plan(), plan: ['Collect requested data', 'Explain findings', 'Return source links'] },
        { decision: 'finish', success: true, plan: null, response: 'REPLANNER MUST NOT REPLACE THE ANSWER.' },
      ],
    );

    const result = await runReactAgent({
      context,
      llm: llm as BaseChatModel,
      actions: [realTaskComplete(context)],
      task: 'Return the extracted value.',
    });

    expect(result).toEqual({ finalAnswer: answer, error: null });
    expect(context.finalAnswer).toBe(answer);
    expect(llm.chatInvocations).toBe(1);
    // The planner, then the replanner reviewing the early completion.
    expect(llm.structuredInvocations).toBe(2);
    expect(terminalStates(events)).toEqual([
      expect.objectContaining({ state: ExecutionState.TASK_OK, details: answer }),
    ]);
    expect(events.filter(event => event.details.startsWith('{"type":"plan"')).at(-1)?.details).toBe(
      JSON.stringify({ type: 'plan', items: [] }),
    );
  });

  it('treats a rejected task_complete action as failure and never reports TASK_OK', async () => {
    const { context, events } = makeContext();
    const llm = new ScriptedChatModel(
      [
        new AIMessage({
          content: '',
          tool_calls: [
            { id: 'complete-1', name: 'task_complete', args: { outcome: 'answered', response: 'invented success' } },
          ],
        }),
        new AIMessage('The terminal action failed.'),
      ],
      [plan(), { decision: 'finish', success: true, plan: null, response: 'FALSE SUCCESS' }],
    );

    const result = await runReactAgent({
      context,
      llm: llm as BaseChatModel,
      actions: [failedTaskComplete()],
      task: 'Return a result only if task_complete succeeds.',
    });

    expect(result.finalAnswer).toBeNull();
    expect(result.error).toContain('terminal action was rejected');
    expect(terminalStates(events).map(event => event.state)).toEqual([ExecutionState.TASK_FAIL]);
  });

  // 2026-10-01 robustness eval: «the shop does not sell it» was delivered as a
  // success because only a blocked site counted as failure.
  it('maps task_complete(outcome=not_on_site) to TASK_FAIL with the response verbatim', async () => {
    const { context, events } = makeContext();
    const explanation = 'KitchenStore lists Zephyr X7 and X8, but no Zephyr X9, so there is no price to report.';
    const llm = new ScriptedChatModel(
      [
        new AIMessage({
          content: '',
          tool_calls: [
            { id: 'complete-1', name: 'task_complete', args: { outcome: 'not_on_site', response: explanation } },
          ],
        }),
      ],
      [plan()],
    );

    const result = await runReactAgent({
      context,
      llm: llm as BaseChatModel,
      actions: [realTaskComplete(context)],
      task: 'What is the price of the Zephyr X9 blender?',
    });

    expect(result).toEqual({ finalAnswer: null, error: explanation });
    expect(terminalStates(events)).toEqual([
      expect.objectContaining({ state: ExecutionState.TASK_FAIL, details: explanation }),
    ]);
  });

  it('never reports TASK_OK for a completion without an outcome', async () => {
    const { context, events } = makeContext();
    const llm = new ScriptedChatModel(
      [
        new AIMessage({
          content: '',
          tool_calls: [
            {
              id: 'complete-1',
              name: 'task_complete',
              args: { response: "I couldn't verify a price for the Zephyr X9 blender.", success: true },
            },
          ],
        }),
        new AIMessage('The terminal action failed.'),
      ],
      [plan(), { decision: 'finish', success: true, plan: null, response: 'FALSE SUCCESS' }],
    );

    const result = await runReactAgent({
      context,
      llm: llm as BaseChatModel,
      actions: [realTaskComplete(context)],
      task: 'What is the price of the Zephyr X9 blender?',
    });

    expect(result.finalAnswer).toBeNull();
    expect(terminalStates(events).map(event => event.state)).toEqual([ExecutionState.TASK_FAIL]);
  });

  it('maps task_complete(outcome=blocked) to TASK_FAIL while preserving its explanation', async () => {
    const { context, events } = makeContext();
    const explanation = 'The website requires a CAPTCHA before the requested export can be completed.';
    const llm = new ScriptedChatModel(
      [
        new AIMessage({
          content: '',
          tool_calls: [
            { id: 'complete-1', name: 'task_complete', args: { outcome: 'blocked', response: explanation } },
          ],
        }),
      ],
      [plan()],
    );

    const result = await runReactAgent({
      context,
      llm: llm as BaseChatModel,
      actions: [realTaskComplete(context)],
      task: 'Export the requested data.',
    });

    expect(result).toEqual({ finalAnswer: null, error: explanation });
    expect(terminalStates(events)).toEqual([
      expect.objectContaining({ state: ExecutionState.TASK_FAIL, details: explanation }),
    ]);
    expect(events.filter(event => event.details.startsWith('{"type":"plan"')).at(-1)?.details).toBe(
      JSON.stringify({ type: 'plan', items: [] }),
    );
  });

  it('fails closed when a malformed task_complete call is rejected by its schema', async () => {
    const { context, events } = makeContext();
    const llm = new ScriptedChatModel(
      [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'complete-1', name: 'task_complete', args: { outcome: 'answered', response: '   ' } }],
        }),
      ],
      [plan()],
    );

    const result = await runReactAgent({
      context,
      llm: llm as BaseChatModel,
      actions: [realTaskComplete(context)],
      task: 'Return a valid answer.',
    });

    expect(result.finalAnswer).toBeNull();
    expect(result.error).toMatch(/response.*blank|invalid|valid result/i);
    expect(terminalStates(events).map(event => event.state)).toEqual([ExecutionState.TASK_FAIL]);
  });

  it('rejects a model batch that mixes task_complete with another action before either action executes', async () => {
    const { context, events } = makeContext();
    const dangerousCall = vi.fn(async () => new ActionResult({ extractedContent: 'side effect ran' }));
    const dangerousAction = new Action(dangerousCall, {
      name: 'mutate_page',
      description: 'A deliberately observable side-effecting test action.',
      schema: z.object({ value: z.string() }),
    });
    const llm = new ScriptedChatModel(
      [
        new AIMessage({
          content: '',
          tool_calls: [
            { id: 'complete-1', name: 'task_complete', args: { outcome: 'answered', response: 'answer' } },
            { id: 'mutation-1', name: 'mutate_page', args: { value: 'must never execute' } },
          ],
        }),
        new AIMessage('This retry must never run.'),
      ],
      [plan(), { decision: 'finish', success: true, plan: null, response: 'FALSE SUCCESS' }],
    );

    const result = await runReactAgent({
      context,
      llm: llm as BaseChatModel,
      actions: [realTaskComplete(context), dangerousAction],
      task: 'Finish without mutations.',
    });

    expect(dangerousCall).not.toHaveBeenCalled();
    expect(result.finalAnswer).toBeNull();
    expect(result.error).toMatch(/task_complete.*other tool|terminal.*batch/i);
    expect(terminalStates(events).map(event => event.state)).toEqual([ExecutionState.TASK_FAIL]);
  });

  it('emits TASK_FAIL, never TASK_OK, when the agent tab disappears', async () => {
    const { context, events } = makeContext({ tabGone: true });
    const llm = new ScriptedChatModel([], [plan('Read the page')]);

    const result = await runReactAgent({ context, llm: llm as BaseChatModel, actions: [], task: 'Read the page.' });

    expect(result.finalAnswer).toBeNull();
    expect(result.error).toMatch(/tab.*(available|reachable)/i);
    expect(terminalStates(events).map(event => event.state)).toEqual([ExecutionState.TASK_FAIL]);
  });

  it('emits TASK_CANCEL, never TASK_OK, when execution is already cancelled', async () => {
    const { context, events } = makeContext({ stopped: true });
    const llm = new ScriptedChatModel([], [plan('Do any work')]);

    const result = await runReactAgent({ context, llm: llm as BaseChatModel, actions: [], task: 'Do any work.' });

    expect(result).toEqual({ finalAnswer: null, error: 'cancelled' });
    expect(terminalStates(events).map(event => event.state)).toEqual([ExecutionState.TASK_CANCEL]);
    expect(events.filter(event => event.details.startsWith('{"type":"plan"')).at(-1)?.details).toBe(
      JSON.stringify({ type: 'plan', items: [] }),
    );
  });

  it('keeps the replanner path for a normal non-terminal subgoal', async () => {
    const { context, events } = makeContext();
    const answer = 'The ordinary subgoal result was synthesized by the replanner.';
    const llm = new ScriptedChatModel(
      [new AIMessage('I collected the requested data.')],
      [plan(), { decision: 'finish', success: true, plan: null, response: answer }],
    );

    const result = await runReactAgent({ context, llm: llm as BaseChatModel, actions: [], task: 'Collect data.' });

    expect(result).toEqual({ finalAnswer: answer, error: null });
    expect(llm.chatInvocations).toBe(1);
    expect(terminalStates(events)).toEqual([
      expect.objectContaining({ state: ExecutionState.TASK_OK, details: answer }),
    ]);
  });

  it('maps a replanner-declared incomplete result to TASK_FAIL', async () => {
    const { context, events } = makeContext();
    const explanation = 'The target page requires a user sign-in before the remaining data can be read.';
    const llm = new ScriptedChatModel(
      [new AIMessage('I reached the sign-in wall.')],
      [plan(), { decision: 'finish', success: false, plan: null, response: explanation }],
    );

    const result = await runReactAgent({
      context,
      llm: llm as BaseChatModel,
      actions: [],
      task: 'Read protected data.',
    });

    expect(result).toEqual({ finalAnswer: null, error: explanation });
    expect(terminalStates(events)).toEqual([
      expect.objectContaining({ state: ExecutionState.TASK_FAIL, details: explanation }),
    ]);
  });

  it('continues an unfinished plan and delivers a later terminal answer without another replan', async () => {
    const { context, events } = makeContext();
    const answer = 'Collected both requested values: 42 and 43.';
    const llm = new ScriptedChatModel(
      [
        new AIMessage('The first value is 42; the second page still needs reading.'),
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'complete-2', name: 'task_complete', args: { outcome: 'answered', response: answer } }],
        }),
      ],
      [plan(), { decision: 'continue', plan: ['Read the second page'], response: null, success: null }],
    );
    const result = await runReactAgent({
      context,
      llm,
      actions: [realTaskComplete(context)],
      task: 'Read two values.',
    });
    expect(result).toEqual({ finalAnswer: answer, error: null });
    expect(llm.chatInvocations).toBe(2);
    expect(llm.structuredInvocations).toBe(2);
    expect(terminalStates(events).map(event => event.state)).toEqual([ExecutionState.TASK_OK]);
  });

  // 2026-09-27 Online-Mind2Web baseline (P0-1): the subgoal agent called
  // task_complete after subgoal 1 of 2 with a progress report, and that
  // report became the task's final answer. Red on 16ebcf1.
  it('does not let a subgoal task_complete end the task while later subgoals remain', async () => {
    const { context, events } = makeContext();
    const progress =
      'Subgoal complete: Florida City, FL is selected in the search suggestions. Next, open the monthly forecast.';
    const answer = 'Monthly forecast for Florida City, FL: October highs 86–88°F, lows 72–75°F.';
    const llm = new ScriptedChatModel(
      [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'complete-1', name: 'task_complete', args: { outcome: 'answered', response: progress } }],
        }),
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'complete-2', name: 'task_complete', args: { outcome: 'answered', response: answer } }],
        }),
      ],
      [
        { ...plan(), plan: ['Search for Florida City', 'Open its monthly forecast'] },
        { decision: 'continue', plan: ['Open its monthly forecast'], response: null, success: null },
      ],
    );

    const result = await runReactAgent({
      context,
      llm: llm as BaseChatModel,
      actions: [realTaskComplete(context)],
      task: 'Show me the monthly weather forecast for Florida City.',
    });

    expect(result).toEqual({ finalAnswer: answer, error: null });
    expect(llm.chatInvocations).toBe(2);
    expect(llm.structuredInvocations).toBe(2);
    expect(terminalStates(events)).toEqual([
      expect.objectContaining({ state: ExecutionState.TASK_OK, details: answer }),
    ]);
    expect(events.some(event => event.details === progress)).toBe(false);
  });

  it('routes a subgoal task_complete(outcome=blocked) to the replanner while later subgoals remain', async () => {
    const { context, events } = makeContext();
    const partial = 'The highest-prize competition is ARC Prize 2026. The next step is to open its Code tab.';
    const answer = 'ARC Prize 2026 ($850,000); most-voted notebook: "ARC baseline" (1,204 votes).';
    const llm = new ScriptedChatModel(
      [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'complete-1', name: 'task_complete', args: { outcome: 'blocked', response: partial } }],
        }),
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'complete-2', name: 'task_complete', args: { outcome: 'answered', response: answer } }],
        }),
      ],
      [
        { ...plan(), plan: ['Find the highest-prize competition', 'Find its most-voted code'] },
        { decision: 'continue', plan: ['Find its most-voted code'], response: null, success: null },
      ],
    );

    const result = await runReactAgent({
      context,
      llm: llm as BaseChatModel,
      actions: [realTaskComplete(context)],
      task: 'Find the most-voted code in the highest-prize competition.',
    });

    expect(result).toEqual({ finalAnswer: answer, error: null });
    expect(llm.structuredInvocations).toBe(2);
    expect(terminalStates(events).map(event => event.state)).toEqual([ExecutionState.TASK_OK]);
  });

  // 2026-09-27: without today's date the replanner turned "tomorrow" into
  // "May 7, 2026" on the Ryanair task.
  it("gives the planner and the replanner today's date", async () => {
    const { context } = makeContext();
    const llm = new ScriptedChatModel(
      [new AIMessage('Found the search form.')],
      [plan(), { decision: 'finish', success: true, plan: null, response: 'Flights listed.' }],
    );

    await runReactAgent({ context, llm: llm as BaseChatModel, actions: [], task: 'Find a flight for tomorrow.' });

    const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
    const text = (input: unknown) => JSON.stringify(input);
    expect(llm.structuredInputs).toHaveLength(2);
    expect(text(llm.structuredInputs[0])).toContain(today);
    expect(text(llm.structuredInputs[1])).toContain(today);
  });

  it('fails closed when the replanner exhausts the plan without a completed task result', async () => {
    const { context, events } = makeContext();
    const llm = new ScriptedChatModel(
      [new AIMessage('I completed the only subgoal but have no final result.')],
      [plan(), { decision: 'continue', success: null, plan: [], response: null }],
    );

    const result = await runReactAgent({
      context,
      llm: llm as BaseChatModel,
      actions: [],
      task: 'Produce a final result.',
    });

    expect(result.finalAnswer).toBeNull();
    expect(result.error).toMatch(/plan was exhausted/i);
    expect(terminalStates(events).map(event => event.state)).toEqual([ExecutionState.TASK_FAIL]);
  });

  it('turns a real inner ReAct recursion exhaustion into TASK_FAIL', async () => {
    const { context, events } = makeContext();
    const observe = new Action(async () => new ActionResult({ extractedContent: 'No new observation.' }), {
      name: 'observe',
      description: 'Return an observation.',
      schema: z.object({ turn: z.number() }),
    });
    const llm = new ScriptedChatModel(
      Array.from(
        { length: 30 },
        (_, turn) =>
          new AIMessage({
            content: '',
            tool_calls: [{ id: `observe-${turn}`, name: 'observe', args: { turn } }],
          }),
      ),
      [plan('Keep observing')],
    );

    const result = await runReactAgent({
      context,
      llm: llm as BaseChatModel,
      actions: [observe],
      task: 'Observe forever.',
    });

    expect(llm.chatInvocations).toBeGreaterThan(1);
    expect(result.finalAnswer).toBeNull();
    expect(result.error).toMatch(/recursion/i);
    expect(terminalStates(events).map(event => event.state)).toEqual([ExecutionState.TASK_FAIL]);
  });
});
