/**
 * In-product notices (a feature intro, "what's new") and which ones the user
 * has already seen. Each notice is shown once, to new and existing users alike:
 * an id missing from `seen` is shown the next time its trigger fires.
 */
import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

export interface NoticesState {
  seen: string[];
}

export type NoticesStorage = BaseStorage<NoticesState> & {
  hasSeen: (id: string) => Promise<boolean>;
  markSeen: (id: string) => Promise<void>;
};

const storage = createStorage<NoticesState>(
  'browd-notices',
  { seen: [] },
  { storageEnum: StorageEnum.Local, liveUpdate: true },
);

export const noticesStore: NoticesStorage = {
  ...storage,
  hasSeen: async id => ((await storage.get())?.seen ?? []).includes(id),
  markSeen: async id => {
    const seen = (await storage.get())?.seen ?? [];
    if (!seen.includes(id)) await storage.set({ seen: [...seen, id] });
  },
};
