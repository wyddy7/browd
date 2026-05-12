import { describe, it, expect } from 'vitest';
import { GenericFormSkill } from '../genericFormSkill';
import type { FormModel } from '@src/background/browser/dom/forms';

function makeForm(fields: Array<{ label: string; required?: boolean }>): FormModel {
  return {
    fields: fields.map((f, i) => ({
      label: f.label,
      type: 'text' as const,
      value: '',
      required: f.required ?? false,
      xpathCandidates: [],
      highlightIndex: i + 1,
      labelSource: 'aria_label' as const,
    })),
    submitButtons: [],
    containerXpath: null,
  };
}

describe('GenericFormSkill', () => {
  it('returns email suggestion from profile', () => {
    const skill = new GenericFormSkill({ email: 'user@example.com' });
    const form = makeForm([{ label: 'Email' }]);
    const suggestions = skill.suggest([form]);
    expect(suggestions[0].value).toBe('user@example.com');
    expect(suggestions[0].confidence).toBe('high');
    expect(suggestions[0].source).toBe('profile');
  });

  it('returns github suggestion from profile', () => {
    const skill = new GenericFormSkill({ github: 'https://github.com/wyddy7' });
    const form = makeForm([{ label: 'GitHub репозиторий' }]);
    const suggestions = skill.suggest([form]);
    expect(suggestions[0].value).toBe('https://github.com/wyddy7');
    expect(suggestions[0].confidence).toBe('high');
  });

  it('returns telegram suggestion from profile', () => {
    const skill = new GenericFormSkill({ telegram: '@wyddy7' });
    const form = makeForm([{ label: 'Telegram' }]);
    const [s] = skill.suggest([form]);
    expect(s.value).toBe('@wyddy7');
  });

  it('returns low-confidence suggestion for required field with no match', () => {
    const skill = new GenericFormSkill({});
    const form = makeForm([{ label: 'Непонятный вопрос работодателя', required: true }]);
    const suggestions = skill.suggest([form]);
    expect(suggestions[0].confidence).toBe('low');
    expect(suggestions[0].source).toBe('none');
  });

  it('returns nothing for optional field with no match', () => {
    const skill = new GenericFormSkill({});
    const form = makeForm([{ label: 'Optional mystery field', required: false }]);
    const suggestions = skill.suggest([form]);
    expect(suggestions).toHaveLength(0);
  });

  it('shouldAutoFill: true for high/medium, false for low', () => {
    expect(
      GenericFormSkill.shouldAutoFill({ fieldLabel: 'x', value: 'y', confidence: 'high', source: 'profile' }),
    ).toBe(true);
    expect(
      GenericFormSkill.shouldAutoFill({ fieldLabel: 'x', value: 'y', confidence: 'medium', source: 'pattern' }),
    ).toBe(true);
    expect(GenericFormSkill.shouldAutoFill({ fieldLabel: 'x', value: '', confidence: 'low', source: 'none' })).toBe(
      false,
    );
  });
});
