import { describe, it, expect, beforeEach } from 'vitest';
import { LoopDetector } from '../loopDetector';

describe('LoopDetector', () => {
  let detector: LoopDetector;

  beforeEach(() => {
    detector = new LoopDetector(3, 6);
  });

  it('does not trigger with varied actions', () => {
    detector.record({ name: 'click_element', primaryArg: '5' });
    detector.record({ name: 'fill_field_by_label', primaryArg: 'Email' });
    detector.record({ name: 'scroll_to_bottom', primaryArg: '' });
    expect(detector.isLooping()).toBe(false);
  });

  it('triggers on scroll loop (same name+arg repeated 3 times)', () => {
    detector.record({ name: 'scroll_to_bottom', primaryArg: '' });
    detector.record({ name: 'scroll_to_bottom', primaryArg: '' });
    expect(detector.isLooping()).toBe(false); // only 2
    detector.record({ name: 'scroll_to_bottom', primaryArg: '' });
    expect(detector.isLooping()).toBe(true);
  });

  it('triggers on click loop', () => {
    for (let i = 0; i < 3; i++) {
      detector.record({ name: 'click_element', primaryArg: '9' });
    }
    expect(detector.isLooping()).toBe(true);
  });

  it('does not trigger when same action on different args', () => {
    detector.record({ name: 'click_element', primaryArg: '9' });
    detector.record({ name: 'click_element', primaryArg: '10' });
    detector.record({ name: 'click_element', primaryArg: '11' });
    expect(detector.isLooping()).toBe(false);
  });

  it('sliding window evicts old entries', () => {
    // fill window with scrolls (3 scrolls = loop)
    detector.record({ name: 'scroll_to_bottom', primaryArg: '' });
    detector.record({ name: 'scroll_to_bottom', primaryArg: '' });
    detector.record({ name: 'scroll_to_bottom', primaryArg: '' });
    expect(detector.isLooping()).toBe(true);

    // add 6 different actions to push scrolls out of window
    for (let i = 0; i < 6; i++) {
      detector.record({ name: 'click_element', primaryArg: String(i) });
    }
    expect(detector.isLooping()).toBe(false);
  });

  it('reset clears the window', () => {
    detector.record({ name: 'scroll_to_bottom', primaryArg: '' });
    detector.record({ name: 'scroll_to_bottom', primaryArg: '' });
    detector.record({ name: 'scroll_to_bottom', primaryArg: '' });
    detector.reset();
    expect(detector.isLooping()).toBe(false);
  });

  it('sigFromAction extracts index for index-based actions', () => {
    const sig = LoopDetector.sigFromAction({ click_element: { index: 9, intent: 'click submit' } });
    expect(sig.name).toBe('click_element');
    expect(sig.primaryArg).toBe('9');
  });

  it('sigFromAction extracts label for semantic actions', () => {
    const sig = LoopDetector.sigFromAction({ fill_field_by_label: { label: 'Email', value: 'test@test.com' } });
    expect(sig.name).toBe('fill_field_by_label');
    expect(sig.primaryArg).toBe('Email');
  });

  it('buildLoopError produces reasoning_failure', () => {
    for (let i = 0; i < 3; i++) {
      detector.record({ name: 'scroll_to_bottom', primaryArg: '' });
    }
    const err = detector.buildLoopError();
    expect(err.type).toBe('reasoning_failure');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('Loop detected');
  });
});
