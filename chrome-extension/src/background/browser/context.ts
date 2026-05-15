import 'webextension-polyfill';
import {
  type BrowserContextConfig,
  type BrowserState,
  DEFAULT_BROWSER_CONTEXT_CONFIG,
  type TabInfo,
  URLNotAllowedError,
  TabGoneError,
  isTabGoneErrorMessage,
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
   * Id of the tab the agent is currently working in. When set,
   * `getCurrentPage()` resolves to this tab even if the user clicks
   * away. null between tasks; cleared on `cleanup()`.
   */
  private _agentTabId: number | null = null;
  /**
   * T2s-1 — id of the Chrome tab group that scopes the agent's
   * workspace. On task start, `openAgentTab()` takes the user's
   * current active tab and wraps it in a "Browd" tab group; every
   * subsequent tab the agent opens is added to the group; switching
   * to a tab outside the group is refused at runtime. The group is
   * the security boundary — without it the LLM could call
   * `switch_tab(42)` and silently take over any tab the user had open.
   * null between tasks; cleared (but the underlying Chrome group is
   * left alone so the user can keep using it) on `cleanup()`.
   */
  private _agentGroupId: number | null = null;

  /**
   * T2n-overlay-handling — set after `switchTab` / `navigateTo` so
   * the very next stateModifier build forces a fresh screenshot
   * capture regardless of the fallback heuristic. This addresses
   * the overlay-on-load case (cookie banner / sign-in modal /
   * paywall) where the existing triggers
   * (`domEmpty || domFault || stepsExpired`) would silently miss
   * the blocking overlay. The flag is consumed on the next read
   * via `consumePendingForceScreenshot()` so it only fires once
   * per tab settle.
   */
  private _pendingForceScreenshot: boolean = false;

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
    // T2s-1 — drop the in-memory pointer but leave the Chrome tab
    // group itself intact. The user keeps their workspace visible;
    // Chrome auto-destroys the group only when its last tab closes.
    this._agentGroupId = null;
  }

  /**
   * T2s-1 — initialise the agent workspace for a new task.
   *
   * Instead of creating a fresh `about:blank` tab (the pre-T2s
   * behaviour: visible "blank flash" + an extra goofy tab the user
   * never asked for), this takes the user's CURRENT active tab and
   * wraps it in a Chrome tab group titled "Browd". The agent works
   * inside that group; tabs the agent opens later are auto-added to
   * the same group; `switchTab` refuses any tab outside the group.
   * The colour-labelled group is also the visual cue the user needs
   * to see where the agent's work boundary is — replaces the
   * pre-T2s `[Browd]` title-prefix injection.
   *
   * `initialUrl` (optional): if the user's task started with a
   * concrete URL, navigate the existing tab there. Empty / `about:blank`
   * = keep whatever the user had loaded.
   *
   * Returns the agent's working tab id.
   */
  public async openAgentTab(initialUrl: string = 'about:blank'): Promise<number> {
    // 1. Find the user's current active tab. That tab IS the agent's
    //    workspace — we don't conjure a new one.
    const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!activeTab?.id) {
      throw new Error('openAgentTab: no active tab in current window to anchor the agent group');
    }
    const tabId = activeTab.id;

    // 2. Wrap it in a Chrome tab group. `chrome.tabs.group` returns
    //    the new group id; subsequent calls with the same `groupId`
    //    add tabs to that group. We give it a recognisable title and
    //    colour so the user can see the agent's boundary at a glance.
    try {
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      this._agentGroupId = groupId;
      try {
        await chrome.tabGroups.update(groupId, { title: 'Browd', color: 'purple' });
      } catch (err) {
        logger.warning('tabGroups.update failed; group remains untitled', err);
      }
      logger.info(`openAgentTab: anchored agent group ${groupId} on tab ${tabId} (${activeTab.url ?? ''})`);
    } catch (err) {
      // Grouping failed (e.g. unsupported browser variant, perms
      // missing). Continue without isolation rather than aborting the
      // task — log loudly so the user notices.
      logger.warning('openAgentTab: tabs.group failed, isolation disabled for this task', err);
      this._agentGroupId = null;
    }

    this._agentTabId = tabId;
    this._currentTabId = tabId;

    // 3. If the task supplied a concrete URL hint, navigate the
    //    anchored tab to it. The user typed the task, so this is
    //    consented navigation — same semantics as clicking a link.
    if (initialUrl && initialUrl !== 'about:blank') {
      try {
        await chrome.tabs.update(tabId, { url: initialUrl });
      } catch (err) {
        logger.warning(`openAgentTab: failed to navigate ${tabId} to ${initialUrl}`, err);
      }
    }

    return tabId;
  }

  /**
   * T2s-1 — runtime check used by `switchTab` to refuse cross-over
   * to tabs outside the agent's group. Returns true when isolation
   * is OFF (group not set) so legacy / fallback callers don't break.
   */
  private async _isTabInsideAgentGroup(tabId: number): Promise<boolean> {
    if (this._agentGroupId === null) return true;
    try {
      const tab = await chrome.tabs.get(tabId);
      return tab.groupId === this._agentGroupId;
    } catch {
      return false;
    }
  }

  /**
   * Pin the agent to an existing user tab. Used by the
   * `take_over_user_tab` action when the task explicitly references
   * a page already open in the user's browser. The taken-over tab
   * is added to the agent group so subsequent `switch_tab` calls
   * targeting it are allowed.
   *
   * T2s-2 will wrap this behind an HITL approval prompt; for now
   * the action layer (`actions/builder.ts`) is the gate.
   */
  public takeOverTab(tabId: number): void {
    if (this._agentGroupId !== null) {
      void chrome.tabs.group({ tabIds: [tabId], groupId: this._agentGroupId }).catch(err => {
        logger.warning(`takeOverTab: failed to add ${tabId} to agent group`, err);
      });
    }
    this._agentTabId = tabId;
    this._currentTabId = tabId;
    logger.info(`takeOverTab: agent now operates in tab ${tabId}`);
  }

  public agentTabId(): number | null {
    return this._agentTabId;
  }

  public agentGroupId(): number | null {
    return this._agentGroupId;
  }

  /**
   * T2n-overlay-handling — read & clear the pending-force-screenshot
   * flag. Called by the per-step stateModifier in runReactAgent so
   * the next state message gets a fresh capture even if the existing
   * fallback triggers wouldn't have fired. One-shot semantic: after
   * `consumePendingForceScreenshot()` returns true, the flag is
   * reset to false so subsequent state-message builds revert to
   * the regular adaptive heuristic.
   */
  public consumePendingForceScreenshot(): boolean {
    const v = this._pendingForceScreenshot;
    this._pendingForceScreenshot = false;
    return v;
  }

  /**
   * T2n-overlay-handling — test-only accessor. Production code reads
   * via `consumePendingForceScreenshot()` (which clears the flag);
   * tests use this to assert state without disturbing it.
   */
  public hasPendingForceScreenshot(): boolean {
    return this._pendingForceScreenshot;
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

  /**
   * T2u-runaway-loop — evict every cached reference to a tab that
   * Chrome has reported as gone ("No tab with id: N"). Without this
   * call the cached `Page` in `_attachedPages` stays bound to a dead
   * `tabId`, `getCurrentPage()` keeps resolving to it via the
   * `cached` early return, `getState()` keeps hitting it, every call
   * loops through ~N iframes worth of executeScript failures, and
   * the SW console fills up at ~5–10k log lines/sec.
   *
   * Best-effort:
   *   - detach the puppeteer connection (swallowing errors — the
   *     underlying CDP target is already gone, but we want the
   *     attempt logged at debug level for traceability),
   *   - remove the entry from `_attachedPages`,
   *   - clear `_agentTabId` and `_currentTabId` iff they point to
   *     the dead tab. Other tabs in the workspace remain attached.
   */
  public handleTabGone(tabId: number): void {
    const page = this._attachedPages.get(tabId);
    if (page) {
      // detachPuppeteer is fire-and-forget here: awaiting it would
      // block the caller on a CDP cleanup that is guaranteed to
      // fail (target gone). The promise chain swallows the
      // expected rejection.
      void page.detachPuppeteer().catch(err => {
        logger.debug(`handleTabGone: detachPuppeteer(${tabId}) failed (expected)`, err);
      });
      this._attachedPages.delete(tabId);
    }
    if (this._agentTabId === tabId) {
      this._agentTabId = null;
    }
    if (this._currentTabId === tabId) {
      this._currentTabId = null;
    }
    logger.warning(`handleTabGone: tab ${tabId} evicted from BrowserContext`);
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

    // T2s-1 — isolation enforcement. If an agent group is pinned,
    // refuse to switch to any tab outside that group. This closes
    // the cross-over breach where the LLM could call
    // `switch_tab(figmaTabId)` for any random user-owned tab and
    // implicitly take it over. New tabs the agent opens (via
    // `openTab`) are auto-added to the group, so legitimate flows
    // ("agent opens search results, switches to a result tab")
    // keep working. To bring in an existing user tab the agent must
    // go through `take_over_user_tab`.
    if (!(await this._isTabInsideAgentGroup(tabId))) {
      throw new Error(
        `switch_tab(${tabId}) refused: tab is outside the agent group. ` +
          `Open a new tab (it will join the group automatically) or call take_over_user_tab(${tabId}) ` +
          `if the user needs the agent to work in that tab.`,
      );
    }

    // T2n-overlay-handling — mark that the next state-message build
    // must capture a fresh screenshot regardless of the adaptive
    // fallback heuristic. The new tab may have an overlay
    // (cookie banner / sign-in / paywall) blocking real content
    // that the existing triggers (domEmpty / domFault / stepsExpired)
    // would silently miss. Set BEFORE the awaits so the flag is
    // visible even if the page-attach pipeline yields.
    this._pendingForceScreenshot = true;

    await chrome.tabs.update(tabId, { active: true });
    await this.waitForTabEvents(tabId, { waitForUpdate: false });

    const page = await this._getOrCreatePage(await chrome.tabs.get(tabId));
    await this.attachPage(page);
    this._currentTabId = tabId;
    if (this._agentTabId !== null) {
      // T2o-agent-tab-follow: agent-driven switchTab MUST move agent
      // attention to the new tab. Otherwise getCurrentPage() keeps
      // resolving to the original _agentTabId, state-message builds
      // from stale content, and the LLM loops re-emitting switch_tab.
      this._agentTabId = tabId;
    }
    return page;
  }

  public async navigateTo(url: string): Promise<void> {
    if (!isUrlAllowed(url, this._config.allowedUrls, this._config.deniedUrls)) {
      throw new URLNotAllowedError(`URL: ${url} is not allowed`);
    }

    // T2n-overlay-handling — same rationale as switchTab: a navigation
    // that lands on a new origin commonly surfaces a cookie / consent
    // / sign-in modal that the next state message must include in
    // its screenshot for the LLM to dismiss it. Set BEFORE the awaits.
    this._pendingForceScreenshot = true;

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

    // T2s-1 — every new tab the agent opens is added to the agent
    // group so isolation stays intact. Chrome enforces "tab can only
    // be in one group at a time", so this is also the safest way to
    // pull the new tab into our workspace.
    if (this._agentGroupId !== null) {
      try {
        await chrome.tabs.group({ tabIds: [tab.id], groupId: this._agentGroupId });
      } catch (err) {
        logger.warning(`openTab: failed to add new tab ${tab.id} to agent group ${this._agentGroupId}`, err);
      }
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
      try {
        pageState = await currentPage.getState(useVision, cacheClickableElementsHashes);
      } catch (err) {
        this._handleStateError(currentPage?.tabId ?? null, err);
        throw err;
      }
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

    let pageState;
    try {
      pageState = !currentPage
        ? build_initial_state()
        : await currentPage.getState(useVision, cacheClickableElementsHashes);
    } catch (err) {
      this._handleStateError(currentPage?.tabId ?? null, err);
      throw err;
    }
    const tabInfos = await this.getTabInfos();
    const browserState: BrowserState = {
      ...pageState,
      tabs: tabInfos,
      // browser_errors: [],
    };
    return browserState;
  }

  /**
   * T2u-runaway-loop — central place to react to a `TabGoneError`
   * (or a raw `No tab with id` message escaping from a code path we
   * have not converted yet). Evicts the dead tab from the attached
   * cache so the next `getCurrentPage()` does not return the same
   * stale `Page` instance. We do not swallow the error here — the
   * caller (agent loop) needs to see it and bubble up to the outer
   * `runReactAgent` catch which classifies as TASK_FAIL.
   */
  private _handleStateError(tabId: number | null, err: unknown): void {
    if (err instanceof TabGoneError) {
      this.handleTabGone(err.tabId);
      return;
    }
    if (tabId != null) {
      const msg = err instanceof Error ? err.message : String(err);
      if (isTabGoneErrorMessage(msg)) {
        this.handleTabGone(tabId);
      }
    }
  }

  public async removeHighlight(): Promise<void> {
    const page = await this.getCurrentPage();
    if (page) {
      await page.removeHighlight();
    }
  }
}
