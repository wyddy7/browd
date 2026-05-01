import { z } from 'zod';

export interface ActionSchema {
  name: string;
  description: string;
  schema: z.ZodType;
}

export const doneActionSchema: ActionSchema = {
  name: 'done',
  description: 'Complete task',
  schema: z.object({
    text: z.string(),
    success: z.boolean(),
  }),
};

// Basic Navigation Actions
export const searchGoogleActionSchema: ActionSchema = {
  name: 'search_google',
  description:
    'Search the query in Google in the current tab, the query should be a search query like humans search in Google, concrete and not vague or super long. More the single most important items.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    query: z.string(),
  }),
};

export const goToUrlActionSchema: ActionSchema = {
  name: 'go_to_url',
  description: 'Navigate to URL in the current tab',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    url: z.string(),
  }),
};

export const goBackActionSchema: ActionSchema = {
  name: 'go_back',
  description: 'Go back to the previous page',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
  }),
};

export const clickElementActionSchema: ActionSchema = {
  name: 'click_element',
  description: 'Click element by index',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().describe('index of the element'),
    xpath: z.string().nullable().optional().describe('xpath of the element'),
  }),
};

export const inputTextActionSchema: ActionSchema = {
  name: 'input_text',
  description: 'Input text into an interactive input element',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().describe('index of the element'),
    text: z.string().describe('text to input'),
    xpath: z.string().nullable().optional().describe('xpath of the element'),
  }),
};

// Tab Management Actions
export const switchTabActionSchema: ActionSchema = {
  name: 'switch_tab',
  description: 'Switch to tab by tab id',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    tab_id: z.number().int().describe('id of the tab to switch to'),
  }),
};

export const openTabActionSchema: ActionSchema = {
  name: 'open_tab',
  description: 'Open URL in new tab',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    url: z.string().describe('url to open'),
  }),
};

export const closeTabActionSchema: ActionSchema = {
  name: 'close_tab',
  description: 'Close tab by tab id',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    tab_id: z.number().int().describe('id of the tab'),
  }),
};

// Content Actions, not used currently
// export const extractContentActionSchema: ActionSchema = {
//   name: 'extract_content',
//   description:
//     'Extract page content to retrieve specific information from the page, e.g. all company names, a specific description, all information about, links with companies in structured format or simply links',
//   schema: z.object({
//     goal: z.string(),
//   }),
// };

// Cache Actions
export const cacheContentActionSchema: ActionSchema = {
  name: 'cache_content',
  description: 'Cache what you have found so far from the current page for future use',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    content: z.string().default('').describe('content to cache'),
  }),
};

export const scrollToPercentActionSchema: ActionSchema = {
  name: 'scroll_to_percent',
  description:
    'Scrolls to a particular vertical percentage of the document or an element. If no index of element is specified, scroll the whole document.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    yPercent: z.number().int().describe('percentage to scroll to - min 0, max 100; 0 is top, 100 is bottom'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const scrollToTopActionSchema: ActionSchema = {
  name: 'scroll_to_top',
  description: 'Scroll the document in the window or an element to the top',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const scrollToBottomActionSchema: ActionSchema = {
  name: 'scroll_to_bottom',
  description: 'Scroll the document in the window or an element to the bottom',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const previousPageActionSchema: ActionSchema = {
  name: 'previous_page',
  description:
    'Scroll the document in the window or an element to the previous page. If no index is specified, scroll the whole document.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const nextPageActionSchema: ActionSchema = {
  name: 'next_page',
  description:
    'Scroll the document in the window or an element to the next page. If no index is specified, scroll the whole document.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().nullable().optional().describe('index of the element'),
  }),
};

export const scrollToTextActionSchema: ActionSchema = {
  name: 'scroll_to_text',
  description: 'If you dont find something which you want to interact with in current viewport, try to scroll to it',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    text: z.string().describe('text to scroll to'),
    nth: z
      .number()
      .int()
      .min(1)
      .default(1)
      .describe('which occurrence of the text to scroll to (1-indexed, default: 1)'),
  }),
};

export const sendKeysActionSchema: ActionSchema = {
  name: 'send_keys',
  description:
    'Send strings of special keys like Backspace, Insert, PageDown, Delete, Enter. Shortcuts such as `Control+o`, `Control+Shift+T` are supported as well. This gets used in keyboard press. Be aware of different operating systems and their shortcuts',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    keys: z.string().describe('keys to send'),
  }),
};

export const getDropdownOptionsActionSchema: ActionSchema = {
  name: 'get_dropdown_options',
  description: 'Get all options from a native dropdown',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().describe('index of the dropdown element'),
  }),
};

export const selectDropdownOptionActionSchema: ActionSchema = {
  name: 'select_dropdown_option',
  description: 'Select dropdown option for interactive element index by the text of the option you want to select',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    index: z.number().int().describe('index of the dropdown element'),
    text: z.string().describe('text of the option'),
  }),
};

export const waitActionSchema: ActionSchema = {
  name: 'wait',
  description: 'Wait for x seconds default 3, do NOT use this action unless user asks to wait explicitly',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    seconds: z.number().int().default(3).describe('amount of seconds'),
  }),
};

/**
 * Semantic form field fill — preferred over input_text when a form is detected.
 * Finds the field by its human-readable label, not by DOM index.
 */
export const fillFieldByLabelActionSchema: ActionSchema = {
  name: 'fill_field_by_label',
  description:
    'Fill a form field identified by its label text (not DOM index). Use this whenever a "## Forms detected" section is visible in the page state. Preferred over input_text for form fields to avoid index confusion when multiple similar fields exist.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this action'),
    label: z.string().describe('the exact or partial label text of the field (e.g. "Email", "Английский язык")'),
    value: z.string().describe('value to type into the field'),
    nth: z
      .number()
      .int()
      .min(1)
      .default(1)
      .optional()
      .describe('which occurrence to use if multiple fields match the label (1-indexed, default 1)'),
    xpath: z
      .string()
      .nullable()
      .optional()
      .describe('xpath override — filled in by the executor after label resolution; do not set manually'),
  }),
};

/**
 * T1 — read-only web tools.
 *
 * These three let the agent satisfy information-seeking tasks without
 * opening a browser tab or interacting with the DOM. Prefer these for
 * "find X", "what is Y", "look up Z" style requests. See
 * auto-docs/browd-agent-evolution.md (Tier 1) for context.
 */
export const webFetchMarkdownActionSchema: ActionSchema = {
  name: 'web_fetch_markdown',
  description:
    'Fetch a URL and return its main readable content as Markdown (no tab opened). Use for read-only research: docs pages, articles, leaderboards. Do NOT use for interactive flows (login, forms) — use go_to_url + click for those.',
  schema: z.object({
    intent: z.string().default('').describe('purpose of this fetch'),
    url: z.string().describe('absolute URL to fetch'),
    maxChars: z
      .number()
      .int()
      .min(500)
      .max(8000)
      .optional()
      .default(3000)
      .describe('truncate the markdown to this many characters; default 3000'),
  }),
};

export const webSearchActionSchema: ActionSchema = {
  name: 'web_search',
  description:
    'Search the web and return up to topK {title, url, snippet} hits without opening any tab. Prefer this over search_google when the result is the answer (no need to navigate). Falls back across engines if the primary fails.',
  schema: z.object({
    intent: z.string().default('').describe('why you are searching'),
    query: z.string().describe('search query'),
    topK: z.number().int().min(1).max(10).optional().default(5).describe('how many results to return; default 5'),
  }),
};

export const extractPageMarkdownActionSchema: ActionSchema = {
  name: 'extract_page_as_markdown',
  description:
    'Extract the currently-active tab as Markdown (Readability + Turndown over the live DOM). Use when the agent already navigated and now wants to read content semantically rather than by DOM index.',
  schema: z.object({
    intent: z.string().default('').describe('purpose'),
    maxChars: z.number().int().min(500).max(8000).optional().default(3000),
  }),
};

/**
 * Ask the user a clarifying question and wait for their answer before continuing.
 * Use when a form field is ambiguous, goal is unclear, or confidence is low.
 * The user's answer is injected into agent memory and the task resumes.
 */
export const askUserActionSchema: ActionSchema = {
  name: 'ask_user',
  description:
    'Pause execution and ask the user a question. Use when: (1) a form field purpose is unclear, (2) you need a value only the user knows, (3) confidence in the next action is low. Do NOT use for routine steps — only for genuine ambiguity.',
  schema: z.object({
    question: z.string().describe('clear, specific question to ask the user'),
    reasoning: z.string().describe('why you need this information to proceed'),
    options: z.array(z.string()).optional().describe('optional suggested answers to show as quick-pick buttons'),
  }),
};
