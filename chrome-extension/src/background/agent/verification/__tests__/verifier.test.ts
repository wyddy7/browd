import { describe, it, expect, vi } from 'vitest';
import { Verifier, type VerifierDeps } from '../verifier';

function makeDeps(overrides?: Partial<VerifierDeps>): VerifierDeps {
  return {
    readFieldValue: vi.fn().mockResolvedValue(null),
    readScrollY: vi.fn().mockResolvedValue(0),
    readDomHash: vi.fn().mockResolvedValue('hash1'),
    ...overrides,
  };
}

describe('Verifier', () => {
  it('fill_field_by_label: ok when field value matches expected', async () => {
    const deps = makeDeps({ readFieldValue: vi.fn().mockResolvedValue('B2') });
    const v = new Verifier(deps);
    const result = await v.verify({
      actionName: 'fill_field_by_label',
      actionArgs: { label: 'Английский', value: 'B2', expectedValue: 'B2', xpath: '//textarea[@id="english"]' },
      tabId: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it('fill_field_by_label: fail when field value mismatches', async () => {
    const deps = makeDeps({ readFieldValue: vi.fn().mockResolvedValue('wrong value') });
    const v = new Verifier(deps);
    const result = await v.verify({
      actionName: 'fill_field_by_label',
      actionArgs: {
        label: 'Email',
        value: 'user@test.com',
        expectedValue: 'user@test.com',
        xpath: '//input[@name="email"]',
      },
      tabId: 1,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('mismatch');
  });

  it('fill_field_by_label: trusts without xpath (confidence 0.5)', async () => {
    const deps = makeDeps();
    const v = new Verifier(deps);
    const result = await v.verify({
      actionName: 'fill_field_by_label',
      actionArgs: { label: 'Email', value: 'x@x.com' },
      tabId: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.confidence).toBe(0.5);
  });

  it('click_element: ok when DOM hash changed', async () => {
    const deps = makeDeps();
    const v = new Verifier(deps);
    const result = await v.verify({
      actionName: 'click_element',
      actionArgs: { index: 9 },
      tabId: 1,
      domHashBefore: 'abc123',
      domHashAfter: 'def456',
    });
    expect(result.ok).toBe(true);
    expect(result.reason).toContain('DOM changed');
  });

  it('click_element: fail when DOM unchanged', async () => {
    const deps = makeDeps();
    const v = new Verifier(deps);
    const result = await v.verify({
      actionName: 'click_element',
      actionArgs: { index: 9 },
      tabId: 1,
      domHashBefore: 'same_hash',
      domHashAfter: 'same_hash',
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toContain('unchanged');
  });

  it('scroll_to_bottom: ok when scrollY changed', async () => {
    const deps = makeDeps({ readScrollY: vi.fn().mockResolvedValue(400) });
    const v = new Verifier(deps);
    const result = await v.verify({
      actionName: 'scroll_to_bottom',
      actionArgs: {},
      tabId: 1,
      scrollYBefore: 0,
    });
    expect(result.ok).toBe(true);
  });

  it('scroll_to_bottom: false but low confidence when scrollY unchanged (boundary case)', async () => {
    const deps = makeDeps({ readScrollY: vi.fn().mockResolvedValue(0) });
    const v = new Verifier(deps);
    const result = await v.verify({
      actionName: 'scroll_to_bottom',
      actionArgs: {},
      tabId: 1,
      scrollYBefore: 0,
    });
    expect(result.ok).toBe(false);
    expect(result.confidence).toBeLessThan(0.8); // boundary case — not a hard fail
  });

  it('done action always returns ok', async () => {
    const deps = makeDeps();
    const v = new Verifier(deps);
    const result = await v.verify({
      actionName: 'done',
      actionArgs: { text: 'Task complete', success: true },
      tabId: 1,
    });
    expect(result.ok).toBe(true);
    expect(result.confidence).toBe(1.0);
  });

  it('toActionError: high-confidence failure → reasoning_failure', () => {
    const err = Verifier.toActionError(
      { ok: false, reason: 'mismatch', confidence: 0.9, evidence: [] },
      'fill_field_by_label',
    );
    expect(err.type).toBe('reasoning_failure');
    expect(err.retryable).toBe(false);
  });

  it('toActionError: low-confidence failure → transient', () => {
    const err = Verifier.toActionError(
      { ok: false, reason: 'uncertain', confidence: 0.5, evidence: [] },
      'scroll_to_bottom',
    );
    expect(err.type).toBe('transient');
    expect(err.retryable).toBe(true);
  });
});
