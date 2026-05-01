/**
 * T2b meta-tools — `replan`, `remember`, evidence-aware `done`.
 *
 * These are only registered for the UnifiedAgent. The classic
 * Planner+Navigator path keeps its existing `done` schema (empty evidence
 * stays soft-allowed) so swapping `agentMode` does not break old behavior.
 *
 * Read order before editing: auto-docs/browd-agent-evolution.md (Tier 2b).
 */
import type { z } from 'zod';
import type { AgentContext } from '@src/background/agent/types';
import { ActionResult } from '@src/background/agent/types';
import type { doneActionSchema, replanActionSchema, rememberActionSchema } from '../actions/schemas';
import { globalTracer } from '../tracing';

export type DoneInput = z.infer<typeof doneActionSchema.schema>;
export type ReplanInput = z.infer<typeof replanActionSchema.schema>;
export type RememberInput = z.infer<typeof rememberActionSchema.schema>;

/**
 * Verify that `evidence` actually points to recorded tool calls in the
 * current task's trace. Returns the list of unknown IDs (empty = ok).
 *
 * The unified agent gives evidence as either short numeric stepNumbers
 * ('3') or 'step-3' / 'tool-3' / arbitrary identifiers. We only check that
 * SOME tool call with a matching stepNumber exists. This is intentionally
 * permissive — we only need to block "no evidence at all" hallucinations,
 * not enforce a perfect citation graph.
 */
export async function validateEvidence(taskId: string, evidence: readonly string[]): Promise<string[]> {
  if (evidence.length === 0) return ['no evidence provided'];
  const trace = await globalTracer.read(taskId);
  if (trace.length === 0) return ['no trace recorded yet'];
  const knownSteps = new Set(trace.map(e => String(e.stepNumber)));
  const knownTools = new Set(trace.map(e => e.tool));
  const unknown: string[] = [];
  for (const id of evidence) {
    const numeric = id.replace(/^(step-|tool-)/, '').trim();
    if (knownSteps.has(numeric) || knownTools.has(id)) continue;
    unknown.push(id);
  }
  return unknown;
}

/**
 * Unified-mode `done` handler. Rejects empty evidence with a repair-loop
 * error so the agent gets a concrete schema-feedback message and re-emits
 * with citations. In classic mode the existing handler is used (no
 * evidence enforcement), preserving backwards compatibility.
 */
export async function handleUnifiedDone(context: AgentContext, input: DoneInput): Promise<ActionResult> {
  const evidence = input.evidence ?? [];
  if (evidence.length === 0) {
    return new ActionResult({
      error:
        'done() rejected: evidence required in unified mode. Pass an array of tool-call step numbers (e.g. ["1","3"]) referring to entries in the trace that support your answer. If you cannot cite evidence, you are not done — call replan() instead.',
      includeInMemory: true,
    });
  }
  const unknown = await validateEvidence(context.taskId, evidence);
  if (unknown.length > 0) {
    return new ActionResult({
      error: `done() rejected: evidence references unknown tool calls: ${unknown.join(', ')}. Use the stepNumber (e.g. "0", "1") from previous tool calls in this task's trace.`,
      includeInMemory: true,
    });
  }
  context.finalAnswer = input.text;
  return new ActionResult({
    isDone: true,
    success: input.success,
    extractedContent: input.text,
    includeInMemory: true,
  });
}

/**
 * `replan(reason)` handler — clears the short-term plan signal and writes
 * the reason into memory. The next agent step will see the replan note in
 * context and is expected to take a different approach.
 */
export async function handleReplan(context: AgentContext, input: ReplanInput): Promise<ActionResult> {
  context.messageManager.addPlan(`[REPLAN] ${input.reason}`, context.messageManager.length());
  return new ActionResult({
    extractedContent: `Replan acknowledged: ${input.reason}. Next step must take a different approach.`,
    includeInMemory: true,
  });
}

/**
 * `remember(fact)` handler — appends a durable fact to MessageManager so it
 * survives compaction. Use sparingly: only for stable IDs / preferences /
 * constraints, not for tool results (those already live in the trace).
 */
export async function handleRemember(context: AgentContext, input: RememberInput): Promise<ActionResult> {
  context.messageManager.addPlan(`[REMEMBER] ${input.fact}`, context.messageManager.length());
  return new ActionResult({
    extractedContent: `Remembered: ${input.fact}`,
    includeInMemory: true,
  });
}
