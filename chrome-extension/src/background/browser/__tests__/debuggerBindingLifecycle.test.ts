/**
 * Debugger-binding lifecycle — the node that attaches CDP to the agent tab.
 *
 * Model of the node (2026-08-06):
 *  - `Page` owns exactly one binding (puppeteer Browser over ExtensionTransport,
 *    which is a thin veneer over `chrome.debugger.attach/sendCommand/detach`).
 *  - Chrome can kill the binding unilaterally at any time; the ONLY push signal
 *    is `chrome.debugger.onDetach`, wired through
 *    `BrowserContext.handleDebuggerDetached` → `Page.markBindingLost`.
 *  - Chrome refuses attach while ANY frame in the tab belongs to a different
 *    extension (Chromium debugger_api.cc walks every RenderFrameHost). A
 *    password-manager iframe injected on credential-field focus therefore
 *    kills the session AND blocks the re-attach that tries to cure it.
 *  - Recovery is lazy (next `_updateState`), must detach before re-attach
 *    (transport's own detach is fire-and-forget), and must clear foreign
 *    frames when they are what blocks the attach.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('webextension-polyfill', () => ({ default: {} }));

const puppeteerMocks = vi.hoisted(() => ({
  connect: vi.fn(),
  connectTab: vi.fn(),
}));

vi.mock('puppeteer-core/lib/esm/puppeteer/puppeteer-core-browser.js', () => ({
  connect: puppeteerMocks.connect,
  ExtensionTransport: { connectTab: puppeteerMocks.connectTab },
}));

// Keep the heavy DOM machinery out of these unit tests.
vi.mock('../dom/service', () => ({
  getClickableElements: vi.fn(),
  removeHighlights: vi.fn(),
  getScrollInfo: vi.fn(),
}));
vi.mock('../dom/clickable/service', () => ({
  ClickableElementProcessor: {
    getClickableElements: vi.fn(),
    getClickableElementsHashes: vi.fn(),
    hashDomElement: vi.fn(),
  },
}));

import Page, { describeBindingLoss } from '../page';
import BrowserContext from '../context';
import { isStaleTargetErrorMessage, isForeignExtensionFrameError } from '../views';

const FOREIGN_ERR = 'Cannot access a chrome-extension:// URL of different extension';

type ChromeStub = {
  debugger: { detach: ReturnType<typeof vi.fn> };
  scripting: { executeScript: ReturnType<typeof vi.fn> };
  tabs: { get: ReturnType<typeof vi.fn>; query: ReturnType<typeof vi.fn> };
  runtime: { id: string };
};

function stubChrome(): ChromeStub {
  const stub: ChromeStub = {
    debugger: { detach: vi.fn().mockResolvedValue(undefined) },
    scripting: { executeScript: vi.fn().mockResolvedValue([{ result: 0 }]) },
    tabs: {
      get: vi.fn().mockResolvedValue({ id: 42, url: 'http://localhost:8765/', title: 'Login', status: 'complete' }),
      query: vi.fn().mockResolvedValue([]),
    },
    runtime: { id: 'our-own-extension-id' },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = stub;
  return stub;
}

function makeFakeBrowser() {
  const puppeteerPage = {
    evaluate: vi.fn().mockResolvedValue(1),
    evaluateOnNewDocument: vi.fn().mockResolvedValue(undefined),
    url: () => 'http://localhost:8765/',
    title: vi.fn().mockResolvedValue('Login'),
  };
  const browser = {
    pages: vi.fn().mockResolvedValue([puppeteerPage]),
    disconnect: vi.fn().mockResolvedValue(undefined),
  };
  return { browser, puppeteerPage };
}

/** Reach the private re-attach entry point for focused unit tests. */
function reattach(page: Page, message: string): Promise<boolean> {
  return (page as unknown as { _reattachIfStale(m: string): Promise<boolean> })._reattachIfStale(message);
}

beforeEach(() => {
  vi.clearAllMocks();
  puppeteerMocks.connect.mockReset();
  puppeteerMocks.connectTab.mockReset();
});

describe('error classification', () => {
  it.each([
    'Protocol error: Connection closed',
    'Session closed. Most likely the page has been closed.',
    'Debugger is not attached to the tab with id: 42.',
    'debugger binding lost for tab 42',
  ])('dead-connection errors are re-attachable (stale): %s', msg => {
    expect(isStaleTargetErrorMessage(msg)).toBe(true);
  });

  it('foreign-frame denial is a strict subset of stale', () => {
    expect(isForeignExtensionFrameError(`Protocol error (Input.dispatchKeyEvent): ${FOREIGN_ERR}`)).toBe(true);
    expect(isStaleTargetErrorMessage(`Protocol error (Input.dispatchKeyEvent): ${FOREIGN_ERR}`)).toBe(true);
    expect(isForeignExtensionFrameError('Target closed')).toBe(false);
  });

  it('describeBindingLoss names the mechanic for the foreign-frame class only', () => {
    expect(describeBindingLoss(FOREIGN_ERR)).toContain('password manager');
    expect(describeBindingLoss(FOREIGN_ERR)).toContain(FOREIGN_ERR);
    expect(describeBindingLoss('net::ERR_CONNECTION_REFUSED')).toBe('net::ERR_CONNECTION_REFUSED');
  });
});

describe('attachPuppeteer — no leaked chrome.debugger session', () => {
  it('handshake failure after the raw attach → explicit chrome.debugger.detach, then rethrow', async () => {
    const chromeStub = stubChrome();
    puppeteerMocks.connectTab.mockResolvedValue({});
    puppeteerMocks.connect.mockRejectedValue(new Error('handshake exploded'));

    const page = new Page(42, 'http://localhost:8765/', 'Login');
    await expect(page.attachPuppeteer()).rejects.toThrow('handshake exploded');
    expect(chromeStub.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
    expect(page.attached).toBe(false);
  });

  it('failure after connect (no page target) disposes the browser too', async () => {
    const chromeStub = stubChrome();
    const browser = { pages: vi.fn().mockResolvedValue([]), disconnect: vi.fn().mockResolvedValue(undefined) };
    puppeteerMocks.connectTab.mockResolvedValue({});
    puppeteerMocks.connect.mockResolvedValue(browser);

    const page = new Page(42, 'http://localhost:8765/', 'Login');
    await expect(page.attachPuppeteer()).rejects.toThrow('no page target');
    expect(browser.disconnect).toHaveBeenCalled();
    expect(chromeStub.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
  });

  it('second attach on a live binding is a no-op (no double chrome.debugger session)', async () => {
    stubChrome();
    const { browser } = makeFakeBrowser();
    puppeteerMocks.connectTab.mockResolvedValue({});
    puppeteerMocks.connect.mockResolvedValue(browser);

    const page = new Page(42, 'http://localhost:8765/', 'Login');
    expect(await page.attachPuppeteer()).toBe(true);
    expect(await page.attachPuppeteer()).toBe(true);
    expect(puppeteerMocks.connectTab).toHaveBeenCalledTimes(1);
  });
});

describe('detachPuppeteer — the detach is awaited, not fire-and-forget', () => {
  it('calls chrome.debugger.detach explicitly so an immediate re-attach cannot race it', async () => {
    const chromeStub = stubChrome();
    const { browser } = makeFakeBrowser();
    puppeteerMocks.connectTab.mockResolvedValue({});
    puppeteerMocks.connect.mockResolvedValue(browser);

    const page = new Page(42, 'http://localhost:8765/', 'Login');
    await page.attachPuppeteer();
    await page.detachPuppeteer();

    expect(browser.disconnect).toHaveBeenCalled();
    expect(chromeStub.debugger.detach).toHaveBeenCalledWith({ tabId: 42 });
    expect(page.attached).toBe(false);
  });
});

describe('markBindingLost — Chrome-initiated detach invalidates the binding', () => {
  it('drops refs, disposes the dead connection once, and is idempotent', async () => {
    stubChrome();
    const { browser } = makeFakeBrowser();
    puppeteerMocks.connectTab.mockResolvedValue({});
    puppeteerMocks.connect.mockResolvedValue(browser);

    const page = new Page(42, 'http://localhost:8765/', 'Login');
    await page.attachPuppeteer();
    expect(page.attached).toBe(true);

    page.markBindingLost('target_closed');
    expect(page.attached).toBe(false);
    page.markBindingLost('target_closed');
    expect(browser.disconnect).toHaveBeenCalledTimes(1);
  });

  it('BrowserContext.handleDebuggerDetached routes to the page and keeps it registered', () => {
    stubChrome();
    const ctx = new BrowserContext({});
    const fakePage = { markBindingLost: vi.fn() };
    const registry = (ctx as unknown as { _attachedPages: Map<number, unknown> })._attachedPages;
    registry.set(42, fakePage);

    ctx.handleDebuggerDetached(42, 'target_closed');
    expect(fakePage.markBindingLost).toHaveBeenCalledWith('target_closed');
    expect(registry.has(42)).toBe(true);

    // Unknown tab must be a silent no-op.
    expect(() => ctx.handleDebuggerDetached(99, 'target_closed')).not.toThrow();
  });
});

describe('re-attach after document / target change', () => {
  it('stale error → detach, then fresh attach on the new document', async () => {
    const chromeStub = stubChrome();
    const { browser } = makeFakeBrowser();
    puppeteerMocks.connectTab.mockResolvedValue({});
    puppeteerMocks.connect.mockResolvedValue(browser);

    const page = new Page(42, 'http://localhost:8765/', 'Login');
    await page.attachPuppeteer();

    const ok = await reattach(page, 'Protocol error (Runtime.evaluate): Target closed');
    expect(ok).toBe(true);
    // detach of the old session happened before the second attach
    expect(chromeStub.debugger.detach).toHaveBeenCalled();
    expect(puppeteerMocks.connectTab).toHaveBeenCalledTimes(2);
  });

  it('non-stale error → no re-attach attempt at all', async () => {
    stubChrome();
    const page = new Page(42, 'http://localhost:8765/', 'Login');
    const ok = await reattach(page, 'net::ERR_CONNECTION_REFUSED');
    expect(ok).toBe(false);
    expect(puppeteerMocks.connectTab).not.toHaveBeenCalled();
  });

  // Owner decision 2026-08-06: we do NOT delete another extension's DOM to
  // unblock ourselves. Credential fields are refused outright now, so the
  // password-manager iframe that triggers this is rarely summoned at all.
  it('attach blocked by a foreign-extension frame → reports failure, leaves the page alone', async () => {
    const chromeStub = stubChrome();
    puppeteerMocks.connectTab.mockRejectedValue(new Error(FOREIGN_ERR));

    const page = new Page(42, 'http://localhost:8765/', 'Login');
    const ok = await reattach(page, `Protocol error (Input.dispatchKeyEvent): ${FOREIGN_ERR}`);

    expect(ok).toBe(false);
    // The other extension's frames are untouched.
    expect(chromeStub.scripting.executeScript).not.toHaveBeenCalled();
    // Exactly one attempt — no retry loop against an unchanged tab.
    expect(puppeteerMocks.connectTab).toHaveBeenCalledTimes(1);
  });
});

describe('_updateState with a lost, unrecoverable binding', () => {
  it('returns an honest unavailable snapshot with the actionable reason and tabs-API URL', async () => {
    const chromeStub = stubChrome();
    // Attach never succeeds: the foreign frame persists.
    puppeteerMocks.connectTab.mockRejectedValue(new Error(FOREIGN_ERR));

    const page = new Page(42, 'http://localhost:8765/', 'Login');
    // Never attached (binding lost); probe must not TypeError on null.
    const state = await (
      page as unknown as {
        _updateState(
          v?: boolean,
        ): Promise<{ perception: { verdict: string; urlSource: string; error?: string }; url: string }>;
      }
    )._updateState(false);

    expect(state.perception.verdict).toBe('unavailable');
    expect(state.perception.urlSource).toBe('tabs-api');
    expect(state.url).toBe('http://localhost:8765/');
    expect(state.perception.error).toContain('password manager');
    expect(chromeStub.tabs.get).toHaveBeenCalledWith(42);
  });
});
