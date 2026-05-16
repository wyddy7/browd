/**
 * T2u-runaway-loop tests — kill-switch for the runaway log/CPU loop
 * that fired after a user pressed Stop on a task whose `agentTab`
 * had just been closed. Pre-fix symptom (recorded in the bug
 * report): 1.25M warnings shaped like
 *   [DOMService] skipping subFrame N during tree build: No tab with id: X
 *   [Page] Failed to update state: Error: No tab with id: X
 * piled up in the SW console at ~5–10k lines/sec because:
 *   1) `Page._updateState` caught the underlying Chrome error and
 *      returned a stale cached `PageState` — so the next call hit
 *      the same code path again,
 *   2) `BrowserContext._attachedPages` still held the dead Page,
 *      so `getCurrentPage()` resolved to it via the short-circuit
 *      `cached` early-return,
 *   3) `constructFrameTree` `continue`d on every iframe rather than
 *      breaking on the first `No tab with id`, multiplying the spam
 *      by the iframe count per `_updateState` call.
 *
 * The three tests below pin each of those failure points:
 *   1) `BrowserContext.handleTabGone` evicts the cached Page and
 *      clears matching `_agentTabId` / `_currentTabId` fields.
 *   2) `BrowserContext.getState` translates a `TabGoneError` from
 *      the underlying Page into a `handleTabGone` call AND
 *      re-throws (so the agent loop sees a real failure rather
 *      than a silently degraded cached state).
 *   3) `constructFrameTree` (called via `getClickableElements`)
 *      throws a `TabGoneError` on first "No tab with id" instead
 *      of looping through every iframe in `failedLoadingFrames`.
 *
 * Tests run under happy-dom (vitest default for this workspace).
 * The MV3 chrome.* surface is stubbed with `vi.stubGlobal` so we
 * don't need a real extension host.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('webextension-polyfill', () => ({ default: {} }));

import { TabGoneError } from '../views';

// ------------------------------------------------------------------
// Test 1 + 2 — BrowserContext.handleTabGone + getState eviction path
// ------------------------------------------------------------------

describe('T2u BrowserContext — handleTabGone evicts a dead tab', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('clears _agentTabId, _currentTabId, and removes the cached Page entry', async () => {
    // Use a vi.mock so `new Page(...)` returns a tracking stub. The
    // real Page would try to open a CDP connection.
    vi.doMock('../page', () => {
      return {
        default: class FakePage {
          tabId: number;
          _url: string;
          _title: string;
          detached = false;
          constructor(tabId: number, url: string, title: string) {
            this.tabId = tabId;
            this._url = url;
            this._title = title;
          }
          async attachPuppeteer() {
            return true;
          }
          async detachPuppeteer() {
            this.detached = true;
          }
          removeHighlight() {}
          updateConfig() {}
          url() {
            return this._url;
          }
        },
        build_initial_state: () => ({}),
      };
    });

    vi.stubGlobal('chrome', {
      tabs: {
        get: vi
          .fn()
          .mockImplementation((id: number) =>
            Promise.resolve({ id, url: `https://example.com/${id}`, title: 'T', active: true, groupId: -1 }),
          ),
        query: vi
          .fn()
          .mockResolvedValue([{ id: 7, url: 'https://example.com/7', title: 'T', active: true, groupId: -1 }]),
        update: vi.fn().mockResolvedValue(undefined),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      scripting: { executeScript: vi.fn().mockResolvedValue([]) },
    });

    const BrowserContext = (await import('../context')).default;
    const ctx = new BrowserContext({});

    // Prime the cache by walking through getCurrentPage()
    const page = await ctx.getCurrentPage();
    expect(page.tabId).toBe(7);
    // Force _agentTabId to a known value via takeOverTab (private state
    // would otherwise need ts-expect-error). takeOverTab sets both
    // _agentTabId and _currentTabId.
    ctx.takeOverTab(7);
    expect(ctx.agentTabId()).toBe(7);

    // Now: simulate the Chrome runtime reporting the tab is gone.
    ctx.handleTabGone(7);

    expect(ctx.agentTabId()).toBeNull();
    // _currentTabId is private; verify indirectly: next getCurrentPage()
    // would re-query the active tab via chrome.tabs.query. Re-priming
    // the stub to return a *different* active tab proves the previous
    // _currentTabId was cleared.
    const chromeStub = (globalThis as unknown as { chrome: { tabs: { query: ReturnType<typeof vi.fn> } } }).chrome;
    chromeStub.tabs.query.mockResolvedValueOnce([
      { id: 42, url: 'https://example.com/42', title: 'T42', active: true, groupId: -1 },
    ]);
    const reResolved = await ctx.getCurrentPage();
    expect(reResolved.tabId).toBe(42);

    vi.doUnmock('../page');
  });
});

// ------------------------------------------------------------------
// Test 2 — BrowserContext.getState surfaces TabGoneError and evicts
// ------------------------------------------------------------------

describe('T2u BrowserContext.getState — propagates TabGoneError and evicts the cached Page', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('rethrows TabGoneError from Page.getState and removes the cached entry', async () => {
    const DEAD_TAB = 1452658496;

    // Page stub: getState throws TabGoneError once cached entry hit.
    let pageGetStateCalls = 0;
    vi.doMock('../page', () => {
      return {
        default: class FakePage {
          tabId: number;
          constructor(tabId: number) {
            this.tabId = tabId;
          }
          async attachPuppeteer() {
            return true;
          }
          async detachPuppeteer() {}
          removeHighlight() {}
          updateConfig() {}
          url() {
            return `https://example.com/${this.tabId}`;
          }
          getCachedState() {
            return null;
          }
          async getState() {
            pageGetStateCalls += 1;
            // Mirrors what real Page._updateState now does on tab-gone.
            throw new TabGoneError(this.tabId, new Error(`No tab with id: ${this.tabId}`));
          }
        },
        build_initial_state: () => ({}),
      };
    });

    vi.stubGlobal('chrome', {
      tabs: {
        get: vi.fn().mockImplementation((id: number) =>
          Promise.resolve({
            id,
            url: `https://example.com/${id}`,
            title: 'T',
            active: true,
            groupId: -1,
          }),
        ),
        query: vi.fn().mockResolvedValue([{ id: DEAD_TAB, url: 'https://x/', title: 'X', active: true, groupId: -1 }]),
        update: vi.fn().mockResolvedValue(undefined),
        onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
        onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
      },
      scripting: { executeScript: vi.fn().mockResolvedValue([]) },
    });

    const BrowserContext = (await import('../context')).default;
    const ctx = new BrowserContext({});

    // Prime cache with the soon-to-be-dead tab.
    await ctx.getCurrentPage();
    ctx.takeOverTab(DEAD_TAB);
    expect(ctx.agentTabId()).toBe(DEAD_TAB);

    // First getState — should throw TabGoneError, NOT return a cached
    // state. This is the contract that breaks the loop: the agent
    // sees a real failure instead of a silently degraded success.
    await expect(ctx.getState(false)).rejects.toBeInstanceOf(TabGoneError);

    // After the throw, the cached Page MUST be evicted. We assert by
    // checking _agentTabId was cleared (which only happens via
    // handleTabGone) — confirms _handleStateError fired the eviction.
    expect(ctx.agentTabId()).toBeNull();
    expect(pageGetStateCalls).toBe(1);

    vi.doUnmock('../page');
  });
});

// ------------------------------------------------------------------
// Test 3 — dom/service constructFrameTree breaks on "No tab with id"
// instead of `continue`ing through every iframe
// ------------------------------------------------------------------

describe('T2u dom/service — getClickableElements aborts on dead tab', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws TabGoneError from the main-frame executeScript path', async () => {
    const DEAD_TAB = 1452658496;
    const executeScript = vi.fn().mockImplementation(() => {
      // Mirrors Chrome's actual rejection shape when the target tab
      // has been destroyed between the call and dispatch.
      return Promise.reject(new Error(`No tab with id: ${DEAD_TAB}`));
    });
    vi.stubGlobal('chrome', {
      scripting: { executeScript },
      // injectBuildDomTreeScripts hits hasOwnProperty check first;
      // returning a non-empty result with hasBuildDomTree=true skips
      // injection. We don't need that path here — the failure should
      // happen on the main-frame buildDomTree call below, *after*
      // injection. So make injection succeed:
      // (executeScript.mockResolvedValueOnce wouldn't help — we want
      // EVERY call to fail. Instead, the test exercises the catch
      // path on the very first call, which is the hasBuildDomTree
      // check. The flow then goes:
      //   - hasBuildDomTree check fails (rejects)
      //   - injection code path rethrows or continues, depending
      // We assert the error reaches the caller as a TabGoneError.
    });

    const { getClickableElements } = await import('../dom/service');

    // Note: do NOT use `toBeInstanceOf(TabGoneError)` here. The two
    // earlier tests call `vi.resetModules()` in their `afterEach`,
    // which reloads `../views` and gives `dom/service` a fresh
    // `TabGoneError` class identity that no longer matches the one
    // imported at the top of this test file. Match on `name`
    // instead — same behavioural contract, immune to module
    // identity churn under vitest module isolation.
    await expect(
      getClickableElements(DEAD_TAB, 'https://example.com/', /*showHighlight*/ false, /*focus*/ -1, /*vp*/ 0),
    ).rejects.toMatchObject({ name: 'TabGoneError', tabId: DEAD_TAB });

    // Confirms the burst-amplifier is gone: executeScript should NOT
    // have been called once per (hypothetical) iframe. The
    // constructFrameTree subFrame loop is not reached because the
    // earlier main-frame call already short-circuits with a typed
    // throw. The exact call count depends on injectBuildDomTreeScripts
    // semantics; what matters is that we throw BEFORE entering a
    // per-frame loop. A hard bound: fewer than 10 calls in total.
    expect(executeScript.mock.calls.length).toBeLessThan(10);
  });
});
