/**
 * Attachability gate for the agent's anchor tab.
 *
 * Regression origin (2026-08-06): `openAgentTab` anchored on whatever tab the
 * user had focused. That was `chrome://newtab/`, replaced by another
 * extension, so the real URL was `chrome-extension://<other-id>/…` — a page
 * the Chrome debugger cannot attach to. Every state capture failed, the agent
 * never saw the page it was asked to open, and the task died on the recursion
 * limit. Chrome's own limitation; the fix is to never leave the agent parked
 * on a page it cannot drive.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('webextension-polyfill', () => ({ default: {} }));
vi.mock('../page', () => ({
  default: class FakePage {},
  build_initial_state: () => ({}),
}));

import BrowserContext, { isAttachableUrl } from '../context';

describe('isAttachableUrl', () => {
  it.each([
    'https://example.com/form',
    'http://localhost:8765/',
    'about:blank',
    'https://hh.ru/vacancy/123',
    'file:///Users/someone/page.html',
  ])('%s → attachable', url => {
    expect(isAttachableUrl(url)).toBe(true);
  });

  it.each([
    'chrome://newtab/',
    'chrome://extensions/',
    'chrome-extension://abcdefghijklmnop/newtab.html',
    'brave://settings',
    'edge://flags',
    'devtools://devtools/bundled/inspector.html',
    'view-source:https://example.com',
    'about:srcdoc',
    'https://chromewebstore.google.com/detail/foo',
    '',
  ])('%s → NOT attachable', url => {
    expect(isAttachableUrl(url)).toBe(false);
  });

  it('is case-insensitive and tolerates whitespace', () => {
    expect(isAttachableUrl('  CHROME://NewTab/  ')).toBe(false);
    expect(isAttachableUrl('  HTTPS://Example.com  ')).toBe(true);
  });
});

function stubChrome(activeTabUrl: string) {
  // Mirror real Chrome closely enough for waitForTabSettled: `tabs.update`
  // changes the URL the subsequent `tabs.get` reports. A frozen `get` would
  // make the settle-wait (which now demands evidence the document CHANGED)
  // spin until its timeout.
  const tabState = { id: 42, url: activeTabUrl, title: '', status: 'complete' };
  const update = vi.fn().mockImplementation(async (_tabId: number, props: { url?: string }) => {
    if (props.url) tabState.url = props.url;
    return undefined;
  });
  const chromeStub = {
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 42, url: activeTabUrl }]),
      group: vi.fn().mockResolvedValue(900),
      update,
      get: vi.fn().mockImplementation(async () => ({ ...tabState })),
    },
    tabGroups: { update: vi.fn().mockResolvedValue(undefined) },
  };
  (globalThis as unknown as { chrome: unknown }).chrome = chromeStub;
  return { update };
}

describe('openAgentTab — anchor must be drivable', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('anchor on a foreign-extension new tab → moved to about:blank', async () => {
    const { update } = stubChrome('chrome-extension://abcdefghijklmnop/newtab.html');
    const ctx = new BrowserContext({});
    const tabId = await ctx.openAgentTab();
    expect(tabId).toBe(42);
    expect(update).toHaveBeenCalledWith(42, { url: 'about:blank' });
  });

  it('anchor on chrome://newtab → moved to about:blank', async () => {
    const { update } = stubChrome('chrome://newtab/');
    const ctx = new BrowserContext({});
    await ctx.openAgentTab();
    expect(update).toHaveBeenCalledWith(42, { url: 'about:blank' });
  });

  it('anchor on a normal page → left alone (no navigation, user keeps their page)', async () => {
    const { update } = stubChrome('https://example.com/form');
    const ctx = new BrowserContext({});
    await ctx.openAgentTab();
    expect(update).not.toHaveBeenCalled();
  });

  it('explicit initialUrl wins over the gate', async () => {
    const { update } = stubChrome('chrome://newtab/');
    const ctx = new BrowserContext({});
    await ctx.openAgentTab('https://example.com/target');
    expect(update).toHaveBeenCalledWith(42, { url: 'https://example.com/target' });
    expect(update).not.toHaveBeenCalledWith(42, { url: 'about:blank' });
  });
});
