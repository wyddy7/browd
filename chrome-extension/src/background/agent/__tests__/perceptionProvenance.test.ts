/**
 * Perception provenance — the runtime must never hand the model a stale page
 * dressed up as the current one.
 *
 * Regression origin (2026-08-06): `_updateState` silently returned the cached
 * snapshot when the page could not be captured. The model saw the previous
 * URL rendered as current, concluded it had already navigated, skipped
 * `go_to_url`, and spent all 25 recursion rounds typing into an element that
 * did not exist. These tests pin the model-facing contract: a failed capture
 * is visible in the state message, and the element list is declared unusable.
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('webextension-polyfill', () => ({ default: {} }));

import type { PerceptionProvenance } from '../../browser/views';
import { buildBrowserStateMessage } from '../agents/runReactAgent';

type Ctx = Parameters<typeof buildBrowserStateMessage>[0];

function makeContext(opts: { perception?: PerceptionProvenance; url: string; elements: string }): Ctx {
  const state = {
    tabId: 7,
    url: opts.url,
    title: 'Test page',
    screenshot: null,
    scrollY: 0,
    scrollHeight: 0,
    visualViewportHeight: 0,
    pageText: undefined,
    tabs: [{ id: 7, url: opts.url, title: 'Test page' }],
    perception: opts.perception,
    elementTree: {
      clickableElementsToString: () => opts.elements,
      // extractForms walks children; an empty root is enough here.
      children: [],
      tagName: 'root',
      attributes: {},
    },
    selectorMap: new Map(),
  };
  return {
    browserContext: {
      getState: async () => state,
      getConfig: () => ({ deniedUrls: [] }),
      agentTabId: () => 7,
    },
    options: { includeAttributes: [] },
  } as unknown as Ctx;
}

describe('perception provenance in the model-facing state message', () => {
  it('fresh capture → no error block, elements rendered (non-regression)', async () => {
    const msg = await buildBrowserStateMessage(
      makeContext({
        perception: { verdict: 'fresh', capturedAt: 1, urlSource: 'cdp' },
        url: 'https://example.com/page',
        elements: '[1]<button>Go</button>',
      }),
    );
    const text = String(msg.content);
    expect(text).not.toContain('browser-state-error');
    expect(text).toContain('[1]<button>Go</button>');
    expect(text).toContain('https://example.com/page');
  });

  it('failed capture → error block present and element list declared unavailable', async () => {
    const msg = await buildBrowserStateMessage(
      makeContext({
        perception: {
          verdict: 'unavailable',
          capturedAt: 2,
          urlSource: 'tabs-api',
          error: 'Cannot access a chrome-extension:// URL of different extension',
        },
        url: 'chrome://newtab/',
        elements: '[1]<button>STALE from the previous page</button>',
      }),
    );
    const text = String(msg.content);

    expect(text).toContain('<browser-state-error>');
    expect(text).toContain('Cannot access a chrome-extension:// URL of different extension');
    // The stale element list must NOT reach the model.
    expect(text).not.toContain('STALE from the previous page');
    expect(text).toContain('(unavailable — see browser-state-error above)');
    // The authoritative URL must be shown so the model can tell it is not
    // where it assumed it was.
    expect(text).toContain('chrome://newtab/');
    // And it must be told what to do about it.
    expect(text).toMatch(/go_to_url/);
  });

  it('failed capture → index-based actions are explicitly invalidated', async () => {
    const msg = await buildBrowserStateMessage(
      makeContext({
        perception: { verdict: 'unavailable', capturedAt: 3, urlSource: 'none', error: 'capture timeout' },
        url: 'about:blank',
        elements: '[2]<input>stale</input>',
      }),
    );
    const text = String(msg.content);
    expect(text).toMatch(/INVALID/);
    expect(text).toMatch(/Do not click or type by index/i);
  });

  it('missing provenance is treated as fresh (back-compat with legacy snapshots)', async () => {
    const msg = await buildBrowserStateMessage(
      makeContext({ perception: undefined, url: 'https://example.com', elements: '[1]<a>link</a>' }),
    );
    const text = String(msg.content);
    expect(text).not.toContain('browser-state-error');
    expect(text).toContain('[1]<a>link</a>');
  });
});
