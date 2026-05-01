import { makeActionError, type ActionError } from '../agentErrors';

export interface ActionSignature {
  name: string;
  /** Primary arg: index for index-based actions, label for semantic, url for navigation */
  primaryArg: string;
}

/**
 * Detects agent loops by tracking a sliding window of (actionName, primaryArg) tuples.
 * If the same tuple appears >= maxRepeated times within the window, isLooping() returns true.
 *
 * Surfaces a reasoning_failure ActionError so FailureClassifier routes to hitl_handoff.
 */
export class LoopDetector {
  private window: ActionSignature[] = [];

  constructor(
    private readonly maxRepeated: number = 3,
    private readonly windowSize: number = 6,
  ) {}

  /** Record a completed action. Call AFTER execution. */
  record(sig: ActionSignature): void {
    this.window.push(sig);
    if (this.window.length > this.windowSize) {
      this.window.shift();
    }
  }

  /** Returns true if the same action appears >= maxRepeated times in the current window. */
  isLooping(): boolean {
    if (this.window.length < this.maxRepeated) return false;

    const counts = new Map<string, number>();
    for (const sig of this.window) {
      const key = `${sig.name}::${sig.primaryArg}`;
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      if (count >= this.maxRepeated) return true;
    }
    return false;
  }

  /** Returns a structured error to feed to FailureClassifier. */
  buildLoopError(): ActionError {
    const latest = this.window.at(-1);
    const actionDesc = latest ? `${latest.name}(${latest.primaryArg})` : 'unknown';
    return makeActionError(
      'reasoning_failure',
      `Loop detected: action "${actionDesc}" repeated >= ${this.maxRepeated} times in last ${this.windowSize} steps`,
    );
  }

  /** Reset the window (call after a new task or goal change). */
  reset(): void {
    this.window = [];
  }

  /** Build an ActionSignature from a raw action record (as returned by navigator). */
  static sigFromAction(actionRecord: Record<string, unknown>): ActionSignature {
    const name = Object.keys(actionRecord)[0] ?? 'unknown';
    const args = actionRecord[name];
    let primaryArg = '';
    if (args && typeof args === 'object') {
      const a = args as Record<string, unknown>;
      if ('index' in a) primaryArg = String(a.index);
      else if ('label' in a) primaryArg = String(a.label);
      else if ('url' in a) primaryArg = String(a.url);
      else if ('query' in a) primaryArg = String(a.query);
    }
    return { name, primaryArg };
  }
}
