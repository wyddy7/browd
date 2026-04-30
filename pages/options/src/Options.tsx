import { useState, useEffect } from 'react';
import '@src/Options.css';
import { Button } from '@extension/ui';
import { withErrorBoundary, withSuspense } from '@extension/shared';
import { t } from '@extension/i18n';
import { FiSettings, FiCpu, FiShield, FiTrendingUp, FiHelpCircle } from 'react-icons/fi';
import { type AppearanceTheme, generalSettingsStore } from '@extension/storage';
import { GeneralSettings } from './components/GeneralSettings';
import { ModelSettings } from './components/ModelSettings';
import { FirewallSettings } from './components/FirewallSettings';
import { AnalyticsSettings } from './components/AnalyticsSettings';

type TabTypes = 'general' | 'models' | 'firewall' | 'analytics' | 'help';

const TABS: { id: TabTypes; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
  { id: 'general', icon: FiSettings, label: t('options_tabs_general') },
  { id: 'models', icon: FiCpu, label: t('options_tabs_models') },
  { id: 'firewall', icon: FiShield, label: t('options_tabs_firewall') },
  { id: 'analytics', icon: FiTrendingUp, label: 'Analytics' },
  { id: 'help', icon: FiHelpCircle, label: t('options_tabs_help') },
];

type ShortcutParts = {
  key: string;
  ctrl: boolean;
  meta: boolean;
  alt: boolean;
  shift: boolean;
};

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }

  return (
    target.isContentEditable ||
    target.tagName === 'INPUT' ||
    target.tagName === 'TEXTAREA' ||
    target.tagName === 'SELECT' ||
    target.getAttribute('role') === 'textbox'
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

const Options = () => {
  const [activeTab, setActiveTab] = useState<TabTypes>('models');
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [appearanceTheme, setAppearanceTheme] = useState<AppearanceTheme>('light');
  const [launchShortcut, setLaunchShortcut] = useState('');

  // Check for dark mode preference
  useEffect(() => {
    const darkModeMediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    setIsDarkMode(darkModeMediaQuery.matches);

    const handleChange = (e: MediaQueryListEvent) => {
      setIsDarkMode(e.matches);
    };

    darkModeMediaQuery.addEventListener('change', handleChange);
    return () => darkModeMediaQuery.removeEventListener('change', handleChange);
  }, []);

  useEffect(() => {
    generalSettingsStore
      .getSettings()
      .then(settings => {
        setAppearanceTheme(settings.appearanceTheme);
        setLaunchShortcut(settings.launchShortcut);
      })
      .catch(() => setAppearanceTheme('light'));
  }, [activeTab]);

  useEffect(() => {
    const unsubscribe = generalSettingsStore.subscribe(() => {
      const snapshot = generalSettingsStore.getSnapshot();
      if (!snapshot) {
        return;
      }

      setLaunchShortcut(snapshot.launchShortcut);
    });

    return unsubscribe;
  }, []);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat || isEditableTarget(event.target)) {
        return;
      }

      if (!matchesShortcut(event, launchShortcut)) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();
      void chrome.runtime.sendMessage({ type: 'open-side-panel' });
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [launchShortcut]);

  const handleTabClick = (tabId: TabTypes) => {
    if (tabId === 'help') {
      window.open('https://github.com/wyddy7/browd', '_blank');
    } else {
      setActiveTab(tabId);
    }
  };

  const renderTabContent = () => {
    switch (activeTab) {
      case 'general':
        return <GeneralSettings onAppearanceThemeChange={setAppearanceTheme} />;
      case 'models':
        return <ModelSettings isDarkMode={isDarkMode} />;
      case 'firewall':
        return <FirewallSettings />;
      case 'analytics':
        return <AnalyticsSettings />;
      default:
        return null;
    }
  };

  return (
    <div
      data-browd-theme={appearanceTheme}
      data-browd-mode={isDarkMode ? 'dark' : 'light'}
      className="browd-shell flex min-h-screen min-w-[768px] text-[var(--browd-text)]">
      {/* Vertical Navigation Bar */}
      <nav className="w-48 border-r border-[var(--browd-border)] bg-[var(--browd-surface)]/85 backdrop-blur-sm">
        <div className="p-4">
          <h1 className="mb-6 text-xl font-bold text-[var(--browd-text)]">{t('options_nav_header')}</h1>
          <ul className="space-y-2">
            {TABS.map(item => (
              <li key={item.id}>
                <Button
                  onClick={() => handleTabClick(item.id)}
                  className={`flex w-full items-center space-x-2 rounded-lg px-4 py-2 text-left text-sm shadow-none
                    ${
                      activeTab !== item.id
                        ? 'border border-transparent bg-transparent text-[var(--browd-muted)] hover:bg-[var(--browd-panel-strong)] hover:text-[var(--browd-text)]'
                        : 'border border-transparent bg-[var(--browd-panel-strong)] text-[var(--browd-text)]'
                    }`}>
                  <item.icon className="h-4 w-4" />
                  <span>{item.label}</span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      </nav>

      {/* Main Content Area */}
      <main className="flex-1 bg-[var(--browd-bg)]/45 p-8 backdrop-blur-sm">
        <div className="mx-auto min-w-[512px] max-w-screen-lg">{renderTabContent()}</div>
      </main>
    </div>
  );
};

export default withErrorBoundary(withSuspense(Options, <div>Loading...</div>), <div>Error Occurred</div>);
