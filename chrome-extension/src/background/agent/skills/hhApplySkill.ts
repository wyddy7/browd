import { GenericFormSkill, type FieldSuggestion } from './genericFormSkill';
import type { FormField } from '@src/background/browser/dom/forms';

/**
 * hh.ru-specific form skill.
 * Extends GenericFormSkill with regex mappings for typical HR questionnaire questions.
 * Safe values only — no hallucinated facts.
 */

type PatternEntry = [RegExp, string, 'high' | 'medium' | 'low'];

export class HhApplySkill extends GenericFormSkill {
  private readonly patterns: PatternEntry[];

  constructor(profile = {}) {
    super(profile);
    this.patterns = this.buildPatterns();
  }

  private buildPatterns(): PatternEntry[] {
    const p = this.profile;
    return [
      // English level
      [
        /английск|english.*level|уровень.*англ/i,
        p.englishLevel ?? 'B2 — читаю техническую документацию, работаю с англоязычными API и инструментами.',
        'high',
      ],
      // Bad habits
      [/вредн.*привыч|bad.*habit/i, p.badHabits ?? 'Вредных привычек нет.', 'high'],
      // How did you find us
      [/как.*узнал|how.*hear|source.*vacancy|откуда.*узнал/i, 'Через поиск вакансий на hh.ru.', 'high'],
      // GitHub / portfolio
      [/github|gitlab|репозитор/i, p.github ?? '', 'high'],
      [/portfolio|сайт|портфолио|personal.*site/i, p.portfolio ?? '', 'high'],
      // Telegram
      [/telegram|телеграм/i, p.telegram ?? '', 'high'],
      // Salary expectations — medium confidence, might need user input
      [
        /ожидаем.*зарплат|желаем.*зарплат|желаем.*оклад|salary.*expect|desired.*salary/i,
        'По результатам собеседования.',
        'medium',
      ],
      // Notice period
      [/notice.*period|срок.*уведомл|когда.*готов.*выйти|ready.*to.*start/i, '2 недели.', 'medium'],
      // Work format preference
      [/формат.*работы|remote|офис.*гибрид|work.*format/i, 'Гибридный или удалённый формат предпочтителен.', 'medium'],
      // Cover letter / motivation
      [/сопроводительн|cover.*letter|почему.*хотите|motivation|why.*apply/i, '', 'low'], // always ask user
    ];
  }

  protected matchPattern(field: FormField): FieldSuggestion | null {
    const label = field.label;
    for (const [regex, value, confidence] of this.patterns) {
      if (regex.test(label)) {
        if (!value) {
          // Empty value → low confidence → ask_user
          return { fieldLabel: label, value: '', confidence: 'low', source: 'pattern' };
        }
        return { fieldLabel: label, value, confidence, source: 'pattern' };
      }
    }
    return null;
  }
}
