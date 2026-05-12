/**
 * T2f-tab-iso-2 — agent-tab focus preference.
 *
 * Tab isolation (T2f-tab-iso) opens the agent's work in a dedicated
 * Chromium tab. The default behaviour is `foreground` — the new tab
 * is brought to front so the user can watch the agent working, which
 * is the natural product expectation. `background` is opt-in for
 * users who want the agent to operate without disrupting their
 * current focus (a "do-not-distract" mode).
 *
 * Note: this setting does NOT change WHICH tab the agent operates in
 * (always its dedicated tab) — it only toggles whether the user is
 * auto-focused on it. Scope-confinement security model preserved
 * regardless of the setting.
 *
 * This setting toggles whether `openAgentTab()` brings the new tab
 * to the foreground. It does NOT change WHICH tab the agent works in
 * (always the dedicated `[Browd]` tab); only whether the user sees
 * it being opened. Security model preserved.
 *
 * Persisted in chrome.storage.local; live-update so toggle in chat UI
 * is reflected immediately by the background SW on next task start.
 */

import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

export type AgentTabFocusMode = 'background' | 'foreground';

export interface AgentTabFocusRecord {
  mode: AgentTabFocusMode;
}

export type AgentTabFocusStorage = BaseStorage<AgentTabFocusRecord> & {
  setMode: (mode: AgentTabFocusMode) => Promise<void>;
  getMode: () => Promise<AgentTabFocusMode>;
};

const storage = createStorage<AgentTabFocusRecord>(
  'agent-tab-focus',
  { mode: 'foreground' },
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

export const agentTabFocusStore: AgentTabFocusStorage = {
  ...storage,
  setMode: async (mode: AgentTabFocusMode) => {
    await storage.set({ mode });
  },
  getMode: async () => {
    const data = await storage.get();
    return data.mode ?? 'foreground';
  },
};
