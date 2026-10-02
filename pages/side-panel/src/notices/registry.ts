/**
 * In-product notices: a feature intro now, "what's new" later. Each is shown
 * once — to new and existing users alike — the next time its trigger fires,
 * and stays until the user answers it (`noticesStore` keeps the seen ids).
 *
 * Adding one: give it a new id (a changed text needs a new id to be shown
 * again), a trigger, an anchor if it is about a control (the bar grows out of
 * that control and folds back into it), and its strings in every locale. It is
 * a low bar over the composer: a title line and one line of text, a close
 * button, no other controls (the control it is about is right there) — keep
 * both lines short enough for a 360 px panel.
 */
import { t } from '@extension/i18n';
import { spiderSettingsStore } from '@extension/storage';

/** When a notice may appear: the panel opened, or a task started. */
export type NoticeTrigger = 'open' | 'task-start';

export interface NoticeDef {
  id: string;
  trigger: NoticeTrigger;
  /** `data-notice-anchor` of the control the notice is about: the bar grows out of it. */
  anchor?: string;
  /** `data-notice-dock` of what the bar spans (default: the composer). */
  dock?: string;
  icon?: 'spider';
  title: () => string;
  body: () => string;
  /** The close button's label (screen readers, tooltip): the only control on a notice. */
  close: () => string;
  /** Show only while this holds. */
  when?: () => Promise<boolean>;
}

export const NOTICES: NoticeDef[] = [
  {
    // Shown when the first task starts, just before the spider comes out (so: an announcement).
    id: 'spider-watch',
    trigger: 'task-start',
    anchor: 'spider-toggle',
    icon: 'spider',
    title: () => t('notice_spider_title'),
    body: () => t('notice_spider_body'),
    close: () => t('notice_ok'),
    when: async () => (await spiderSettingsStore.getSettings()).enabled,
  },
];
