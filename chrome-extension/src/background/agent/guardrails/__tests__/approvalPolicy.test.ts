import { describe, it, expect } from 'vitest';
import * as actionSchemas from '../../actions/schemas';
import {
  checkApproval,
  INTERACTION_ACTIONS,
  SELF_GATED_ACTIONS,
  mayNeedPageState,
  isSensitiveField,
} from '../approvalPolicy';

/** Every action name the real registry exposes. */
const REAL_ACTION_NAMES = new Set(
  Object.values(actionSchemas)
    .map(s => (s && typeof s === 'object' ? (s as { name?: unknown }).name : undefined))
    .filter((name): name is string => typeof name === 'string'),
);

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

  // --- Layer 1: name + args. The model cannot reword its way past these. ---

  describe('layer 1 — gate does not depend on model-authored intent', () => {
    it('send_keys Enter → approval even when the intent reads harmless', () => {
      const d = checkApproval('send_keys', { keys: 'Enter', intent: 'move to the next field' }, 'questionnaire');
      expect(d.requiresApproval).toBe(true);
      expect(d.risk).toBe('high');
      expect(d.summary).toMatch(/submits the focused form/i);
    });

    it('send_keys Tab → no approval (does not submit)', () => {
      const d = checkApproval('send_keys', { keys: 'Tab', intent: 'move to the next field' }, 'questionnaire');
      expect(d.requiresApproval).toBe(false);
    });

    it('input_text into a password field → approval (was only covered for fill_field_by_label)', () => {
      const d = checkApproval('input_text', { label: 'Пароль', text: 'hunter2', intent: 'type it' }, 'idle');
      expect(d.requiresApproval).toBe(true);
      expect(d.risk).toBe('high');
    });

    it('type_at into a card-number field → approval', () => {
      const d = checkApproval('type_at', { label: 'Card number', text: '4111', intent: 'fill' }, 'content_page');
      expect(d.requiresApproval).toBe(true);
    });
  });

  // --- Layer 2: the coordinate hole this change closes. ---

  describe('layer 2 — coordinate actions no longer bypass the state gate', () => {
    it.each(['click_at', 'type_at', 'drag_at', 'send_keys', 'input_text', 'select_dropdown_option'])(
      '%s in ready_to_submit → approval required',
      action => {
        const d = checkApproval(action, { intent: 'proceed' }, 'ready_to_submit');
        expect(d.requiresApproval).toBe(true);
        expect(d.risk).toBe('high');
      },
    );

    it('read-only action in ready_to_submit → still no approval', () => {
      const d = checkApproval('scroll_to_bottom', { intent: 'look further down' }, 'ready_to_submit');
      expect(d.requiresApproval).toBe(false);
    });
  });

  // --- Self-gated actions must not prompt twice. ---

  describe('self-gated actions', () => {
    it.each([...SELF_GATED_ACTIONS])('%s → policy stays silent (it prompts on its own path)', action => {
      const d = checkApproval(action, { intent: 'submit the application' }, 'ready_to_submit');
      expect(d.requiresApproval).toBe(false);
    });
  });

  // --- Registry consistency: catches the phantom-name class of bug. ---

  describe('registry consistency', () => {
    it('every gated action name exists in the real action registry', () => {
      const gated = [...INTERACTION_ACTIONS, ...SELF_GATED_ACTIONS];
      const phantom = gated.filter(name => !REAL_ACTION_NAMES.has(name));
      expect(phantom).toEqual([]);
    });

    it('mayNeedPageState is true for interaction actions and false for read-only ones', () => {
      expect(mayNeedPageState('click_at')).toBe(true);
      expect(mayNeedPageState('web_search')).toBe(false);
      expect(mayNeedPageState('scroll_to_top')).toBe(false);
    });
  });
});

describe('isSensitiveField — words, not substrings', () => {
  it.each([
    ['shipping-address', false],
    ['businessName', false],
    ['spinner', false],
    ['email', false],
    ['cc-number', true],
    ['cc-csc', true],
    ['one-time-code', true],
    ['current-password', true],
    ['Card number', true],
    ['Пароль', true],
    ['Номер карты', true],
  ])('%s → %s', (label, expected) => {
    expect(isSensitiveField(label)).toBe(expected);
  });
});
