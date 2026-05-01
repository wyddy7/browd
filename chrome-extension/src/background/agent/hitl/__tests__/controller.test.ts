import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HITLController } from '../controller';
import type { HITLRequest, HITLDecision } from '../types';

function makeRequest(id: string): HITLRequest {
  return {
    id,
    reason: 'sensitive_action',
    pendingAction: { click_element: { index: 9, intent: 'Click submit' } },
    context: { summary: 'Submit application to Rubius', risk: 'high', confidence: 0.9 },
  };
}

describe('HITLController', () => {
  let sendMessage: ReturnType<typeof vi.fn>;
  let controller: HITLController;

  beforeEach(() => {
    sendMessage = vi.fn();
    controller = new HITLController(sendMessage);
  });

  it('approve: resolves promise with approve decision', async () => {
    const req = makeRequest('req-1');
    const decisionPromise = controller.requestDecision(req);

    // Simulate user clicking "Approve" in side-panel
    const decision: HITLDecision = { type: 'approve' };
    controller.submitDecision('req-1', decision);

    const result = await decisionPromise;
    expect(result.type).toBe('approve');
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('reject: resolves with reject decision carrying message', async () => {
    const req = makeRequest('req-2');
    const decisionPromise = controller.requestDecision(req);

    controller.submitDecision('req-2', { type: 'reject', message: 'Phone field is empty' });

    const result = await decisionPromise;
    expect(result.type).toBe('reject');
    expect((result as Extract<HITLDecision, { type: 'reject' }>).message).toBe('Phone field is empty');
  });

  it('edit: resolves with edited action args', async () => {
    const req = makeRequest('req-3');
    const decisionPromise = controller.requestDecision(req);

    const edited = { fill_field_by_label: { label: 'Email', value: 'corrected@test.com' } };
    controller.submitDecision('req-3', { type: 'edit', editedAction: edited });

    const result = (await decisionPromise) as Extract<HITLDecision, { type: 'edit' }>;
    expect(result.type).toBe('edit');
    expect(result.editedAction).toEqual(edited);
  });

  it('answer: resolves with user text answer', async () => {
    const req = makeRequest('req-4');
    const decisionPromise = controller.requestDecision(req);

    controller.submitDecision('req-4', { type: 'answer', answer: 'B2 Intermediate' });

    const result = (await decisionPromise) as Extract<HITLDecision, { type: 'answer' }>;
    expect(result.type).toBe('answer');
    expect(result.answer).toBe('B2 Intermediate');
  });

  it('submitDecision returns false for unknown id', () => {
    const ok = controller.submitDecision('nonexistent', { type: 'approve' });
    expect(ok).toBe(false);
  });

  it('isWaiting: true while pending, false after decision', async () => {
    const req = makeRequest('req-5');
    const p = controller.requestDecision(req);
    expect(controller.isWaiting()).toBe(true);

    controller.submitDecision('req-5', { type: 'approve' });
    await p;
    expect(controller.isWaiting()).toBe(false);
  });

  it('cancelAll: rejects all pending promises', async () => {
    const req1 = makeRequest('req-6');
    const req2 = makeRequest('req-7');
    const p1 = controller.requestDecision(req1);
    const p2 = controller.requestDecision(req2);

    controller.cancelAll();

    await expect(p1).rejects.toThrow('cancelled');
    await expect(p2).rejects.toThrow('cancelled');
    expect(controller.isWaiting()).toBe(false);
  });

  it('formatDecisionForMemory: produces correct strings for each type', () => {
    const req = makeRequest('req-m');
    expect(HITLController.formatDecisionForMemory({ type: 'approve' }, req)).toContain('[HITL] User approved');
    expect(HITLController.formatDecisionForMemory({ type: 'reject', message: 'reason' }, req)).toContain('rejected');
    expect(HITLController.formatDecisionForMemory({ type: 'edit', editedAction: {} }, req)).toContain('edited');
    expect(HITLController.formatDecisionForMemory({ type: 'answer', answer: 'ok' }, req)).toContain('answered');
  });
});
