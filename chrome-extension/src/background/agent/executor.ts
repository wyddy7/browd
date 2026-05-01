import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { type ActionResult, AgentContext, type AgentOptions, type AgentOutput } from './types';
import { t } from '@extension/i18n';
import { NavigatorAgent, NavigatorActionRegistry } from './agents/navigator';
import { PlannerAgent, type PlannerOutput } from './agents/planner';
import { NavigatorPrompt } from './prompts/navigator';
import { UnifiedPrompt } from './prompts/unified';
import { PlannerPrompt } from './prompts/planner';
import { createLogger } from '@src/background/log';
import MessageManager from './messages/service';
import type BrowserContext from '../browser/context';
import { ActionBuilder } from './actions/builder';
import { EventManager } from './event/manager';
import { Actors, type EventCallback, EventType, ExecutionState } from './event/types';
import {
  ChatModelAuthError,
  ChatModelBadRequestError,
  ChatModelForbiddenError,
  ExtensionConflictError,
  RequestCancelledError,
  MaxStepsReachedError,
  MaxFailuresReachedError,
} from './agents/errors';
import { URLNotAllowedError } from '../browser/views';
import { chatHistoryStore } from '@extension/storage/lib/chat';
import type { AgentStepHistory } from './history';
import type { GeneralSettingsConfig } from '@extension/storage';
import { FailureClassifier } from './guardrails/failureClassifier';
import { classifyError } from './agentErrors';
import { globalTracer } from './tracing';
import { HITLController, type SendMessage } from './hitl/controller';

const logger = createLogger('Executor');

export interface ExecutorExtraArgs {
  plannerLLM?: BaseChatModel;
  extractorLLM?: BaseChatModel;
  agentOptions?: Partial<AgentOptions>;
  agentSystemPrompts?: Partial<Record<'planner' | 'navigator', string>>;
  generalSettings?: GeneralSettingsConfig;
  /** Inject to enable real HITL pause/resume. Called by HITLController to send requests to side-panel. */
  hitlSendMessage?: SendMessage;
}

export class Executor {
  private readonly navigator: NavigatorAgent;
  private readonly planner: PlannerAgent;
  private readonly context: AgentContext;
  private readonly plannerPrompt: PlannerPrompt;
  private readonly navigatorPrompt: NavigatorPrompt | UnifiedPrompt;
  private readonly generalSettings: GeneralSettingsConfig | undefined;
  private readonly failureClassifier = new FailureClassifier();
  private readonly _hitlController?: HITLController;
  private tasks: string[] = [];
  private readonly unifiedMode: boolean = false;
  constructor(
    task: string,
    taskId: string,
    browserContext: BrowserContext,
    navigatorLLM: BaseChatModel,
    extraArgs?: Partial<ExecutorExtraArgs>,
  ) {
    const messageManager = new MessageManager();

    const plannerLLM = extraArgs?.plannerLLM ?? navigatorLLM;
    const extractorLLM = extraArgs?.extractorLLM ?? navigatorLLM;
    const eventManager = new EventManager();
    const context = new AgentContext(
      taskId,
      browserContext,
      messageManager,
      eventManager,
      extraArgs?.agentOptions ?? {},
    );

    this.generalSettings = extraArgs?.generalSettings;
    if (extraArgs?.hitlSendMessage) {
      this._hitlController = new HITLController(extraArgs.hitlSendMessage);
      context.hitlController = this._hitlController;
    }
    this.tasks.push(task);
    // T2b: agentMode='unified' uses one ReAct loop (no Planner) with the
    // UnifiedPrompt and the unified action set (evidence-required `done`,
    // `replan`, `remember`). agentMode='classic' is the inherited
    // Planner+Navigator pipeline. Default is 'classic' until T3 evals
    // promote 'unified' to default.
    this.unifiedMode = extraArgs?.generalSettings?.agentMode === 'unified';
    // T2c hotfix: in unified mode FORCE maxActionsPerStep=1. ReAct semantics
    // require one observation per thought; batching multiple actions in a
    // single LLM turn defeats the verifier-then-replan loop and produces
    // confusing traces (e.g. multiple `done` calls in one step retrying
    // different evidence ids). Classic keeps user-configured value.
    if (this.unifiedMode) {
      context.options.maxActionsPerStep = 1;
    }
    this.navigatorPrompt = this.unifiedMode
      ? new UnifiedPrompt(1, extraArgs?.agentSystemPrompts?.navigator)
      : new NavigatorPrompt(context.options.maxActionsPerStep, extraArgs?.agentSystemPrompts?.navigator);
    this.plannerPrompt = new PlannerPrompt(extraArgs?.agentSystemPrompts?.planner);

    const actionBuilder = new ActionBuilder(context, extractorLLM);
    const navigatorActionRegistry = new NavigatorActionRegistry(
      this.unifiedMode ? actionBuilder.buildUnifiedActions() : actionBuilder.buildDefaultActions(),
    );

    // Initialize agents with their respective prompts
    this.navigator = new NavigatorAgent(navigatorActionRegistry, {
      chatLLM: navigatorLLM,
      context: context,
      prompt: this.navigatorPrompt,
    });

    this.planner = new PlannerAgent({
      chatLLM: plannerLLM,
      context: context,
      prompt: this.plannerPrompt,
    });

    this.context = context;
    // Initialize message history
    this.context.messageManager.initTaskMessages(this.navigatorPrompt.getSystemMessage(), task);
  }

  get hitlController(): HITLController | undefined {
    return this._hitlController;
  }

  subscribeExecutionEvents(callback: EventCallback): void {
    this.context.eventManager.subscribe(EventType.EXECUTION, callback);
  }

  clearExecutionEvents(): void {
    // Clear all execution event listeners
    this.context.eventManager.clearSubscribers(EventType.EXECUTION);
  }

  addFollowUpTask(task: string): void {
    this.tasks.push(task);
    this.context.messageManager.addNewTask(task);

    // need to reset previous action results that are not included in memory
    this.context.actionResults = this.context.actionResults.filter(result => result.includeInMemory);
  }

  /**
   * Check if task is complete based on planner output and handle completion
   */
  private checkTaskCompletion(planOutput: AgentOutput<PlannerOutput> | null): boolean {
    if (planOutput?.result?.done) {
      logger.info('✅ Planner confirms task completion');
      if (planOutput.result.final_answer) {
        this.context.finalAnswer = planOutput.result.final_answer;
      }
      return true;
    }
    return false;
  }

  /**
   * Execute the task
   *
   * @returns {Promise<void>}
   */
  async execute(): Promise<void> {
    logger.info(
      `🚀 Executing task (mode=${this.unifiedMode ? 'unified' : 'classic'}): ${this.tasks[this.tasks.length - 1]}`,
    );
    const context = this.context;
    context.nSteps = 0;

    // T0: bind the tracer to this task so every Action.call writes a record
    // attributed to the right taskId.
    globalTracer.setContext({ taskId: context.taskId, stepNumber: 0 });
    // Forward structured trace entries to side-panel via STEP_TRACE events.
    // The payload is JSON-encoded inside `details` so existing string-based
    // consumers keep working; the side panel tries JSON.parse first.
    const traceUnsubscribe = globalTracer.subscribe(entry => {
      void this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.STEP_TRACE, JSON.stringify({ structured: entry }));
    });

    try {
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);
      if (this.unifiedMode) {
        await this.runUnifiedLoop();
      } else {
        await this.runClassicLoop();
      }
    } catch (error) {
      if (error instanceof RequestCancelledError) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));
      } else {
        const errorMessage = error instanceof Error ? error.message : String(error);
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_task_fail', [errorMessage]));
      }
    } finally {
      if (import.meta.env.DEV) {
        logger.debug('Executor history', JSON.stringify(this.context.history, null, 2));
      }
      // store the history only if replay is enabled
      if (this.generalSettings?.replayHistoricalTasks) {
        const historyString = JSON.stringify(this.context.history);
        logger.info(`Executor history size: ${historyString.length}`);
        await chatHistoryStore.storeAgentStepHistory(this.context.taskId, this.tasks[0], historyString);
      } else {
        logger.info('Replay historical tasks is disabled, skipping history storage');
      }
      // T0: stop forwarding trace events and persist remaining entries.
      try {
        traceUnsubscribe();
      } catch {
        // ignore
      }
      try {
        await globalTracer.flush();
      } catch (err) {
        logger.warning('tracer flush failed', err);
      }
    }
  }

  /**
   * Classic Planner+Navigator loop — inherited from Nanobrowser.
   * Runs the Planner periodically (every `planningInterval` steps or after
   * the Navigator emits a tentative `done`) which validates / corrects the
   * Navigator's direction. Terminal: Planner confirms `done` OR maxSteps.
   */
  private async runClassicLoop(): Promise<void> {
    const context = this.context;
    const allowedMaxSteps = context.options.maxSteps;
    let step = 0;
    let latestPlanOutput: AgentOutput<PlannerOutput> | null = null;
    let navigatorDone = false;

    for (step = 0; step < allowedMaxSteps; step++) {
      context.stepInfo = { stepNumber: context.nSteps, maxSteps: allowedMaxSteps };
      globalTracer.setStep(context.nSteps);
      logger.info(`🔄 [classic] Step ${step + 1} / ${allowedMaxSteps}`);

      if (await this.shouldStop()) break;
      if (context.messageManager.length() > 30) {
        context.messageManager.compactOldStateMessages();
      }

      if (this.planner && (context.nSteps % context.options.planningInterval === 0 || navigatorDone)) {
        navigatorDone = false;
        latestPlanOutput = await this.runPlanner();
        if (this.checkTaskCompletion(latestPlanOutput)) break;
      }

      navigatorDone = await this.navigate();
      if (navigatorDone) {
        logger.info('🔄 Navigator indicates completion - will be validated by next planner run');
      }
    }

    const isCompleted = latestPlanOutput?.result?.done === true;
    if (isCompleted) {
      const finalMessage = context.finalAnswer || context.taskId;
      context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, finalMessage);
    } else if (step >= allowedMaxSteps) {
      logger.error('❌ Task failed: Max steps reached');
      context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_errors_maxStepsReached'));
    } else if (context.stopped) {
      context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));
    } else {
      context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, t('exec_task_pause'));
    }
  }

  /**
   * UnifiedAgent ReAct loop — single agent, no Planner.
   *
   * Owns its own termination contract: a navigator-emitted `done` (after
   * passing handleUnifiedDone evidence validation) IS the terminal signal.
   * No legacy plumbing — `done` here means done, no Planner re-validation.
   *
   * The Navigator class is reused as the LLM driver because it already
   * knows how to invoke a model with the {current_state, action[]} schema
   * over the message history. The unified action set (built via
   * buildUnifiedActions) replaces the lenient `done` with the
   * evidence-aware one and adds replan/remember meta-tools.
   */
  private async runUnifiedLoop(): Promise<void> {
    const context = this.context;
    const allowedMaxSteps = context.options.maxSteps;
    let step = 0;
    let terminated = false;

    for (step = 0; step < allowedMaxSteps; step++) {
      context.stepInfo = { stepNumber: context.nSteps, maxSteps: allowedMaxSteps };
      globalTracer.setStep(context.nSteps);
      logger.info(`🔄 [unified] Step ${step + 1} / ${allowedMaxSteps}`);

      if (await this.shouldStop()) break;
      if (context.messageManager.length() > 30) {
        context.messageManager.compactOldStateMessages();
      }

      const navigatorDone = await this.navigate();
      // T2c safety: paranoidly check that any action in this step set
      // isDone, not just the last one. With maxActionsPerStep=1 navigate()
      // already returns true on done, but if a future change re-enables
      // batching this catches the "done in middle of batch" case.
      const someDone = (context.actionResults ?? []).some(r => r.isDone);
      if (navigatorDone || someDone) {
        terminated = true;
        break;
      }
    }

    if (terminated) {
      const finalMessage = context.finalAnswer || 'Task completed.';
      context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, finalMessage);
    } else if (step >= allowedMaxSteps) {
      logger.error('❌ Task failed: Max steps reached');
      context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_errors_maxStepsReached'));
    } else if (context.stopped) {
      context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_task_cancel'));
    } else {
      context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_PAUSE, t('exec_task_pause'));
    }
  }

  /**
   * Helper method to run planner and store its output
   */
  private async runPlanner(): Promise<AgentOutput<PlannerOutput> | null> {
    const context = this.context;
    try {
      // Add current browser state to memory
      let positionForPlan = 0;
      if (this.tasks.length > 1 || this.context.nSteps > 0) {
        await this.navigator.addStateMessageToMemory();
        positionForPlan = this.context.messageManager.length() - 1;
      } else {
        positionForPlan = this.context.messageManager.length();
      }

      // Execute planner
      const planOutput = await this.planner.execute();
      if (planOutput.result) {
        this.context.messageManager.addPlan(JSON.stringify(planOutput.result), positionForPlan);
      }
      return planOutput;
    } catch (error) {
      logger.error(`Failed to execute planner: ${error}`);
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      context.consecutiveFailures++;
      logger.error(`Failed to execute planner: ${error}`);
      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
      return null;
    }
  }

  private async navigate(): Promise<boolean> {
    const context = this.context;
    try {
      // Get and execute navigation action
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      const navOutput = await this.navigator.execute();
      // check if the task is paused or stopped
      if (context.paused || context.stopped) {
        return false;
      }
      context.nSteps++;
      if (navOutput.error) {
        throw new Error(navOutput.error);
      }
      this.failureClassifier.recordSuccess();
      context.consecutiveFailures = 0;
      if (navOutput.result?.done) {
        return true;
      }
    } catch (error) {
      if (
        error instanceof ChatModelAuthError ||
        error instanceof ChatModelBadRequestError ||
        error instanceof ChatModelForbiddenError ||
        error instanceof URLNotAllowedError ||
        error instanceof RequestCancelledError ||
        error instanceof ExtensionConflictError
      ) {
        throw error;
      }
      const classified = classifyError(error);
      const failAction = this.failureClassifier.next(classified);
      logger.warning(`FailureClassifier → ${failAction} (${classified.type}): ${classified.message}`);
      context.consecutiveFailures = this.failureClassifier.getTotalFailures();

      // T2a: route on the classifier verdict instead of just counting.
      // - fail_fast / auth_or_config: abort immediately, do not retry.
      // - hitl_handoff: pause the loop and ask the user how to proceed.
      // - retry_backoff: wait before continuing the loop.
      // - retry / repair / hitl_ask / hitl_approve: fall through (existing
      //   action handlers already manage hitl_ask / hitl_approve via
      //   ApprovalPolicy).
      if (failAction === 'fail_fast') {
        logger.error(`fail_fast: ${classified.type}: ${classified.message}`);
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
      if (failAction === 'hitl_handoff' && this._hitlController) {
        try {
          const decision = await this._hitlController.requestDecision({
            id: `hitl-handoff-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            reason: 'repeated_failure',
            pendingAction: { handoff: { reason: classified.type, message: classified.message } },
            context: {
              summary: `Agent stuck after repeated ${classified.type} failures. Last error: ${classified.message}`,
              risk: 'medium',
              confidence: 0.4,
            },
          });
          context.messageManager.addHITLDecision(decision, {
            id: `hitl-handoff-${Date.now()}`,
            reason: 'repeated_failure',
            pendingAction: { handoff: {} },
            context: { summary: 'handoff', risk: 'medium', confidence: 0.4 },
          });
          if (decision.type === 'reject') {
            throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
          }
          // approve / edit / answer → continue the loop, classifier reset
          this.failureClassifier.recordSuccess();
          context.consecutiveFailures = 0;
          return false;
        } catch (handoffErr) {
          if (handoffErr instanceof MaxFailuresReachedError) throw handoffErr;
          logger.warning('HITL handoff failed, falling back to maxFailures gate', handoffErr);
        }
      }
      if (failAction === 'retry_backoff') {
        const backoffMs = Math.min(
          5_000,
          (context.options.retryDelay ?? 1) * 1000 * Math.pow(2, this.failureClassifier.getCounts().transient - 1),
        );
        logger.info(`retry_backoff: sleeping ${backoffMs}ms before next iteration`);
        await new Promise(r => setTimeout(r, backoffMs));
      }

      if (context.consecutiveFailures >= context.options.maxFailures) {
        throw new MaxFailuresReachedError(t('exec_errors_maxFailuresReached'));
      }
    }
    return false;
  }

  private async shouldStop(): Promise<boolean> {
    if (this.context.stopped) {
      logger.info('Agent stopped');
      return true;
    }

    while (this.context.paused) {
      await new Promise(resolve => setTimeout(resolve, 200));
      if (this.context.stopped) {
        return true;
      }
    }

    if (this.context.consecutiveFailures >= this.context.options.maxFailures) {
      logger.error(`Stopping due to ${this.context.options.maxFailures} consecutive failures`);
      return true;
    }

    return false;
  }

  async cancel(): Promise<void> {
    this.context.stop();
  }

  async resume(): Promise<void> {
    this.context.resume();
  }

  async pause(): Promise<void> {
    this.context.pause();
  }

  async cleanup(): Promise<void> {
    try {
      await this.context.browserContext.cleanup();
    } catch (error) {
      logger.error(`Failed to cleanup browser context: ${error}`);
    }
  }

  async getCurrentTaskId(): Promise<string> {
    return this.context.taskId;
  }

  /**
   * Replays a saved history of actions with error handling and retry logic.
   *
   * @param history - The history to replay
   * @param maxRetries - Maximum number of retries per action
   * @param skipFailures - Whether to skip failed actions or stop execution
   * @param delayBetweenActions - Delay between actions in seconds
   * @returns List of action results
   */
  async replayHistory(
    sessionId: string,
    maxRetries = 3,
    skipFailures = true,
    delayBetweenActions = 2.0,
  ): Promise<ActionResult[]> {
    const results: ActionResult[] = [];
    const replayLogger = createLogger('Executor:replayHistory');

    logger.info('replay task', this.tasks[0]);

    try {
      const historyFromStorage = await chatHistoryStore.loadAgentStepHistory(sessionId);
      if (!historyFromStorage) {
        throw new Error(t('exec_replay_historyNotFound'));
      }

      const history = JSON.parse(historyFromStorage.history) as AgentStepHistory;
      if (history.history.length === 0) {
        throw new Error(t('exec_replay_historyEmpty'));
      }
      logger.debug(`🔄 Replaying history: ${JSON.stringify(history, null, 2)}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_START, this.context.taskId);

      for (let i = 0; i < history.history.length; i++) {
        const historyItem = history.history[i];

        // Check if execution should stop
        if (this.context.stopped) {
          replayLogger.info('Replay stopped by user');
          break;
        }

        // Execute the history step with enhanced method that handles all the logic
        const stepResults = await this.navigator.executeHistoryStep(
          historyItem,
          i,
          history.history.length,
          maxRetries,
          delayBetweenActions * 1000,
          skipFailures,
        );

        results.push(...stepResults);

        // If stopped during execution, break the loop
        if (this.context.stopped) {
          break;
        }
      }

      if (this.context.stopped) {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_CANCEL, t('exec_replay_cancel'));
      } else {
        this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_OK, t('exec_replay_ok'));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      replayLogger.error(`Replay failed: ${errorMessage}`);
      this.context.emitEvent(Actors.SYSTEM, ExecutionState.TASK_FAIL, t('exec_replay_fail', [errorMessage]));
    }

    return results;
  }
}
