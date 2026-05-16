/**
 * BrowserContext pending-force-screenshot flag — set-side regression
 * test.
 *
 * The flag is set by `switchTab` / `navigateTo` so a future cookie-
 * overlay / tab-settle tier can surface "page just changed, you may
 * want a screenshot" to the model. The consume-side currently has no
 * reader (the runtime no longer auto-attaches images — the LLM owns
 * screenshot timing via the `screenshot()` tool). This test pins the
 * set-side contract so the flag is still available when the next tier
 * needs it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

// webextension-polyfill detects "not a browser extension" at module
// load and throws. Replace with an empty stub for the test environment.
vi.mock('webextension-polyfill', () => ({ default: {} }));

vi.mock('../../browser/page', () => {
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

import BrowserContext from '../../browser/context';

function stubChrome() {
  const chromeStub = {
    tabs: {
      update: vi.fn().mockResolvedValue(undefined),
      get: vi
        .fn()
        .mockImplementation((id: number) =>
          Promise.resolve({ id, url: 'https://example.com/', title: 'Example', active: true }),
        ),
      query: vi.fn().mockResolvedValue([{ id: 1, url: 'https://example.com/', title: 'Example', active: true }]),
      create: vi.fn().mockResolvedValue({ id: 99 }),
      onUpdated: { addListener: vi.fn(), removeListener: vi.fn() },
      onActivated: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    scripting: { executeScript: vi.fn().mockResolvedValue([]) },
  };
  vi.stubGlobal('chrome', chromeStub);
}

describe('BrowserContext pendingForceScreenshot flag — set-side', () => {
  beforeEach(() => {
    stubChrome();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('switchTab sets the pending-force flag', async () => {
    const ctx = new BrowserContext({});
    expect(ctx.hasPendingForceScreenshot()).toBe(false);
    await ctx.switchTab(42);
    expect(ctx.hasPendingForceScreenshot()).toBe(true);
  });

  it('consumePendingForceScreenshot is one-shot (true once, then false)', async () => {
    const ctx = new BrowserContext({});
    await ctx.switchTab(42);
    expect(ctx.consumePendingForceScreenshot()).toBe(true);
    expect(ctx.consumePendingForceScreenshot()).toBe(false);
    expect(ctx.hasPendingForceScreenshot()).toBe(false);
  });
});
