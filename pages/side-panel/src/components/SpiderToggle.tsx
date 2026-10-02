import { FaSpider } from 'react-icons/fa';
import { useStorage } from '@extension/shared';
import { spiderSettingsStore } from '@extension/storage';
import { t } from '@extension/i18n';

/**
 * Show / hide the agent spider from the chat input. Works mid-task: the
 * background reads the setting live, the spider climbs away or comes back.
 */
export const SpiderToggle = () => {
  const settings = useStorage(spiderSettingsStore);
  const on = settings.enabled !== false;
  const label = on ? t('chat_input_spider_on_label') : t('chat_input_spider_off_label');
  return (
    <button
      type="button"
      data-testid="spider-toggle"
      aria-pressed={on}
      aria-label={label}
      title={label}
      onClick={() => void spiderSettingsStore.updateSettings({ enabled: !on })}
      className={`rounded-md p-1.5 transition-colors ${
        on
          ? 'bg-[var(--browd-accent)]/15 text-[var(--browd-accent)] hover:bg-[var(--browd-accent)]/25'
          : 'browd-icon-button opacity-70'
      }`}>
      <FaSpider className="size-4" />
    </button>
  );
};
