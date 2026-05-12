import { describe, it, expect, vi } from 'vitest';

vi.mock('@src/background/log', () => ({
  createLogger: () => ({ warning: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));

import { ActionBuilder, Action } from '../builder';
import type { AgentContext } from '../../types';

// T2k-tab-follow: click_at and type_at must mirror click_element's
// snapshot-tab-ids → switchTab(newTabId) pattern so target="_blank"
// clicks (and rare typing-spawns-tab cases) don't loop on the stale
// original page.

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

describe('click_at / type_at — T2k-tab-follow', () => {
  it('click_at switches to new tab when one opens and reports it in extractedContent', async () => {
    const clickAtImageCoord = vi.fn().mockResolvedValue({ cssX: 10, cssY: 20, vw: 800, vh: 600 });
    const { ctx, getAllTabIds, switchTab } = makeContext([[1], [1, 99]], { clickAtImageCoord });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = new ActionBuilder(ctx, {} as any);
    const action = findAction(builder, 'click_at');
    const result = await action.call({ intent: '', x: 10, y: 20 });
    expect(getAllTabIds).toHaveBeenCalledTimes(2);
    expect(switchTab).toHaveBeenCalledWith(99);
    expect(result.error).toBeFalsy();
    expect(result.extractedContent).toContain('new tab opened');
    expect(result.extractedContent).toContain('tabId=99');
  });

  it('type_at switches to new tab when typing spawns one', async () => {
    const typeAtImageCoord = vi.fn().mockResolvedValue({ cssX: 5, cssY: 6 });
    const { ctx, switchTab } = makeContext([[1], [1, 42]], { typeAtImageCoord });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const builder = new ActionBuilder(ctx, {} as any);
    const action = findAction(builder, 'type_at');
    const result = await action.call({ intent: '', x: 5, y: 6, text: 'hi' });
    expect(switchTab).toHaveBeenCalledWith(42);
    expect(result.extractedContent).toContain('new tab opened');
    expect(result.extractedContent).toContain('tabId=42');
  });
});
