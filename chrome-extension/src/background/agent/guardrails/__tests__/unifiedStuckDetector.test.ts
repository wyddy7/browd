import { describe, expect, it } from 'vitest';
import { UnifiedStuckDetector, computeStateFingerprint, isInnerRecursionLimitError } from '../unifiedStuckDetector';
import type { BrowserState } from '@src/background/browser/views';

describe('UnifiedStuckDetector', () => {
  describe('env-fingerprint guard', () => {
    it('does not trip on varied fingerprints', () => {
      const d = new UnifiedStuckDetector();
      expect(d.recordSubgoal({ fingerprint: 'a' })).toBeNull();
      expect(d.recordSubgoal({ fingerprint: 'b' })).toBeNull();
      expect(d.recordSubgoal({ fingerprint: 'c' })).toBeNull();
      expect(d.recordSubgoal({ fingerprint: 'd' })).toBeNull();
    });

    it('trips on three identical fingerprints in window', () => {
      const d = new UnifiedStuckDetector();
      expect(d.recordSubgoal({ fingerprint: 'x' })).toBeNull();
      expect(d.recordSubgoal({ fingerprint: 'x' })).toBeNull();
      const v = d.recordSubgoal({ fingerprint: 'x' });
      expect(v).not.toBeNull();
      expect(v?.kind).toBe('env-fingerprint');
      expect(v?.error.type).toBe('reasoning_failure');
    });

    it('replays test10 frozen-page pattern (4× identical screenshot+DOM)', () => {
      const d = new UnifiedStuckDetector();
      const fp = 'https://lmsys.org/blog/2023-05-25-arena|0|';
      expect(d.recordSubgoal({ fingerprint: fp })).toBeNull();
      expect(d.recordSubgoal({ fingerprint: fp })).toBeNull();
      expect(d.recordSubgoal({ fingerprint: fp })).not.toBeNull();
    });

    it('honours window size — repeats outside the window do not stack', () => {
      const d = new UnifiedStuckDetector({ fingerprintWindow: 3, fingerprintMaxRepeat: 3 });
      expect(d.recordSubgoal({ fingerprint: 'a' })).toBeNull();
      expect(d.recordSubgoal({ fingerprint: 'b' })).toBeNull();
      expect(d.recordSubgoal({ fingerprint: 'b' })).toBeNull();
      // window now [a,b,b]; a slides out next.
      expect(d.recordSubgoal({ fingerprint: 'b' })).not.toBeNull();
    });
  });

  describe('reset', () => {
    it('clears the fingerprint window', () => {
      const d = new UnifiedStuckDetector();
      d.recordSubgoal({ fingerprint: 'x' });
      d.recordSubgoal({ fingerprint: 'x' });
      d.reset();
      const s = d.getState();
      expect(s.fpWindow).toEqual([]);
    });
  });
});

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

describe('isInnerRecursionLimitError (T2p-2)', () => {
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
