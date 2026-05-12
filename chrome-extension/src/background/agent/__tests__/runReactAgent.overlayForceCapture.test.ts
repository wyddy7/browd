/**
 * T2n-overlay-handling — verify that the pendingForceScreenshot flag
 * set by BrowserContext.switchTab / navigateTo is consumed and
 * translated into shouldCapture=true at the top of the per-step
 * stateModifier path. Uses the pure `resolveBaseCaptureDecision`
 * helper extracted from runReactAgent so the assertion does not
 * require a real LangGraph harness.
 *
 * Also verifies the one-shot semantic round-trip: BrowserContext
 * sets the flag on switchTab, the helper reads `pendingForce=true`
 * once, and the BrowserContext flag is cleared by the
 * `consumePendingForceScreenshot()` read — second call returns
 * `false`, so the next state-message build reverts to the regular
 * adaptive heuristic.
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
import { resolveBaseCaptureDecision } from '../agents/runReactAgent';

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

describe('T2n-overlay-handling — force-capture consume-and-clear cycle', () => {
  beforeEach(() => {
    stubChrome();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('switchTab → next stateModifier reads pendingForce=true AND BrowserContext flag clears (visionMode=fallback)', async () => {
    const ctx = new BrowserContext({});
    await ctx.switchTab(42);
    expect(ctx.hasPendingForceScreenshot()).toBe(true);

    // Simulate stateModifier's read.
    const pendingForce = ctx.consumePendingForceScreenshot();
    expect(pendingForce).toBe(true);

    // Translated decision: visionMode='fallback' + pendingForce
    // -> shouldCapture=true with the T2n intent.
    const decision = resolveBaseCaptureDecision({
      visionMode: 'fallback',
      hasScreenshotAction: true,
      pendingForce,
    });
    expect(decision.shouldCapture).toBe(true);
    expect(decision.intent).toMatch(/T2n overlay-handling/);

    // Next stateModifier pass — flag is cleared, base decision now false
    // for visionMode='fallback' (the adaptive triggers run separately
    // and may still flip shouldCapture, but the BASE decision is false).
    expect(ctx.hasPendingForceScreenshot()).toBe(false);
    const next = resolveBaseCaptureDecision({
      visionMode: 'fallback',
      hasScreenshotAction: true,
      pendingForce: ctx.consumePendingForceScreenshot(),
    });
    expect(next.shouldCapture).toBe(false);
  });

  it('visionMode=always always captures even without pending-force', () => {
    const decision = resolveBaseCaptureDecision({
      visionMode: 'always',
      hasScreenshotAction: true,
      pendingForce: false,
    });
    expect(decision.shouldCapture).toBe(true);
  });

  it('visionMode=off with pendingForce=true does NOT capture (no screenshotAction available)', () => {
    const decision = resolveBaseCaptureDecision({
      visionMode: 'off',
      hasScreenshotAction: false,
      pendingForce: true,
    });
    expect(decision.shouldCapture).toBe(false);
  });

  it('per-step system prompt contains the T2n modal-overlay nudge', async () => {
    // Read the source file and assert the literal nudge string is
    // present. This is the "bonus" guard from the plan — future
    // refactors must not silently drop the prompt addition.
    const fs = await import('node:fs/promises');
    const { fileURLToPath } = await import('node:url');
    const url = new URL('../agents/runReactAgent.ts', import.meta.url);
    const src = await fs.readFile(fileURLToPath(url), 'utf-8');
    expect(src).toMatch(/If a modal overlay \(cookie banner, newsletter signup, sign-in prompt, paywall dialog\)/);
  });
});
