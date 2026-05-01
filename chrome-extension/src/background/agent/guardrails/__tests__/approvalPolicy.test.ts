import { describe, it, expect } from 'vitest';
import { checkApproval } from '../approvalPolicy';

describe('ApprovalPolicy', () => {
  it('safe click in idle state → no approval', () => {
    const d = checkApproval('click_element', { index: 5, intent: 'Click on the job title' }, 'idle');
    expect(d.requiresApproval).toBe(false);
  });

  it('click_element in ready_to_submit state → approval required (high risk)', () => {
    const d = checkApproval('click_element', { index: 9, intent: '' }, 'ready_to_submit');
    expect(d.requiresApproval).toBe(true);
    expect(d.risk).toBe('high');
    expect(d.reason).toBe('sensitive_action');
  });

  it('click_element in apply_modal state → approval required (high risk)', () => {
    const d = checkApproval('click_element', { index: 3, intent: 'click continue' }, 'apply_modal');
    expect(d.requiresApproval).toBe(true);
    expect(d.risk).toBe('high');
  });

  it('sensitive intent "submit" triggers approval', () => {
    const d = checkApproval('click_element', { index: 7, intent: 'Submit the application form' }, 'content_page');
    expect(d.requiresApproval).toBe(true);
    expect(d.reason).toBe('sensitive_action');
  });

  it('sensitive intent "отправить" triggers approval', () => {
    const d = checkApproval('click_element', { index: 7, intent: 'Отправить отклик' }, 'questionnaire');
    expect(d.requiresApproval).toBe(true);
  });

  it('fill_field_by_label for password field → approval required', () => {
    const d = checkApproval('fill_field_by_label', { label: 'Password', value: 'secret' }, 'idle');
    expect(d.requiresApproval).toBe(true);
    expect(d.risk).toBe('high');
  });

  it('fill_field_by_label for normal field → no approval', () => {
    const d = checkApproval('fill_field_by_label', { label: 'Английский язык', value: 'B2' }, 'questionnaire');
    expect(d.requiresApproval).toBe(false);
  });

  it('go_to_url → no approval', () => {
    const d = checkApproval('go_to_url', { intent: 'navigate', url: 'https://hh.ru' }, 'idle');
    expect(d.requiresApproval).toBe(false);
  });
});
