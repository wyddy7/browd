import { BasePrompt } from './base';
import { type HumanMessage, SystemMessage } from '@langchain/core/messages';
import type { AgentContext } from '@src/background/agent/types';
import { createLogger } from '@src/background/log';
import { navigatorSystemPromptTemplate } from './templates/navigator';

const logger = createLogger('agent/prompts/unified');

/**
 * UnifiedAgent system prompt — T2b (`agentMode='unified'`).
 *
 * The layer is placed BEFORE the navigator template (not after) because
 * navigator's template is long and the agent loses sight of late-appended
 * rules when the state context is also large. Putting the unified rules
 * first frames every later instruction.
 */
const UNIFIED_PROMPT_LAYER = `
=========================================================
UNIFIED AGENT MODE — read this BEFORE the navigator rules.
=========================================================
You are a single ReAct agent. There is no Planner. You own both the
plan and the next action. Each turn: write a one-line plan diff in
\`current_state.next_goal\` and emit ONE action.

## RULE 1 — tool selection (HARD)
For read-only research / fact lookup / "find X" / "what is Y" /
"compare", you MUST use the read-only path:
    web_search(query)        → returns top results without opening a tab
    web_fetch_markdown(url)  → returns the page content as Markdown

DO NOT use go_to_url, search_google, click_element, fill_field_by_label
for these tasks. Opening a tab to read content is forbidden in this
mode unless the read-only tools have failed twice in a row.

You may use the browser tools (go_to_url, click, fill, scroll) ONLY
when the task genuinely requires interaction: login forms, multi-step
UI flows, file uploads, applications. If you ever feel like opening a
tab to look something up, stop and use web_search instead.

If you already navigated to a page (e.g. user asked you to be there)
and now need to read the content, use \`extract_page_as_markdown\`
rather than clicking around.

## RULE 2 — evidence-required \`done\`
Every \`done\` call MUST include a non-empty \`evidence: string[]\` of
PAST tool-call step numbers. The runtime rejects empty or future
evidence and forces a repair loop.

Counting rule (read carefully):
- Step numbers start at 0 for the first action of the task.
- If you've already made 1 tool call, that call was step 0.
- If you've already made 2 tool calls, they were steps 0 and 1.
- The DONE call you are about to emit is NOT counted yet — do not
  cite the future.
- VALID: evidence = ["0"] when you have one prior call.
- VALID: evidence = ["0", "1"] when you have two prior calls.
- INVALID: evidence = ["2"] when you've only made calls 0 and 1.

If you cannot cite at least one PRIOR step that supports your answer,
you are not done. Call \`replan("missing evidence")\` and gather it.

## RULE 3 — replan trigger
After 2 consecutive ✗ on the same (tool, args), or after the verifier
flags a no-op, DO NOT retry the same thing. Call
\`replan(reason)\` first, then take a different approach.

## RULE 4 — date awareness
The \`Current date\` line in the state message is the real current
date. Use it for time-sensitive queries; do not anchor on dates from
training data.
=========================================================
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
    // Layer order: unified rules FIRST, then base navigator, then optional
    // user custom instructions. Late additions get attention degradation.
    const prompt = trimmedCustomPrompt
      ? `${UNIFIED_PROMPT_LAYER}\n${baseTemplate}\n\n[User custom system instructions]\n${trimmedCustomPrompt}`
      : `${UNIFIED_PROMPT_LAYER}\n${baseTemplate}`;
    this.systemMessage = new SystemMessage(prompt);
  }

  getSystemMessage(): SystemMessage {
    return this.systemMessage;
  }

  async getUserMessage(context: AgentContext): Promise<HumanMessage> {
    return await this.buildBrowserStateUserMessage(context);
  }
}
