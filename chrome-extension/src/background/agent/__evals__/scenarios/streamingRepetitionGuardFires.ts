/**
 * T3 — StreamingRepetitionGuard fires on degenerate output.
 *
 * Pure unit — no LLM, no real browser. Synthesises a token stream that
 * contains a 60+ char substring repeated 3+ times in a 1500-char window
 * and asserts the guard's AbortController fires within that window.
 *
 * Catches regressions in the stream-side detector that ships in
 * `guardrails/streamingRepetitionGuard.ts`. Free; should run in <50ms.
 */

import { StreamingRepetitionGuard } from '../../guardrails/streamingRepetitionGuard';
import { assertion, type ScenarioReport } from '../runner';

export async function runStreamingRepetitionGuardFires(): Promise<ScenarioReport> {
  const name = 'streaming-repetition-guard-fires';
  const start = Date.now();
  const scriptedAssertions: ScenarioReport['scriptedAssertions'] = [];

  try {
    // Case 1 — degenerate stream should fire abort.
    const controller1 = new AbortController();
    const guard1 = new StreamingRepetitionGuard(controller1);
    const repeating = 'I will now go back to the search results to find another benchmark site. ';
    // Push tokens char-by-char to mimic streaming. After ~3 repetitions
    // the guard should fire.
    let firedAfter = -1;
    const fullStream = repeating.repeat(8);
    for (let i = 0; i < fullStream.length; i++) {
      guard1.handleLLMNewToken(fullStream[i], { prompt: 0, completion: 0 }, 'run-1');
      if (controller1.signal.aborted && firedAfter === -1) {
        firedAfter = i;
        break;
      }
    }
    scriptedAssertions.push(
      assertion(
        'guard fires on 3+ repetitions of 60+ char chunk',
        controller1.signal.aborted,
        `aborted=${controller1.signal.aborted}, firedAfter=${firedAfter}`,
      ),
      assertion(
        'guard fires within first 1500 chars (window size)',
        firedAfter >= 0 && firedAfter <= 1500,
        `firedAfter=${firedAfter}`,
      ),
    );

    // Case 2 — non-degenerate diverse stream must NOT fire.
    const controller2 = new AbortController();
    const guard2 = new StreamingRepetitionGuard(controller2);
    const diverseText =
      'Open source models vary in price and quality. The Llama 3 family offers strong performance at low cost. ' +
      'Qwen models target multilingual workloads with competitive pricing. DeepSeek prioritises reasoning depth. ' +
      'Choosing depends on the task: coding favours one family, summarisation another. ' +
      'Pricing per million tokens spans roughly two orders of magnitude across the open ecosystem in 2026. ' +
      'For evaluation purposes the relevant axes are latency, cost, and benchmark scores on the target task.';
    for (const char of diverseText) {
      guard2.handleLLMNewToken(char, { prompt: 0, completion: 0 }, 'run-2');
      if (controller2.signal.aborted) break;
    }
    scriptedAssertions.push(
      assertion(
        'guard does NOT fire on diverse non-repeating prose',
        !controller2.signal.aborted,
        `aborted=${controller2.signal.aborted}`,
      ),
    );

    // Case 3 — short stream below detection threshold should NOT fire.
    const controller3 = new AbortController();
    const guard3 = new StreamingRepetitionGuard(controller3);
    const shortStream = 'The answer is 42.';
    for (const char of shortStream) {
      guard3.handleLLMNewToken(char, { prompt: 0, completion: 0 }, 'run-3');
    }
    scriptedAssertions.push(
      assertion(
        'guard does NOT fire on stream shorter than detection threshold',
        !controller3.signal.aborted,
        `aborted=${controller3.signal.aborted}`,
      ),
    );

    const passed = scriptedAssertions.every(a => a.passed);
    return { name, passed, scriptedAssertions, durationMs: Date.now() - start };
  } catch (err) {
    return {
      name,
      passed: false,
      scriptedAssertions,
      durationMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
