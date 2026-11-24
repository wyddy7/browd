/**
 * Approval memory — one "yes" must cover the retries of the same intent.
 *
 * Regression origin (2026-08-06): the gate had no memory, so when an approved
 * action failed and the agent retried it, the user was asked again. In the
 * recorded run someone pressed Approve three times for one password field
 * while the underlying action kept failing for an unrelated reason.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
vi.mock('webextension-polyfill', () => ({ default: {} }));
const finder = vi.hoisted(() => ({ result: null as unknown }));
vi.mock('@src/background/browser/dom/fieldFinder', () => ({ findFieldByLabel: () => finder.result }));
const settings = vi.hoisted(() => ({ permissionMode: 'default' as 'default' | 'full' }));
vi.mock('@extension/storage', () => ({
  generalSettingsStore: { getSettings: async () => ({ permissionMode: settings.permissionMode }) },
}));

import { createApprovalGate } from '../approvalGate';

type Decision = { type: 'approve' } | { type: 'reject'; message: string };

function makeContext(decisions: Decision[]) {
  const requestDecision = vi.fn(async () => decisions.shift() ?? { type: 'approve' });
  const context = {
    hitlController: { requestDecision },
    browserContext: {
      agentTabId: () => 11,
      getState: async () => ({ url: 'https://example.com/apply', title: 'Apply' }),
    },
    messageManager: { addHITLDecision: vi.fn() },
    emitEvent: vi.fn(),
  };
  return { context, requestDecision };
}

beforeEach(() => {
  settings.permissionMode = 'default';
  finder.result = null;
  (globalThis as unknown as { chrome: unknown }).chrome = {
    tabs: { get: vi.fn().mockResolvedValue({ id: 11, url: 'https://example.com/apply' }) },
  };
});

// A sensitive INTENT on a click trips the policy without needing page
// classification, so these tests never touch browser state.
//
// Deliberately not a credential field: those are now refused outright
// (`handOff`), never offered for approval, so they cannot exercise the memory.
const SENSITIVE = { index: 1, intent: 'submit the application' };

describe('createApprovalGate — approval memory', () => {
  it('asks once, then auto-approves the identical retry', async () => {
    const { context, requestDecision } = makeContext([{ type: 'approve' }]);
    const gate = createApprovalGate(context as never)!;

    const first = await gate('click_element', SENSITIVE);
    const second = await gate('click_element', SENSITIVE);
    const third = await gate('click_element', SENSITIVE);

    expect(first).toEqual({ proceed: true });
    expect(second).toEqual({ proceed: true });
    expect(third).toEqual({ proceed: true });
    expect(requestDecision).toHaveBeenCalledTimes(1);
  });

  it('a reworded intent still counts as the same action (intent is model-authored)', async () => {
    const { context, requestDecision } = makeContext([{ type: 'approve' }]);
    const gate = createApprovalGate(context as never)!;

    await gate('click_element', SENSITIVE);
    await gate('click_element', { ...SENSITIVE, intent: 'submit the form now, please' });

    expect(requestDecision).toHaveBeenCalledTimes(1);
  });

  it('different arguments ask again — approval does not generalise', async () => {
    const { context, requestDecision } = makeContext([{ type: 'approve' }, { type: 'approve' }]);
    const gate = createApprovalGate(context as never)!;

    await gate('click_element', SENSITIVE);
    await gate('click_element', { ...SENSITIVE, keys: 'other' });

    expect(requestDecision).toHaveBeenCalledTimes(2);
  });

  it('a different action asks again even with identical arguments', async () => {
    const { context, requestDecision } = makeContext([{ type: 'approve' }, { type: 'approve' }]);
    const gate = createApprovalGate(context as never)!;

    await gate('click_element', SENSITIVE);
    await gate('click_at', SENSITIVE);

    expect(requestDecision).toHaveBeenCalledTimes(2);
  });

  it('a rejection is NOT cached — the next attempt asks again', async () => {
    const { context, requestDecision } = makeContext([{ type: 'reject', message: 'no thanks' }, { type: 'approve' }]);
    const gate = createApprovalGate(context as never)!;

    const first = await gate('click_element', SENSITIVE);
    expect(first.proceed).toBe(false);

    const second = await gate('click_element', SENSITIVE);
    expect(second).toEqual({ proceed: true });
    expect(requestDecision).toHaveBeenCalledTimes(2);
  });

  it('a different host asks again — approval is scoped to the page', async () => {
    const { context, requestDecision } = makeContext([{ type: 'approve' }, { type: 'approve' }]);
    const gate = createApprovalGate(context as never)!;

    await gate('click_element', SENSITIVE);
    (globalThis as unknown as { chrome: { tabs: { get: ReturnType<typeof vi.fn> } } }).chrome.tabs.get = vi
      .fn()
      .mockResolvedValue({ id: 11, url: 'https://evil.example.net/apply' });
    await gate('click_element', SENSITIVE);

    expect(requestDecision).toHaveBeenCalledTimes(2);
  });

  it('auto-approval is announced, not silent', async () => {
    const { context } = makeContext([{ type: 'approve' }]);
    const gate = createApprovalGate(context as never)!;

    await gate('click_element', SENSITIVE);
    context.emitEvent.mockClear();
    await gate('click_element', SENSITIVE);

    expect(context.emitEvent).toHaveBeenCalled();
    const emitted = context.emitEvent.mock.calls.map(c => String(c[2])).join(' ');
    expect(emitted).toMatch(/Auto-approved retry/);
  });
});

describe('createApprovalGate — safety invariants', () => {
  it('no HITL controller → no gate at all (legacy/dev behaviour unchanged)', () => {
    expect(createApprovalGate({ hitlController: undefined } as never)).toBeUndefined();
  });

  it('an unanswered prompt fails CLOSED and is not remembered', async () => {
    const requestDecision = vi.fn().mockRejectedValue(new Error('HITL timeout after 300s'));
    const context = {
      hitlController: { requestDecision },
      browserContext: { agentTabId: () => 11, getState: async () => ({ url: '', title: '' }) },
      messageManager: { addHITLDecision: vi.fn() },
      emitEvent: vi.fn(),
    };
    const gate = createApprovalGate(context as never)!;

    const first = await gate('click_element', SENSITIVE);
    expect(first.proceed).toBe(false);
    expect('message' in first && first.message).toMatch(/was not granted/);

    // A timeout must not leave a cached approval behind.
    const second = await gate('click_element', SENSITIVE);
    expect(second.proceed).toBe(false);
    expect(requestDecision).toHaveBeenCalledTimes(2);
  });

  // Owner decision 2026-08-06: an agent typing a password is not something to
  // approve, it is something not to do. Refusing also stops us summoning the
  // password-manager iframe that force-detaches the debugger from the tab.
  it('a credential field is REFUSED without ever asking the user', async () => {
    const { context, requestDecision } = makeContext([]);
    const gate = createApprovalGate(context as never)!;

    const out = await gate('fill_field_by_label', { label: 'Password', value: 'hunter2', intent: 'log in' });

    expect(out.proceed).toBe(false);
    expect(requestDecision).not.toHaveBeenCalled();
    expect('message' in out && out.message).toMatch(/does not type credentials/i);
    expect('message' in out && out.message).toMatch(/Do not retry this field/i);
  });

  it('input_text by INDEX into type=password is refused (label read from the element)', async () => {
    const { context, requestDecision } = makeContext([]);
    const pw = { tagName: 'input', attributes: { type: 'password', 'aria-label': 'Password' }, highlightIndex: 3 };
    const email = { tagName: 'input', attributes: { type: 'email', name: 'email' }, highlightIndex: 1 };
    (context.browserContext as unknown as { getState: unknown }).getState = async () => ({
      url: 'https://example.com/signup',
      title: 'Sign up',
      selectorMap: new Map<number, unknown>([
        [1, email],
        [3, pw],
      ]),
    });
    const gate = createApprovalGate(context as never)!;

    const refused = await gate('input_text', { index: 3, text: 'hunter2', intent: 'enter the password' });
    expect(refused.proceed).toBe(false);
    expect(requestDecision).not.toHaveBeenCalled();

    const allowed = await gate('input_text', { index: 1, text: 'sam@example.com', intent: 'enter the email' });
    expect(allowed.proceed).toBe(true);
  });

  it.each([
    ['fill_field_by_label', 'Password'],
    ['input_text', 'CVV'],
    ['type_at', 'Card number'],
  ])('%s into "%s" is refused, not queued for approval', async (action, label) => {
    const { context, requestDecision } = makeContext([]);
    const gate = createApprovalGate(context as never)!;
    const out = await gate(action, { label, value: 'x', intent: 'fill it' });
    expect(out.proceed).toBe(false);
    expect(requestDecision).not.toHaveBeenCalled();
  });

  it('refusal is not cached as a decision — it is a standing rule', async () => {
    const { context, requestDecision } = makeContext([]);
    const gate = createApprovalGate(context as never)!;
    const args = { label: 'Password', value: 'hunter2', intent: 'log in' };

    const first = await gate('fill_field_by_label', args);
    const second = await gate('fill_field_by_label', args);

    expect(first.proceed).toBe(false);
    expect(second.proceed).toBe(false);
    expect(requestDecision).not.toHaveBeenCalled();
  });

  it('a harmless action is never gated', async () => {
    const { context, requestDecision } = makeContext([]);
    const gate = createApprovalGate(context as never)!;
    const out = await gate('web_search', { query: 'weather', intent: 'look it up' });
    expect(out).toEqual({ proceed: true });
    expect(requestDecision).not.toHaveBeenCalled();
  });
});

// --- Hardening after the independent review of PR #32 (2026-11-24) ---

type Node = {
  tagName: string;
  attributes: Record<string, string>;
  xpath: string;
  getAllTextTillNextClickableElement?: () => string;
};
const node = (tagName: string, attributes: Record<string, string>, xpath: string, text = ''): Node => ({
  tagName,
  attributes,
  xpath,
  getAllTextTillNextClickableElement: () => text,
});

function withPage(ctx: ReturnType<typeof makeContext>['context'], map: Map<number, Node>, underPoint: unknown = null) {
  (ctx.browserContext as unknown as Record<string, unknown>).getState = async () => ({
    url: 'https://shop.example/checkout',
    title: 'Checkout',
    selectorMap: map,
    elementTree: { children: [], attributes: {}, tagName: 'body' },
  });
  (ctx.browserContext as unknown as Record<string, unknown>).getCurrentPage = async () => ({
    describeElementAtImageCoord: async () => underPoint,
  });
}

describe('approval gate — targets are read from the page', () => {
  it('type_at over a password input is refused (real schema: x, y, text — no label)', async () => {
    const { context, requestDecision } = makeContext([]);
    withPage(context, new Map(), {
      tag: 'input',
      attributes: { type: 'password' },
      text: '',
      path: 'form[0]/input[1]',
    });
    const gate = createApprovalGate(context as never)!;
    const out = await gate('type_at', { intent: 'type it', x: 100, y: 200, text: 'hunter2' });
    expect(out.proceed).toBe(false);
    expect(requestDecision).not.toHaveBeenCalled();
  });

  it('fill_field_by_label with a harmless model label is refused when the field it finds is a password', async () => {
    const { context, requestDecision } = makeContext([]);
    withPage(context, new Map());
    finder.result = node('input', { type: 'password', name: 'pw' }, 'form/input[2]');
    const gate = createApprovalGate(context as never)!;
    const out = await gate('fill_field_by_label', { label: 'field 2', value: 'hunter2', intent: 'fill' });
    expect(out.proceed).toBe(false);
    expect(requestDecision).not.toHaveBeenCalled();
  });

  it('type_at over a search box runs without a prompt', async () => {
    const { context, requestDecision } = makeContext([]);
    withPage(context, new Map(), {
      tag: 'input',
      attributes: { type: 'search', name: 'q' },
      text: '',
      path: 'form[0]/input[0]',
    });
    const gate = createApprovalGate(context as never)!;
    const out = await gate('type_at', { intent: 'search', x: 10, y: 20, text: 'shoes' });
    expect(out.proceed).toBe(true);
    expect(requestDecision).not.toHaveBeenCalled();
  });

  it('a field-writing action whose target cannot be read asks instead of passing', async () => {
    const { context, requestDecision } = makeContext([{ type: 'reject', message: 'no' }]);
    withPage(context, new Map(), null);
    const gate = createApprovalGate(context as never)!;
    const out = await gate('type_at', { intent: 'type', x: 1, y: 1, text: 'x' });
    expect(requestDecision).toHaveBeenCalledTimes(1);
    expect(out.proceed).toBe(false);
  });

  it('an approval of "Continue" does not carry over to "Place order" that got the same index', async () => {
    const { context, requestDecision } = makeContext([{ type: 'approve' }, { type: 'approve' }]);
    const gate = createApprovalGate(context as never)!;
    withPage(context, new Map([[12, node('button', { type: 'submit' }, 'form/button[1]', 'Continue')]]));
    await gate('click_element', { index: 12, intent: 'submit the application' });
    withPage(context, new Map([[12, node('button', { type: 'submit' }, 'form/button[2]', 'Place order')]]));
    await gate('click_element', { index: 12, intent: 'submit the application' });
    expect(requestDecision).toHaveBeenCalledTimes(2);
  });

  it('the same element under a new index is still remembered', async () => {
    const { context, requestDecision } = makeContext([{ type: 'approve' }]);
    const gate = createApprovalGate(context as never)!;
    const btn = node('button', { type: 'submit' }, 'form/button[1]', 'Continue');
    withPage(context, new Map([[12, btn]]));
    await gate('click_element', { index: 12, intent: 'submit the application' });
    withPage(context, new Map([[7, btn]]));
    const out = await gate('click_element', { index: 7, intent: 'submit the application' });
    expect(out.proceed).toBe(true);
    expect(requestDecision).toHaveBeenCalledTimes(1);
  });

  it('permissionMode=full skips the prompt but never the credential refusal', async () => {
    settings.permissionMode = 'full';
    const { context, requestDecision } = makeContext([]);
    withPage(context, new Map([[3, node('input', { type: 'password' }, 'form/input[1]')]]));
    const gate = createApprovalGate(context as never)!;
    const submit = await gate('click_element', { index: 9, intent: 'submit the application' });
    const pw = await gate('input_text', { index: 3, text: 'hunter2', intent: 'enter it' });
    expect(submit.proceed).toBe(true);
    expect(pw.proceed).toBe(false);
    expect(requestDecision).not.toHaveBeenCalled();
  });

  it('a neutral click on a form submit button asks (the element decides, not the intent)', async () => {
    const { context, requestDecision } = makeContext([{ type: 'reject', message: 'no' }]);
    withPage(context, new Map([[4, node('button', { type: 'submit' }, 'html/body/form/button', 'Create account')]]));
    const gate = createApprovalGate(context as never)!;
    const out = await gate('click_element', { index: 4, intent: 'click Create account' });
    expect(requestDecision).toHaveBeenCalledTimes(1);
    expect(out.proceed).toBe(false);
  });

  it('a search button and a plain link do not ask', async () => {
    const { context, requestDecision } = makeContext([]);
    withPage(
      context,
      new Map([
        [1, node('button', { type: 'submit' }, 'html/body/form/button', 'Search')],
        [2, node('a', {}, 'html/body/nav/a', 'Pricing')],
      ]),
    );
    const gate = createApprovalGate(context as never)!;
    expect((await gate('click_element', { index: 1, intent: 'look it up' })).proceed).toBe(true);
    expect((await gate('click_element', { index: 2, intent: 'open pricing' })).proceed).toBe(true);
    expect(requestDecision).not.toHaveBeenCalled();
  });
});
