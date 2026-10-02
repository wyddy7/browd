import { useEffect, useState } from 'react';
import {
  DEFAULT_SPIDER_SETTINGS,
  spiderSettingsStore,
  type SpiderColor,
  type SpiderMarks,
  type SpiderPace,
  type SpiderSettings as SpiderSettingsConfig,
} from '@extension/storage';
import { ToggleSwitch } from '@extension/ui';
import { t } from '@extension/i18n';

interface SpiderSettingsProps {
  classes: {
    heading: string;
    lead: string;
    list: string;
    row: string;
    rowLeft: string;
    rowControl: string;
    title: string;
    description: string;
    select: string;
    badge: string;
  };
}

const COLORS: Array<{ value: SpiderColor; label: Parameters<typeof t>[0] }> = [
  { value: 'violet', label: 'options_spider_color_violet' },
  { value: 'ink', label: 'options_spider_color_ink' },
  { value: 'white', label: 'options_spider_color_white' },
  { value: 'cyan', label: 'options_spider_color_cyan' },
  { value: 'magenta', label: 'options_spider_color_magenta' },
  { value: 'rainbow', label: 'options_spider_color_rainbow' },
];

const SIZES = [
  { value: 0.8, label: 'options_spider_size_small' },
  { value: 1, label: 'options_spider_size_normal' },
  { value: 1.35, label: 'options_spider_size_large' },
] as const;

/** Agent spider knobs. Changes reach a spider already on screen. */
export const SpiderSettings = ({ classes: c }: SpiderSettingsProps) => {
  const [settings, setSettings] = useState<SpiderSettingsConfig>(DEFAULT_SPIDER_SETTINGS);

  useEffect(() => {
    spiderSettingsStore.getSettings().then(setSettings);
  }, []);

  const update = async (patch: Partial<SpiderSettingsConfig>) => {
    setSettings(prev => ({ ...prev, ...patch }));
    await spiderSettingsStore.updateSettings(patch);
    setSettings(await spiderSettingsStore.getSettings());
  };

  const sizeValue = SIZES.reduce((best, s) =>
    Math.abs(s.value - settings.size) < Math.abs(best.value - settings.size) ? s : best,
  ).value;

  return (
    <div>
      <h2 className={c.heading}>
        {t('options_spider_section')}
        <span className={c.badge}>beta</span>
      </h2>
      <p className={c.lead}>{t('options_spider_section_lead')}</p>
      <div className={c.list}>
        <div className={c.row}>
          <div className={c.rowLeft}>
            <h3 className={c.title}>{t('options_spider_enabled')}</h3>
            <p className={c.description}>{t('options_spider_enabled_desc')}</p>
          </div>
          <div className={c.rowControl}>
            <ToggleSwitch
              id="spiderEnabled"
              checked={settings.enabled}
              onChange={e => update({ enabled: e.target.checked })}
              label={t('options_spider_enabled')}
            />
          </div>
        </div>

        <div className={c.row}>
          <div className={c.rowLeft}>
            <h3 className={c.title}>{t('options_spider_size')}</h3>
            <p className={c.description}>{t('options_spider_size_desc')}</p>
          </div>
          <div className={c.rowControl}>
            <label htmlFor="spiderSize" className="sr-only">
              {t('options_spider_size')}
            </label>
            <select
              id="spiderSize"
              value={sizeValue}
              disabled={!settings.enabled}
              onChange={e => update({ size: Number(e.target.value) })}
              className={c.select}>
              {SIZES.map(s => (
                <option key={s.value} value={s.value}>
                  {t(s.label)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className={c.row}>
          <div className={c.rowLeft}>
            <h3 className={c.title}>{t('options_spider_pace')}</h3>
            <p className={c.description}>{t('options_spider_pace_desc')}</p>
          </div>
          <div className={c.rowControl}>
            <label htmlFor="spiderPace" className="sr-only">
              {t('options_spider_pace')}
            </label>
            <select
              id="spiderPace"
              value={settings.pace}
              disabled={!settings.enabled}
              onChange={e => update({ pace: e.target.value as SpiderPace })}
              className={c.select}>
              <option value="calm">{t('options_spider_pace_calm')}</option>
              <option value="normal">{t('options_spider_pace_normal')}</option>
              <option value="fast">{t('options_spider_pace_fast')}</option>
            </select>
          </div>
        </div>

        <div className={c.row}>
          <div className={c.rowLeft}>
            <h3 className={c.title}>{t('options_spider_color')}</h3>
            <p className={c.description}>{t('options_spider_color_desc')}</p>
          </div>
          <div className={c.rowControl}>
            <label htmlFor="spiderColor" className="sr-only">
              {t('options_spider_color')}
            </label>
            <select
              id="spiderColor"
              value={settings.color}
              disabled={!settings.enabled}
              onChange={e => update({ color: e.target.value as SpiderColor })}
              className={c.select}>
              {COLORS.map(col => (
                <option key={col.value} value={col.value}>
                  {t(col.label)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className={c.row}>
          <div className={c.rowLeft}>
            <h3 className={c.title}>{t('options_spider_tear')}</h3>
            <p className={c.description}>{t('options_spider_tear_desc')}</p>
          </div>
          <div className={c.rowControl}>
            <ToggleSwitch
              id="spiderTear"
              checked={settings.tear}
              onChange={e => update({ tear: e.target.checked })}
              label={t('options_spider_tear')}
            />
          </div>
        </div>

        <div className={c.row}>
          <div className={c.rowLeft}>
            <h3 className={c.title}>{t('options_spider_marks')}</h3>
            <p className={c.description}>{t('options_spider_marks_desc')}</p>
          </div>
          <div className={c.rowControl}>
            <label htmlFor="spiderMarks" className="sr-only">
              {t('options_spider_marks')}
            </label>
            <select
              id="spiderMarks"
              value={settings.marks}
              disabled={!settings.enabled}
              onChange={e => update({ marks: e.target.value as SpiderMarks })}
              className={c.select}>
              <option value="off">{t('options_spider_marks_off')}</option>
              <option value="target">{t('options_spider_marks_target')}</option>
              <option value="feet">{t('options_spider_marks_feet')}</option>
            </select>
          </div>
        </div>
      </div>
    </div>
  );
};
