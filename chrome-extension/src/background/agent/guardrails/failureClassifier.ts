import type { ActionError, ActionErrorType } from '../agentErrors';

export type FailureAction =
  | 'retry' // safe to retry immediately (transient)
  | 'retry_backoff' // retry but wait (repeated transient)
  | 'repair' // ask LLM to fix its output (schema)
  | 'hitl_ask' // pause and ask user a question (ambiguous)
  | 'hitl_approve' // pause and wait for user approval (side_effect)
  | 'hitl_handoff' // transfer ownership to user with summary (reasoning failure)
  | 'fail_fast'; // abort — non-recoverable (auth/config)

interface TypeCounts {
  transient: number;
  schema_violation: number;
  ambiguous_input: number;
  reasoning_failure: number;
  side_effect_risk: number;
  auth_or_config: number;
}

const MAX_TRANSIENT_RETRIES = 5;
const MAX_SCHEMA_REPAIRS = 2;

/**
 * Classifies failures and decides the next action.
 * Replaces the naive consecutiveFailures++ counter with per-type accounting.
 * Pattern from auto-docs/for-development/agents/failure-policy.md
 */
export class FailureClassifier {
  private counts: TypeCounts = {
    transient: 0,
    schema_violation: 0,
    ambiguous_input: 0,
    reasoning_failure: 0,
    side_effect_risk: 0,
    auth_or_config: 0,
  };

  /** Call after each successful action to reset counts. */
  recordSuccess(): void {
    this.counts = {
      transient: 0,
      schema_violation: 0,
      ambiguous_input: 0,
      reasoning_failure: 0,
      side_effect_risk: 0,
      auth_or_config: 0,
    };
  }

  /**
   * Record a failure and return what to do next.
   * Increments the per-type counter, then applies routing rules.
   */
  next(error: ActionError): FailureAction {
    const type: ActionErrorType = error.type;
    this.counts[type]++;

    switch (type) {
      case 'auth_or_config':
        return 'fail_fast';

      case 'transient':
        if (this.counts.transient <= 2) return 'retry';
        if (this.counts.transient <= MAX_TRANSIENT_RETRIES) return 'retry_backoff';
        return 'hitl_handoff';

      case 'schema_violation':
        if (this.counts.schema_violation <= MAX_SCHEMA_REPAIRS) return 'repair';
        return 'hitl_handoff';

      case 'ambiguous_input':
        return 'hitl_ask';

      case 'side_effect_risk':
        return 'hitl_approve';

      case 'reasoning_failure':
        if (this.counts.reasoning_failure <= 1) return 'hitl_handoff';
        return 'fail_fast';

      default:
        return 'hitl_handoff';
    }
  }

  getCounts(): Readonly<TypeCounts> {
    return { ...this.counts };
  }

  getTotalFailures(): number {
    return Object.values(this.counts).reduce((a, b) => a + b, 0);
  }
}
