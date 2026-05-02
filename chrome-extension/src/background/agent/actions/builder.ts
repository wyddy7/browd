import { ActionResult, type AgentContext } from '@src/background/agent/types';
import { DOMHistoryElement } from '@src/background/browser/dom/history/view';
import { t } from '@extension/i18n';
import {
  clickElementActionSchema,
  doneActionSchema,
  goBackActionSchema,
  goToUrlActionSchema,
  inputTextActionSchema,
  openTabActionSchema,
  searchGoogleActionSchema,
  switchTabActionSchema,
  type ActionSchema,
  sendKeysActionSchema,
  scrollToTextActionSchema,
  cacheContentActionSchema,
  selectDropdownOptionActionSchema,
  getDropdownOptionsActionSchema,
  closeTabActionSchema,
  waitActionSchema,
  previousPageActionSchema,
  scrollToPercentActionSchema,
  nextPageActionSchema,
  scrollToTopActionSchema,
  scrollToBottomActionSchema,
  fillFieldByLabelActionSchema,
  askUserActionSchema,
  webFetchMarkdownActionSchema,
  webSearchActionSchema,
  extractPageMarkdownActionSchema,
  screenshotActionSchema,
  clickAtActionSchema,
  typeAtActionSchema,
  scrollAtActionSchema,
  hitlClickAtActionSchema,
  dragAtActionSchema,
  takeOverUserTabActionSchema,
} from './schemas';
import { webFetchMarkdown, webSearch, extractActiveTabAsMarkdown } from '../tools/webTools';
import { findFieldByLabel } from '@src/background/browser/dom/fieldFinder';
import { makeActionError } from '../agentErrors';
import type { HITLRequest } from '../hitl/types';
import { z } from 'zod';
import { createLogger } from '@src/background/log';
import { ExecutionState, Actors } from '../event/types';
import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { wrapUntrustedContent } from '../messages/utils';
import { globalTracer } from '../tracing';
import { downscaleJpegToThumb, applyCoordinateGrid } from '../imageUtils';

const logger = createLogger('Action');

/** Categorise tools for the trace UI. Browser-DOM tools dominate today;
 * web_* and meta-tools land in T1/T2. Names that don't match default to
 * 'browser' since the existing registry is browser-only. */
function classifyTool(name: string): 'browser' | 'web' | 'meta' {
  if (name.startsWith('web_') || name === 'extract_page_as_markdown') return 'web';
  if (name === 'replan' || name === 'remember' || name === 'ask_user' || name === 'done') return 'meta';
  // `screenshot` is browser-side (puppeteer captures the active tab).
  return 'browser';
}

export class InvalidInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidInputError';
  }
}

/**
 * An action is a function that takes an input and returns an ActionResult
 */
export class Action {
  constructor(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private readonly handler: (input: any) => Promise<ActionResult>,
    public readonly schema: ActionSchema,
    // Whether this action has an index argument
    public readonly hasIndex: boolean = false,
  ) {}

  async call(input: unknown): Promise<ActionResult> {
    // Validate input before calling the handler
    const schema = this.schema.schema;

    // check if the schema is schema: z.object({}), if so, ignore the input
    const isEmptySchema =
      schema instanceof z.ZodObject &&
      Object.keys((schema as z.ZodObject<Record<string, z.ZodTypeAny>>).shape || {}).length === 0;

    const toolName = this.schema.name;
    const kind = classifyTool(toolName);
    const start = Date.now();
    let resolvedInput: unknown = input;

    try {
      if (isEmptySchema) {
        const result = await this.handler({});
        await this.recordTrace(toolName, {}, result, start, kind);
        return result;
      }

      const parsedArgs = this.schema.schema.safeParse(input);
      if (!parsedArgs.success) {
        const errorMessage = parsedArgs.error.message;
        globalTracer.record({
          tool: toolName,
          args: input,
          result: `InvalidInputError: ${errorMessage}`,
          ok: false,
          durationMs: Date.now() - start,
          kind,
        });
        throw new InvalidInputError(errorMessage);
      }
      resolvedInput = parsedArgs.data;
      const result = await this.handler(parsedArgs.data);
      await this.recordTrace(toolName, parsedArgs.data, result, start, kind);
      return result;
    } catch (error) {
      // Re-throw — Action callers (navigator) handle errors. Tracer must
      // still see the failure so the trace is complete.
      if (!(error instanceof InvalidInputError)) {
        globalTracer.record({
          tool: toolName,
          args: resolvedInput,
          result: error instanceof Error ? error.message : String(error),
          ok: false,
          durationMs: Date.now() - start,
          kind,
        });
      }
      throw error;
    }
  }

  /**
   * T2f-1.5b: shared trace-write helper. The screenshot tool's
   * ActionResult carries `imageBase64`; we downscale it to a small
   * JPEG thumbnail and attach it to the trace entry so the side panel
   * renders an inline preview without needing a separate event
   * channel. Other tools take this path too — for them
   * imageThumbBase64 stays undefined and the record looks identical
   * to the pre-T2f-1.5 one.
   */
  private async recordTrace(
    toolName: string,
    args: unknown,
    result: ActionResult,
    start: number,
    kind: 'browser' | 'web' | 'meta',
  ): Promise<void> {
    let imageThumbBase64: string | undefined;
    let imageThumbMime: string | undefined;
    let imageFullBase64: string | undefined;
    let imageFullMime: string | undefined;
    if (toolName === 'screenshot' && result.imageBase64) {
      // T2f-final-fix: ship both a small chat thumbnail (for inline
      // rendering and storage) and the full-resolution JPEG (for the
      // in-panel lightbox). The tracer strips the full payload before
      // persisting so the storage ring buffer doesn't blow up.
      const thumb = await downscaleJpegToThumb(result.imageBase64, result.imageMime ?? 'image/jpeg');
      if (thumb) {
        imageThumbBase64 = thumb.base64;
        imageThumbMime = thumb.mime;
      }
      imageFullBase64 = result.imageBase64;
      imageFullMime = result.imageMime ?? 'image/jpeg';
    }
    globalTracer.record({
      tool: toolName,
      args,
      result: result.error ?? result.extractedContent ?? 'ok',
      ok: !result.error,
      durationMs: Date.now() - start,
      kind,
      imageThumbBase64,
      imageThumbMime,
      imageFullBase64,
      imageFullMime,
    });
  }

  name() {
    return this.schema.name;
  }

  /**
   * Returns the prompt for the action
   * @returns {string} The prompt for the action
   */
  prompt() {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const schemaShape = (this.schema.schema as z.ZodObject<any>).shape || {};
    const schemaProperties = Object.entries(schemaShape).map(([key, value]) => {
      const zodValue = value as z.ZodTypeAny;
      return `'${key}': {'type': '${zodValue.description}', ${zodValue.isOptional() ? "'optional': true" : "'required': true"}}`;
    });

    const schemaStr =
      schemaProperties.length > 0 ? `{${this.name()}: {${schemaProperties.join(', ')}}}` : `{${this.name()}: {}}`;

    return `${this.schema.description}:\n${schemaStr}`;
  }

  /**
   * Get the index argument from the input if this action has an index
   * @param input The input to extract the index from
   * @returns The index value if found, null otherwise
   */
  getIndexArg(input: unknown): number | null {
    if (!this.hasIndex) {
      return null;
    }
    if (input && typeof input === 'object' && 'index' in input) {
      return (input as { index: number }).index;
    }
    return null;
  }

  /**
   * Set the index argument in the input if this action has an index
   * @param input The input to update the index in
   * @param newIndex The new index value to set
   * @returns Whether the index was set successfully
   */
  setIndexArg(input: unknown, newIndex: number): boolean {
    if (!this.hasIndex) {
      return false;
    }
    if (input && typeof input === 'object') {
      (input as { index: number }).index = newIndex;
      return true;
    }
    return false;
  }
}

// TODO: can not make every action optional, don't know why
export function buildDynamicActionSchema(actions: Action[]): z.ZodType {
  let schema = z.object({});
  for (const action of actions) {
    // create a schema for the action, it could be action.schema.schema or null
    // but don't use default: null as it causes issues with Google Generative AI
    const actionSchema = action.schema.schema;
    schema = schema.extend({
      [action.name()]: actionSchema.nullable().optional().describe(action.schema.description),
    });
  }
  return schema;
}

export class ActionBuilder {
  private readonly context: AgentContext;
  private readonly extractorLLM: BaseChatModel;

  constructor(context: AgentContext, extractorLLM: BaseChatModel) {
    this.context = context;
    this.extractorLLM = extractorLLM;
  }

  buildDefaultActions() {
    const actions = [];

    const done = new Action(async (input: z.infer<typeof doneActionSchema.schema>) => {
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, doneActionSchema.name);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, input.text);
      return new ActionResult({
        isDone: true,
        extractedContent: input.text,
      });
    }, doneActionSchema);
    actions.push(done);

    const searchGoogle = new Action(async (input: z.infer<typeof searchGoogleActionSchema.schema>) => {
      const context = this.context;
      const intent = input.intent || t('act_searchGoogle_start', [input.query]);
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      await context.browserContext.navigateTo(`https://www.google.com/search?q=${input.query}`);

      const msg2 = t('act_searchGoogle_ok', [input.query]);
      context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, searchGoogleActionSchema);
    actions.push(searchGoogle);

    const goToUrl = new Action(async (input: z.infer<typeof goToUrlActionSchema.schema>) => {
      const intent = input.intent || t('act_goToUrl_start', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      await this.context.browserContext.navigateTo(input.url);
      const msg2 = t('act_goToUrl_ok', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, goToUrlActionSchema);
    actions.push(goToUrl);

    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const goBack = new Action(async (input: z.infer<typeof goBackActionSchema.schema>) => {
      const intent = input.intent || t('act_goBack_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await this.context.browserContext.getCurrentPage();
      await page.goBack();
      const msg2 = t('act_goBack_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg2);
      return new ActionResult({
        extractedContent: msg2,
        includeInMemory: true,
      });
    }, goBackActionSchema);
    actions.push(goBack);

    const wait = new Action(async (input: z.infer<typeof waitActionSchema.schema>) => {
      const seconds = input.seconds || 3;
      const intent = input.intent || t('act_wait_start', [seconds.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
      const msg = t('act_wait_ok', [seconds.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, waitActionSchema);
    actions.push(wait);

    // Element Interaction Actions
    const clickElement = new Action(
      async (input: z.infer<typeof clickElementActionSchema.schema>) => {
        const intent = input.intent || t('act_click_start', [input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const state = await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          throw new Error(t('act_errors_elementNotExist', [input.index.toString()]));
        }

        // Check if element is a file uploader
        if (page.isFileUploader(elementNode)) {
          const msg = t('act_click_fileUploader', [input.index.toString()]);
          logger.info(msg);
          return new ActionResult({
            extractedContent: msg,
            includeInMemory: true,
          });
        }

        try {
          const initialTabIds = await this.context.browserContext.getAllTabIds();
          await page.clickElementNode(this.context.options.useVision, elementNode);
          let msg = t('act_click_ok', [input.index.toString(), elementNode.getAllTextTillNextClickableElement(2)]);
          logger.info(msg);

          // TODO: could be optimized by chrome extension tab api
          const currentTabIds = await this.context.browserContext.getAllTabIds();
          if (currentTabIds.size > initialTabIds.size) {
            const newTabMsg = t('act_click_newTabOpened');
            msg += ` - ${newTabMsg}`;
            logger.info(newTabMsg);
            // find the tab id that is not in the initial tab ids
            const newTabId = Array.from(currentTabIds).find(id => !initialTabIds.has(id));
            if (newTabId) {
              await this.context.browserContext.switchTab(newTabId);
            }
          }
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: msg, includeInMemory: true });
        } catch (error) {
          const msg = t('act_errors_elementNoLongerAvailable', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
          return new ActionResult({
            error: error instanceof Error ? error.message : String(error),
          });
        }
      },
      clickElementActionSchema,
      true,
    );
    actions.push(clickElement);

    const inputText = new Action(
      async (input: z.infer<typeof inputTextActionSchema.schema>) => {
        const intent = input.intent || t('act_inputText_start', [input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const state = await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          throw new Error(t('act_errors_elementNotExist', [input.index.toString()]));
        }

        await page.inputTextElementNode(this.context.options.useVision, elementNode, input.text);
        const msg = t('act_inputText_ok', [input.text, input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      },
      inputTextActionSchema,
      true,
    );
    actions.push(inputText);

    // Tab Management Actions
    const switchTab = new Action(async (input: z.infer<typeof switchTabActionSchema.schema>) => {
      const intent = input.intent || t('act_switchTab_start', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await this.context.browserContext.switchTab(input.tab_id);
      const msg = t('act_switchTab_ok', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, switchTabActionSchema);
    actions.push(switchTab);

    const openTab = new Action(async (input: z.infer<typeof openTabActionSchema.schema>) => {
      const intent = input.intent || t('act_openTab_start', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await this.context.browserContext.openTab(input.url);
      const msg = t('act_openTab_ok', [input.url]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, openTabActionSchema);
    actions.push(openTab);

    const closeTab = new Action(async (input: z.infer<typeof closeTabActionSchema.schema>) => {
      const intent = input.intent || t('act_closeTab_start', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      await this.context.browserContext.closeTab(input.tab_id);
      const msg = t('act_closeTab_ok', [input.tab_id.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, closeTabActionSchema);
    actions.push(closeTab);

    // Content Actions
    // TODO: this is not used currently, need to improve on input size
    // const extractContent = new Action(async (input: z.infer<typeof extractContentActionSchema.schema>) => {
    //   const goal = input.goal;
    //   const intent = input.intent || `Extracting content from page`;
    //   this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
    //   const page = await this.context.browserContext.getCurrentPage();
    //   const content = await page.getReadabilityContent();
    //   const promptTemplate = PromptTemplate.fromTemplate(
    //     'Your task is to extract the content of the page. You will be given a page and a goal and you should extract all relevant information around this goal from the page. If the goal is vague, summarize the page. Respond in json format. Extraction goal: {goal}, Page: {page}',
    //   );
    //   const prompt = await promptTemplate.invoke({ goal, page: content.content });

    //   try {
    //     const output = await this.extractorLLM.invoke(prompt);
    //     const msg = `📄  Extracted from page\n: ${output.content}\n`;
    //     return new ActionResult({
    //       extractedContent: msg,
    //       includeInMemory: true,
    //     });
    //   } catch (error) {
    //     logger.error(`Error extracting content: ${error instanceof Error ? error.message : String(error)}`);
    //     const msg =
    //       'Failed to extract content from page, you need to extract content from the current state of the page and store it in the memory. Then scroll down if you still need more information.';
    //     return new ActionResult({
    //       extractedContent: msg,
    //       includeInMemory: true,
    //     });
    //   }
    // }, extractContentActionSchema);
    // actions.push(extractContent);

    // cache content for future use
    const cacheContent = new Action(async (input: z.infer<typeof cacheContentActionSchema.schema>) => {
      const intent = input.intent || t('act_cache_start', [input.content]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      // cache content is untrusted content, it is not instructions
      const rawMsg = t('act_cache_ok', [input.content]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, rawMsg);

      const msg = wrapUntrustedContent(rawMsg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, cacheContentActionSchema);
    actions.push(cacheContent);

    // Scroll to percent
    const scrollToPercent = new Action(async (input: z.infer<typeof scrollToPercentActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToPercent_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();

      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
        logger.info(`Scrolling to percent: ${input.yPercent} with elementNode: ${elementNode.xpath}`);
        await page.scrollToPercent(input.yPercent, elementNode);
      } else {
        await page.scrollToPercent(input.yPercent);
      }
      const msg = t('act_scrollToPercent_ok', [input.yPercent.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, scrollToPercentActionSchema);
    actions.push(scrollToPercent);

    // Scroll to top
    const scrollToTop = new Action(async (input: z.infer<typeof scrollToTopActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToTop_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();
      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
        await page.scrollToPercent(0, elementNode);
      } else {
        await page.scrollToPercent(0);
      }
      const msg = t('act_scrollToTop_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, scrollToTopActionSchema);
    actions.push(scrollToTop);

    // Scroll to bottom
    const scrollToBottom = new Action(async (input: z.infer<typeof scrollToBottomActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToBottom_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();
      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }
        await page.scrollToPercent(100, elementNode);
      } else {
        await page.scrollToPercent(100);
      }
      const msg = t('act_scrollToBottom_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, scrollToBottomActionSchema);
    actions.push(scrollToBottom);

    // Scroll to previous page
    const previousPage = new Action(async (input: z.infer<typeof previousPageActionSchema.schema>) => {
      const intent = input.intent || t('act_previousPage_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();

      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }

        // Check if element is already at top of its scrollable area
        try {
          const [elementScrollTop] = await page.getElementScrollInfo(elementNode);
          if (elementScrollTop === 0) {
            const msg = t('act_errors_alreadyAtTop', [input.index.toString()]);
            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
            return new ActionResult({ extractedContent: msg, includeInMemory: true });
          }
        } catch (error) {
          // If we can't get scroll info, let the scrollToPreviousPage method handle it
          logger.warning(
            `Could not get element scroll info: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        await page.scrollToPreviousPage(elementNode);
      } else {
        // Check if page is already at top
        const [initialScrollY] = await page.getScrollInfo();
        if (initialScrollY === 0) {
          const msg = t('act_errors_pageAlreadyAtTop');
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: msg, includeInMemory: true });
        }

        await page.scrollToPreviousPage();
      }
      const msg = t('act_previousPage_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, previousPageActionSchema);
    actions.push(previousPage);

    // Scroll to next page
    const nextPage = new Action(async (input: z.infer<typeof nextPageActionSchema.schema>) => {
      const intent = input.intent || t('act_nextPage_start');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const page = await this.context.browserContext.getCurrentPage();

      if (input.index) {
        const state = await page.getCachedState();
        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({ error: errorMsg, includeInMemory: true });
        }

        // Check if element is already at bottom of its scrollable area
        try {
          const [elementScrollTop, elementClientHeight, elementScrollHeight] =
            await page.getElementScrollInfo(elementNode);
          if (elementScrollTop + elementClientHeight >= elementScrollHeight) {
            const msg = t('act_errors_alreadyAtBottom', [input.index.toString()]);
            this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
            return new ActionResult({ extractedContent: msg, includeInMemory: true });
          }
        } catch (error) {
          // If we can't get scroll info, let the scrollToNextPage method handle it
          logger.warning(
            `Could not get element scroll info: ${error instanceof Error ? error.message : String(error)}`,
          );
        }

        await page.scrollToNextPage(elementNode);
      } else {
        // Check if page is already at bottom
        const [initialScrollY, initialVisualViewportHeight, initialScrollHeight] = await page.getScrollInfo();
        if (initialScrollY + initialVisualViewportHeight >= initialScrollHeight) {
          const msg = t('act_errors_pageAlreadyAtBottom');
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({ extractedContent: msg, includeInMemory: true });
        }

        await page.scrollToNextPage();
      }
      const msg = t('act_nextPage_ok');
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, nextPageActionSchema);
    actions.push(nextPage);

    // Scroll to text
    const scrollToText = new Action(async (input: z.infer<typeof scrollToTextActionSchema.schema>) => {
      const intent = input.intent || t('act_scrollToText_start', [input.text, input.nth.toString()]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await this.context.browserContext.getCurrentPage();
      try {
        const scrolled = await page.scrollToText(input.text, input.nth);
        const msg = scrolled
          ? t('act_scrollToText_ok', [input.text, input.nth.toString()])
          : t('act_scrollToText_notFound', [input.text, input.nth.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      } catch (error) {
        const msg = t('act_scrollToText_failed', [error instanceof Error ? error.message : String(error)]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
        return new ActionResult({ error: msg, includeInMemory: true });
      }
    }, scrollToTextActionSchema);
    actions.push(scrollToText);

    // Keyboard Actions
    const sendKeys = new Action(async (input: z.infer<typeof sendKeysActionSchema.schema>) => {
      const intent = input.intent || t('act_sendKeys_start', [input.keys]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await this.context.browserContext.getCurrentPage();
      await page.sendKeys(input.keys);
      const msg = t('act_sendKeys_ok', [input.keys]);
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({ extractedContent: msg, includeInMemory: true });
    }, sendKeysActionSchema);
    actions.push(sendKeys);

    // Get all options from a native dropdown
    const getDropdownOptions = new Action(
      async (input: z.infer<typeof getDropdownOptionsActionSchema.schema>) => {
        const intent = input.intent || t('act_getDropdownOptions_start', [input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const state = await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        try {
          // Use the existing getDropdownOptions method
          const options = await page.getDropdownOptions(input.index);

          if (options && options.length > 0) {
            // Format options for display
            const formattedOptions: string[] = options.map(opt => {
              // Encoding ensures AI uses the exact string in select_dropdown_option
              const encodedText = JSON.stringify(opt.text);
              return `${opt.index}: text=${encodedText}`;
            });

            let msg = formattedOptions.join('\n');
            msg += '\n' + t('act_getDropdownOptions_useExactText');
            this.context.emitEvent(
              Actors.NAVIGATOR,
              ExecutionState.ACT_OK,
              t('act_getDropdownOptions_ok', [options.length.toString()]),
            );
            return new ActionResult({
              extractedContent: msg,
              includeInMemory: true,
            });
          }

          // This code should not be reached as getDropdownOptions throws an error when no options found
          // But keeping as fallback
          const msg = t('act_getDropdownOptions_noOptions');
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({
            extractedContent: msg,
            includeInMemory: true,
          });
        } catch (error) {
          const errorMsg = t('act_getDropdownOptions_failed', [error instanceof Error ? error.message : String(error)]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }
      },
      getDropdownOptionsActionSchema,
      true,
    );
    actions.push(getDropdownOptions);

    // Select dropdown option for interactive element index by the text of the option you want to select'
    const selectDropdownOption = new Action(
      async (input: z.infer<typeof selectDropdownOptionActionSchema.schema>) => {
        const intent = input.intent || t('act_selectDropdownOption_start', [input.text, input.index.toString()]);
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

        const page = await this.context.browserContext.getCurrentPage();
        const state = await page.getState();

        const elementNode = state?.selectorMap.get(input.index);
        if (!elementNode) {
          const errorMsg = t('act_errors_elementNotExist', [input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        // Validate that we're working with a select element
        if (!elementNode.tagName || elementNode.tagName.toLowerCase() !== 'select') {
          const errorMsg = t('act_selectDropdownOption_notSelect', [
            input.index.toString(),
            elementNode.tagName || 'unknown',
          ]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }

        logger.debug(`Attempting to select '${input.text}' using xpath: ${elementNode.xpath}`);

        try {
          const result = await page.selectDropdownOption(input.index, input.text);
          const msg = t('act_selectDropdownOption_ok', [input.text, input.index.toString()]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
          return new ActionResult({
            extractedContent: result,
            includeInMemory: true,
          });
        } catch (error) {
          const errorMsg = t('act_selectDropdownOption_failed', [
            error instanceof Error ? error.message : String(error),
          ]);
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, errorMsg);
          return new ActionResult({
            error: errorMsg,
            includeInMemory: true,
          });
        }
      },
      selectDropdownOptionActionSchema,
      true,
    );
    actions.push(selectDropdownOption);

    // Semantic form fill — finds field by label, not DOM index
    const fillFieldByLabel = new Action(async (input: z.infer<typeof fillFieldByLabelActionSchema.schema>) => {
      const intent = input.intent || `Fill "${input.label}" = "${input.value}"`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const page = await this.context.browserContext.getCurrentPage();
      const pageState = await page.getState();

      const elementNode = findFieldByLabel(pageState, input.label, input.nth ?? 1);
      if (!elementNode) {
        const msg = `Field not found for label: "${input.label}"`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_FAIL, msg);
        // Returns structured error so FailureClassifier routes to hitl_ask
        return new ActionResult({
          error: msg,
          includeInMemory: true,
        });
      }

      await page.inputTextElementNode(this.context.options.useVision, elementNode, input.value);
      const msg = `Filled "${input.label}" = "${input.value}"`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
      return new ActionResult({
        extractedContent: msg,
        includeInMemory: true,
        interactedElement: elementNode.xpath
          ? new DOMHistoryElement(
              elementNode.tagName ?? 'input',
              elementNode.xpath,
              elementNode.highlightIndex,
              [input.label],
              elementNode.attributes,
              false,
              null,
            )
          : null,
      });
    }, fillFieldByLabelActionSchema);
    actions.push(fillFieldByLabel);

    // Human-in-the-loop question — pauses execution and waits for the user to answer
    const askUser = new Action(async (input: z.infer<typeof askUserActionSchema.schema>) => {
      const intent = `Asking user: "${input.question}"`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);

      const hitl = this.context.hitlController;
      if (!hitl) {
        // No HITL controller wired — emit event and continue (dev/test mode)
        this.context.emitEvent(
          Actors.SYSTEM,
          ExecutionState.TASK_HITL_ASK,
          JSON.stringify({ question: input.question, reasoning: input.reasoning, options: input.options }),
        );
        return new ActionResult({
          extractedContent: `[HITL unavailable] Question: "${input.question}"`,
          includeInMemory: true,
        });
      }

      const request: HITLRequest = {
        id: `hitl-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        reason: 'ambiguous_input',
        pendingAction: { ask_user: input },
        context: { summary: input.question, risk: 'low', confidence: 0.5 },
        question: input.question,
        options: input.options,
      };

      // Actually pause the agent loop here — resolves when user submits a decision
      const decision = await hitl.requestDecision(request);

      let answer = '';
      if (decision.type === 'answer') {
        answer = decision.answer;
      } else if (decision.type === 'approve') {
        answer = '[User approved / skipped]';
      } else if (decision.type === 'reject') {
        answer = `[User rejected: ${decision.message}]`;
      } else if (decision.type === 'edit') {
        answer = JSON.stringify(decision.editedAction);
      }

      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, `User answered: "${answer}"`);
      return new ActionResult({
        extractedContent: `User answer: "${answer}"`,
        includeInMemory: true,
      });
    }, askUserActionSchema);
    actions.push(askUser);

    // T1: web tools — read-only path that bypasses the browser DOM.
    // Each tool returns a JSON-stringified result so the LLM sees structured
    // evidence (which T2 will use to enforce evidence-on-done).
    // T2f-untrusted-wrap: web_fetch_markdown returns arbitrary
    // third-party page content. Wrap it as untrusted so embedded
    // "Ignore previous instructions" / forged tool calls / prompt
    // injection attempts in the content are framed as data, not
    // instructions. Same wrap is applied to web_search snippets and
    // extract_page_as_markdown output.
    const webFetchMd = new Action(async (input: z.infer<typeof webFetchMarkdownActionSchema.schema>) => {
      const result = await webFetchMarkdown({ url: input.url, maxChars: input.maxChars });
      if (!result.ok) {
        return new ActionResult({ error: `web_fetch_markdown failed: ${result.errorType}: ${result.message}` });
      }
      const inner = `# ${result.title}\n${result.markdown}`;
      const summary = `web_fetch_markdown(${result.url}):\n${wrapUntrustedContent(inner)}`;
      return new ActionResult({ extractedContent: summary, includeInMemory: true });
    }, webFetchMarkdownActionSchema);
    actions.push(webFetchMd);

    const wSearch = new Action(async (input: z.infer<typeof webSearchActionSchema.schema>) => {
      const result = await webSearch({ query: input.query, topK: input.topK });
      if (!result.ok) {
        return new ActionResult({ error: `web_search failed: ${result.errorType}: ${result.message}` });
      }
      const summary = result.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n\n');
      return new ActionResult({
        extractedContent: `web_search(${input.query}) via ${result.engine}:\n${wrapUntrustedContent(summary)}`,
        includeInMemory: true,
      });
    }, webSearchActionSchema);
    actions.push(wSearch);

    // T2f-2: explicit screenshot tool. The action runs the existing
    // puppeteer JPEG capture and surfaces the bytes via ActionResult's
    // imageBase64/imageMime fields; the langGraph adapter (T2f-3)
    // converts them into a multimodal ToolMessage. Registry-side
    // gating happens in T2f-4 — this Action is created here so it's
    // available when the Executor decides to opt in.
    //
    // T2f-coords: when `gridOverlay` is true a labelled 10×10
    // coordinate grid is drawn over the JPEG before it travels to
    // the LLM. Set-of-Mark / WebVoyager-style grounding lifts raw-
    // coordinate accuracy meaningfully — required precondition for
    // click_at / type_at / scroll_at.
    const screenshot = new Action(async (input: z.infer<typeof screenshotActionSchema.schema>) => {
      const intent = input.intent || 'capture viewport';
      const gridOverlay = input.gridOverlay === true;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      try {
        const page = await this.context.browserContext.getCurrentPage();
        // T2f-drag: silent-skip if puppeteer isn't attached yet (the
        // tab is still on chrome://, about:blank, or otherwise pre-
        // attach). The fallback auto-trigger fires on dom-empty, which
        // is also true for those pages, so we'd otherwise spam errors.
        if (!page.attached) {
          return new ActionResult({
            extractedContent: 'screenshot skipped: page not yet attached',
            includeInMemory: false,
          });
        }
        let base64 = await page.takeScreenshot();
        if (!base64) {
          return new ActionResult({ error: 'screenshot returned no data' });
        }
        let mime = 'image/jpeg';
        if (gridOverlay) {
          const overlaid = await applyCoordinateGrid(base64, mime);
          if (overlaid) {
            base64 = overlaid.base64;
            mime = overlaid.mime;
          } else {
            logger.warning('coordinate grid overlay failed; falling back to clean screenshot');
          }
        }
        const summary = gridOverlay ? 'screenshot captured (grid attached)' : 'screenshot captured (image attached)';
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, summary);
        return new ActionResult({
          extractedContent: summary,
          imageBase64: base64,
          imageMime: mime,
          // includeInMemory stays false: classic-mode replay ignores
          // tool images, and unified mode rewinds DOM/screenshot via
          // priorMessages — so persisting the bytes would just bloat
          // chat history storage.
          includeInMemory: false,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new ActionResult({ error: `screenshot failed: ${message}` });
      }
    }, screenshotActionSchema);
    actions.push(screenshot);

    // T2f-coords: coordinate-based mouse/keyboard primitives. Used
    // by the unified vision agent for non-DOM elements. The Page
    // wrapper handles DPR conversion (image px → CSS px) and
    // viewport clamping. Verification of "did anything change?" is
    // attached as a follow-up signature comparison so a no-op click
    // surfaces in the trace as `Error: …` instead of silently looping.
    const clickAt = new Action(async (input: z.infer<typeof clickAtActionSchema.schema>) => {
      const intent = input.intent || `click_at (${input.x},${input.y})`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      try {
        const page = await this.context.browserContext.getCurrentPage();
        const before = await page.readClickSignature();
        const m = await page.clickAtImageCoord(input.x, input.y);
        // Brief settle delay so SPAs have a chance to react.
        await new Promise(r => setTimeout(r, 200));
        const after = await page.readClickSignature();
        const noop = before.url === after.url && before.scrollY === after.scrollY && before.domHash === after.domHash;
        if (noop) {
          return new ActionResult({
            error: `click_at (${input.x},${input.y} → CSS ${m.cssX},${m.cssY}; viewport ${m.vw}×${m.vh}) had no observable effect — DOM/url/scroll unchanged. Re-take a screenshot with gridOverlay=true and verify coordinates, or fall back to a DOM-driven action.`,
          });
        }
        const msg = `clicked at image (${input.x},${input.y}) → css (${m.cssX},${m.cssY})`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new ActionResult({ error: `click_at failed: ${message}` });
      }
    }, clickAtActionSchema);
    actions.push(clickAt);

    const typeAt = new Action(async (input: z.infer<typeof typeAtActionSchema.schema>) => {
      const intent = input.intent || `type_at (${input.x},${input.y})`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      try {
        const page = await this.context.browserContext.getCurrentPage();
        const m = await page.typeAtImageCoord(input.x, input.y, input.text);
        const msg = `typed at image (${input.x},${input.y}) → css (${m.cssX},${m.cssY})`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new ActionResult({ error: `type_at failed: ${message}` });
      }
    }, typeAtActionSchema);
    actions.push(typeAt);

    // T2f-handover: real-user click for isTrusted-walls. Captures
    // a fresh thumb (no grid — the user is the one clicking, they
    // don't need labelled coordinates), pushes a HITLRequest and
    // blocks until the user confirms or rejects.
    const hitlClickAt = new Action(async (input: z.infer<typeof hitlClickAtActionSchema.schema>) => {
      const { x, y, intent, reason } = input;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      const hitl = this.context.hitlController;
      if (!hitl) {
        return new ActionResult({ error: 'hitl_click_at unavailable: HITL controller not wired' });
      }
      let thumbBase64: string | undefined;
      let thumbMime: string | undefined;
      try {
        const page = await this.context.browserContext.getCurrentPage();
        const fullBase64 = await page.takeScreenshot();
        if (fullBase64) {
          const downscaled = await downscaleJpegToThumb(fullBase64, 'image/jpeg', 480, 270, 0.8);
          if (downscaled) {
            thumbBase64 = downscaled.base64;
            thumbMime = downscaled.mime;
          }
        }
      } catch (err) {
        logger.warning('hitl_click_at thumb capture failed', err);
      }
      try {
        const decision = await hitl.requestDecision({
          id: `hitl-click-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
          reason: 'real_user_click',
          pendingAction: { hitl_click_at: { x, y, intent, reason } },
          context: {
            summary: intent,
            risk: 'low',
            confidence: 0.4,
            userClick: { x, y, imageThumbBase64: thumbBase64, imageThumbMime: thumbMime },
          },
        });
        if (decision.type === 'approve') {
          this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, 'user confirmed click');
          return new ActionResult({ extractedContent: 'user clicked it manually', includeInMemory: true });
        }
        if (decision.type === 'reject') {
          return new ActionResult({
            error: `user could not perform the click: ${decision.message || 'no reason given'}`,
          });
        }
        // approve-but-with-edit / answer aren't meaningful here — treat as approve.
        return new ActionResult({ extractedContent: 'user responded; assuming click happened', includeInMemory: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new ActionResult({ error: `hitl_click_at: ${message}` });
      }
    }, hitlClickAtActionSchema);
    actions.push(hitlClickAt);

    // T2f-drag: drag gesture for canvas / whiteboard shape drawing.
    // Same registry gating as click_at (see runReactAgent).
    // T2f-tab-iso-1c: explicit hand-off to a user tab. Sets the
    // BrowserContext's pinned agent tab to the requested user tab
    // — subsequent DOM tools / screenshots / state-messages all
    // resolve to that tab. The action does NOT navigate or click;
    // the LLM has to do that as a follow-up.
    const takeOverUserTab = new Action(async (input: z.infer<typeof takeOverUserTabActionSchema.schema>) => {
      const intent = input.intent || `take over user tab ${input.tabId}`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      try {
        // Sanity: confirm the tab exists and is open.
        const tab = await chrome.tabs.get(input.tabId);
        if (!tab?.id) {
          return new ActionResult({ error: `take_over_user_tab: tab ${input.tabId} not found` });
        }
        this.context.browserContext.takeOverTab(input.tabId);
        const msg = `agent now operates in tab ${input.tabId} (${tab.url ?? 'unknown url'}); reason: ${input.reason}`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new ActionResult({ error: `take_over_user_tab failed: ${message}` });
      }
    }, takeOverUserTabActionSchema);
    actions.push(takeOverUserTab);

    const dragAt = new Action(async (input: z.infer<typeof dragAtActionSchema.schema>) => {
      const intent = input.intent || `drag_at (${input.fromX},${input.fromY}) → (${input.toX},${input.toY})`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      try {
        const page = await this.context.browserContext.getCurrentPage();
        const m = await page.dragAtImageCoord(input.fromX, input.fromY, input.toX, input.toY);
        const msg = `dragged image (${input.fromX},${input.fromY}) → (${input.toX},${input.toY}) [css (${m.fromCssX},${m.fromCssY}) → (${m.toCssX},${m.toCssY})]`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new ActionResult({ error: `drag_at failed: ${message}` });
      }
    }, dragAtActionSchema);
    actions.push(dragAt);

    const scrollAt = new Action(async (input: z.infer<typeof scrollAtActionSchema.schema>) => {
      const intent = input.intent || `scroll_at (${input.x},${input.y}) dy=${input.dy}`;
      this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_START, intent);
      try {
        const page = await this.context.browserContext.getCurrentPage();
        const m = await page.scrollAtImageCoord(input.x, input.y, input.dy);
        const msg = `scrolled at image (${input.x},${input.y}) → css (${m.cssX},${m.cssY}) dy=${input.dy}`;
        this.context.emitEvent(Actors.NAVIGATOR, ExecutionState.ACT_OK, msg);
        return new ActionResult({ extractedContent: msg, includeInMemory: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return new ActionResult({ error: `scroll_at failed: ${message}` });
      }
    }, scrollAtActionSchema);
    actions.push(scrollAt);

    const extractMd = new Action(async (input: z.infer<typeof extractPageMarkdownActionSchema.schema>) => {
      // T2f-untrusted-wrap: extracted page markdown is also third-
      // party content; wrap it before showing to the LLM.
      const result = await extractActiveTabAsMarkdown({ maxChars: input.maxChars });
      if (!result.ok) {
        return new ActionResult({ error: `extract_page_as_markdown failed: ${result.errorType}: ${result.message}` });
      }
      const inner = `# ${result.title}\n${result.markdown}`;
      return new ActionResult({
        extractedContent: `extract_page_as_markdown(${result.url}):\n${wrapUntrustedContent(inner)}`,
        includeInMemory: true,
      });
    }, extractPageMarkdownActionSchema);
    actions.push(extractMd);

    return actions;
  }
}
