import { describe, expect, it } from 'vitest';
import { UnifiedStuckDetector, computeStateFingerprint } from '../unifiedStuckDetector';
import type { BrowserState } from '@src/background/browser/views';

const ok = { toolCallCount: 1 } as const;
const silent = { toolCallCount: 0 } as const;

describe('UnifiedStuckDetector', () => {
  describe('env-fingerprint guard', () => {
    it('does not trip on varied fingerprints', () => {
      const d = new UnifiedStuckDetector();
      expect(d.recordSubgoal({ fingerprint: 'a', ...ok })).toBeNull();
      expect(d.recordSubgoal({ fingerprint: 'b', ...ok })).toBeNull();
      expect(d.recordSubgoal({ fingerprint: 'c', ...ok })).toBeNull();
      expect(d.recordSubgoal({ fingerprint: 'd', ...ok })).toBeNull();
    });

    it('trips on three identical fingerprints in window', () => {
      const d = new UnifiedStuckDetector();
      expect(d.recordSubgoal({ fingerprint: 'x', ...ok })).toBeNull();
      expect(d.recordSubgoal({ fingerprint: 'x', ...ok })).toBeNull();
      const v = d.recordSubgoal({ fingerprint: 'x', ...ok });
      expect(v).not.toBeNull();
      expect(v?.kind).toBe('env-fingerprint');
      expect(v?.error.type).toBe('reasoning_failure');
    });

    it('replays test10 frozen-page pattern (4× identical screenshot+DOM)', () => {
      const d = new UnifiedStuckDetector();
      const fp = 'https://lmsys.org/blog/2023-05-25-arena|0|';
      // First two subgoals same page (no progress yet), third trips.
      expect(d.recordSubgoal({ fingerprint: fp, ...ok })).toBeNull();
      expect(d.recordSubgoal({ fingerprint: fp, ...ok })).toBeNull();
      expect(d.recordSubgoal({ fingerprint: fp, ...ok })).not.toBeNull();
    });

    it('honours window size — repeats outside the window do not stack', () => {
      const d = new UnifiedStuckDetector({ fingerprintWindow: 3, fingerprintMaxRepeat: 3 });
      expect(d.recordSubgoal({ fingerprint: 'a', ...ok })).toBeNull();
      // a outside window after these:
      expect(d.recordSubgoal({ fingerprint: 'b', ...ok })).toBeNull();
      expect(d.recordSubgoal({ fingerprint: 'b', ...ok })).toBeNull();
      // window now [a,b,b]; a slides out next.
      expect(d.recordSubgoal({ fingerprint: 'b', ...ok })).not.toBeNull();
    });
  });

  describe('silent-step guard', () => {
    it('does not trip on a single silent step', () => {
      const d = new UnifiedStuckDetector();
      expect(d.recordSubgoal({ fingerprint: 'a', ...silent })).toBeNull();
    });

    it('trips on two consecutive silent steps', () => {
      const d = new UnifiedStuckDetector();
      expect(d.recordSubgoal({ fingerprint: 'a', ...silent })).toBeNull();
      const v = d.recordSubgoal({ fingerprint: 'b', ...silent });
      expect(v).not.toBeNull();
      expect(v?.kind).toBe('silent-step');
      expect(v?.error.type).toBe('reasoning_failure');
    });

    it('replays test10 "Wait for the leaderboard" no-toolCall pattern', () => {
      const d = new UnifiedStuckDetector();
      expect(d.recordSubgoal({ fingerprint: 'a', ...silent })).toBeNull();
      const v = d.recordSubgoal({ fingerprint: 'a', ...silent });
      // env-fingerprint with only 2 records does NOT fire (max=3);
      // silent-step DOES fire because consecutive=2.
      expect(v?.kind).toBe('silent-step');
    });

    it('resets the silent run on a non-silent step', () => {
      const d = new UnifiedStuckDetector();
      expect(d.recordSubgoal({ fingerprint: 'a', ...silent })).toBeNull();
      expect(d.recordSubgoal({ fingerprint: 'b', ...ok })).toBeNull();
      expect(d.recordSubgoal({ fingerprint: 'c', ...silent })).toBeNull(); // only 1 in a row
    });
  });

  describe('reset', () => {
    it('clears both windows', () => {
      const d = new UnifiedStuckDetector();
      d.recordSubgoal({ fingerprint: 'x', ...silent });
      d.recordSubgoal({ fingerprint: 'x', ...silent });
      d.reset();
      const s = d.getState();
      expect(s.fpWindow).toEqual([]);
      expect(s.silentRun).toBe(0);
    });
  });

  describe('order of checks', () => {
    it('reports env-fingerprint first when both could fire', () => {
      const d = new UnifiedStuckDetector();
      // Three silent + identical fingerprint subgoals.
      expect(d.recordSubgoal({ fingerprint: 'x', ...silent })).toBeNull();
      const v2 = d.recordSubgoal({ fingerprint: 'x', ...silent });
      // After two records: silent-step (2 in a row) tips; fp guard needs 3.
      expect(v2?.kind).toBe('silent-step');
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
