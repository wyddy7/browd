import type { DevLocale, MessageKey } from './type';
import { defaultLocale, getMessageFromLocale } from './getMessageFromLocale';

const LANGUAGE_OVERRIDE_KEY = 'browd-interface-language';

type I18nValue = {
  message: string;
  placeholders?: Record<string, { content?: string; example?: string }>;
};

function getOverrideLocale() {
  if (typeof globalThis.localStorage === 'undefined') {
    return undefined;
  }

  const override = globalThis.localStorage.getItem(LANGUAGE_OVERRIDE_KEY);
  return override && override !== 'system' ? override : undefined;
}

function applyPlaceholders(value: I18nValue, substitutions?: string | string[]) {
  let message = value.message;

  if (value.placeholders) {
    Object.entries(value.placeholders).forEach(([key, { content }]) => {
      if (content) {
        message = message.replace(new RegExp(`\\$${key}\\$`, 'gi'), content);
      }
    });
  }

  if (!substitutions) {
    return message;
  }

  if (Array.isArray(substitutions)) {
    return substitutions.reduce((acc, cur, idx) => acc.replace(`$${idx + 1}`, cur), message);
  }

  return message.replace(/\$(\d+)/, substitutions);
}

export function t(key: MessageKey, substitutions?: string | string[]) {
  const overrideLocale = getOverrideLocale();
  if (overrideLocale) {
    const value = getMessageFromLocale(overrideLocale)[key] as I18nValue | undefined;
    if (value) {
      return applyPlaceholders(value, substitutions).replace(/\$\d+/g, '');
    }
  }

  return chrome.i18n.getMessage(key, substitutions);
}

t.devLocale = defaultLocale as DevLocale; // for type consistency with i18n-dev.ts
