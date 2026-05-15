/**
 * T2o-agent-tab-follow tests — verify that `BrowserContext.switchTab`
 * moves `_agentTabId` along with `_currentTabId` when running in
 * unified mode (agent tab pinned via `openAgentTab`). The previous
 * T2k coverage only asserted that `switchTab` was invoked; it did
 * not assert that `getCurrentPage()` resolved to the new tab
 * afterwards. That gap let `switchTab(newTabId)` succeed in Chrome
 * while the agent's perception stayed on the original agent tab,
 * causing the LLM to loop re-emitting `switch_tab`.
 *
 * T2s-1 update — `openAgentTab` no longer creates a fresh blank tab;
 * it anchors on the user's current active tab and wraps it in a
 * Chrome tab group. Stubs reflect this: chrome.tabs.query returns
 * the anchor tab, chrome.tabs.group returns a group id, and the
 * group-membership check on switchTab is satisfied by chrome.tabs.get
 * returning the matching groupId for the target tab.
 *
 * Legacy mode (`_agentTabId === null`, no openAgentTab call) must
 * remain untouched — pre-T2f behaviour where the agent follows the
 * user's active tab.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';

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

interface StubOptions {
  /** Tab id chrome.tabs.query({active:true}) returns — the agent anchor. */
  anchorTabId: number;
  /** Group id chrome.tabs.group resolves to. */
  groupId: number;
  /** Set of tab ids that chrome.tabs.get reports as members of `groupId`. */
  tabsInGroup: Set<number>;
}

function stubChrome(opts: StubOptions) {
  const chromeStub = {
    tabs: {
      update: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockImplementation((id: number) =>
        Promise.resolve({
          id,
          url: `https://example.com/${id}`,
          title: `Tab ${id}`,
          active: true,
          groupId: opts.tabsInGroup.has(id) ? opts.groupId : -1,
        }),
      ),
      query: vi.fn().mockResolvedValue([
        {
          id: opts.anchorTabId,
          url: 'https://example.com/',
          title: 'Anchor',
          active: true,
          groupId: opts.groupId,
        },
      ]),
      create: vi.fn().mockResolvedValue({ id: 99 }),
      group: vi.fn().mockResolvedValue(opts.groupId),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    tabGroups: {
      update: vi.fn().mockResolvedValue(undefined),
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
    const ANCHOR = 1000;
    const NEW_TAB = 2000;
    const GROUP = 50;
    // Both ANCHOR (initial) and NEW_TAB (target) are members of the
    // agent group, so the T2s-1 isolation check lets switchTab proceed.
    stubChrome({ anchorTabId: ANCHOR, groupId: GROUP, tabsInGroup: new Set([ANCHOR, NEW_TAB]) });

    const ctx = new BrowserContext({});
    await ctx.openAgentTab('about:blank');
    expect(ctx.agentTabId()).toBe(ANCHOR);
    expect(ctx.agentGroupId()).toBe(GROUP);

    await ctx.switchTab(NEW_TAB);

    // The fix: _agentTabId must follow the agent-driven switch so
    // getCurrentPage() doesn't keep resolving to the original tab.
    expect(ctx.agentTabId()).toBe(NEW_TAB);
    const currentPage = await ctx.getCurrentPage();
    expect(currentPage.tabId).toBe(NEW_TAB);
  });

  it('legacy mode: switchTab does NOT mutate _agentTabId (stays null)', async () => {
    stubChrome({ anchorTabId: 9999, groupId: 7, tabsInGroup: new Set() });

    const ctx = new BrowserContext({});
    // Legacy run — openAgentTab is never called, _agentTabId / _agentGroupId
    // are null throughout. switchTab must not promote a current tab into
    // the agent tab role, and isolation enforcement is OFF (group not
    // pinned), so the switch is allowed to anywhere.
    expect(ctx.agentTabId()).toBe(null);
    expect(ctx.agentGroupId()).toBe(null);

    await ctx.switchTab(42);

    expect(ctx.agentTabId()).toBe(null);
  });
});
