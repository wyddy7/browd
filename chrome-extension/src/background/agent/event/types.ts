export enum Actors {
  SYSTEM = 'system',
  USER = 'user',
  PLANNER = 'planner',
  NAVIGATOR = 'navigator',
}

export enum EventType {
  /**
   * Type of events that can be subscribed to.
   *
   * For now, only execution events are supported.
   */
  EXECUTION = 'execution',
}

export enum ExecutionState {
  /**
   * States representing different phases in the execution lifecycle.
   *
   * Format: <SCOPE>.<STATUS>
   * Scopes: task, step, act
   * Statuses: start, ok, fail, cancel
   *
   * Examples:
   *     TASK_OK = "task.ok"  // Task completed successfully
   *     STEP_FAIL = "step.fail"  // Step failed
   *     ACT_START = "act.start"  // Action started
   */
  // Task level states
  TASK_START = 'task.start',
  TASK_OK = 'task.ok',
  TASK_FAIL = 'task.fail',
  TASK_PAUSE = 'task.pause',
  TASK_RESUME = 'task.resume',
  TASK_CANCEL = 'task.cancel',

  // Human-in-the-loop states
  /** Agent needs a yes/no/edit/cancel decision from the user before a sensitive action. */
  TASK_HITL_APPROVE = 'task.hitl.approve',
  /** Agent needs a text answer from the user to resolve ambiguity. */
  TASK_HITL_ASK = 'task.hitl.ask',

  // Step level states
  STEP_START = 'step.start',
  STEP_OK = 'step.ok',
  STEP_FAIL = 'step.fail',
  STEP_CANCEL = 'step.cancel',
  /** Emitted after each verified action with human-readable description for the Trace UI. */
  STEP_TRACE = 'step.trace',

  // Action/Tool level states
  ACT_START = 'act.start',
  ACT_OK = 'act.ok',
  ACT_FAIL = 'act.fail',

  /**
   * T2f-final-2 — token-usage telemetry. Emitted by the unified agent
   * runtime after each agent.invoke() completes. `details` carries a
   * JSON payload `{inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, contextWindow}` so the
   * side panel can render the live token ring in the header. Cache fields
   * stay 0 when the provider/wrapper doesn't surface cache telemetry through
   * any of the parsed paths in `runReactAgent.ts`.
   */
  TASK_USAGE = 'task.usage',

  /**
   * T2v — token-level live indicator. Emitted by `streamBridge` while
   * the unified agent driver consumes `compiled.streamEvents()`.
   * `details` carries a JSON payload `{kind, ...}` where `kind` is one
   * of:
   *   - 'llm_streaming' — `{runId, model, tokensSoFar, msElapsed, ratePerSec}`
   *   - 'tool_start'    — `{runId, name, argsPreview}`
   *   - 'tool_end'      — `{runId, name, ok, ms}`
   *   - 'node'          — `{name, state}` where state is 'start'|'end'
   *                       and name is whitelisted to the
   *                       planner/agent/replanner graph nodes.
   *   - 'idle'          — `{}` (strip emptied, no active call)
   * Side panel renders this as a compact status strip above the TRACE
   * pane so a long LLM round shows visible activity instead of dead
   * silence.
   */
  TASK_LIVE = 'task.live',
}

export interface EventData {
  /** Data associated with an event */
  taskId: string;
  /** step is the step number of the task where the event occurred */
  step: number;
  /** max_steps is the maximum number of steps in the task */
  maxSteps: number;
  /** details is the content of the event */
  details: string;
}

export class AgentEvent {
  /**
   * Represents a state change event in the task execution system.
   * Each event has a type, a specific state that changed,
   * the actor that triggered the change, and associated data.
   */
  constructor(
    public actor: Actors,
    public state: ExecutionState,
    public data: EventData,
    public timestamp: number = Date.now(),
    public type: EventType = EventType.EXECUTION,
  ) {}
}

// The type of callback for event subscribers
export type EventCallback = (event: AgentEvent) => Promise<void>;
