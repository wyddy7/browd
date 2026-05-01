import { describe, it, expect } from 'vitest';
import { classifyState } from '../classifier';
import type { FormModel } from '@src/background/browser/dom/forms';

function noForms(): FormModel[] {
  return [];
}
function withForm(requiredFilled = false): FormModel[] {
  return [
    {
      fields: [
        {
          label: 'Email',
          type: 'email',
          value: requiredFilled ? 'a@b.com' : '',
          required: true,
          xpathCandidates: [],
          highlightIndex: 1,
          labelSource: 'label_for',
        },
        {
          label: 'Message',
          type: 'textarea',
          value: '',
          required: false,
          xpathCandidates: [],
          highlightIndex: 2,
          labelSource: 'aria_label',
        },
      ],
      submitButtons: [{ label: 'Send', xpath: null, highlightIndex: null }],
      containerXpath: null,
    },
  ];
}

describe('classifyState', () => {
  it('idle for blank URL', () => {
    expect(classifyState('about:blank', noForms(), [])).toBe('idle');
    expect(classifyState('chrome://newtab', noForms(), [])).toBe('idle');
    expect(classifyState('', noForms(), [])).toBe('idle');
  });

  it('submitted when success text is visible', () => {
    expect(classifyState('https://hh.ru/vacancy/123', noForms(), ['Отклик отправлен работодателю'])).toBe('submitted');
    expect(classifyState('https://example.com', noForms(), ['Application submitted successfully'])).toBe('submitted');
  });

  it('auth_required when sign-in text visible', () => {
    expect(classifyState('https://gmail.com', noForms(), ['Войти в аккаунт Google'])).toBe('auth_required');
  });

  it('blocked when captcha detected', () => {
    expect(classifyState('https://example.com', noForms(), ['Please complete the captcha'])).toBe('blocked');
  });

  it('questionnaire when form has unfilled required field', () => {
    expect(classifyState('https://hh.ru/vacancy/123/apply', withForm(false), ['Вопросы работодателя'])).toBe(
      'questionnaire',
    );
  });

  it('ready_to_submit when all required fields filled and submit exists', () => {
    expect(classifyState('https://hh.ru/vacancy/123/apply', withForm(true), [])).toBe('ready_to_submit');
  });

  it('vacancy_page for hh.ru vacancy URL without form', () => {
    expect(classifyState('https://hh.ru/vacancy/123456', noForms(), ['Senior Python Developer', '500k руб'])).toBe(
      'vacancy_page',
    );
  });

  it('search_results for Google SERP', () => {
    expect(classifyState('https://www.google.com/search?q=python+jobs', noForms(), [])).toBe('search_results');
  });

  it('apply_modal when apply button visible', () => {
    expect(classifyState('https://some-jobs.com/view/123', noForms(), ['Откликнуться на вакансию'])).toBe(
      'apply_modal',
    );
  });

  it('content_page for generic HTTP URL', () => {
    expect(classifyState('https://docs.python.org/3/', noForms(), ['Python 3.12 docs'])).toBe('content_page');
  });
});
