import { describe, expect, it } from 'vitest';
import { AIMessage, HumanMessage, ToolMessage } from '@langchain/core/messages';
import { findTaskCompleteAnswer } from '../agents/runReactAgent';

/**
 * T2x phase 0c — `findTaskCompleteAnswer` finds a `task_complete`
 * sentinel call across three provider/adapter shapes. Test25
 * (Gemini-2.5-flash via OpenRouter, 2026-05-16) showed that scanning
 * ToolMessage.content alone is not enough: the model called the
 * action twice with valid args but the agent never short-circuited.
 */

describe('findTaskCompleteAnswer', () => {
  it('returns null on an empty message list', () => {
    expect(findTaskCompleteAnswer([])).toBeNull();
  });

  it('returns null when no task_complete signal is present', () => {
    const messages = [
      new HumanMessage('Find the best open-source model.'),
      new AIMessage({
        content: 'Let me check.',
        tool_calls: [{ id: '1', name: 'web_search', args: { query: 'foo' } }],
      }),
      new ToolMessage({ tool_call_id: '1', content: 'search results...' }),
      new AIMessage('I have searched, looking deeper.'),
    ];
    expect(findTaskCompleteAnswer(messages)).toBeNull();
  });

  describe('shape 1: ToolMessage with TASK_COMPLETE prefix', () => {
    it('catches a ToolMessage whose string content starts with the prefix', () => {
      const messages = [new ToolMessage({ tool_call_id: 'tc-1', content: 'TASK_COMPLETE: Qwen3.5-397B-A17B' })];
      expect(findTaskCompleteAnswer(messages)).toBe('TASK_COMPLETE: Qwen3.5-397B-A17B');
    });

    it('ignores ToolMessages whose content is not a string', () => {
      const messages = [
        new ToolMessage({
          tool_call_id: 'tc-2',
          content: [{ type: 'text', text: 'TASK_COMPLETE: should not match — multimodal' }] as never,
        }),
      ];
      expect(findTaskCompleteAnswer(messages)).toBeNull();
    });

    it('returns the FIRST matching message in order', () => {
      const messages = [
        new ToolMessage({ tool_call_id: 'tc-1', content: 'TASK_COMPLETE: first answer' }),
        new ToolMessage({ tool_call_id: 'tc-2', content: 'TASK_COMPLETE: second answer' }),
      ];
      expect(findTaskCompleteAnswer(messages)).toBe('TASK_COMPLETE: first answer');
    });
  });

  describe('shape 2: AIMessage.tool_calls (LangChain-canonical)', () => {
    it('catches task_complete from the canonical tool_calls slot', () => {
      const messages = [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'tc-x', name: 'task_complete', args: { response: 'best model is Qwen3.5' } }],
        }),
      ];
      expect(findTaskCompleteAnswer(messages)).toBe('TASK_COMPLETE: best model is Qwen3.5');
    });

    it('ignores tool_calls with non-matching names', () => {
      const messages = [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'tc-y', name: 'web_search', args: { query: 'unrelated' } }],
        }),
      ];
      expect(findTaskCompleteAnswer(messages)).toBeNull();
    });

    it('ignores task_complete tool_calls with empty response arg', () => {
      const messages = [
        new AIMessage({
          content: '',
          tool_calls: [{ id: 'tc-z', name: 'task_complete', args: { response: '' } }],
        }),
      ];
      expect(findTaskCompleteAnswer(messages)).toBeNull();
    });
  });

  describe('shape 3: additional_kwargs.tool_calls (raw OpenAI/OpenRouter)', () => {
    it('catches task_complete from additional_kwargs.tool_calls[i].function', () => {
      const ai = new AIMessage('');
      (ai as unknown as { additional_kwargs: unknown }).additional_kwargs = {
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: {
              name: 'task_complete',
              arguments: JSON.stringify({ response: 'Llama-3 70B is best by perf/$' }),
            },
          },
        ],
      };
      expect(findTaskCompleteAnswer([ai])).toBe('TASK_COMPLETE: Llama-3 70B is best by perf/$');
    });

    it('tolerates malformed JSON in function.arguments', () => {
      const ai = new AIMessage('');
      (ai as unknown as { additional_kwargs: unknown }).additional_kwargs = {
        tool_calls: [{ id: 'call_2', function: { name: 'task_complete', arguments: '{ this is not json' } }],
      };
      expect(findTaskCompleteAnswer([ai])).toBeNull();
    });

    it('ignores function calls with non-string response field', () => {
      const ai = new AIMessage('');
      (ai as unknown as { additional_kwargs: unknown }).additional_kwargs = {
        tool_calls: [
          { id: 'call_3', function: { name: 'task_complete', arguments: JSON.stringify({ response: 42 }) } },
        ],
      };
      expect(findTaskCompleteAnswer([ai])).toBeNull();
    });
  });

  it('replays test25 pattern: AIMessage with task_complete tool_call sandwiched between thinking', () => {
    // Simulates: model thought, called task_complete, then thought again silently.
    // Phase 0c must catch the answer even when the inner agent didn't exit
    // immediately after the tool call.
    const messages = [
      new HumanMessage('Find the best open-source model.'),
      new AIMessage({
        content: 'On llm-stats.com, comparing prices and benchmarks.',
        tool_calls: [{ id: 'tc-1', name: 'extract_page_as_markdown', args: { maxChars: 3000 } }],
      }),
      new ToolMessage({ tool_call_id: 'tc-1', content: '| Model | $/M in | ...' }),
      new AIMessage({
        content: '',
        tool_calls: [
          {
            id: 'tc-2',
            name: 'task_complete',
            args: { response: 'Best open-source: Qwen3.5-397B-A17B at $0.30/M in. Source: llm-stats.com.' },
          },
        ],
      }),
      new ToolMessage({
        tool_call_id: 'tc-2',
        content: 'TASK_COMPLETE: Best open-source: Qwen3.5-397B-A17B at $0.30/M in. Source: llm-stats.com.',
      }),
      new AIMessage('I have provided the answer.'),
    ];
    expect(findTaskCompleteAnswer(messages)).toBe(
      'TASK_COMPLETE: Best open-source: Qwen3.5-397B-A17B at $0.30/M in. Source: llm-stats.com.',
    );
  });
});
