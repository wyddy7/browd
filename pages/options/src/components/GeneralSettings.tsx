import { useState, useEffect } from 'react';
import {
  type AppearanceTheme,
  type GeneralSettingsConfig,
  type InterfaceLanguage,
  type VisionMode,
  type AgentMode,
  generalSettingsStore,
  agentModelStore,
  AgentNameEnum,
  modelSupportsVision,
  DEFAULT_GENERAL_SETTINGS,
} from '@extension/storage';
import { ToggleSwitch, ToggleTheme } from '@extension/ui';
import { t } from '@extension/i18n';

const settingTitleClass = 'text-base font-medium text-[var(--browd-text)]';
const settingDescriptionClass = 'text-sm font-normal text-[var(--browd-muted)]';
const numberInputClass = 'browd-input w-[88px] px-3 py-2 text-right';
const selectInputClass = 'browd-input w-full min-w-[200px] px-3 py-2 text-sm';
const shortcutButtonClass = 'browd-input min-w-[160px] rounded-full px-4 py-2 text-center text-sm transition-colors';
const rowClass = 'flex items-center justify-between gap-6 py-4 first:pt-0 last:pb-0';
const rowLeftClass = 'min-w-0 flex-1';
const rowControlClass = 'flex shrink-0 items-center justify-end gap-3 min-w-[240px]';
const LANGUAGE_OVERRIDE_KEY = 'browd-interface-language';

interface GeneralSettingsProps {
  onAppearanceThemeChange?: (theme: AppearanceTheme) => void;
}

export const GeneralSettings = ({ onAppearanceThemeChange }: GeneralSettingsProps) => {
  const [settings, setSettings] = useState<GeneralSettingsConfig>(DEFAULT_GENERAL_SETTINGS);
  const [navigatorSupportsVision, setNavigatorSupportsVision] = useState(false);

  useEffect(() => {
    // Load initial settings
    generalSettingsStore.getSettings().then(settings => {
      setSettings(settings);
      window.localStorage.setItem(LANGUAGE_OVERRIDE_KEY, settings.interfaceLanguage);
    });
    // T2f-1: poll the Navigator model capability so the Vision Mode
    // section can warn when the user's choice cannot be honoured at
    // runtime. agentModelStore has liveUpdate; the Options page is
    // also the only place where it is mutated, so a single read on
    // mount is enough — re-render happens via the model select itself.
    agentModelStore
      .getAgentModel(AgentNameEnum.Navigator)
      .then(model => {
        setNavigatorSupportsVision(modelSupportsVision(model?.provider ?? '', model?.modelName ?? ''));
      })
      .catch(() => setNavigatorSupportsVision(false));
  }, []);

  const updateSetting = async <K extends keyof GeneralSettingsConfig>(key: K, value: GeneralSettingsConfig[K]) => {
    // Optimistically update the local state for responsiveness
    setSettings(prevSettings => ({ ...prevSettings, [key]: value }));
    if (key === 'appearanceTheme') {
      onAppearanceThemeChange?.(value as AppearanceTheme);
    }
    if (key === 'interfaceLanguage') {
      window.localStorage.setItem(LANGUAGE_OVERRIDE_KEY, value as InterfaceLanguage);
    }

    // Call the store to update the setting
    await generalSettingsStore.updateSettings({ [key]: value } as Partial<GeneralSettingsConfig>);

    // After the store update (which might have side effects, e.g., useVision affecting displayHighlights),
    // fetch the latest settings from the store and update the local state again to ensure UI consistency.
    const latestSettings = await generalSettingsStore.getSettings();
    setSettings(latestSettings);

    if (key === 'interfaceLanguage') {
      window.setTimeout(() => window.location.reload(), 50);
    }
  };

  return (
    <section className="space-y-6">
      <div className="browd-card p-6 text-left">
        <h2 className="mb-4 text-left text-xl font-semibold text-[var(--browd-text)]">{t('options_general_header')}</h2>

        <div className="divide-y divide-[var(--browd-border)]">
          <div className={rowClass}>
            <div className={rowLeftClass}>
              <h3 className={settingTitleClass}>{t('options_general_theme')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_theme_desc')}</p>
            </div>
            <div className={rowControlClass}>
              <ToggleTheme
                value={settings.appearanceTheme}
                onValueChange={theme => updateSetting('appearanceTheme', theme as AppearanceTheme)}
                labels={{
                  light: t('options_general_theme_light'),
                  dark: t('options_general_theme_dark'),
                }}
              />
            </div>
          </div>

          <div className={rowClass}>
            <div className={rowLeftClass}>
              <h3 className={settingTitleClass}>{t('options_general_language')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_language_desc')}</p>
            </div>
            <div className={rowControlClass}>
              <label htmlFor="interfaceLanguage" className="sr-only">
                {t('options_general_language')}
              </label>
              <select
                id="interfaceLanguage"
                value={settings.interfaceLanguage}
                onChange={e => updateSetting('interfaceLanguage', e.target.value as InterfaceLanguage)}
                className={selectInputClass}>
                <option value="system">{t('options_general_language_system')}</option>
                <option value="en">{t('options_general_language_en')}</option>
                <option value="ru">{t('options_general_language_ru')}</option>
                <option value="es">{t('options_general_language_es')}</option>
                <option value="fr">{t('options_general_language_fr')}</option>
                <option value="de">{t('options_general_language_de')}</option>
                <option value="pt_BR">{t('options_general_language_ptBR')}</option>
              </select>
            </div>
          </div>

          <div className={rowClass}>
            <div className={rowLeftClass}>
              <h3 className={settingTitleClass}>{t('options_general_maxSteps')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_maxSteps_desc')}</p>
            </div>
            <div className={rowControlClass}>
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
          </div>

          <div className={rowClass}>
            <div className={rowLeftClass}>
              <h3 className={settingTitleClass}>{t('options_general_maxActions')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_maxActions_desc')}</p>
            </div>
            <div className={rowControlClass}>
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
          </div>

          <div className={rowClass}>
            <div className={rowLeftClass}>
              <h3 className={settingTitleClass}>{t('options_general_maxFailures')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_maxFailures_desc')}</p>
            </div>
            <div className={rowControlClass}>
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
          </div>

          <div className={rowClass}>
            <div className={rowLeftClass}>
              <h3 className={settingTitleClass}>{t('options_general_enableVision')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_enableVision_desc')}</p>
            </div>
            <div className={rowControlClass}>
              <ToggleSwitch
                id="useVision"
                checked={settings.useVision}
                onChange={e => updateSetting('useVision', e.target.checked)}
                label={t('options_general_enableVision')}
              />
            </div>
          </div>

          <div className={rowClass}>
            <div className={rowLeftClass}>
              <h3 className={settingTitleClass}>{t('options_general_displayHighlights')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_displayHighlights_desc')}</p>
            </div>
            <div className={rowControlClass}>
              <ToggleSwitch
                id="displayHighlights"
                checked={settings.displayHighlights}
                onChange={e => updateSetting('displayHighlights', e.target.checked)}
                label={t('options_general_displayHighlights')}
              />
            </div>
          </div>

          <div className={rowClass}>
            <div className={rowLeftClass}>
              <h3 className={settingTitleClass}>{t('options_general_planningInterval')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_planningInterval_desc')}</p>
            </div>
            <div className={rowControlClass}>
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
          </div>

          <div className={rowClass}>
            <div className={rowLeftClass}>
              <h3 className={settingTitleClass}>{t('options_general_minWaitPageLoad')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_minWaitPageLoad_desc')}</p>
            </div>
            <div className={rowControlClass}>
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

          <div className={rowClass}>
            <div className={rowLeftClass}>
              <h3 className={settingTitleClass}>{t('options_general_replayHistoricalTasks')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_replayHistoricalTasks_desc')}</p>
            </div>
            <div className={rowControlClass}>
              <ToggleSwitch
                id="replayHistoricalTasks"
                checked={settings.replayHistoricalTasks}
                onChange={e => updateSetting('replayHistoricalTasks', e.target.checked)}
                label={t('options_general_replayHistoricalTasks')}
              />
            </div>
          </div>

          <div className={rowClass}>
            <div className={rowLeftClass}>
              <h3 className={settingTitleClass}>{t('options_general_agentMode')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_agentMode_desc')}</p>
            </div>
            <div className={rowControlClass}>
              <label htmlFor="agentMode" className="sr-only">
                {t('options_general_agentMode')}
              </label>
              <select
                id="agentMode"
                value={settings.agentMode}
                onChange={e => updateSetting('agentMode', e.target.value as AgentMode)}
                className={selectInputClass}>
                <option value="unified">{t('options_general_agentMode_unified')}</option>
                <option value="legacy">{t('options_general_agentMode_legacy')}</option>
              </select>
            </div>
          </div>

          {settings.agentMode === 'unified' && (
            <div className={rowClass}>
              <div className={rowLeftClass}>
                <h3 className={settingTitleClass}>{t('options_general_visionMode')}</h3>
                <p className={settingDescriptionClass}>{t('options_general_visionMode_desc')}</p>
                {!navigatorSupportsVision && settings.visionMode !== 'off' && (
                  <div className="mt-3 flex items-start gap-2 rounded-[var(--browd-radius-sm)] bg-[hsl(var(--browd-warning-400)/0.14)] px-3 py-2 text-sm text-[hsl(var(--browd-warning-400))]">
                    <span aria-hidden="true" className="mt-0.5 leading-none">
                      ⚠
                    </span>
                    <span>{t('options_general_visionMode_warning')}</span>
                  </div>
                )}
              </div>
              <div className={rowControlClass}>
                <label htmlFor="visionMode" className="sr-only">
                  {t('options_general_visionMode')}
                </label>
                <select
                  id="visionMode"
                  value={settings.visionMode}
                  onChange={e => updateSetting('visionMode', e.target.value as VisionMode)}
                  className={selectInputClass}>
                  <option value="off">{t('options_general_visionMode_off')}</option>
                  <option value="always" disabled={!navigatorSupportsVision}>
                    {t('options_general_visionMode_always')}
                  </option>
                  <option value="fallback" disabled={!navigatorSupportsVision}>
                    {t('options_general_visionMode_fallback')}
                  </option>
                </select>
              </div>
            </div>
          )}

          <div className={rowClass}>
            <div className={rowLeftClass}>
              <h3 className={settingTitleClass}>{t('options_general_launchShortcut')}</h3>
              <p className={settingDescriptionClass}>{t('options_general_launchShortcut_desc')}</p>
            </div>
            <div className={rowControlClass}>
              <div className="browd-input min-w-[80px] rounded-full px-3 py-2 text-center text-sm text-[var(--browd-text)]">
                {settings.launchShortcut}
              </div>
              <button
                type="button"
                onClick={() => {
                  void chrome.tabs.create({ url: 'chrome://extensions/shortcuts' });
                }}
                className={`${shortcutButtonClass} text-[var(--browd-text)] hover:bg-[var(--browd-panel-strong)]`}>
                {t('options_general_launchShortcut_btnOpen') || 'Open Shortcuts'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
};
