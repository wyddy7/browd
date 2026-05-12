/**
 * T2n-overlay-handling tests — verify `pendingForceScreenshot` flag
 * lifecycle on BrowserContext:
 *   - set by `switchTab` immediately, before the page-attach awaits
 *     finish (so a later state-message build sees it even if the
 *     attach pipeline yields);
 *   - set by `navigateTo` for the same reason;
 *   - read & cleared by `consumePendingForceScreenshot` (one-shot
 *     semantic — second read returns false).
 *
 * The MV3 service-worker chrome.* APIs are stubbed via `vi.stubGlobal`
 * so we don't need a real extension host. The Page constructor is
 * mocked at the module level so attachPuppeteer() doesn't try to
 * talk to a real Chrome debugger.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

// webextension-polyfill detects "not a browser extension" at module
// load and throws. Replace with an empty stub for the test environment.
vi.mock('webextension-polyfill', () => ({ default: {} }));

// Mock the Page module so `new Page(...)` returns a no-op stub
// (real Page tries to attach a puppeteer CDP session).
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
    scripting: {
      executeScript: vi.fn().mockResolvedValue([]),
    },
  };
  vi.stubGlobal('chrome', chromeStub);
  return chromeStub;
}

describe('BrowserContext T2n-overlay-handling — pendingForceScreenshot flag', () => {
  beforeEach(() => {
    stubChrome();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('switchTab sets pendingForceScreenshot=true', async () => {
    const ctx = new BrowserContext({});
    expect(ctx.hasPendingForceScreenshot()).toBe(false);
    await ctx.switchTab(7);
    expect(ctx.hasPendingForceScreenshot()).toBe(true);
  });

  it('navigateTo sets pendingForceScreenshot=true', async () => {
    const ctx = new BrowserContext({});
    expect(ctx.hasPendingForceScreenshot()).toBe(false);
    await ctx.navigateTo('https://example.com/landing');
    expect(ctx.hasPendingForceScreenshot()).toBe(true);
  });

  it('consumePendingForceScreenshot is one-shot — second read returns false', async () => {
    const ctx = new BrowserContext({});
    await ctx.switchTab(11);
    expect(ctx.consumePendingForceScreenshot()).toBe(true);
    expect(ctx.consumePendingForceScreenshot()).toBe(false);
    expect(ctx.hasPendingForceScreenshot()).toBe(false);
  });
});
