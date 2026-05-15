/**
 * T2s-1 tests — Chrome tab-group isolation contract.
 *
 * The agent's workspace is a Chrome tab group created at task start.
 * Three runtime invariants are enforced and must be locked by tests:
 *
 *   1. openAgentTab anchors on the user's current active tab and
 *      wraps it in a "Browd" tab group (no fresh blank tab).
 *   2. switchTab refuses tabs outside the agent group, so the LLM
 *      cannot silently take over a user-owned tab elsewhere.
 *   3. openTab joins new tabs to the agent group automatically.
 *   4. takeOverTab adds an external tab to the group (HITL approval
 *      gate lands in T2s-2 at the action layer).
 *   5. cleanup forgets the group id but leaves the actual Chrome
 *      tab group alone (no auto-ungroup, per the user's contract).
 *
 * The chrome.* surface is stubbed via `vi.stubGlobal`; the Page
 * module is mocked so attachPuppeteer doesn't talk to a real CDP.
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
  anchorTabId: number;
  groupId: number;
  tabsInGroup: Set<number>;
  /** Optional: provide a custom chrome.tabs.create mock (e.g. to inject the new tab into the group set on success). */
  onCreate?: (created: chrome.tabs.Tab) => void;
}

function stubChrome(opts: StubOptions) {
  let nextCreatedId = 5000;
  const chromeStub = {
    tabs: {
      update: vi.fn().mockResolvedValue(undefined),
      get: vi.fn().mockImplementation((id: number) =>
        Promise.resolve({
          id,
          url: `https://example.com/${id}`,
          title: `Tab ${id}`,
          active: true,
          // `status:'complete'` lets waitForTabEvents resolve immediately
          // off the get() probe so tests don't hit the 5s timeout.
          status: 'complete',
          // -1 mirrors Chrome's TAB_GROUP_ID_NONE for ungrouped tabs.
          groupId: opts.tabsInGroup.has(id) ? opts.groupId : -1,
        }),
      ),
      query: vi.fn().mockResolvedValue([
        {
          id: opts.anchorTabId,
          url: 'https://example.com/',
          title: 'Anchor',
          active: true,
        },
      ]),
      create: vi.fn().mockImplementation(async () => {
        const tab = { id: nextCreatedId++, status: 'complete' as const, url: '', title: '' };
        opts.onCreate?.(tab as unknown as chrome.tabs.Tab);
        return tab;
      }),
      group: vi.fn().mockImplementation(async (args: { tabIds: number[]; groupId?: number }) => {
        for (const id of args.tabIds) opts.tabsInGroup.add(id);
        return args.groupId ?? opts.groupId;
      }),
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

describe('BrowserContext T2s-1 — tab group isolation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('openAgentTab anchors the agent group on the user\'s active tab and titles it "Browd"', async () => {
    const ANCHOR = 100;
    const GROUP = 42;
    const stub = stubChrome({ anchorTabId: ANCHOR, groupId: GROUP, tabsInGroup: new Set([ANCHOR]) });

    const ctx = new BrowserContext({});
    const tabId = await ctx.openAgentTab();

    expect(tabId).toBe(ANCHOR);
    expect(ctx.agentTabId()).toBe(ANCHOR);
    expect(ctx.agentGroupId()).toBe(GROUP);
    expect(stub.tabs.group).toHaveBeenCalledWith({ tabIds: [ANCHOR] });
    expect(stub.tabGroups.update).toHaveBeenCalledWith(GROUP, { title: 'Browd', color: 'purple' });
    // Crucially: NO chrome.tabs.create — we anchor on the existing
    // active tab, not a fresh blank one.
    expect(stub.tabs.create).not.toHaveBeenCalled();
  });

  it('openAgentTab with a concrete initialUrl navigates the anchor tab to it', async () => {
    const ANCHOR = 200;
    const stub = stubChrome({ anchorTabId: ANCHOR, groupId: 1, tabsInGroup: new Set([ANCHOR]) });

    const ctx = new BrowserContext({});
    await ctx.openAgentTab('https://lmarena.ai/');

    expect(stub.tabs.update).toHaveBeenCalledWith(ANCHOR, { url: 'https://lmarena.ai/' });
  });

  it('switchTab refuses tabs outside the agent group', async () => {
    const ANCHOR = 100;
    const OUTSIDE = 777;
    stubChrome({ anchorTabId: ANCHOR, groupId: 42, tabsInGroup: new Set([ANCHOR]) });

    const ctx = new BrowserContext({});
    await ctx.openAgentTab();

    await expect(ctx.switchTab(OUTSIDE)).rejects.toThrow(/refused.*outside the agent group/);
  });

  it('switchTab allows tabs that are members of the agent group', async () => {
    const ANCHOR = 100;
    const INSIDE = 555;
    const GROUP = 42;
    stubChrome({
      anchorTabId: ANCHOR,
      groupId: GROUP,
      tabsInGroup: new Set([ANCHOR, INSIDE]),
    });

    const ctx = new BrowserContext({});
    await ctx.openAgentTab();

    await expect(ctx.switchTab(INSIDE)).resolves.toBeDefined();
    expect(ctx.agentTabId()).toBe(INSIDE);
  });

  it('openTab adds the new tab to the agent group', async () => {
    const ANCHOR = 100;
    const GROUP = 42;
    const stub = stubChrome({ anchorTabId: ANCHOR, groupId: GROUP, tabsInGroup: new Set([ANCHOR]) });

    const ctx = new BrowserContext({});
    await ctx.openAgentTab();
    expect(stub.tabs.group).toHaveBeenCalledTimes(1); // anchor call only

    await ctx.openTab('https://example.com/x');

    // Anchor call + new-tab join call.
    expect(stub.tabs.group).toHaveBeenCalledTimes(2);
    expect(stub.tabs.group).toHaveBeenLastCalledWith({ tabIds: [expect.any(Number)], groupId: GROUP });
  });

  it('takeOverTab adds an external tab to the agent group and pins agentTabId to it', async () => {
    const ANCHOR = 100;
    const FOREIGN = 999;
    const GROUP = 42;
    const stub = stubChrome({ anchorTabId: ANCHOR, groupId: GROUP, tabsInGroup: new Set([ANCHOR]) });

    const ctx = new BrowserContext({});
    await ctx.openAgentTab();

    ctx.takeOverTab(FOREIGN);

    expect(ctx.agentTabId()).toBe(FOREIGN);
    // Group call sequence: [anchor], [foreign join]
    expect(stub.tabs.group).toHaveBeenLastCalledWith({ tabIds: [FOREIGN], groupId: GROUP });
  });

  it('cleanup forgets the group id but does NOT ungroup the actual Chrome group', async () => {
    const ANCHOR = 100;
    const GROUP = 42;
    const stub = stubChrome({ anchorTabId: ANCHOR, groupId: GROUP, tabsInGroup: new Set([ANCHOR]) });

    const ctx = new BrowserContext({});
    await ctx.openAgentTab();
    expect(ctx.agentGroupId()).toBe(GROUP);

    await ctx.cleanup();

    expect(ctx.agentGroupId()).toBe(null);
    expect(ctx.agentTabId()).toBe(null);
    // We never call chrome.tabs.ungroup or chrome.tabGroups.remove —
    // the user keeps their workspace as-is.
    expect((stub.tabs as unknown as { ungroup?: unknown }).ungroup).toBeUndefined();
    expect((stub.tabGroups as unknown as { remove?: unknown }).remove).toBeUndefined();
  });

  it('without openAgentTab (legacy / fallback): switchTab is unrestricted', async () => {
    stubChrome({ anchorTabId: 0, groupId: 0, tabsInGroup: new Set() });

    const ctx = new BrowserContext({});
    // No group pinned → isolation OFF → switchTab to any tab proceeds.
    await expect(ctx.switchTab(12345)).resolves.toBeDefined();
  });
});
