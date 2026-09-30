/**
 * A navigation is reported for what it was. 2026-09-30, Online-Mind2Web «Florida City
 * forecast»: the site reset every https request and never answered over http; `go_to_url`
 * reported «Navigated to http://…» five times while the tab sat on the browser's error page,
 * and every following page-state read waited out the full 20 s deadline on that error page.
 *
 * Contract pinned here:
 *   - a load that ends on `chrome-error://` throws `NavigationFailedError` (tool → error);
 *   - a load that times out returns `timeout`, saying whether the tab left the previous page;
 *   - `getState` on the error page answers at once with a note naming it, no DOM build.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('webextension-polyfill', () => ({ default: {} }));

import Page from '../page';
import { NavigationFailedError } from '../views';

const ERROR_PAGE = 'chrome-error://chromewebdata/';
const START = 'http://shop.test/';
const TARGET = 'http://shop.test/p/lamp';

/** A Page whose puppeteer handle is a scripted fake: `goto` runs `onGoto`, then the URL is `urlAfter`. */
function pageWith(onGoto: () => Promise<unknown>, urlAfter: string) {
  const page = new Page(7, START, 'Shop');
  let url = START;
  const fakePuppeteer = {
    url: () => url,
    goto: vi.fn(async () => {
      try {
        return await onGoto();
      } finally {
        url = urlAfter;
      }
    }),
  };
  Object.assign(page as unknown as Record<string, unknown>, { _puppeteerPage: fakePuppeteer });
  vi.spyOn(page, 'waitForPageAndFramesLoad').mockResolvedValue(undefined);
  return page;
}

const timeout = () => Promise.reject(new Error('Navigation timeout of 30000 ms exceeded'));

describe('Page.navigateTo reports how the load ended', () => {
  afterEach(() => vi.restoreAllMocks());

  it('loaded: a normal navigation', async () => {
    await expect(pageWith(async () => null, TARGET).navigateTo(TARGET)).resolves.toEqual({ status: 'loaded' });
  });

  it('throws when goto resolves onto the browser error page (connection reset)', async () => {
    await expect(pageWith(async () => null, ERROR_PAGE).navigateTo(TARGET)).rejects.toBeInstanceOf(
      NavigationFailedError,
    );
  });

  it('throws when a timed-out load leaves the tab on the browser error page', async () => {
    await expect(pageWith(timeout, ERROR_PAGE).navigateTo(TARGET)).rejects.toBeInstanceOf(NavigationFailedError);
  });

  it('timeout without a response: the tab still shows the previous page', async () => {
    await expect(pageWith(timeout, START).navigateTo(TARGET)).resolves.toEqual({
      status: 'timeout',
      committed: false,
      currentUrl: START,
    });
  });

  it('timeout after the page started loading: committed, may be incomplete', async () => {
    await expect(pageWith(timeout, TARGET).navigateTo(TARGET)).resolves.toEqual({
      status: 'timeout',
      committed: true,
      currentUrl: TARGET,
    });
  });

  it('other navigation errors still propagate unchanged', async () => {
    const boom = new Error('net::ERR_NAME_NOT_RESOLVED at http://shop.test/p/lamp');
    await expect(pageWith(() => Promise.reject(boom), START).navigateTo(TARGET)).rejects.toBe(boom);
  });
});

describe('Page.getState on the browser error page', () => {
  afterEach(() => vi.restoreAllMocks());

  it('answers at once with a note naming the error page, without building the DOM', async () => {
    const page = pageWith(async () => null, ERROR_PAGE);
    await page.navigateTo(TARGET).catch(() => {});
    const build = vi.spyOn(page, '_updateState');
    vi.stubGlobal('chrome', { tabs: { get: vi.fn(async () => ({ title: 'shop.test' })) } });

    const state = await page.getState();

    expect(build).not.toHaveBeenCalled();
    expect(state.url).toBe(ERROR_PAGE);
    expect(state.stateNote).toMatch(/browser's error page/);
    expect(state.selectorMap.size).toBe(0);
    vi.unstubAllGlobals();
  });
});
