import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { Action } from '../../actions/builder';
import { ActionResult } from '../../types';
import { actionToTool, type ApprovalGate, type DuplicateGuardState } from '../langGraphAdapter';

/**
 * T-hitl-unified — the approval gate is the third guard in `actionToTool`,
 * alongside the tool-call budget (T2g) and the duplicate guard (T2f-final-fix).
 *
 * browd/CLAUDE.md § Caskad halt rule requires that any new guard ships with a
 * test exercising its interaction with at least one existing guard — the
 * previous round of guards passed in isolation and suffocated the agent in
 * combination. The `blocked earlier` cases below are exactly that test: a call
 * already stopped by budget or dup must never reach the user as a prompt.
 */

function makeAction(name: string, onCall: () => void) {
  return new Action(
    async () => {
      onCall();
      return new ActionResult({ extractedContent: 'did the thing', includeInMemory: true });
    },
    {
      name,
      description: `test action ${name}`,
      schema: z.object({ intent: z.string().optional(), keys: z.string().optional() }),
    },
  );
}

const approve: ApprovalGate = async () => ({ proceed: true });
const reject: ApprovalGate = async actionName => ({
  proceed: false,
  message: `Error: the user rejected "${actionName}".`,
});

describe('langGraphAdapter — approval gate', () => {
  it('approved → the underlying action runs', async () => {
    const ran = vi.fn();
    const tool = actionToTool(makeAction('click_element', ran), undefined, undefined, approve);
    const out = await tool.invoke({ intent: 'submit the form' });
    expect(ran).toHaveBeenCalledTimes(1);
    expect(String(out)).toContain('did the thing');
  });

  it('rejected → the action never runs and the model is told why', async () => {
    const ran = vi.fn();
    const tool = actionToTool(makeAction('click_element', ran), undefined, undefined, reject);
    const out = await tool.invoke({ intent: 'submit the form' });
    expect(ran).not.toHaveBeenCalled();
    expect(String(out)).toContain('rejected');
  });

  it('no gate supplied → behaviour is unchanged (legacy/passthrough)', async () => {
    const ran = vi.fn();
    const tool = actionToTool(makeAction('click_element', ran));
    await tool.invoke({ intent: 'submit the form' });
    expect(ran).toHaveBeenCalledTimes(1);
  });

  // --- Caskad-required: interaction with the guards that already exist. ---

  it('budget-blocked call never reaches the approval gate (no pointless prompt)', async () => {
    const ran = vi.fn();
    const gate = vi.fn(approve);
    const budget = { counters: { web_search: 5 }, limits: { web_search: 5 } };
    const tool = actionToTool(makeAction('web_search', ran), budget, undefined, gate);

    const out = await tool.invoke({ intent: 'search again' });

    expect(String(out)).toContain('budget exhausted');
    expect(gate).not.toHaveBeenCalled();
    expect(ran).not.toHaveBeenCalled();
  });

  it('dup-blocked call never reaches the approval gate', async () => {
    const ran = vi.fn();
    const gate = vi.fn(approve);
    const dupGuard: DuplicateGuardState = { recentKeys: [] };
    const tool = actionToTool(makeAction('click_element', ran), undefined, dupGuard, gate);

    // Three identical calls: the third trips the 3-in-last-5 window.
    await tool.invoke({ intent: 'same thing' });
    await tool.invoke({ intent: 'same thing' });
    const third = await tool.invoke({ intent: 'same thing' });

    expect(String(third)).toMatch(/BLOCKED|repeat|identical|same/i);
    // First two were approved and ran; the blocked third must not prompt again.
    expect(gate).toHaveBeenCalledTimes(2);
    expect(ran).toHaveBeenCalledTimes(2);
  });

  it('budget guard still counts a call that the user then rejects', async () => {
    const ran = vi.fn();
    const budget: { counters: Record<string, number>; limits: Record<string, number> } = {
      counters: {},
      limits: { web_search: 2 },
    };
    const tool = actionToTool(makeAction('web_search', ran), budget, undefined, reject);

    await tool.invoke({ intent: 'search' });

    // Budget is incremented before the gate runs — a rejected call still
    // consumes its slot, so a rejection loop cannot spin forever.
    expect(budget.counters.web_search).toBe(1);
    expect(ran).not.toHaveBeenCalled();
  });
});
