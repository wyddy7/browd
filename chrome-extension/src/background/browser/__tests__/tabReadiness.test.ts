import { afterEach, describe, expect, it, vi } from 'vitest';
import { waitForTabReady } from '../tabReadiness';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('tab readiness event ordering', () => {
  it('activation-only waits ignore loading updates', async () => {
    vi.useFakeTimers();
    let update!: (id: number, info: chrome.tabs.TabChangeInfo) => void;
    let activate!: (info: chrome.tabs.TabActiveInfo) => void;
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn(async () => ({ id: 7, active: false, status: 'loading' })),
        onUpdated: {
          addListener: (fn: typeof update) => {
            update = fn;
          },
          removeListener: vi.fn(),
        },
        onActivated: {
          addListener: (fn: typeof activate) => {
            activate = fn;
          },
          removeListener: vi.fn(),
        },
      },
    });
    const waiting = waitForTabReady(7, { waitForUpdate: false });
    update(7, { status: 'loading' });
    activate({ tabId: 7, windowId: 1 });
    await vi.advanceTimersByTimeAsync(5001);
    expect(await waiting).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not overwrite a newer loading event with a stale complete snapshot', async () => {
    vi.useFakeTimers();
    let update!: (id: number, info: chrome.tabs.TabChangeInfo) => void;
    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn(async () => ({ id: 7, active: true, status: 'complete' })),
        onUpdated: {
          addListener: (fn: typeof update) => {
            update = fn;
          },
          removeListener: vi.fn(),
        },
        onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
    });
    const waiting = waitForTabReady(7);
    update(7, { status: 'loading' });
    await vi.advanceTimersByTimeAsync(5001);
    expect(await waiting).toBe(false);
  });
});
