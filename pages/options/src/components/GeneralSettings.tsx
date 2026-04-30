import { useState, useEffect } from 'react';
import {
  type AppearanceTheme,
  type GeneralSettingsConfig,
  generalSettingsStore,
  DEFAULT_GENERAL_SETTINGS,
} from '@extension/storage';
import { ToggleSwitch, ToggleTheme } from '@extension/ui';
import { t } from '@extension/i18n';

const settingTitleClass = 'text-base font-medium text-[var(--browd-text)]';
const settingDescriptionClass = 'text-sm font-normal text-[var(--browd-muted)]';
const numberInputClass = 'browd-input w-20 px-3 py-2';
const shortcutButtonClass = 'browd-input min-w-[180px] rounded-full px-4 py-2 text-center text-sm transition-colors';

interface GeneralSettingsProps {
  onAppearanceThemeChange?: (theme: AppearanceTheme) => void;
}

export const GeneralSettings = ({ onAppearanceThemeChange }: GeneralSettingsProps) => {
  const [settings, setSettings] = useState<GeneralSettingsConfig>(DEFAULT_GENERAL_SETTINGS);

  useEffect(() => {
    // Load initial settings
    generalSettingsStore.getSettings().then(setSettings);
  }, []);

  const updateSetting = async <K extends keyof GeneralSettingsConfig>(key: K, value: GeneralSettingsConfig[K]) => {
    // Optimistically update the local state for responsiveness
    setSettings(prevSettings => ({ ...prevSettings, [key]: value }));
    if (key === 'appearanceTheme') {
      onAppearanceThemeChange?.(value as AppearanceTheme);
    }

    // Call the store to update the setting
    await generalSettingsStore.updateSettings({ [key]: value } as Partial<GeneralSettingsConfig>);

    // After the store update (which might have side effects, e.g., useVision affecting displayHighlights),
    // fetch the latest settings from the store and update the local state again to ensure UI consistency.
    const latestSettings = await generalSettingsStore.getSettings();
    setSettings(latestSettings);
  };

  return (
    <section className="space-y-6">
      <div className="browd-card p-6 text-left">
        <h2 className="mb-4 text-left text-xl font-semibold text-[var(--browd-text)]">{t('options_general_header')}</h2>

        <div className="space-y-4">
          <div className="flex items-center justify-between gap-6 border-b border-[var(--browd-border)] pb-4">
            <div>
              <h3 className={settingTitleClass}>{t('options_general_theme')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_theme_desc')}</p>
            </div>
            <ToggleTheme
              value={settings.appearanceTheme}
              onValueChange={theme => updateSetting('appearanceTheme', theme as AppearanceTheme)}
              labels={{
                light: t('options_general_theme_light'),
                dark: t('options_general_theme_dark'),
              }}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <h3 className={settingTitleClass}>{t('options_general_maxSteps')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_maxSteps_desc')}</p>
            </div>
            <label htmlFor="maxSteps" className="sr-only">
              {t('options_general_maxSteps')}
            </label>
            <input
              id="maxSteps"
              type="number"
              min={1}
              max={50}
              value={settings.maxSteps}
              onChange={e => updateSetting('maxSteps', Number.parseInt(e.target.value, 10))}
              className={numberInputClass}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <h3 className={settingTitleClass}>{t('options_general_maxActions')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_maxActions_desc')}</p>
            </div>
            <label htmlFor="maxActionsPerStep" className="sr-only">
              {t('options_general_maxActions')}
            </label>
            <input
              id="maxActionsPerStep"
              type="number"
              min={1}
              max={50}
              value={settings.maxActionsPerStep}
              onChange={e => updateSetting('maxActionsPerStep', Number.parseInt(e.target.value, 10))}
              className={numberInputClass}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <h3 className={settingTitleClass}>{t('options_general_maxFailures')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_maxFailures_desc')}</p>
            </div>
            <label htmlFor="maxFailures" className="sr-only">
              {t('options_general_maxFailures')}
            </label>
            <input
              id="maxFailures"
              type="number"
              min={1}
              max={10}
              value={settings.maxFailures}
              onChange={e => updateSetting('maxFailures', Number.parseInt(e.target.value, 10))}
              className={numberInputClass}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <h3 className={settingTitleClass}>{t('options_general_enableVision')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_enableVision_desc')}</p>
            </div>
            <ToggleSwitch
              id="useVision"
              checked={settings.useVision}
              onChange={e => updateSetting('useVision', e.target.checked)}
              label={t('options_general_enableVision')}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <h3 className={settingTitleClass}>{t('options_general_displayHighlights')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_displayHighlights_desc')}</p>
            </div>
            <ToggleSwitch
              id="displayHighlights"
              checked={settings.displayHighlights}
              onChange={e => updateSetting('displayHighlights', e.target.checked)}
              label={t('options_general_displayHighlights')}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <h3 className={settingTitleClass}>{t('options_general_planningInterval')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_planningInterval_desc')}</p>
            </div>
            <label htmlFor="planningInterval" className="sr-only">
              {t('options_general_planningInterval')}
            </label>
            <input
              id="planningInterval"
              type="number"
              min={1}
              max={20}
              value={settings.planningInterval}
              onChange={e => updateSetting('planningInterval', Number.parseInt(e.target.value, 10))}
              className={numberInputClass}
            />
          </div>

          <div className="flex items-center justify-between">
            <div>
              <h3 className={settingTitleClass}>{t('options_general_minWaitPageLoad')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_minWaitPageLoad_desc')}</p>
            </div>
            <div className="flex items-center space-x-2">
              <label htmlFor="minWaitPageLoad" className="sr-only">
                {t('options_general_minWaitPageLoad')}
              </label>
              <input
                id="minWaitPageLoad"
                type="number"
                min={250}
                max={5000}
                step={50}
                value={settings.minWaitPageLoad}
                onChange={e => updateSetting('minWaitPageLoad', Number.parseInt(e.target.value, 10))}
                className={numberInputClass}
              />
            </div>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <h3 className={settingTitleClass}>{t('options_general_replayHistoricalTasks')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_replayHistoricalTasks_desc')}</p>
            </div>
            <ToggleSwitch
              id="replayHistoricalTasks"
              checked={settings.replayHistoricalTasks}
              onChange={e => updateSetting('replayHistoricalTasks', e.target.checked)}
              label={t('options_general_replayHistoricalTasks')}
            />
          </div>

          <div className="flex items-center justify-between gap-6">
            <div>
              <h3 className={settingTitleClass}>{t('options_general_autoGroupOnLaunch')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_autoGroupOnLaunch_desc')}</p>
            </div>
            <ToggleSwitch
              id="autoGroupOnLaunch"
              checked={settings.autoGroupOnLaunch}
              onChange={e => updateSetting('autoGroupOnLaunch', e.target.checked)}
              label={t('options_general_autoGroupOnLaunch')}
            />
          </div>

          <div className="flex items-center justify-between gap-6">
            <div>
              <h3 className={settingTitleClass}>{t('options_general_launchShortcut')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_launchShortcut_desc')}</p>
            </div>
            <div className="flex items-center gap-3">
              <div className="browd-input min-w-[120px] rounded-full px-4 py-2 text-center text-sm text-[var(--browd-text)]">
                {settings.launchShortcut}
              </div>
              <button
                type="button"
                onClick={() => {
                  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
                }}
                className={`${shortcutButtonClass} text-[var(--browd-text)] hover:bg-[var(--browd-panel-strong)]`}>
                Open Shortcuts
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
