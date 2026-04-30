import { createStorage } from '../base/base';
import { StorageEnum } from '../base/enums';

export interface ChatInputDraftRecord {
  text: string;
}

export interface ChatInputDraftStorage {
  getDraft: () => Promise<string>;
  setDraft: (text: string) => Promise<void>;
  clearDraft: () => Promise<void>;
}

const chatInputDraftStorage = createStorage<ChatInputDraftRecord>(
  'chat_input_draft',
  {
    text: '',
  },
  {
    storageEnum: StorageEnum.Local,
    liveUpdate: true,
  },
);

export function createChatInputDraftStorage(): ChatInputDraftStorage {
  return {
    getDraft: async () => {
      const { text } = await chatInputDraftStorage.get();
      return text;
    },

    setDraft: async (text: string) => {
      await chatInputDraftStorage.set({ text });
    },

    clearDraft: async () => {
      await chatInputDraftStorage.set({ text: '' });
    },
  };
}

export default createChatInputDraftStorage();
