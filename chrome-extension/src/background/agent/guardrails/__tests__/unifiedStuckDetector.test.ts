import { describe, expect, it } from 'vitest';
import { computeStateFingerprint, isInnerRecursionLimitError } from '../unifiedStuckDetector';
import type { BrowserState } from '@src/background/browser/views';

describe('computeStateFingerprint', () => {
  function buildState(over: Partial<BrowserState>): BrowserState {
    return {
      url: 'https://example.com/page',
      title: 'Example',
      tabId: 1,
      tabs: [],
      pageText: 'Hello world',
      selectorMap: new Map([
        [1, {}],
        [2, {}],
      ]) as unknown as BrowserState['selectorMap'],
      ...over,
    } as BrowserState;
  }

  it('strips query and hash from URL', () => {
    const a = computeStateFingerprint(buildState({ url: 'https://example.com/page?a=1#x' }));
    const b = computeStateFingerprint(buildState({ url: 'https://example.com/page?b=2#y' }));
    expect(a).toBe(b);
  });

  it('reflects different element counts', () => {
    const a = computeStateFingerprint(buildState({}));
    const b = computeStateFingerprint(
      buildState({ selectorMap: new Map([[1, {}]]) as unknown as BrowserState['selectorMap'] }),
    );
    expect(a).not.toBe(b);
  });

  it('reflects different page text in the first 200 chars', () => {
    const a = computeStateFingerprint(buildState({ pageText: 'AAAA' }));
    const b = computeStateFingerprint(buildState({ pageText: 'BBBB' }));
    expect(a).not.toBe(b);
  });

  it('ignores page text past the first 200 chars', () => {
    const head = 'x'.repeat(200);
    const a = computeStateFingerprint(buildState({ pageText: head + 'TAIL_A' }));
    const b = computeStateFingerprint(buildState({ pageText: head + 'TAIL_B' }));
    expect(a).toBe(b);
  });

  it('handles missing url / pageText / selectorMap gracefully', () => {
    const fp = computeStateFingerprint({
      url: undefined,
      title: '',
      tabId: 0,
      tabs: [],
      pageText: undefined,
      selectorMap: undefined,
    } as unknown as BrowserState);
    expect(fp).toBe('|0|');
  });
});

describe('isInnerRecursionLimitError', () => {
  it('matches the canonical LangGraph GraphRecursionError message', () => {
    expect(isInnerRecursionLimitError('Recursion limit of 25 reached without hitting a stop condition.')).toBe(true);
  });

  it('matches when wrapped in a longer error string', () => {
    expect(
      isInnerRecursionLimitError(
        'Error inside agent.invoke: Recursion limit of 25 reached without hitting a stop condition. See troubleshooting URL...',
      ),
    ).toBe(true);
  });

  it('survives future limit-number changes', () => {
    expect(isInnerRecursionLimitError('Recursion limit of 50 reached.')).toBe(true);
    expect(isInnerRecursionLimitError('Recursion limit of 8 reached and we gave up.')).toBe(true);
  });

  it('does not false-positive on unrelated error messages', () => {
    expect(isInnerRecursionLimitError('Network timeout after 30s')).toBe(false);
    expect(isInnerRecursionLimitError('Element with index 12 does not exist')).toBe(false);
    expect(isInnerRecursionLimitError('History entry to navigate to not found')).toBe(false);
    expect(isInnerRecursionLimitError('')).toBe(false);
  });

  it('handles non-string inputs without throwing', () => {
    expect(isInnerRecursionLimitError(null as unknown as string)).toBe(false);
    expect(isInnerRecursionLimitError(undefined as unknown as string)).toBe(false);
    expect(isInnerRecursionLimitError(42 as unknown as string)).toBe(false);
  });
});
