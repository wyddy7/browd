import type { DOMState } from './dom/views';
import type { DOMHistoryElement } from './dom/history/view';

export interface BrowserContextWindowSize {
  width: number;
  height: number;
}

export interface BrowserContextConfig {
  /**
   * Minimum time to wait before getting page state for LLM input
   * @default 0.25
   */
  minimumWaitPageLoadTime: number;

  /**
   * Time to wait for network requests to finish before getting page state.
   * Lower values may result in incomplete page loads.
   * @default 0.5
   */
  waitForNetworkIdlePageLoadTime: number;

  /**
   * Maximum time to wait for page load before proceeding anyway
   * @default 5.0
   */
  maximumWaitPageLoadTime: number;

  /**
   * Time to wait between multiple actions in one step
   * @default 0.5
   */
  waitBetweenActions: number;

  /**
   * Default browser window size
   * @default { width: 1280, height: 1100 }
   */
  browserWindowSize: BrowserContextWindowSize;

  /**
   * Viewport expansion in pixels. This amount will increase the number of elements
   * which are included in the state what the LLM will see.
   * If set to -1, all elements will be included (this leads to high token usage).
   * If set to 0, only the elements which are visible in the viewport will be included.
   * @default 0
   */
  viewportExpansion: number;

  /**
   * List of allowed domains that can be accessed. If None, all domains are allowed.
   * @default null
   */
  allowedUrls: string[];

  /**
   * List of denied domains that can be accessed. If None, all domains are allowed.
   * @default null
   */
  deniedUrls: string[];

  /**
   * Include dynamic attributes in the CSS selector. If you want to reuse the css_selectors, it might be better to set this to False.
   * @default true
   */
  includeDynamicAttributes: boolean;

  /**
   * Home page url
   * @default 'https://www.google.com'
   */
  homePageUrl: string;

  /**
   * Display highlights on interactive elements
   * @default true
   */
  displayHighlights: boolean;
}

export const DEFAULT_BROWSER_CONTEXT_CONFIG: BrowserContextConfig = {
  minimumWaitPageLoadTime: 0.25,
  waitForNetworkIdlePageLoadTime: 0.5,
  maximumWaitPageLoadTime: 5.0,
  waitBetweenActions: 0.5,
  browserWindowSize: { width: 1280, height: 1100 },
  viewportExpansion: 0,
  allowedUrls: [],
  deniedUrls: [],
  includeDynamicAttributes: true,
  homePageUrl: 'about:blank',
  displayHighlights: true,
};

/**
 * Provenance of a `PageState` snapshot — how much of it can be trusted.
 *
 * Added 2026-08-06 after a production loop where `_updateState` silently
 * returned the cached snapshot when CDP could not attach to the page. The
 * model received a stale URL rendered as if it were current, concluded it was
 * already on the target page, skipped `go_to_url`, and burned all 25 recursion
 * rounds typing into an element that did not exist. The runtime lied to the
 * model, and nothing in the type system stopped it.
 *
 * The field is REQUIRED: a snapshot cannot exist without stating how it was
 * obtained, so no future code path can hand the model stale data unlabelled.
 * Frontier browser agents do the same — browser-use surfaces a
 * `<browser_state_error>` block rather than a cached page, and Anthropic's
 * computer-use returns tool failures as `is_error` instead of the last success.
 */
export interface PerceptionProvenance {
  /**
   * `fresh`       — captured live from the page this turn.
   * `degraded`    — partially captured; some fields may lag.
   * `unavailable` — capture failed; element data must not be trusted at all.
   */
  verdict: 'fresh' | 'degraded' | 'unavailable';
  /** epoch ms of the capture attempt. */
  capturedAt: number;
  /**
   * Where `url`/`title` came from. `tabs-api` is authoritative even when CDP
   * cannot attach (chrome://, another extension's pages), which makes it the
   * one channel that never goes stale.
   */
  urlSource: 'cdp' | 'tabs-api' | 'none';
  /** Why the capture failed. Present when verdict is not `fresh`. */
  error?: string;
}

export interface PageState extends DOMState {
  tabId: number;
  url: string;
  title: string;
  screenshot: string | null;
  scrollY: number;
  scrollHeight: number;
  visualViewportHeight: number;
  /** Truncated plain-text of the page body for LLM context. */
  pageText?: string;
  /** How trustworthy this snapshot is. Never optional — see the type docs. */
  perception: PerceptionProvenance;
}

export interface TabInfo {
  id: number;
  url: string;
  title: string;
}

export interface BrowserState extends PageState {
  tabs: TabInfo[];
  // browser_errors: string[];
}

export class BrowserStateHistory {
  url: string;
  title: string;
  tabs: TabInfo[];
  interactedElements: (DOMHistoryElement | null)[];
  // screenshot is too large to store in the history
  // screenshot: string | null;

  constructor(state: BrowserState, interactedElements?: (DOMHistoryElement | null)[]) {
    this.url = state.url;
    this.title = state.title;
    this.tabs = state.tabs;
    this.interactedElements = interactedElements ?? [];
    // this.screenshot = state.screenshot;
  }
}

export class BrowserError extends Error {
  /**
   * Base class for all browser errors
   */
  constructor(message?: string) {
    super(message);
    this.name = 'BrowserError';
  }
}

export class URLNotAllowedError extends BrowserError {
  /**
   * Error raised when a URL is not allowed
   */
  constructor(message?: string) {
    super(message);
    this.name = 'URLNotAllowedError';
  }
}

/**
 * T2u-runaway-loop — typed error raised when an underlying Chrome API
 * (`chrome.tabs.get`, `chrome.scripting.executeScript`,
 * `chrome.webNavigation.getAllFrames`) reports that the target tab no
 * longer exists ("No tab with id: N"). The pre-fix path swallowed
 * this error and returned a cached `PageState`, which let the caller
 * immediately retry against the same dead tab — generating tens of
 * thousands of identical `[DOMService] skipping subFrame ... No tab
 * with id` warnings per second after the user pressed Stop.
 *
 * The cure is a typed bubble: throw `TabGoneError` from the leaf
 * Chrome-API try/catch, evict the cached `Page` in `BrowserContext`,
 * and let the outer agent loop see a real failure instead of an
 * infinitely retriable one.
 */
export class TabGoneError extends BrowserError {
  public readonly tabId: number;
  constructor(tabId: number, cause?: unknown) {
    super(`Tab ${tabId} is gone: ${cause instanceof Error ? cause.message : String(cause ?? 'No tab with id')}`);
    this.name = 'TabGoneError';
    this.tabId = tabId;
  }
}

/**
 * T2u-runaway-loop — string-level detector. Chrome surfaces the dead
 * tab condition through multiple error messages depending on the API
 * surface that triggered it; the canonical one is
 * `No tab with id: <N>`. We also match `No frame with id` because
 * `chrome.scripting.executeScript({ target: { frameIds: [...] }})`
 * raises that variant when the parent tab is alive but a recorded
 * sub-frame has been torn down. Both indicate the cached Page is no
 * longer driving anything real and must be evicted.
 */
export function isTabGoneErrorMessage(message: string): boolean {
  return /No tab with id\b/i.test(message) || /No frame with id\b/i.test(message);
}

/**
 * The debugger session is bound to a document the tab has already left.
 *
 * Happens on any cross-process navigation: `chrome-extension://` → `http://`
 * spawns a NEW target, and a session attached to the old one keeps answering
 * with the old page's access error forever. Observed 2026-08-06 as 36
 * consecutive failures while `chrome.tabs.get` reported the tab was long since
 * on the requested page — the tab had moved, the debugger had not.
 *
 * Distinct from `isTabGoneErrorMessage`: the tab is alive and reachable, only
 * our attachment is stale, so the cure is re-attach rather than eviction.
 */
export function isStaleTargetErrorMessage(message: string): boolean {
  return (
    /Cannot access a chrome-extension:\/\/ URL of different extension/i.test(message) ||
    /Cannot access a chrome:\/\/ URL/i.test(message) ||
    /Cannot access contents of the page/i.test(message) ||
    /Target closed/i.test(message) ||
    // Dead puppeteer connection after Chrome force-detached the session
    // (chrome.debugger.onDetach). The tab is alive; only the binding died.
    /Connection closed/i.test(message) ||
    /Session closed/i.test(message) ||
    /Debugger is not attached/i.test(message) ||
    /debugger binding lost/i.test(message)
  );
}

/**
 * Chrome refuses debugger access because SOME frame in the tab belongs to a
 * different extension. Verified against Chromium `debugger_api.cc`:
 * `ExtensionMayAttachToRenderFrameHost` walks EVERY RenderFrameHost with
 * `ForEachRenderFrameHostWithAction` and fails the whole tab when any frame's
 * committed URL is `chrome-extension://<id≠ours>/…` (`kCannotAccessExtensionUrl`).
 *
 * Two ways to get here:
 *  1. The tab's main document IS a foreign extension page (new-tab override).
 *  2. A foreign extension injected an iframe into an ordinary page — password
 *     managers do this the moment a credential field receives focus. Chrome
 *     then force-detaches the live session (onDetach, reason `target_closed`)
 *     and denies re-attach for as long as the frame exists.
 *
 * Subset of `isStaleTargetErrorMessage`; used to decide whether clearing
 * foreign frames before re-attach can help.
 */
export function isForeignExtensionFrameError(message: string): boolean {
  return /Cannot access a chrome-extension:\/\/ URL of different extension/i.test(message);
}
