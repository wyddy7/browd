import { useState, useEffect } from 'react';
import '@src/Options.css';
import { Button } from '@extension/ui';
import { withErrorBoundary, withSuspense } from '@extension/shared';
import { t } from '@extension/i18n';
import { FiSettings, FiCpu, FiShield, FiHelpCircle } from 'react-icons/fi';
import { type AppearanceTheme, generalSettingsStore } from '@extension/storage';
import { GeneralSettings } from './components/GeneralSettings';
import { ModelSettings } from './components/ModelSettings';
import { FirewallSettings } from './components/FirewallSettings';

type TabTypes = 'general' | 'models' | 'firewall' | 'help';

const TABS: { id: TabTypes; icon: React.ComponentType<{ className?: string }>; label: string }[] = [
  { id: 'general', icon: FiSettings, label: t('options_tabs_general') },
  { id: 'models', icon: FiCpu, label: t('options_tabs_models') },
  { id: 'firewall', icon: FiShield, label: t('options_tabs_firewall') },
  { id: 'help', icon: FiHelpCircle, label: t('options_tabs_help') },
];

const Options = () => {
  const [activeTab, setActiveTab] = useState<TabTypes>('models');
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [appearanceTheme, setAppearanceTheme] = useState<AppearanceTheme>('light');

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
      })
      .catch(() => setAppearanceTheme('light'));
  }, [activeTab]);

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
