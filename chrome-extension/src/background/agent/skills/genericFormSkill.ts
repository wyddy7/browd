import type { FormField, FormModel } from '@src/background/browser/dom/forms';

export type FieldConfidence = 'high' | 'medium' | 'low';

export interface FieldSuggestion {
  fieldLabel: string;
  value: string;
  confidence: FieldConfidence;
  /** Where the value came from: matched pattern, user profile, or no match. */
  source: 'pattern' | 'profile' | 'none';
}

export interface UserProfile {
  name?: string;
  email?: string;
  phone?: string;
  github?: string;
  portfolio?: string;
  telegram?: string;
  englishLevel?: string;
  badHabits?: string;
}

/**
 * Generic form field skill — maps form fields to safe values.
 *
 * confidence >= 0.7 → fill automatically
 * confidence 0.4..0.7 → fill, but flag in trace as uncertain
 * confidence < 0.4 → use ask_user
 *
 * Extend this class for site-specific overrides (see HhApplySkill).
 */
export class GenericFormSkill {
  constructor(protected readonly profile: UserProfile = {}) {}

  /**
   * Suggest values for all fields in the given forms.
   * Returns only fields that have a suggestion (skips blanks).
   */
  suggest(forms: FormModel[]): FieldSuggestion[] {
    const suggestions: FieldSuggestion[] = [];
    for (const form of forms) {
      for (const field of form.fields) {
        const suggestion = this.suggestField(field);
        if (suggestion) suggestions.push(suggestion);
      }
    }
    return suggestions;
  }

  protected suggestField(field: FormField): FieldSuggestion | null {
    const label = field.label.toLowerCase();

    // Profile-based mappings
    if (/^email|e-mail/.test(label) && this.profile.email) {
      return { fieldLabel: field.label, value: this.profile.email, confidence: 'high', source: 'profile' };
    }
    if (/phone|телефон|тел\.?$/.test(label) && this.profile.phone) {
      return { fieldLabel: field.label, value: this.profile.phone, confidence: 'high', source: 'profile' };
    }
    if (/github|gitlab|репозитор/.test(label) && this.profile.github) {
      return { fieldLabel: field.label, value: this.profile.github, confidence: 'high', source: 'profile' };
    }
    if (/portfolio|сайт|портфолио|website/.test(label) && this.profile.portfolio) {
      return { fieldLabel: field.label, value: this.profile.portfolio, confidence: 'high', source: 'profile' };
    }
    if (/telegram|телеграм/.test(label) && this.profile.telegram) {
      return { fieldLabel: field.label, value: this.profile.telegram, confidence: 'high', source: 'profile' };
    }

    // Pattern-based: check site-specific patterns (overridable)
    const patternResult = this.matchPattern(field);
    if (patternResult) return patternResult;

    // No match — if field is required, signal low confidence so ask_user fires
    if (field.required) {
      return { fieldLabel: field.label, value: '', confidence: 'low', source: 'none' };
    }

    return null;
  }

  /** Override in subclasses to add site-specific patterns. */
  protected matchPattern(_field: FormField): FieldSuggestion | null {
    return null;
  }

  /** Routing helper for executor — which fields to auto-fill vs ask_user. */
  static shouldAutoFill(suggestion: FieldSuggestion): boolean {
    return suggestion.confidence === 'high' || suggestion.confidence === 'medium';
  }

  static shouldAskUser(suggestion: FieldSuggestion): boolean {
    return suggestion.confidence === 'low';
  }
}
