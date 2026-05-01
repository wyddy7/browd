import { BasePrompt } from './base';
import { type HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AgentContext } from '@src/background/agent/types';
import { createLogger } from '@src/background/log';
import { navigatorSystemPromptTemplate } from './templates/navigator';

const logger = createLogger('agent/prompts/unified');

/**
 * UnifiedAgent system prompt — T2b (`agentMode='unified'`).
 *
 * Layered on top of the existing navigator template. The base navigator
 * prompt knows how to drive browser tools and emit a `{current_state,
 * action[]}` JSON envelope. The unified-specific layer adds:
 *
 *   1. Tool-preference rules (web_* for read-only, browser tools only
 *      when interaction is required).
 *   2. Evidence-required `done` contract — closes the Planner-hallucination
 *      class.
 *   3. Replan trigger — after 2 consecutive ✗ on the same tool/args, the
 *      agent must call `replan(reason)` instead of repeating.
 *   4. No mention of Planner — there is no Planner in unified mode, so the
 *      agent must own its own planning inline in `current_state.next_goal`.
 */
const UNIFIED_PROMPT_LAYER = `
==== UNIFIED AGENT MODE ====
You are operating without a separate Planner. You own both the high-level
plan and the next concrete action. Each turn write your plan diff in
\`current_state.next_goal\` (one short sentence) and emit ONE action.

# Tool selection
- For read-only research / fact lookup / "find X" / "what is Y":
  PREFER \`web_search\` then \`web_fetch_markdown\`. Do NOT open a tab
  for read-only tasks.
- Only use \`search_google\` / \`go_to_url\` / \`click_element\` /
  \`fill_field_by_label\` when the task genuinely requires interaction
  (login, form submission, multi-step UI flow).
- After landing on a page where you only need to read content, use
  \`extract_page_as_markdown\` instead of clicking around.

# Evidence-required \`done\`
\`done\` requires a non-empty \`evidence: string[]\` listing the step
numbers (e.g. ["0", "2"]) of tool calls in this task that support your
answer. The runtime REJECTS empty evidence and forces a repair loop. If
you cannot cite any tool result that proves the answer, you are not
done — call \`replan(reason)\` instead and try a different approach.

Memorise tool-call step numbers as you go: each tool result is recorded
with stepNumber starting at 0. When you cite ["1", "3"] you are saying
"the answer rests on the result of step 1 and step 3".

# Replan trigger
If the same (tool, args) failed twice in a row, OR the verifier reported
✗ on the last action, do NOT retry the same thing. Call
\`replan(reason)\` first, then take a different approach.

# Date awareness
The \`Current date\` line in the state message is the actual current
date. Use it for time-sensitive queries instead of dates from training
data.

==== END UNIFIED AGENT MODE ====
`;

export class UnifiedPrompt extends BasePrompt {
  private systemMessage: SystemMessage;

  constructor(
    private readonly maxActionsPerStep = 5,
    customSystemPrompt?: string,
  ) {
    super();
    const baseTemplate = navigatorSystemPromptTemplate
      .replace('{{max_actions}}', this.maxActionsPerStep.toString())
      .trim();
    const trimmedCustomPrompt = customSystemPrompt?.trim();
    const prompt = trimmedCustomPrompt
      ? `${baseTemplate}\n${UNIFIED_PROMPT_LAYER}\n[User custom system instructions]\n${trimmedCustomPrompt}`
      : `${baseTemplate}\n${UNIFIED_PROMPT_LAYER}`;
    this.systemMessage = new SystemMessage(prompt);
  }

  getSystemMessage(): SystemMessage {
    return this.systemMessage;
  }

  async getUserMessage(context: AgentContext): Promise<HumanMessage> {
    return await this.buildBrowserStateUserMessage(context);
  }
}
