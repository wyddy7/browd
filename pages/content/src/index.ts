import { DEFAULT_GENERAL_SETTINGS, generalSettingsStore } from '@extension/storage';

type ShortcutParts = {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

let launchShortcut = DEFAULT_GENERAL_SETTINGS.launchShortcut;

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT'
  );
}

function parseShortcut(shortcut: string): ShortcutParts | null {
  const normalized = shortcut.trim();
  if (!normalized) {
    return null;
  }

  const tokens = normalized
    .split('+')
    .map(token => token.trim())
    .filter(Boolean);
  if (tokens.length === 0) {
    return null;
  }

  const key = tokens[tokens.length - 1];
  const modifiers = new Set(tokens.slice(0, -1).map(token => token.toLowerCase()));

  return {
    key: key.length === 1 ? key.toUpperCase() : key.toLowerCase(),
    ctrl: modifiers.has('ctrl') || modifiers.has('control'),
    meta: modifiers.has('meta') || modifiers.has('cmd') || modifiers.has('command'),
    alt: modifiers.has('alt') || modifiers.has('option'),
    shift: modifiers.has('shift'),
  };
}

function matchesShortcut(event: KeyboardEvent, shortcut: string): boolean {
  const parsed = parseShortcut(shortcut);
  if (!parsed) {
    return false;
  }

  const eventKey = event.key.length === 1 ? event.key.toUpperCase() : event.key.toLowerCase();

  return (
    eventKey === parsed.key &&
    event.ctrlKey === parsed.ctrl &&
    event.metaKey === parsed.meta &&
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift
  );
}

async function syncSettings() {
  const settings = await generalSettingsStore.getSettings();
  launchShortcut = settings.launchShortcut;
}

if (window.top === window) {
  void syncSettings();

  generalSettingsStore.subscribe(() => {
    const latest = generalSettingsStore.getSnapshot();
    if (!latest) {
      return;
    }

    launchShortcut = latest.launchShortcut;
  });

  window.addEventListener(
    'keydown',
    event => {
      if (event.defaultPrevented || event.repeat || isEditableTarget(event.target)) {
        return;
      }

      if (!matchesShortcut(event, launchShortcut)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      void chrome.runtime.sendMessage({ type: 'open-side-panel' });
    },
    true,
  );
}
