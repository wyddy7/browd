/** Readiness is not creation success. Always release listeners, including on timeout/get failure. */
export function waitForTabReady(
  tabId: number,
  { waitForUpdate = true, waitForActivation = true, timeoutMs = 5000 } = {},
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    let loaded = !waitForUpdate;
    let active = !waitForActivation;
    let receivedStatusEvent = false;
    const cleanup = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onActivated.removeListener(onActivated);
    };
    const finish = (ready: boolean) => {
      cleanup();
      resolve(ready);
    };
    const check = () => {
      if (loaded && active) finish(true);
    };
    const onUpdated = (id: number, change: chrome.tabs.TabChangeInfo) => {
      if (id !== tabId) return;
      if (waitForUpdate && change.status) {
        receivedStatusEvent = true;
        loaded = change.status === 'complete';
      }
      check();
    };
    const onActivated = (info: chrome.tabs.TabActiveInfo) => {
      if (info.tabId === tabId) {
        active = true;
        check();
      }
    };
    const timer = setTimeout(() => finish(false), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onActivated.addListener(onActivated);
    chrome.tabs.get(tabId).then(
      tab => {
        if (!receivedStatusEvent) loaded ||= tab.status === 'complete';
        active ||= tab.active;
        check();
      },
      error => {
        cleanup();
        reject(error);
      },
    );
  });
}
