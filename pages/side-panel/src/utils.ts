import { Actors, chatHistoryStore } from '@extension/storage';

/**
 * T2h — build the chat-history seed forwarded to the agent on every
 * `new_task` / `follow_up_task`.
 *
 * Reads the persistent transcript from `chatHistoryStore`, keeps only
 * USER turns and PLANNER finals (PLANNER is what the agent emitted as
 * its answer in unified mode; SYSTEM/NAVIGATOR are progress noise),
 * drops the trailing USER turn (it's the task we are about to send),
 * and trims to the last 20 entries (~10 user/assistant pairs) so the
 * LLM context does not blow up on long sessions. Empty array on the
 * very first turn of a session.
 */
export interface AgentPriorMessage {
  role: 'user' | 'assistant';
  content: string;
}

const PRIOR_MESSAGES_LIMIT = 20;

export async function buildPriorMessagesForAgent(sessionId: string | null): Promise<AgentPriorMessage[]> {
  if (!sessionId) return [];
  try {
    const session = await chatHistoryStore.getSession(sessionId);
    if (!session || !session.messages) return [];
    const filtered: AgentPriorMessage[] = [];
    for (const m of session.messages) {
      if (!m.content) continue;
      if (m.actor === Actors.USER) filtered.push({ role: 'user', content: m.content });
      else if (m.actor === Actors.PLANNER) filtered.push({ role: 'assistant', content: m.content });
    }
    // Drop the trailing USER message — that is the task being sent now.
    if (filtered.length > 0 && filtered[filtered.length - 1].role === 'user') {
      filtered.pop();
    }
    if (filtered.length > PRIOR_MESSAGES_LIMIT) {
      return filtered.slice(filtered.length - PRIOR_MESSAGES_LIMIT);
    }
    return filtered;
  } catch (err) {
    console.warn('buildPriorMessagesForAgent failed', err);
    return [];
  }
}

export function generateNewTaskId(): string {
  /**
   * Generate a new task id based on the current timestamp and a random number.
   */
  return `${Date.now()}-${Math.floor(Math.random() * (999999 - 100000 + 1) + 100000)}`;
}

export function getCurrentTimestampStr(): string {
  /**
   * Get the current timestamp as a string in the format yyyy-MM-dd HH:mm:ss
   * using local timezone.
   *
   * @returns Formatted datetime string in local time
   */
  return new Date()
    .toLocaleString('en-US', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    })
    .replace(',', '');
}
