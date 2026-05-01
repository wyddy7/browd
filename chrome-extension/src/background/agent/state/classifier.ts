import type { FormModel } from '@src/background/browser/dom/forms';

/**
 * Task state machine.
 * Plain code — no LLM. From agents/multi-agent.md: "StateClassifier — plain code".
 * URL patterns + keyword rules to determine where the agent currently is.
 */
export type TaskState =
  | 'idle' // no page loaded or blank
  | 'search_results' // SERP or site search results
  | 'content_page' // article, product, info page — reading/extracting
  | 'vacancy_page' // job listing with apply button
  | 'apply_modal' // application modal/dialog has appeared
  | 'questionnaire' // multi-field form requiring user-specific answers
  | 'ready_to_submit' // questionnaire filled, submit button available
  | 'submitted' // confirmed submission success
  | 'auth_required' // login/signup gate
  | 'blocked' // captcha, rate limit, access denied
  | 'unknown'; // fallback

const SUBMIT_SUCCESS_PATTERNS = [
  /отклик.*отправ/i,
  /резюме.*отправ/i,
  /заявка.*принята/i,
  /application.*sent/i,
  /application.*submitted/i,
  /thank.*you.*appl/i,
  /успешно.*отправ/i,
];

const AUTH_PATTERNS = [/войти|sign in|log in|login|авторизация|вход/i];

const CAPTCHA_PATTERNS = [/captcha|robot|i am not a robot/i, /доступ.*запрещён|access denied|rate limit/i];

const VACANCY_URL_PATTERNS = [
  /hh\.ru\/vacancy\//,
  /linkedin\.com\/jobs\/view/,
  /indeed\.com\/viewjob/,
  /superjob\.ru\/vakansii\//,
  /rabota\.ru\/vacancy\//,
  /zarplata\.ru\/vacancy\//,
  /careers\./,
  /jobs\./,
];

const SEARCH_URL_PATTERNS = [
  /google\.(com|ru)\/search/,
  /yandex\.(ru|com)\/search/,
  /hh\.ru\/(search|vacancies)/,
  /linkedin\.com\/jobs\/search/,
];

const APPLY_BUTTON_PATTERNS = [/откликнуть|apply now|apply for|submit application|подать заявку/i];

function containsText(visibleText: string[], patterns: RegExp[]): boolean {
  const combined = visibleText.join(' ');
  return patterns.some(p => p.test(combined));
}

function isVacancyUrl(url: string): boolean {
  return VACANCY_URL_PATTERNS.some(p => p.test(url));
}

function isSearchUrl(url: string): boolean {
  return SEARCH_URL_PATTERNS.some(p => p.test(url));
}

/**
 * Classify the current agent state from observable signals.
 *
 * @param url - Current page URL
 * @param forms - Extracted form models from the page
 * @param visibleText - Array of visible text segments on the page
 * @returns TaskState
 */
export function classifyState(url: string, forms: FormModel[], visibleText: string[]): TaskState {
  if (!url || url === 'about:blank' || url.startsWith('chrome://')) {
    return 'idle';
  }

  // Confirmed success
  if (containsText(visibleText, SUBMIT_SUCCESS_PATTERNS)) return 'submitted';

  // Auth gate
  if (containsText(visibleText, AUTH_PATTERNS)) return 'auth_required';

  // Blocked
  if (containsText(visibleText, CAPTCHA_PATTERNS)) return 'blocked';

  // Has a form with multiple fields → questionnaire or ready_to_submit
  const hasForm = forms.length > 0 && forms.some(f => f.fields.length > 0);
  if (hasForm) {
    const allRequiredFilled = forms.every(form =>
      form.fields.filter(f => f.required).every(f => f.value.trim().length > 0),
    );
    const hasSubmit = forms.some(f => f.submitButtons.length > 0);

    if (allRequiredFilled && hasSubmit) return 'ready_to_submit';
    return 'questionnaire';
  }

  // Apply modal is open (modal/dialog containing apply button)
  if (containsText(visibleText, APPLY_BUTTON_PATTERNS)) {
    return 'apply_modal';
  }

  // Job listing page
  if (isVacancyUrl(url)) return 'vacancy_page';

  // Search results
  if (isSearchUrl(url)) return 'search_results';

  // Default: reading some page
  if (url.startsWith('http')) return 'content_page';

  return 'unknown';
}
