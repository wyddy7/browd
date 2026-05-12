/**
 * T2o-agent-tab-follow tests — verify that `BrowserContext.switchTab`
 * moves `_agentTabId` along with `_currentTabId` when running in
 * unified mode (agent tab pinned via `openAgentTab`). The previous
 * T2k coverage only asserted that `switchTab` was invoked; it did
 * not assert that `getCurrentPage()` resolved to the new tab
 * afterwards. That gap let `switchTab(newTabId)` succeed in Chrome
 * while the agent's perception stayed on the original agent tab,
 * causing the LLM to loop re-emitting `switch_tab` (captured in
 * test-runs/test8.md).
 *
 * Legacy mode (`_agentTabId === null`) must remain untouched —
 * pre-T2f behaviour where the agent follows the user's active tab.
 *
 * Test harness mirrors `contextOverlayFlag.test.ts` — chrome.* APIs
 * stubbed via `vi.stubGlobal`, Page mocked to a no-op stub so
 * attachPuppeteer() doesn't hit a real CDP.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

vi.mock('webextension-polyfill', () => ({ default: {} }));

vi.mock('../page', () => {
  return {
    default: class FakePage {
      tabId: number;
      _url: string;
      _title: string;
      attached = false;
      constructor(tabId: number, url: string, title: string) {
        this.tabId = tabId;
        this._url = url;
        this._title = title;
      }
      async attachPuppeteer() {
        this.attached = true;
        return true;
      }
      async detachPuppeteer() {
        this.attached = false;
      }
      removeHighlight() {}
      updateConfig() {}
      url() {
        return this._url;
      }
      async navigateTo(url: string) {
        this._url = url;
      }
    },
    build_initial_state: () => ({}),
  };
});

import BrowserContext from '../context';

function stubChrome(initialAgentTabId: number) {
  const chromeStub = {
    tabs: {
      update: vi.fn().mockResolvedValue(undefined),
      get: vi
        .fn()
        .mockImplementation((id: number) =>
          Promise.resolve({ id, url: `https://example.com/${id}`, title: `Tab ${id}`, active: true }),
        ),
      query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://example.com/', title: 'Example', active: true }]),
      create: vi
        .fn()
        .mockResolvedValue({ id: initialAgentTabId, url: 'about:blank', title: 'about:blank', active: false }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: {
      executeScript: vi.fn().mockResolvedValue([]),
    },
  };
  vi.stubGlobal('chrome', chromeStub);
  return chromeStub;
}

describe('BrowserContext T2o-agent-tab-follow — switchTab moves _agentTabId', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('unified mode: switchTab(Y) updates _agentTabId AND getCurrentPage() resolves to Y', async () => {
    const ORIGINAL_AGENT_TAB = 1000;
    const NEW_TAB = 2000;
    stubChrome(ORIGINAL_AGENT_TAB);

    const ctx = new BrowserContext({});
    await ctx.openAgentTab('about:blank');
    expect(ctx.agentTabId()).toBe(ORIGINAL_AGENT_TAB);

    await ctx.switchTab(NEW_TAB);

    // The fix: _agentTabId must follow the agent-driven switch so
    // getCurrentPage() doesn't keep resolving to the original tab.
    expect(ctx.agentTabId()).toBe(NEW_TAB);
    const currentPage = await ctx.getCurrentPage();
    expect(currentPage.tabId).toBe(NEW_TAB);
  });

  it('legacy mode: switchTab does NOT mutate _agentTabId (stays null)', async () => {
    stubChrome(9999);

    const ctx = new BrowserContext({});
    // Legacy run — openAgentTab is never called, _agentTabId is null
    // throughout. switchTab must not promote a current tab into the
    // agent tab role.
    expect(ctx.agentTabId()).toBe(null);

    await ctx.switchTab(42);

    expect(ctx.agentTabId()).toBe(null);
  });
});
