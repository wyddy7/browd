import 'webextension-polyfill';
import {
  type BrowserContextConfig,
  type BrowserState,
  DEFAULT_BROWSER_CONTEXT_CONFIG,
  type TabInfo,
  URLNotAllowedError,
} from './views';
import Page, { build_initial_state } from './page';
import { createLogger } from '@src/background/log';
import { isUrlAllowed } from './util';

const logger = createLogger('BrowserContext');
export default class BrowserContext {
  private _config: BrowserContextConfig;
  private _currentTabId: number | null = null;
  private _attachedPages: Map<number, Page> = new Map();
  /**
   * T2f-tab-iso-1a — id of the tab the agent is working in for the
   * current task. When set, getCurrentPage() always resolves to this
   * tab even if the user clicks away. null between tasks; cleared on
   * `cleanup()`. The agent tab is created via `openAgentTab()` (new
   * blank tab) or pinned to an existing one via `takeOverTab()`.
   */
  private _agentTabId: number | null = null;
  /**
   * T2f-tab-iso-1d — listener for re-applying the [Browd] title
   * prefix after navigation in the agent tab. Lives between
   * openAgentTab() and cleanup().
   */
  private _onTabUpdatedHandler: ((tabId: number, info: chrome.tabs.TabChangeInfo) => void) | null = null;

  constructor(config: Partial<BrowserContextConfig>) {
    this._config = { ...DEFAULT_BROWSER_CONTEXT_CONFIG, ...config };
  }

  public getConfig(): BrowserContextConfig {
    return this._config;
  }

  public updateConfig(config: Partial<BrowserContextConfig>): void {
    this._config = { ...this._config, ...config };
    // T2f-firewall-live: propagate to all attached pages so firewall
    // changes (allow/deny lists) take effect immediately without
    // restarting the task. Page caches its own merged config —
    // mid-task updates were silently lost before this.
    for (const page of this._attachedPages.values()) {
      page.updateConfig(config);
    }
  }

  public updateCurrentTabId(tabId: number): void {
    // only update tab id, but don't attach it.
    this._currentTabId = tabId;
  }

  private async _getOrCreatePage(tab: chrome.tabs.Tab, forceUpdate = false): Promise<Page> {
    if (!tab.id) {
      throw new Error('Tab ID is not available');
    }

    const existingPage = this._attachedPages.get(tab.id);
    if (existingPage) {
      logger.info('getOrCreatePage', tab.id, 'already attached');
      if (!forceUpdate) {
        return existingPage;
      }
      // detach the page and remove it from the attached pages if forceUpdate is true
      await existingPage.detachPuppeteer();
      this._attachedPages.delete(tab.id);
    }
    logger.info('getOrCreatePage', tab.id, 'creating new page');
    return new Page(tab.id, tab.url || '', tab.title || '', this._config);
  }

  public async cleanup(): Promise<void> {
    const currentPage = await this.getCurrentPage();
    currentPage?.removeHighlight();
    // detach all pages
    for (const page of this._attachedPages.values()) {
      await page.detachPuppeteer();
    }
    this._attachedPages.clear();
    this._currentTabId = null;
    this._agentTabId = null;
    if (this._onTabUpdatedHandler) {
      chrome.tabs.onUpdated.removeListener(this._onTabUpdatedHandler);
      this._onTabUpdatedHandler = null;
    }
  }

  /**
   * T2f-tab-iso-1a — open a fresh tab for the agent's task. Returns
   * the new tab id. The agent's getCurrentPage() will resolve to
   * this tab for the rest of the task even if the user switches
   * windows or focuses another tab.
   *
   * Default initial URL is about:blank — the agent's first
   * `go_to_url` moves it to the actual target. We create the tab as
   * inactive (active:false) so the user keeps focus on whatever
   * they were doing; the agent's work is visible as a separate tab
   * the user can click into.
   */
  public async openAgentTab(initialUrl: string = 'about:blank'): Promise<number> {
    const tab = await chrome.tabs.create({ url: initialUrl, active: false });
    if (!tab.id) {
      throw new Error('openAgentTab: chrome.tabs.create returned no tab id');
    }
    this._agentTabId = tab.id;
    this._currentTabId = tab.id;
    logger.info(`openAgentTab: created agent tab ${tab.id} (${initialUrl})`);
    // T2f-tab-iso-1d — visual feedback. Inject a content script to
    // prefix the document title with "[Browd] " so the user can see
    // at a glance which tab in their tab strip is the agent's. Best-
    // effort: about:blank has no scripting permission, but as soon
    // as the agent navigates somewhere the prefix gets re-applied.
    void this._applyAgentTabBadge(tab.id);
    // Re-apply on every navigation in the agent tab — a fresh
    // page.complete clobbers the prefix until our injection runs again.
    if (!this._onTabUpdatedHandler) {
      this._onTabUpdatedHandler = (updatedTabId, info) => {
        if (updatedTabId === this._agentTabId && info.status === 'complete') {
          void this._applyAgentTabBadge(updatedTabId);
        }
      };
      chrome.tabs.onUpdated.addListener(this._onTabUpdatedHandler);
    }
    return tab.id;
  }

  private async _applyAgentTabBadge(tabId: number): Promise<void> {
    try {
      await chrome.scripting.executeScript({
        target: { tabId },
        func: () => {
          const PREFIX = '[Browd] ';
          if (document.title && !document.title.startsWith(PREFIX)) {
            document.title = PREFIX + document.title;
          }
          // Re-apply on every title change so SPAs that overwrite
          // document.title don't strip the badge mid-task.
          // Use a MutationObserver scoped to the title element.
          const titleEl = document.querySelector('title');
          if (titleEl && !(window as any).__browdTitleObserver) {
            const obs = new MutationObserver(() => {
              if (document.title && !document.title.startsWith(PREFIX)) {
                document.title = PREFIX + document.title;
              }
            });
            obs.observe(titleEl, { childList: true });
            (window as any).__browdTitleObserver = obs;
          }
        },
      });
    } catch (err) {
      logger.warning(`agent tab badge injection failed (likely chrome:// or about:blank)`, err);
    }
  }

  /**
   * T2f-tab-iso-1c — pin the agent to an existing user tab. Used
   * only when the task explicitly references the user's open page
   * ("this page", "current tab", "the open form"). Implemented in
   * the `take_over_user_tab` action.
   */
  public takeOverTab(tabId: number): void {
    this._agentTabId = tabId;
    this._currentTabId = tabId;
    logger.info(`takeOverTab: agent now operates in tab ${tabId}`);
  }

  public agentTabId(): number | null {
    return this._agentTabId;
  }

  public async attachPage(page: Page): Promise<boolean> {
    // check if page is already attached
    if (this._attachedPages.has(page.tabId)) {
      logger.info('attachPage', page.tabId, 'already attached');
      return true;
    }

    if (await page.attachPuppeteer()) {
      logger.info('attachPage', page.tabId, 'attached');
      // add page to managed pages
      this._attachedPages.set(page.tabId, page);
      return true;
    }
    return false;
  }

  public async detachPage(tabId: number): Promise<void> {
    // detach page
    const page = this._attachedPages.get(tabId);
    if (page) {
      await page.detachPuppeteer();
      // remove page from managed pages
      this._attachedPages.delete(tabId);
    }
  }

  public async getCurrentPage(): Promise<Page> {
    // T2f-tab-iso-1a — when a task is running with an agent tab
    // pinned, always resolve to it regardless of which tab the user
    // is currently focused on. Prevents user-driven tab switches
    // from yanking the agent into the wrong page mid-action.
    if (this._agentTabId) {
      const cached = this._attachedPages.get(this._agentTabId);
      if (cached) return cached;
      try {
        const tab = await chrome.tabs.get(this._agentTabId);
        const page = await this._getOrCreatePage(tab);
        await this.attachPage(page);
        return page;
      } catch (err) {
        // Agent tab was closed (manually by user or by cleanup).
        // Fall through to default active-tab resolution and clear
        // the stale id so the next call doesn't loop on a missing tab.
        logger.warning(`agent tab ${this._agentTabId} no longer reachable, falling back`, err);
        this._agentTabId = null;
        this._currentTabId = null;
      }
    }

    // 1. If _currentTabId not set, query the active tab and attach it
    if (!this._currentTabId) {
      let activeTab: chrome.tabs.Tab;
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        // open a new tab with blank page
        const newTab = await chrome.tabs.create({ url: this._config.homePageUrl });
        if (!newTab.id) {
          // this should rarely happen
          throw new Error('No tab ID available');
        }
        activeTab = newTab;
      } else {
        activeTab = tab;
      }
      logger.info('active tab', activeTab.id, activeTab.url, activeTab.title);
      const page = await this._getOrCreatePage(activeTab);
      await this.attachPage(page);
      this._currentTabId = activeTab.id || null;
      return page;
    }

    // 2. If _currentTabId is set but not in attachedPages, attach the tab
    const existingPage = this._attachedPages.get(this._currentTabId);
    if (!existingPage) {
      const tab = await chrome.tabs.get(this._currentTabId);
      const page = await this._getOrCreatePage(tab);
      // set current tab id to null if the page is not attached successfully
      await this.attachPage(page);
      return page;
    }

    // 3. Return existing page from attachedPages
    return existingPage;
  }

  /**
   * Get all tab IDs from the browser and the current window.
   * @returns A set of tab IDs.
   */
  public async getAllTabIds(): Promise<Set<number>> {
    const tabs = await chrome.tabs.query({ currentWindow: true });
    return new Set(tabs.map(tab => tab.id).filter(id => id !== undefined));
  }

  /**
   * Wait for tab events to occur after a tab is created or updated.
   * @param tabId - The ID of the tab to wait for events on.
   * @param options - An object containing options for the wait.
   * @returns A promise that resolves when the tab events occur.
   */
  private async waitForTabEvents(
    tabId: number,
    options: {
      waitForUpdate?: boolean;
      waitForActivation?: boolean;
      timeoutMs?: number;
    } = {},
  ): Promise<void> {
    const { waitForUpdate = true, waitForActivation = true, timeoutMs = 5000 } = options;

    const promises: Promise<void>[] = [];

    if (waitForUpdate) {
      const updatePromise = new Promise<void>(resolve => {
        let hasUrl = false;
        let hasTitle = false;
        let isComplete = false;

        const onUpdatedHandler = (updatedTabId: number, changeInfo: chrome.tabs.TabChangeInfo) => {
          if (updatedTabId !== tabId) return;

          if (changeInfo.url) hasUrl = true;
          if (changeInfo.title) hasTitle = true;
          if (changeInfo.status === 'complete') isComplete = true;

          // Resolve when we have all the information we need
          if (hasUrl && hasTitle && isComplete) {
            chrome.tabs.onUpdated.removeListener(onUpdatedHandler);
            resolve();
          }
        };
        chrome.tabs.onUpdated.addListener(onUpdatedHandler);

        // Check current state
        chrome.tabs.get(tabId).then(tab => {
          if (tab.url) hasUrl = true;
          if (tab.title) hasTitle = true;
          if (tab.status === 'complete') isComplete = true;

          if (hasUrl && hasTitle && isComplete) {
            chrome.tabs.onUpdated.removeListener(onUpdatedHandler);
            resolve();
          }
        });
      });
      promises.push(updatePromise);
    }

    if (waitForActivation) {
      const activatedPromise = new Promise<void>(resolve => {
        const onActivatedHandler = (activeInfo: chrome.tabs.TabActiveInfo) => {
          if (activeInfo.tabId === tabId) {
            chrome.tabs.onActivated.removeListener(onActivatedHandler);
            resolve();
          }
        };
        chrome.tabs.onActivated.addListener(onActivatedHandler);

        // Check current state
        chrome.tabs.get(tabId).then(tab => {
          if (tab.active) {
            chrome.tabs.onActivated.removeListener(onActivatedHandler);
            resolve();
          }
        });
      });
      promises.push(activatedPromise);
    }

    const timeoutPromise = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`Tab operation timed out after ${timeoutMs} ms`)), timeoutMs),
    );

    await Promise.race([Promise.all(promises), timeoutPromise]);
  }

  public async switchTab(tabId: number): Promise<Page> {
    logger.info('switchTab', tabId);

    await chrome.tabs.update(tabId, { active: true });
    await this.waitForTabEvents(tabId, { waitForUpdate: false });

    const page = await this._getOrCreatePage(await chrome.tabs.get(tabId));
    await this.attachPage(page);
    this._currentTabId = tabId;
    return page;
  }

  public async navigateTo(url: string): Promise<void> {
    if (!isUrlAllowed(url, this._config.allowedUrls, this._config.deniedUrls)) {
      throw new URLNotAllowedError(`URL: ${url} is not allowed`);
    }

    const page = await this.getCurrentPage();
    if (!page) {
      await this.openTab(url);
      return;
    }
    // if page is attached, use puppeteer to navigate to the url
    if (page.attached) {
      await page.navigateTo(url);
      return;
    }
    //  Use chrome.tabs.update only if the page is not attached
    const tabId = page.tabId;
    // Update tab and wait for events
    await chrome.tabs.update(tabId, { url, active: true });
    await this.waitForTabEvents(tabId);

    // Reattach the page after navigation completes
    const updatedPage = await this._getOrCreatePage(await chrome.tabs.get(tabId), true);
    await this.attachPage(updatedPage);
    this._currentTabId = tabId;
  }

  public async openTab(url: string): Promise<Page> {
    if (!isUrlAllowed(url, this._config.allowedUrls, this._config.deniedUrls)) {
      throw new URLNotAllowedError(`Open tab failed. URL: ${url} is not allowed`);
    }

    // Create the new tab
    const tab = await chrome.tabs.create({ url, active: true });
    if (!tab.id) {
      throw new Error('No tab ID available');
    }
    // Wait for tab events
    await this.waitForTabEvents(tab.id);

    // Get updated tab information
    const updatedTab = await chrome.tabs.get(tab.id);
    // Create and attach the page after tab is fully loaded and activated
    const page = await this._getOrCreatePage(updatedTab);
    await this.attachPage(page);
    this._currentTabId = tab.id;

    return page;
  }

  public async closeTab(tabId: number): Promise<void> {
    await this.detachPage(tabId);
    await chrome.tabs.remove(tabId);
    // update current tab id if needed
    if (this._currentTabId === tabId) {
      this._currentTabId = null;
    }
  }

  /**
   * Remove a tab from the attached pages map. This will not run detachPuppeteer.
   * @param tabId - The ID of the tab to remove.
   */
  public removeAttachedPage(tabId: number): void {
    this._attachedPages.delete(tabId);
    // update current tab id if needed
    if (this._currentTabId === tabId) {
      this._currentTabId = null;
    }
  }

  public async getTabInfos(): Promise<TabInfo[]> {
    const tabs = await chrome.tabs.query({});
    const tabInfos: TabInfo[] = [];

    for (const tab of tabs) {
      if (tab.id && tab.url && tab.title) {
        tabInfos.push({
          id: tab.id,
          url: tab.url,
          title: tab.title,
        });
      }
    }
    return tabInfos;
  }

  public async getCachedState(useVision = false, cacheClickableElementsHashes = false): Promise<BrowserState> {
    const currentPage = await this.getCurrentPage();

    let pageState = !currentPage ? build_initial_state() : currentPage.getCachedState();
    if (!pageState) {
      pageState = await currentPage.getState(useVision, cacheClickableElementsHashes);
    }

    const tabInfos = await this.getTabInfos();
    const browserState: BrowserState = {
      ...pageState,
      tabs: tabInfos,
    };
    return browserState;
  }

  public async getState(useVision = false, cacheClickableElementsHashes = false): Promise<BrowserState> {
    const currentPage = await this.getCurrentPage();

    const pageState = !currentPage
      ? build_initial_state()
      : await currentPage.getState(useVision, cacheClickableElementsHashes);
    const tabInfos = await this.getTabInfos();
    const browserState: BrowserState = {
      ...pageState,
      tabs: tabInfos,
      // browser_errors: [],
    };
    return browserState;
  }

  public async removeHighlight(): Promise<void> {
    const page = await this.getCurrentPage();
    if (page) {
      await page.removeHighlight();
    }
  }
}
