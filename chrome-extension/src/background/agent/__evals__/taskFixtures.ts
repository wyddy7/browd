import type { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { Action, ActionBuilder } from '../actions/builder';
import { extractPageMarkdownActionSchema, waitActionSchema } from '../actions/schemas';
import { ActionResult, type AgentContext } from '../types';
import { type Actors, ExecutionState } from '../event/types';
import { wrapUntrustedContent } from '../messages/utils';
import type { HardAssertion } from './taskEvaluation';

interface FixturePage {
  title: string;
  markdown: string;
}
export interface TaskFixture {
  name: string;
  task: string;
  rubric: string;
  startUrl: string;
  pages: Record<string, FixturePage>;
  expectedUrl: string;
  requiredAnswer: RegExp[];
  expectedNewTabs: number;
  slowOpen?: boolean;
  expectedFailure?: boolean;
}

const source = 'https://example.test/';
const guide = 'https://example.test/help/example-domains';
const pages = {
  [source]: {
    title: 'Example Domain',
    markdown: '# Example Domain\nReserved for documentation examples.\n[Learn more](' + guide + ')',
  },
  [guide]: {
    title: 'Example domains',
    markdown:
      '# Example domains\nThese domains illustrate documentation without prior permission. They are not available for registration or transfer. Do not depend on their web service for production applications.',
  },
};

/** Synthetic data only. Never point model-evaluation fixtures at personal accounts. */
export const taskFixtures: TaskFixture[] = [
  {
    name: 'extract-source-link',
    startUrl: source,
    pages,
    expectedUrl: source,
    task: 'Read the current page. Return its heading, page text and the full destination URL of Learn more. Use this tab; do not open another.',
    rubric:
      'Answer contains the actual heading, documentation purpose and full Learn more destination, not merely a claim that extraction was done.',
    requiredAnswer: [/Example Domain/i, /documentation/i, /https:\/\/example\.test\/help\/example-domains/],
    expectedNewTabs: 0,
  },
  {
    name: 'follow-link-and-explain',
    startUrl: source,
    pages,
    expectedUrl: guide,
    task: 'Follow Learn more in the current tab. Explain in Russian what example domains are for, whether they can be registered, and include the destination URL. Do not open another tab.',
    rubric:
      'Russian answer explains documentation examples, no registration or transfer, and cites the observed destination. Must actually visit the linked page.',
    requiredAnswer: [/[а-яё]/i, /https:\/\/example\.test\/help\/example-domains/],
    expectedNewTabs: 0,
  },
  {
    name: 'slow-tab-created-once',
    startUrl: source,
    pages,
    expectedUrl: guide,
    slowOpen: true,
    task: `Open exactly one new tab at ${guide}, read it and return its title and URL. A loading status means the tab already exists.`,
    rubric:
      'One new tab is created, not repeated on a loading result. Answer contains the observed title and correct URL.',
    requiredAnswer: [/Example domains/i, /https:\/\/example\.test\/help\/example-domains/],
    expectedNewTabs: 1,
  },
  {
    name: 'cheapest-within-category',
    startUrl: 'https://shop.example.test/catalog',
    expectedUrl: 'https://shop.example.test/catalog',
    expectedNewTabs: 0,
    pages: {
      'https://shop.example.test/catalog': {
        title: 'Catalog',
        markdown:
          '# Catalog\nComplete catalog, prices in USD:\n- Battery holder — $1 — category accessories — https://shop.example.test/holder\n- Pocket Thermometer — $9 — category thermometers — https://shop.example.test/pocket\n- Lab Thermometer — $25 — category thermometers — https://shop.example.test/lab',
      },
    },
    task: 'Find the cheapest thermometer in the current shop catalog. Return name, USD price and product URL. Stay on this shop; accessories are not thermometers.',
    rubric:
      'Selects Pocket Thermometer for USD 9 with its product URL. Does not substitute the cheaper battery holder or another shop. Does not invent stock or shipping information.',
    requiredAnswer: [/Pocket Thermometer/i, /(?:\$\s*9|9\s*(?:USD|dollars))/i, /https:\/\/shop\.example\.test\/pocket/],
  },
  {
    name: 'ambiguous-request-is-not-success',
    startUrl: source,
    pages,
    expectedUrl: source,
    task: 'Find the cheapest pribor at Zenith Electro. I have not specified a website or what type of device I mean. If you cannot establish those, ask me to clarify; do not substitute a shop or product.',
    rubric:
      'Explains that the shop URL and product category are unresolved and asks for clarification. Does not assert a cheapest product or pretend the shopping task is completed. An honest incomplete result is the expected behavior.',
    requiredAnswer: [/\?|clarif|уточн/i],
    expectedNewTabs: 0,
    expectedFailure: true,
  },
];

/** Browser boundary fixture; graph, prompts, completion and navigation actions stay real. */
export function createTaskFixture(scenario: TaskFixture, llm: BaseChatModel) {
  let url = scenario.startUrl;
  let tabId = 41;
  let newTabs = 0;
  const observed = new Set<string>();
  const evidence: Array<[string, string]> = [];
  const terminal: ExecutionState[] = [];
  const controller = new AbortController();
  const navigate = async (target: string) => {
    if (!scenario.pages[target]) {
      evidence.push(['navigation rejected', target]);
      throw new Error('URL is not in this controlled fixture. Use the observed links.');
    }
    url = target;
    evidence.push(['navigate', url]);
  };
  const read = () => {
    observed.add(url);
    const page = scenario.pages[url];
    if (!evidence.some(([step]) => step === `read ${url}`)) evidence.push([`read ${url}`, page.markdown]);
    return page;
  };
  const context = {
    taskId: `model-eval-${scenario.name}`,
    controller,
    stopped: false,
    finalAnswer: null,
    options: { maxSteps: 12, maxFailures: 2, includeAttributes: [] },
    browserContext: {
      agentTabId: () => tabId,
      getConfig: () => ({ deniedUrls: [] }),
      getState: async () => {
        const page = read();
        return {
          tabId,
          url,
          title: page.title,
          tabs: [],
          pageText: page.markdown,
          elementTree: { clickableElementsToString: () => '' },
        };
      },
      navigateTo: navigate,
      openTab: async (target: string) => {
        await navigate(target);
        newTabs++;
        tabId++;
        const status = scenario.slowOpen ? 'loading' : 'ready';
        evidence.push(['open_tab', JSON.stringify({ tabId, status })]);
        return { tabId, status };
      },
    },
    emitEvent: async (_actor: Actors, state: ExecutionState) => {
      if ([ExecutionState.TASK_OK, ExecutionState.TASK_FAIL, ExecutionState.TASK_CANCEL].includes(state))
        terminal.push(state);
    },
  } as unknown as AgentContext;
  const actions = new ActionBuilder(context, llm)
    .buildDefaultActions()
    .filter(action => ['task_complete', 'go_to_url', 'open_tab'].includes(action.name()));
  actions.push(
    new Action(
      async () =>
        new ActionResult({ extractedContent: 'Fixture page ready; inspect the current tab.', includeInMemory: true }),
      waitActionSchema,
    ),
  );
  actions.push(
    new Action(
      async () => new ActionResult({ extractedContent: wrapUntrustedContent(read().markdown), includeInMemory: true }),
      extractPageMarkdownActionSchema,
    ),
  );
  const assertions = (answer: string, error: string | null): HardAssertion[] => [
    {
      description: 'Expected terminal outcome exactly once',
      passed:
        terminal.length === 1 &&
        (scenario.expectedFailure
          ? error !== null && terminal[0] === ExecutionState.TASK_FAIL
          : error === null && terminal[0] === ExecutionState.TASK_OK),
    },
    { description: 'Required page was observed', passed: observed.has(scenario.expectedUrl) },
    { description: 'Exact requested number of new tabs', passed: newTabs === scenario.expectedNewTabs },
    ...scenario.requiredAnswer.map(pattern => ({
      description: `Answer satisfies ${pattern}`,
      passed: pattern.test(answer),
    })),
  ];
  return { context, actions, evidence, assertions };
}
