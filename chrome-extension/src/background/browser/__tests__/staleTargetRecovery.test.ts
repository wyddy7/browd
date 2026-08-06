/**
 * Stale debugger target — detection and settle-before-attach.
 *
 * Regression origin (2026-08-06, second pass): the executor extracts a URL
 * from the task text and hands it to `openAgentTab`, which called
 * `chrome.tabs.update` and returned immediately. `tabs.update` resolves when
 * navigation STARTS, so the debugger attached while the tab still showed the
 * outgoing page. `chrome-extension://` → `http://` is a cross-process hop, so
 * Chrome made a new target and the old session answered "Cannot access a
 * chrome-extension:// URL of different extension" 36 times in a row — while
 * `chrome.tabs.get` had long since reported the new URL. The tab had moved;
 * the debugger had not.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('webextension-polyfill', () => ({ default: {} }));
vi.mock('../page', () => ({ default: class FakePage {}, build_initial_state: () => ({}) }));

import { isStaleTargetErrorMessage } from '../views';
import { waitForTabSettled } from '../context';

describe('isStaleTargetErrorMessage', () => {
  it.each([
    'Protocol error (Input.dispatchKeyEvent): Cannot access a chrome-extension:// URL of different extension',
    'Protocol error (Runtime.callFunctionOn): Cannot access a chrome-extension:// URL of different extension',
    'Cannot access a chrome:// URL',
    'Cannot access contents of the page',
    'Target closed',
  ])('recognises: %s', msg => {
    expect(isStaleTargetErrorMessage(msg)).toBe(true);
  });

  it.each([
    'No tab with id: 42',
    'Element: [object Object] not found',
    'net::ERR_CONNECTION_REFUSED',
    'budget exhausted for web_search',
  ])('does not confuse with other failures: %s', msg => {
    expect(isStaleTargetErrorMessage(msg)).toBe(false);
  });
});

describe('waitForTabSettled', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns as soon as the tab reports complete', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ status: 'loading' })
      .mockResolvedValueOnce({ status: 'loading' })
      .mockResolvedValueOnce({ status: 'complete' });
    (globalThis as unknown as { chrome: unknown }).chrome = { tabs: { get } };

    await waitForTabSettled(1, 5000);

    expect(get).toHaveBeenCalledTimes(3);
  });

  it('gives up after the timeout instead of hanging the task', async () => {
    const get = vi.fn().mockResolvedValue({ status: 'loading' });
    (globalThis as unknown as { chrome: unknown }).chrome = { tabs: { get } };

    const started = Date.now();
    await waitForTabSettled(1, 300);
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3000);
    expect(get).toHaveBeenCalled();
  });

  it('returns immediately when the tab is gone', async () => {
    const get = vi.fn().mockRejectedValue(new Error('No tab with id: 1'));
    (globalThis as unknown as { chrome: unknown }).chrome = { tabs: { get } };

    await waitForTabSettled(1, 5000);

    expect(get).toHaveBeenCalledTimes(1);
  });

  // `chrome.tabs.update` resolves when navigation is REQUESTED; until Chrome
  // flips the tab to `loading`, `tabs.get` still reports the OUTGOING document
  // with `status: 'complete'`. Accepting that early poll is exactly how the
  // debugger got attached to the old chrome-extension:// document.
  it('with expectNavigationFrom: does not accept the outgoing document\'s "complete"', async () => {
    const get = vi
      .fn()
      // outgoing document, still reporting complete on the old URL
      .mockResolvedValueOnce({ status: 'complete', url: 'chrome://newtab/' })
      .mockResolvedValueOnce({ status: 'complete', url: 'chrome://newtab/' })
      // navigation becomes visible, then settles
      .mockResolvedValueOnce({ status: 'loading', url: 'chrome://newtab/', pendingUrl: 'http://localhost:8765/' })
      .mockResolvedValue({ status: 'complete', url: 'http://localhost:8765/' });
    (globalThis as unknown as { chrome: unknown }).chrome = { tabs: { get } };

    await waitForTabSettled(1, 5000, 'chrome://newtab/');

    expect(get.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('with expectNavigationFrom: a URL change alone is enough evidence', async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce({ status: 'complete', url: 'chrome://newtab/' })
      .mockResolvedValue({ status: 'complete', url: 'http://localhost:8765/' });
    (globalThis as unknown as { chrome: unknown }).chrome = { tabs: { get } };

    await waitForTabSettled(1, 5000, 'chrome://newtab/');

    expect(get).toHaveBeenCalledTimes(2);
  });

  it('with expectNavigationFrom: bounded when no navigation ever becomes visible', async () => {
    const get = vi.fn().mockResolvedValue({ status: 'complete', url: 'chrome://newtab/' });
    (globalThis as unknown as { chrome: unknown }).chrome = { tabs: { get } };

    const started = Date.now();
    await waitForTabSettled(1, 300, 'chrome://newtab/');

    expect(Date.now() - started).toBeLessThan(3000);
  });
});
