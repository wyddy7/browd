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
