import { describe, it, expect, beforeEach } from 'vitest';
import { FailureClassifier } from '../failureClassifier';
import { makeActionError } from '../../agentErrors';

describe('FailureClassifier', () => {
  let classifier: FailureClassifier;

  beforeEach(() => {
    classifier = new FailureClassifier();
  });

  it('auth_or_config → fail_fast immediately', () => {
    const action = classifier.next(makeActionError('auth_or_config', '401 Unauthorized'));
    expect(action).toBe('fail_fast');
  });

  it('transient → retry first 2 times, then retry_backoff, then hitl_handoff', () => {
    const err = makeActionError('transient', 'ECONNRESET');
    expect(classifier.next(err)).toBe('retry');
    expect(classifier.next(err)).toBe('retry');
    expect(classifier.next(err)).toBe('retry_backoff');
    expect(classifier.next(err)).toBe('retry_backoff');
    expect(classifier.next(err)).toBe('retry_backoff');
    expect(classifier.next(err)).toBe('hitl_handoff'); // count=6, > MAX_TRANSIENT_RETRIES=5
  });

  it('schema_violation → repair first 2 times, then hitl_handoff', () => {
    const err = makeActionError('schema_violation', 'ZodError');
    expect(classifier.next(err)).toBe('repair');
    expect(classifier.next(err)).toBe('repair');
    expect(classifier.next(err)).toBe('hitl_handoff');
  });

  it('ambiguous_input → hitl_ask always', () => {
    const err = makeActionError('ambiguous_input', 'field not found');
    expect(classifier.next(err)).toBe('hitl_ask');
    expect(classifier.next(err)).toBe('hitl_ask');
  });

  it('side_effect_risk → hitl_approve always', () => {
    const err = makeActionError('side_effect_risk', 'submit detected');
    expect(classifier.next(err)).toBe('hitl_approve');
    expect(classifier.next(err)).toBe('hitl_approve');
  });

  it('reasoning_failure → hitl_handoff first, then fail_fast', () => {
    const err = makeActionError('reasoning_failure', 'loop detected');
    expect(classifier.next(err)).toBe('hitl_handoff');
    expect(classifier.next(err)).toBe('fail_fast');
  });

  it('recordSuccess resets all counts', () => {
    const err = makeActionError('transient', 'timeout');
    classifier.next(err);
    classifier.next(err);
    classifier.next(err);
    classifier.recordSuccess();
    expect(classifier.getCounts().transient).toBe(0);
    expect(classifier.getTotalFailures()).toBe(0);
    // After reset: back to retry behaviour
    expect(classifier.next(err)).toBe('retry');
  });
});
