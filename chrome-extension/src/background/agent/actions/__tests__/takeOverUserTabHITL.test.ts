import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { ActionBuilder, Action } from '../builder';
import type { AgentContext } from '../../types';
import type { HITLDecision, HITLRequest } from '../../hitl/types';

// T2s-2: take_over_user_tab MUST gate the take-over behind a HITL
// approval. Cross-isolation-boundary moves (agent tab group → user
// tab) without explicit user consent break the trust contract that
// T2s-1 established.

const TAB_ID = 42;

function stubChrome() {
  const chromeStub = {
    tabs: {
      get: vi
        .fn()
        .mockImplementation((id: number) =>
          Promise.resolve({ id, url: 'https://example.com/', title: 'Example', active: false }),
        ),
    },
  };
  vi.stubGlobal('chrome', chromeStub);
}

function makeContext(opts: {
  hitl?: { requestDecision: (req: HITLRequest) => Promise<HITLDecision> };
  takeOverTab?: ReturnType<typeof vi.fn>;
}) {
  const takeOverTab = opts.takeOverTab ?? vi.fn();
  const ctx = {
    browserContext: { takeOverTab },
    emitEvent: vi.fn().mockResolvedValue(undefined),
    options: { useVision: false },
    hitlController: opts.hitl,
  } as unknown as AgentContext;
  return { ctx, takeOverTab };
}

function findAction(builder: ActionBuilder, name: string): Action {
  const actions = builder.buildDefaultActions();
  const found = actions.find(a => a.name() === name);
  if (!found) throw new Error(`action ${name} not built`);
  return found;
}

describe('take_over_user_tab — T2s-2 HITL gating', () => {
  beforeEach(() => {
    stubChrome();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('approve → BrowserContext.takeOverTab is called and result is success', async () => {
    const requestDecision = vi.fn<(req: HITLRequest) => Promise<HITLDecision>>().mockResolvedValue({ type: 'approve' });
    const { ctx, takeOverTab } = makeContext({ hitl: { requestDecision } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = new ActionBuilder(ctx, {} as any);
    const action = findAction(builder, 'take_over_user_tab');

    const result = await action.call({ intent: '', tabId: TAB_ID, reason: 'user asked' });

    expect(requestDecision).toHaveBeenCalledTimes(1);
    const req = requestDecision.mock.calls[0]![0];
    expect(req.reason).toBe('take_over_request');
    expect(req.context.takeOverRequest).toEqual({
      tabId: TAB_ID,
      title: 'Example',
      url: 'https://example.com/',
      reason: 'user asked',
    });
    expect(takeOverTab).toHaveBeenCalledWith(TAB_ID);
    expect(result.error).toBeFalsy();
    expect(result.extractedContent).toContain('agent now operates in tab');
  });

  it('reject → takeOverTab NOT called, result has error with user message', async () => {
    const requestDecision = vi
      .fn<(req: HITLRequest) => Promise<HITLDecision>>()
      .mockResolvedValue({ type: 'reject', message: 'no thanks' });
    const { ctx, takeOverTab } = makeContext({ hitl: { requestDecision } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = new ActionBuilder(ctx, {} as any);
    const action = findAction(builder, 'take_over_user_tab');

    const result = await action.call({ intent: '', tabId: TAB_ID, reason: 'user asked' });

    expect(takeOverTab).not.toHaveBeenCalled();
    expect(result.error).toBeTruthy();
    expect(result.error).toContain('user refused');
    expect(result.error).toContain('no thanks');
  });

  it('HITL timeout (rejected promise) → takeOverTab NOT called, timeout-specific error', async () => {
    const requestDecision = vi
      .fn<(req: HITLRequest) => Promise<HITLDecision>>()
      .mockRejectedValue(new Error('HITL timeout after 300s for request hitl-takeover-xyz'));
    const { ctx, takeOverTab } = makeContext({ hitl: { requestDecision } });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = new ActionBuilder(ctx, {} as any);
    const action = findAction(builder, 'take_over_user_tab');

    const result = await action.call({ intent: '', tabId: TAB_ID, reason: 'user asked' });

    expect(takeOverTab).not.toHaveBeenCalled();
    expect(result.error).toBeTruthy();
    expect(result.error).toMatch(/did not respond within 5 minutes/);
  });

  it('hitlController undefined → falls back to direct take-over (legacy/test path)', async () => {
    const { ctx, takeOverTab } = makeContext({ hitl: undefined });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = new ActionBuilder(ctx, {} as any);
    const action = findAction(builder, 'take_over_user_tab');

    const result = await action.call({ intent: '', tabId: TAB_ID, reason: 'no hitl' });

    expect(takeOverTab).toHaveBeenCalledWith(TAB_ID);
    expect(result.error).toBeFalsy();
    expect(result.extractedContent).toContain('agent now operates in tab');
  });
});
