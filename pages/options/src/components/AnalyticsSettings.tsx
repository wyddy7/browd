import React, { useState, useEffect } from 'react';
import { analyticsSettingsStore } from '@extension/storage';
import { ToggleSwitch } from '@extension/ui';

import type { AnalyticsSettingsConfig } from '@extension/storage';

const cardClass = 'browd-card p-6 text-left';
const insetClass = 'rounded-md border border-[var(--browd-border)] bg-[var(--browd-panel-strong)] p-4';
const titleClass = 'mb-4 text-xl font-semibold text-[var(--browd-text)]';
const subheadClass = 'mb-4 text-base font-medium text-[var(--browd-text)]';
const listClass = 'list-disc space-y-2 pl-5 text-left text-sm text-[var(--browd-muted)]';
export const AnalyticsSettings: React.FC = () => {
  const [settings, setSettings] = useState<AnalyticsSettingsConfig | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const loadSettings = async () => {
      try {
        const currentSettings = await analyticsSettingsStore.getSettings();
        setSettings(currentSettings);
      } catch (error) {
        console.error('Failed to load analytics settings:', error);
      } finally {
        setLoading(false);
      }
    };

    loadSettings();

    // Listen for storage changes
    const unsubscribe = analyticsSettingsStore.subscribe(loadSettings);
    return () => {
      unsubscribe();
    };
  }, []);

  const handleToggleAnalytics = async (enabled: boolean) => {
    if (!settings) return;

    try {
      await analyticsSettingsStore.updateSettings({ enabled });
      setSettings({ ...settings, enabled });
    } catch (error) {
      console.error('Failed to update analytics settings:', error);
    }
  };

  if (loading) {
    return (
      <section className="space-y-6">
        <div className={cardClass}>
          <h2 className={titleClass}>Analytics Settings</h2>
          <div className="animate-pulse">
            <div className="mb-2 h-4 w-3/4 rounded bg-[var(--browd-panel-strong)]"></div>
            <div className="h-4 w-1/2 rounded bg-[var(--browd-panel-strong)]"></div>
          </div>
        </div>
      </section>
    );
  }

  if (!settings) {
    return (
      <section className="space-y-6">
        <div className={cardClass}>
          <h2 className={titleClass}>Analytics Settings</h2>
          <p className="text-[var(--browd-danger)]">Failed to load analytics settings.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="space-y-6">
      <div className={cardClass}>
        <h2 className={titleClass}>Analytics Settings</h2>

        <div className="space-y-6">
          {/* Main toggle */}
          <div className={`my-6 ${insetClass}`}>
            <div className="flex items-center justify-between">
              <label htmlFor="analytics-enabled" className="text-base font-medium text-[var(--browd-text)]">
                Help improve Browd
              </label>
              <ToggleSwitch
                id="analytics-enabled"
                checked={settings.enabled}
                onChange={e => handleToggleAnalytics(e.target.checked)}
                label="Toggle analytics"
              />
            </div>
            <p className="mt-2 text-sm text-[var(--browd-muted)]">
              Share anonymous usage data to help us improve the extension
            </p>
          </div>

          {/* Information about what we collect */}
          <div className={insetClass}>
            <h3 className={subheadClass}>What we collect:</h3>
            <ul className={listClass}>
              <li>Task execution metrics (start, completion, failure counts and duration)</li>
              <li>Domain names of websites visited (e.g., &quot;amazon.com&quot;, not full URLs)</li>
              <li>Error categories for failed tasks (no sensitive details)</li>
              <li>Anonymous usage statistics</li>
            </ul>

            <h3 className="mb-4 mt-6 text-base font-medium text-[var(--browd-text)]">What we DON&apos;T collect:</h3>
            <ul className={listClass}>
              <li>Personal information or login credentials</li>
              <li>Full URLs or page content</li>
              <li>Task instructions or user prompts</li>
              <li>Screen recordings or screenshots</li>
              <li>Any sensitive or private data</li>
            </ul>
          </div>

          {/* Opt-out message */}
          {!settings.enabled && (
            <div className="rounded-md border border-[var(--browd-warning)] bg-[var(--browd-panel-strong)] p-4">
              <p className="text-sm text-[var(--browd-warning)]">
                Analytics disabled. You can re-enable it anytime to help improve Browd.
              </p>
            </div>
          )}
        </div>
      </div>
    </section>
  );
};
