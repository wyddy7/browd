/* eslint-disable @typescript-eslint/no-unused-vars */
import { BasePrompt } from './base';
import { HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AgentContext } from '@src/background/agent/types';
import { plannerSystemPromptTemplate } from './templates/planner';

export class PlannerPrompt extends BasePrompt {
  private systemMessage: SystemMessage;

  constructor(customSystemPrompt?: string) {
    super();

    const trimmedCustomPrompt = customSystemPrompt?.trim();
    const prompt = trimmedCustomPrompt
      ? `${plannerSystemPromptTemplate.trim()}\n\n[User custom system instructions]\n${trimmedCustomPrompt}`
      : plannerSystemPromptTemplate;

    this.systemMessage = new SystemMessage(prompt);
  }

  getSystemMessage(): SystemMessage {
    return this.systemMessage;
  }

  async getUserMessage(context: AgentContext): Promise<HumanMessage> {
    return new HumanMessage('');
  }
}
