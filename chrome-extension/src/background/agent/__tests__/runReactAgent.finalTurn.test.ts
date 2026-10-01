import { describe, expect, it, vi } from 'vitest';
import { AIMessage, AIMessageChunk, HumanMessage, ToolMessage } from '@langchain/core/messages';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { ChatResult } from '@langchain/core/outputs';
import { z } from 'zod';
import { ScriptedChatModel } from './support/scriptedChatModel';
import { ActionBuilder, Action } from '../actions/builder';
import { ActionResult, type AgentContext } from '../types';
import { type Actors, ExecutionState } from '../event/types';
import { runReactAgent } from '../agents/runReactAgent';
import { closeDanglingToolCalls } from '../agents/finalTurn';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

// 2026-10-01 robustness eval: a listing whose «Next» cycles 1→2→3→1 ran every
// subgoal into the 25-step recursion limit, and the user got «Recursion limit
// of 25 reached without hitting a stop condition…» as the answer (issue #10).

type RecordedEvent = { actor: Actors; state: ExecutionState; details: string };

function makeContext(maxSteps = 20) {
  const events: RecordedEvent[] = [];
  const state = {
    tabId: 41,
    url: 'https://furniture.test/list?page=1',
    title: 'Sofas',
    tabs: [],
    pageText: '',
    elementTree: { clickableElementsToString: () => '' },
  };
  const context = {
    taskId: 'final-turn',
    controller: new AbortController(),
    stopped: false,
    finalAnswer: null,
    options: { maxSteps, maxFailures: 3, includeAttributes: [] },
    browserContext: {
      getState: vi.fn(async () => state),
      getConfig: () => ({ deniedUrls: [] }),
      agentTabId: () => 41,
    },
    emitEvent: vi.fn(async (actor: Actors, eventState: ExecutionState, details: string) => {
      events.push({ actor, state: eventState, details });
    }),
  } as unknown as AgentContext;
  return { context, events };
}

function nextPageAction(): Action {
  return new Action(async () => new ActionResult({ extractedContent: 'Page loaded; no blue 3-seat sofa here.' }), {
    name: 'next_page',
    description: 'Open the next page of the listing.',
    schema: z.object({ intent: z.string().default(''), page: z.number() }),
  });
}

function realTaskComplete(context: AgentContext): Action {
  const action = new ActionBuilder(context, {} as BaseChatModel)
    .buildDefaultActions()
    .find(candidate => candidate.name() === 'task_complete');
  if (!action) throw new Error('task_complete was not registered');
  return action;
}

/**
 * The executor never stops paging. Binding only task_complete (the final turn)
 * returns a model that answers with `finalTurn`, so the test does not depend
 * on how many rounds fit into the recursion limit.
 */
class LoopingModel extends ScriptedChatModel {
  private page = 0;
  finalTurnBindings = 0;

  constructor(
    private readonly finalTurn: AIMessage[],
    structured: unknown[],
  ) {
    super([], structured);
  }

  bindTools(tools?: unknown[]) {
    if (tools?.length === 1) {
      this.finalTurnBindings += 1;
      return new ScriptedChatModel(this.finalTurn, []) as unknown as this;
    }
    return this;
  }

  async _generate(): Promise<ChatResult> {
    this.chatInvocations += 1;
    this.page += 1;
    const message = new AIMessage({
      content: '',
      tool_calls: [{ id: `next-${this.page}`, name: 'next_page', args: { page: this.page } }],
    });
    return { generations: [{ message, text: '' }], llmOutput: {} };
  }
}

function plan(steps: string[]) {
  return { reasoning: 'Walk the listing.', plan: steps, taskParameters: { urls: [], queries: [], names: [] } };
}

function terminalStates(events: RecordedEvent[]) {
  return events.filter(event =>
    [ExecutionState.TASK_OK, ExecutionState.TASK_FAIL, ExecutionState.TASK_CANCEL].includes(event.state),
  );
}

describe('final turn at the step limit', () => {
  it('ends a subgoal that hits the step limit with the agent own task_complete', async () => {
    const { context, events } = makeContext();
    const report = 'I paged through the sofa listing; it cycles 1 → 2 → 3 → 1 and no blue 3-seat sofa is on any page.';
    const llm = new LoopingModel(
      [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'final', name: 'task_complete', args: { outcome: 'not_on_site', response: report } }],
        }),
      ],
      [plan(['Find the blue 3-seat sofa and give its code'])],
    );

    const result = await runReactAgent({
      context,
      llm: llm as unknown as BaseChatModel,
      actions: [nextPageAction(), realTaskComplete(context)],
      task: 'Find the listing for the blue 3-seat sofa and give its code.',
    });

    expect(llm.finalTurnBindings).toBe(1);
    expect(result).toEqual({ finalAnswer: null, error: report });
    expect(terminalStates(events)).toEqual([
      expect.objectContaining({ state: ExecutionState.TASK_FAIL, details: report }),
    ]);
  });

  it('hands a step without a final-turn completion to the replanner, never the recursion-limit text', async () => {
    const { context, events } = makeContext();
    const answer = 'The listing repeats pages 1–3; I found no blue 3-seat sofa.';
    const llm = new LoopingModel(
      [new AIMessage('I will keep looking.')],
      [
        plan(['Find the blue 3-seat sofa', 'Read its listing code']),
        { decision: 'finish', outcome: 'not_on_site', plan: null, response: answer },
      ],
    );

    const result = await runReactAgent({
      context,
      llm: llm as unknown as BaseChatModel,
      actions: [nextPageAction(), realTaskComplete(context)],
      task: 'Find the listing for the blue 3-seat sofa and give its code.',
    });

    // The replanner saw the step as partial work, not as a terminal failure.
    expect(llm.structuredInvocations).toBe(2);
    expect(JSON.stringify(llm.structuredInputs[1])).toMatch(
      /failed: ran out of steps on \\"Find the blue 3-seat sofa\\"/,
    );
    const [terminal] = terminalStates(events);
    expect(terminal.state).toBe(ExecutionState.TASK_FAIL);
    expect(terminal.details).not.toMatch(/Recursion limit|recursionLimit|GRAPH_RECURSION_LIMIT/);
    expect(result.error).toBe(answer);
  });

  it('hands a final-turn completion from an earlier subgoal to the replanner as a proposal', async () => {
    const { context, events } = makeContext();
    const report = 'Pages 1–3 repeat; the blue 3-seat sofa is not listed.';
    const llm = new LoopingModel(
      [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'final', name: 'task_complete', args: { outcome: 'not_on_site', response: report } }],
        }),
      ],
      [
        plan(['Find the blue 3-seat sofa', 'Read its listing code']),
        { decision: 'finish', outcome: 'not_on_site', plan: null, response: report },
      ],
    );

    await runReactAgent({
      context,
      llm: llm as unknown as BaseChatModel,
      actions: [nextPageAction(), realTaskComplete(context)],
      task: 'Find the listing for the blue 3-seat sofa and give its code.',
    });

    expect(llm.structuredInvocations).toBe(2);
    // The forced «not answered» reaches the replanner as a failed step.
    expect(JSON.stringify(llm.structuredInputs[1])).toContain(`failed: ${report}`);
    expect(terminalStates(events).map(event => event.state)).toEqual([ExecutionState.TASK_FAIL]);
  });
});

/** Rejects a forced tool choice the way some providers do (Claude on Bedrock, Qwen), accepts «auto». */
class NoForcedChoiceModel extends LoopingModel {
  forcedAttempts = 0;

  bindTools(tools?: unknown[], options?: { tool_choice?: unknown }) {
    if (tools?.length === 1 && options?.tool_choice && options.tool_choice !== 'auto') {
      this.forcedAttempts += 1;
      const rejecting = new ScriptedChatModel([], []);
      rejecting._generate = async () => {
        throw new Error('400 tool_choice: type "tool" and "any" are not supported for this model.');
      };
      return rejecting as unknown as this;
    }
    return super.bindTools(tools);
  }
}

describe('final turn on a model without forced tool choice', () => {
  it('retries the final turn with tool_choice auto', async () => {
    const { context, events } = makeContext();
    const report = 'The listing cycles 1 → 2 → 3 → 1; no blue 3-seat sofa is listed.';
    const llm = new NoForcedChoiceModel(
      [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'final', name: 'task_complete', args: { outcome: 'not_on_site', response: report } }],
        }),
      ],
      [plan(['Find the blue 3-seat sofa and give its code'])],
    );

    const result = await runReactAgent({
      context,
      llm: llm as unknown as BaseChatModel,
      actions: [nextPageAction(), realTaskComplete(context)],
      task: 'Find the listing for the blue 3-seat sofa and give its code.',
    });

    expect(llm.forcedAttempts).toBe(1);
    expect(result).toEqual({ finalAnswer: null, error: report });
    expect(terminalStates(events)).toEqual([
      expect.objectContaining({ state: ExecutionState.TASK_FAIL, details: report }),
    ]);
  });
});

describe('consecutive forced failures', () => {
  it('ends with the agent last report, not an empty partial result', async () => {
    const { context, events } = makeContext();
    const report = (n: number) => `Attempt ${n}: pages 1–3 repeat and no blue 3-seat sofa is listed.`;
    const llm = new LoopingModel(
      [1, 2, 3].map(
        n =>
          new AIMessage({
            content: '',
            tool_calls: [
              { id: `final-${n}`, name: 'task_complete', args: { outcome: 'not_on_site', response: report(n) } },
            ],
          }),
      ),
      [
        plan(['Find the blue sofa', 'Read its code']),
        { decision: 'continue', plan: ['Search for the blue sofa', 'Read its code'], outcome: null, response: null },
        { decision: 'continue', plan: ['Browse sofas by colour', 'Read its code'], outcome: null, response: null },
      ],
    );

    const result = await runReactAgent({
      context,
      llm: llm as unknown as BaseChatModel,
      actions: [nextPageAction(), realTaskComplete(context)],
      task: 'Find the listing for the blue 3-seat sofa and give its code.',
    });

    const [terminal] = terminalStates(events);
    expect(terminal.state).toBe(ExecutionState.TASK_FAIL);
    expect(terminal.details).toContain(report(3));
    expect(terminal.details).not.toContain('(none)');
    expect(result.error).toBe(terminal.details);
  });
});

describe('task-level step limit', () => {
  it('reports an exhausted task budget in words, not as the graph error', async () => {
    const { context, events } = makeContext(3);
    const llm = new ScriptedChatModel(
      [new AIMessage('Read page 1: no blue sofa.'), new AIMessage('Read page 2: no blue sofa.')],
      [
        plan(['Read the first page']),
        { decision: 'continue', plan: ['Read the next page'], outcome: null, response: null },
        { decision: 'continue', plan: ['Read the next page'], outcome: null, response: null },
      ],
    );

    const result = await runReactAgent({
      context,
      llm: llm as unknown as BaseChatModel,
      actions: [realTaskComplete(context)],
      task: 'Find the listing for the blue 3-seat sofa and give its code.',
    });

    const [terminal] = terminalStates(events);
    expect(terminal.state).toBe(ExecutionState.TASK_FAIL);
    expect(terminal.details).not.toMatch(/Recursion limit|recursionLimit|GRAPH_RECURSION_LIMIT/);
    expect(result.error).toBe(terminal.details);
  });
});

describe('closeDanglingToolCalls', () => {
  it('drops a trailing tool call that never got a result', () => {
    const answered = new AIMessage({ content: '', tool_calls: [{ id: 'a', name: 'next_page', args: {} }] });
    const dangling = new AIMessage({ content: '', tool_calls: [{ id: 'b', name: 'next_page', args: {} }] });
    const messages = [
      new HumanMessage('find it'),
      answered,
      new ToolMessage({ content: 'ok', tool_call_id: 'a', name: 'next_page' }),
      dangling,
    ];
    expect(closeDanglingToolCalls(messages)).toEqual(messages.slice(0, 3));
  });

  it('drops a dangling call held as an AIMessageChunk, as a streamed graph stores it', () => {
    const dangling = new AIMessageChunk({ content: '', tool_calls: [{ id: 'b', name: 'next_page', args: {} }] });
    const messages = [new HumanMessage('find it'), dangling];
    expect(closeDanglingToolCalls(messages)).toEqual(messages.slice(0, 1));
  });

  it('keeps a transcript whose tool calls all have results', () => {
    const messages = [
      new HumanMessage('find it'),
      new AIMessage({ content: '', tool_calls: [{ id: 'a', name: 'next_page', args: {} }] }),
      new ToolMessage({ content: 'ok', tool_call_id: 'a', name: 'next_page' }),
    ];
    expect(closeDanglingToolCalls(messages)).toEqual(messages);
  });
});
