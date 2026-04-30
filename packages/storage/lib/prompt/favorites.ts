import { StorageEnum } from '../base/enums';
import { createStorage } from '../base/base';
import type { BaseStorage } from '../base/types';

// Template data
const defaultFavoritePrompts = [
  {
    title: 'Explore Browd',
    content:
      'Open the Browd repository at https://github.com/wyddy7/browd and summarize what the project does, how to run it locally, and one concrete way I could improve it next.',
  },
  {
    title: 'Extract Info',
    content:
      'Extract the important structured information from this page and return it as a clean list or table. Include names, prices, dates, links, and statuses when available.',
  },
  {
    title: 'Create Workflow',
    content:
      'Look at the current page and draft a reusable step-by-step workflow for this task. Keep it concise and actionable so I can reuse it later.',
  },
];

const systemPromptMatchers = [
  (prompt: FavoritePrompt) =>
    prompt.title === '📚 Explore AI Papers' ||
    prompt.content.includes('https://huggingface.co/papers') ||
    prompt.content.includes('ranked by upvotes'),
  (prompt: FavoritePrompt) =>
    prompt.title === '🔎 Compare Provider Options' ||
    prompt.content.includes('OpenRouter model options') ||
    prompt.content.includes('which model you would choose for planning'),
  (prompt: FavoritePrompt) =>
    prompt.title === '🐦 Follow us on X/Twitter!' ||
    prompt.title.includes('Twitter') ||
    prompt.title.includes('X/Twitter') ||
    prompt.content.includes('x.com/nanobrowser_ai') ||
    prompt.content.includes('latest news and features'),
  (prompt: FavoritePrompt) =>
    prompt.title === '🌟 Star us on GitHub!' ||
    prompt.title === '🌟 Explore Browd on GitHub' ||
    prompt.title === '🌟 Explore Nanobrowser on GitHub' ||
    prompt.title === 'Explore Browd on GitHub' ||
    prompt.title === 'Explore Browd' ||
    prompt.content.includes('https://github.com/wyddy7/browd') ||
    prompt.content.includes('https://github.com/nanobrowser/nanobrowser') ||
    prompt.content.includes('next obvious contribution.') ||
    prompt.content.includes('support us by giving us a star'),
  (prompt: FavoritePrompt) =>
    prompt.title === 'Summarize this page' ||
    prompt.content.includes('Summarize the current page in a few concise bullets.'),
  (prompt: FavoritePrompt) =>
    prompt.title === 'Extract Info' ||
    prompt.title === 'Extract structured data' ||
    prompt.content.includes('Extract the important structured information from this page'),
  (prompt: FavoritePrompt) =>
    prompt.title === 'Compare available options' ||
    prompt.content.includes('Review the visible options on this page, compare their main differences'),
  (prompt: FavoritePrompt) =>
    prompt.title === 'Create Workflow' ||
    prompt.title === 'Create a reusable workflow' ||
    prompt.content.includes('draft a reusable step-by-step workflow for this task'),
];

function isSystemPrompt(prompt: FavoritePrompt): boolean {
  return systemPromptMatchers.some(matchPrompt => matchPrompt(prompt));
}

function rebuildDefaultPrompts(prompts: FavoritePrompt[]): FavoritePrompt[] {
  const customPrompts = prompts.filter(prompt => !isSystemPrompt(prompt));
  const rebuilt = [...defaultFavoritePrompts, ...customPrompts];
  const total = rebuilt.length;

  return rebuilt.map((prompt, index) => ({
    id: total - index,
    title: prompt.title,
    content: prompt.content,
  }));
}

// Define the favorite prompt type
export interface FavoritePrompt {
  id: number;
  title: string;
  content: string;
}

// Define the favorites storage type
export interface FavoritesStorage {
  nextId: number;
  prompts: FavoritePrompt[];
}

// Define the interface for favorite prompts storage operations
export interface FavoritePromptsStorage {
  addPrompt: (title: string, content: string) => Promise<FavoritePrompt>;
  updatePrompt: (id: number, title: string, content: string) => Promise<FavoritePrompt | undefined>;
  updatePromptTitle: (id: number, title: string) => Promise<FavoritePrompt | undefined>;
  removePrompt: (id: number) => Promise<void>;
  getAllPrompts: () => Promise<FavoritePrompt[]>;
  getPromptById: (id: number) => Promise<FavoritePrompt | undefined>;
  reorderPrompts: (draggedId: number, targetId: number) => Promise<void>;
}

// Initial state with proper typing
const initialState: FavoritesStorage = {
  nextId: 1,
  prompts: [],
};

// Create the favorites storage
const favoritesStorage: BaseStorage<FavoritesStorage> = createStorage('favorites', initialState, {
  storageEnum: StorageEnum.Local,
  liveUpdate: true,
});

/**
 * Creates a storage interface for managing favorite prompts
 */
export function createFavoritesStorage(): FavoritePromptsStorage {
  return {
    addPrompt: async (title: string, content: string): Promise<FavoritePrompt> => {
      // Check if prompt with same content already exists
      const { prompts } = await favoritesStorage.get();
      const existingPrompt = prompts.find(prompt => prompt.content === content);

      // If exists, return the existing prompt
      if (existingPrompt) {
        return existingPrompt;
      }

      // Otherwise add new prompt
      await favoritesStorage.set(prev => {
        const id = prev.nextId;
        const newPrompt: FavoritePrompt = { id, title, content };

        return {
          nextId: id + 1,
          prompts: [newPrompt, ...prev.prompts],
        };
      });

      return (await favoritesStorage.get()).prompts[0];
    },

    updatePrompt: async (id: number, title: string, content: string): Promise<FavoritePrompt | undefined> => {
      let updatedPrompt: FavoritePrompt | undefined;

      await favoritesStorage.set(prev => {
        const updatedPrompts = prev.prompts.map(prompt => {
          if (prompt.id === id) {
            updatedPrompt = { ...prompt, title, content };
            return updatedPrompt;
          }
          return prompt;
        });

        // If prompt wasn't found, leave the storage unchanged
        if (!updatedPrompt) {
          return prev;
        }

        return {
          ...prev,
          prompts: updatedPrompts,
        };
      });

      return updatedPrompt;
    },

    updatePromptTitle: async (id: number, title: string): Promise<FavoritePrompt | undefined> => {
      let updatedPrompt: FavoritePrompt | undefined;

      await favoritesStorage.set(prev => {
        const updatedPrompts = prev.prompts.map(prompt => {
          if (prompt.id === id) {
            updatedPrompt = { ...prompt, title };
            return updatedPrompt;
          }
          return prompt;
        });

        // If prompt wasn't found, leave the storage unchanged
        if (!updatedPrompt) {
          return prev;
        }

        return {
          ...prev,
          prompts: updatedPrompts,
        };
      });

      return updatedPrompt;
    },

    removePrompt: async (id: number): Promise<void> => {
      await favoritesStorage.set(prev => ({
        ...prev,
        prompts: prev.prompts.filter(prompt => prompt.id !== id),
      }));
    },

    getAllPrompts: async (): Promise<FavoritePrompt[]> => {
      const currentState = await favoritesStorage.get();
      let prompts = currentState.prompts;

      // Check if storage is in initial state (empty prompts array and nextId=1)
      if (currentState.prompts.length === 0 && currentState.nextId === 1) {
        // Initialize with default prompts
        for (const prompt of defaultFavoritePrompts) {
          await favoritesStorage.set(prev => {
            const id = prev.nextId;
            const newPrompt: FavoritePrompt = { id, title: prompt.title, content: prompt.content };
            return { nextId: id + 1, prompts: [newPrompt, ...prev.prompts] };
          });
        }
        const newState = await favoritesStorage.get();
        prompts = newState.prompts;
      }

      const hasSystemPrompts = prompts.some(isSystemPrompt);

      if (hasSystemPrompts) {
        const rebuiltPrompts = rebuildDefaultPrompts(prompts);
        const hasMigrationChanges =
          rebuiltPrompts.length !== prompts.length ||
          rebuiltPrompts.some((prompt, index) => {
            const originalPrompt = prompts[index];
            return (
              !originalPrompt || prompt.title !== originalPrompt.title || prompt.content !== originalPrompt.content
            );
          });

        if (hasMigrationChanges) {
          await favoritesStorage.set(prev => {
            const nextPrompts = rebuildDefaultPrompts(prev.prompts);
            return {
              nextId: nextPrompts.length + 1,
              prompts: nextPrompts,
            };
          });
          const updatedState = await favoritesStorage.get();
          prompts = updatedState.prompts;
        }
      }

      if (!hasSystemPrompts && currentState.prompts.length === 0 && currentState.nextId === 1) {
        await favoritesStorage.set(prev => ({
          nextId: prev.nextId,
          prompts: prev.prompts,
        }));
      }

      return [...prompts].sort((a, b) => b.id - a.id);
    },

    getPromptById: async (id: number): Promise<FavoritePrompt | undefined> => {
      const { prompts } = await favoritesStorage.get();
      return prompts.find(prompt => prompt.id === id);
    },

    reorderPrompts: async (draggedId: number, targetId: number): Promise<void> => {
      await favoritesStorage.set(prev => {
        // Create a copy of the current prompts
        const promptsCopy = [...prev.prompts];

        // Find indexes
        const sourceIndex = promptsCopy.findIndex(prompt => prompt.id === draggedId);
        const targetIndex = promptsCopy.findIndex(prompt => prompt.id === targetId);

        // Ensure both indexes are valid
        if (sourceIndex === -1 || targetIndex === -1) {
          return prev; // No changes if either index is invalid
        }

        // Reorder by removing dragged item and inserting at target position
        const [movedItem] = promptsCopy.splice(sourceIndex, 1);
        promptsCopy.splice(targetIndex, 0, movedItem);

        // Assign new IDs based on the order
        const numPrompts = promptsCopy.length;
        const updatedPromptsWithNewIds = promptsCopy.map((prompt, index) => ({
          ...prompt,
          id: numPrompts - index, // Assigns IDs: numPrompts, numPrompts-1, ..., 1
        }));

        return {
          ...prev,
          prompts: updatedPromptsWithNewIds,
          nextId: numPrompts + 1, // Update nextId accordingly
        };
      });
    },
  };
}

// Export an instance of the storage by default
export default createFavoritesStorage();
