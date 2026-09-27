import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import type { AIMessage } from '@langchain/core/messages';
import { RunnableLambda } from '@langchain/core/runnables';
import type { ChatResult } from '@langchain/core/outputs';

/**
 * A deterministic transport-level chat model. LangGraph, StateGraph, the
 * ReAct prebuilt graph, and Browd's Action wrappers all stay real; only the
 * provider transport is scripted. Structured calls are kept separate because
 * planner/replanner use `withStructuredOutput`, while the ReAct loop invokes
 * the bound chat model directly.
 */
export class ScriptedChatModel extends BaseChatModel {
  chatInvocations = 0;
  structuredInvocations = 0;
  /** Messages each planner/replanner call received, in call order. */
  structuredInputs: unknown[] = [];

  constructor(
    private readonly chatResponses: AIMessage[],
    private readonly structuredResponses: unknown[],
  ) {
    super({});
    // LangChain's overloaded method distinguishes includeRaw at the type
    // level. This test transport always returns parsed data, so replace the
    // provider boundary once with the inherited overload type intact.
    this.withStructuredOutput = (() =>
      RunnableLambda.from(async (input: unknown) => {
        this.structuredInvocations += 1;
        this.structuredInputs.push(input);
        const next = this.structuredResponses.shift();
        if (!next) throw new Error('unexpected structured-output invocation');
        return next;
      })) as unknown as this['withStructuredOutput'];
  }

  _llmType() {
    return 'scripted-completion-test';
  }

  _combineLLMOutput() {
    return [];
  }

  bindTools() {
    return this;
  }

  async _generate(): Promise<ChatResult> {
    this.chatInvocations += 1;
    const next = this.chatResponses.shift();
    if (!next) throw new Error('unexpected chat-model invocation');
    return {
      generations: [{ message: next, text: typeof next.content === 'string' ? next.content : '' }],
      llmOutput: {},
    };
  }
}
