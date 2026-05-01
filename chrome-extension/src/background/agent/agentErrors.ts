/**
 * Structured action errors for the agent runtime.
 * Pattern from auto-docs/for-development/agents/failure-policy.md
 *
 * Each error carries its type and retryability so the FailureClassifier
 * can route without regex-ing human prose.
 */

export type ActionErrorType =
  | 'transient' // network, timeout, 429 — retry with backoff
  | 'schema_violation' // bad LLM output, invalid JSON — repair and re-ask
  | 'ambiguous_input' // field not found, goal unclear — HITL ask_user
  | 'reasoning_failure' // loop, repeated wrong action — HITL handoff
  | 'side_effect_risk' // about to submit/delete/pay — HITL approve
  | 'auth_or_config'; // missing API key, bad config — fail fast

export interface ActionError {
  type: ActionErrorType;
  retryable: boolean;
  message: string;
  originalError?: unknown;
}

const RETRYABLE: Record<ActionErrorType, boolean> = {
  transient: true,
  schema_violation: true,
  ambiguous_input: false,
  reasoning_failure: false,
  side_effect_risk: false,
  auth_or_config: false,
};

export function makeActionError(type: ActionErrorType, message: string, originalError?: unknown): ActionError {
  return { type, retryable: RETRYABLE[type], message, originalError };
}

/**
 * Convert any raw error into a structured ActionError.
 * Heuristics only — callers that know the exact class should call makeActionError directly.
 */
export function classifyError(raw: unknown): ActionError {
  const msg = raw instanceof Error ? raw.message : String(raw);

  // Network / upstream transient
  if (/timeout|ECONNRESET|ENOTFOUND|429|503|network/i.test(msg)) {
    return makeActionError('transient', msg, raw);
  }

  // Bad LLM JSON / Zod parse
  if (/is not valid JSON|ZodError|parse error|schema/i.test(msg)) {
    return makeActionError('schema_violation', msg, raw);
  }

  // Auth / config
  if (/401|403|Unauthorized|api.?key|forbidden/i.test(msg)) {
    return makeActionError('auth_or_config', msg, raw);
  }

  // Field not found → ambiguous input
  if (/field not found|element not found|no element matching/i.test(msg)) {
    return makeActionError('ambiguous_input', msg, raw);
  }

  // Default to transient for unknown errors (conservative — avoids silent corruption)
  return makeActionError('transient', msg, raw);
}
