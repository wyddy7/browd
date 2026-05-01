import { describe, it, expect } from 'vitest';
import { HhApplySkill } from '../hhApplySkill';
import type { FormModel } from '@src/background/browser/dom/forms';

function makeForm(labels: string[]): FormModel {
  return {
    fields: labels.map((label, i) => ({
      label,
      type: 'textarea' as const,
      value: '',
      required: false,
      xpathCandidates: [],
      highlightIndex: i + 1,
      labelSource: 'sibling_text' as const,
    })),
    submitButtons: [],
    containerXpath: null,
  };
}

const profile = {
  github: 'https://github.com/wyddy7',
  portfolio: 'https://wyddy.tech',
  telegram: '@wyddy7',
  englishLevel: 'B2',
  badHabits: 'Вредных привычек нет.',
};

describe('HhApplySkill', () => {
  const skill = new HhApplySkill(profile);

  it('maps "Ваш уровень английского" to profile englishLevel', () => {
    const form = makeForm(['Ваш уровень английского языка']);
    const [s] = skill.suggest([form]);
    expect(s.value).toContain('B2');
    expect(s.confidence).toBe('high');
  });

  it('maps "Вредные привычки" to badHabits', () => {
    const form = makeForm(['Есть ли у вас вредные привычки?']);
    const [s] = skill.suggest([form]);
    expect(s.value).toBe('Вредных привычек нет.');
  });

  it('maps "Как вы узнали о вакансии" to hh.ru source', () => {
    const form = makeForm(['Как вы узнали о вакансии?']);
    const [s] = skill.suggest([form]);
    expect(s.value).toContain('hh.ru');
  });

  it('maps "GitHub репозиторий" from profile', () => {
    const form = makeForm(['Ссылка на GitHub репозиторий']);
    const [s] = skill.suggest([form]);
    expect(s.value).toBe('https://github.com/wyddy7');
  });

  it('maps "Telegram" to profile telegram', () => {
    const form = makeForm(['Ваш Telegram']);
    const [s] = skill.suggest([form]);
    expect(s.value).toBe('@wyddy7');
  });

  it('cover letter → low confidence (always ask_user)', () => {
    const form = makeForm(['Напишите сопроводительное письмо']);
    const [s] = skill.suggest([form]);
    expect(s.confidence).toBe('low');
  });

  it('handles multiple fields in one form correctly', () => {
    const form = makeForm([
      'Ваш уровень английского языка',
      'Есть ли у вас вредные привычки?',
      'Как вы узнали о вакансии?',
      'Ваш GitHub',
      'Ваш Telegram',
      'Желаемая зарплата',
    ]);
    const suggestions = skill.suggest([form]);
    // First 5 match — all high/medium
    const byLabel = Object.fromEntries(suggestions.map(s => [s.fieldLabel, s]));
    expect(byLabel['Ваш уровень английского языка']?.confidence).toBe('high');
    expect(byLabel['Есть ли у вас вредные привычки?']?.confidence).toBe('high');
    expect(byLabel['Как вы узнали о вакансии?']?.confidence).toBe('high');
    expect(byLabel['Желаемая зарплата']?.confidence).toBe('medium');
  });
});
