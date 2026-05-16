import { describe, it, expect, vi } from 'vitest';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { ActionBuilder, Action } from '../builder';
import type { AgentContext } from '../../types';

// T2f-tab-iso (supersedes T2k-tab-follow): click_at and type_at MUST
// NOT auto-switch to side-effect new tabs (target="_blank", window.open).
// The old auto-switch promoted the new tab to _agentTabId via context.ts
// T2o-agent-tab-follow, after which the LLM could close its own anchor
// and crash with "agent tab no longer reachable". Contract: agent stays
// on its anchored tab; new tabs surface in extractedContent with an
// explicit take_over_user_tab hint, and only enter the agent via that
// action. Verified in test31 (Shutterstock side-tab → agent self-closed).

function makeContext(
  tabSequence: number[][],
  page: {
    clickAtImageCoord?: ReturnType<typeof vi.fn>;
    typeAtImageCoord?: ReturnType<typeof vi.fn>;
    readClickSignature?: ReturnType<typeof vi.fn>;
  },
) {
  const getAllTabIds = vi.fn();
  for (const ids of tabSequence) getAllTabIds.mockResolvedValueOnce(new Set(ids));
  const switchTab = vi.fn().mockResolvedValue(undefined);
  const ctx = {
    browserContext: {
      getCurrentPage: vi.fn().mockResolvedValue({
        readClickSignature:
          page.readClickSignature ?? vi.fn().mockResolvedValue({ url: 'u', scrollY: 0, domHash: 'h' }),
        clickAtImageCoord: page.clickAtImageCoord,
        typeAtImageCoord: page.typeAtImageCoord,
      }),
      getAllTabIds,
      switchTab,
    },
    emitEvent: vi.fn().mockResolvedValue(undefined),
    options: { useVision: false },
  } as unknown as AgentContext;
  return { ctx, getAllTabIds, switchTab };
}

function findAction(builder: ActionBuilder, name: string): Action {
  const actions = builder.buildDefaultActions();
  const found = actions.find(a => a.name() === name);
  if (!found) throw new Error(`action ${name} not built`);
  return found;
}

describe('click_at / type_at — T2f-tab-iso (no auto-switch on side-effect tab)', () => {
  it('click_at reports new tab id WITHOUT auto-switching when one opens', async () => {
    const clickAtImageCoord = vi.fn().mockResolvedValue({ cssX: 10, cssY: 20, vw: 800, vh: 600 });
    const { ctx, getAllTabIds, switchTab } = makeContext([[1], [1, 99]], { clickAtImageCoord });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = new ActionBuilder(ctx, {} as any);
    const action = findAction(builder, 'click_at');
    const result = await action.call({ intent: '', x: 10, y: 20 });
    expect(getAllTabIds).toHaveBeenCalledTimes(2);
    // Contract: NO auto-switch. Agent stays on its anchored tab.
    expect(switchTab).not.toHaveBeenCalled();
    expect(result.error).toBeFalsy();
    // Surfaces the new tab id and the explicit take-over hint so the LLM
    // makes the cross-over decision on the next turn.
    expect(result.extractedContent).toContain('new tab opened');
    expect(result.extractedContent).toContain('id=99');
    expect(result.extractedContent).toContain('take_over_user_tab(99');
  });

  it('type_at reports new tab id WITHOUT auto-switching when typing spawns one', async () => {
    const typeAtImageCoord = vi.fn().mockResolvedValue({ cssX: 5, cssY: 6 });
    const { ctx, switchTab } = makeContext([[1], [1, 42]], { typeAtImageCoord });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = new ActionBuilder(ctx, {} as any);
    const action = findAction(builder, 'type_at');
    const result = await action.call({ intent: '', x: 5, y: 6, text: 'hi' });
    expect(switchTab).not.toHaveBeenCalled();
    expect(result.extractedContent).toContain('new tab opened');
    expect(result.extractedContent).toContain('id=42');
    expect(result.extractedContent).toContain('take_over_user_tab(42');
  });
});
