import { useState, useEffect, useCallback } from 'react';
import { firewallStore } from '@extension/storage';
import { Button, ToggleSwitch } from '@extension/ui';
import { t } from '@extension/i18n';

const cardClass = 'browd-card p-7 text-left';
const insetClass = 'rounded-md border border-[var(--browd-border)] bg-[var(--browd-panel-strong)] p-4';
const cardHeaderClass = 'mb-6';
const titleClass = 'text-[20px] font-semibold leading-tight tracking-[-0.014em] text-[var(--browd-text)]';
const titleLeadClass = 'mt-1.5 text-[13px] font-normal leading-[1.55] text-[var(--browd-muted)]';
const labelClass = 'text-[15px] font-medium leading-tight text-[var(--browd-text)]';
const mutedClass = 'text-[var(--browd-muted)]';
const activeSegmentClass =
  'rounded-md border border-[var(--browd-border)] bg-[var(--browd-panel-strong)] text-[var(--browd-text)] shadow-none';
const inactiveSegmentClass =
  'rounded-md border border-transparent bg-transparent text-[var(--browd-muted)] shadow-none hover:bg-[var(--browd-panel-strong)] hover:text-[var(--browd-text)]';

export const FirewallSettings = () => {
  const [isEnabled, setIsEnabled] = useState(true);
  const [allowList, setAllowList] = useState<string[]>([]);
  const [denyList, setDenyList] = useState<string[]>([]);
  const [newUrl, setNewUrl] = useState('');
  const [activeList, setActiveList] = useState<'allow' | 'deny'>('allow');

  const loadFirewallSettings = useCallback(async () => {
    const settings = await firewallStore.getFirewall();
    setIsEnabled(settings.enabled);
    setAllowList(settings.allowList);
    setDenyList(settings.denyList);
  }, []);

  useEffect(() => {
    loadFirewallSettings();
  }, [loadFirewallSettings]);

  const handleToggleFirewall = async () => {
    await firewallStore.updateFirewall({ enabled: !isEnabled });
    await loadFirewallSettings();
  };

  const handleAddUrl = async () => {
    // Remove http:// or https:// prefixes
    const cleanUrl = newUrl.trim().replace(/^https?:\/\//, '');
    if (!cleanUrl) return;

    if (activeList === 'allow') {
      await firewallStore.addToAllowList(cleanUrl);
    } else {
      await firewallStore.addToDenyList(cleanUrl);
    }
    await loadFirewallSettings();
    setNewUrl('');
  };

  const handleRemoveUrl = async (url: string, listType: 'allow' | 'deny') => {
    if (listType === 'allow') {
      await firewallStore.removeFromAllowList(url);
    } else {
      await firewallStore.removeFromDenyList(url);
    }
    await loadFirewallSettings();
  };

  return (
    <section className="space-y-8">
      <div className={cardClass}>
        <header className={cardHeaderClass}>
          <h2 className={titleClass}>{t('options_firewall_header')}</h2>
          <p className={titleLeadClass}>{t('options_firewall_header_lead')}</p>
        </header>

        <div className="space-y-6">
          <div className={`my-6 ${insetClass}`}>
            <div className="flex items-center justify-between">
              <label htmlFor="toggle-firewall" className={labelClass}>
                {t('options_firewall_enableToggle')}
              </label>
              <ToggleSwitch
                id="toggle-firewall"
                checked={isEnabled}
                onChange={handleToggleFirewall}
                label={t('options_firewall_toggleFirewall_a11y')}
              />
            </div>
          </div>

          <div className="mb-6 mt-10 flex items-center justify-between">
            <div className="flex space-x-2">
              <Button
                onClick={() => setActiveList('allow')}
                className={`px-3 py-1.5 text-[13px] font-medium ${activeList === 'allow' ? activeSegmentClass : inactiveSegmentClass}`}>
                {t('options_firewall_allowList_header')}
              </Button>
              <Button
                onClick={() => setActiveList('deny')}
                className={`px-3 py-1.5 text-[13px] font-medium ${activeList === 'deny' ? activeSegmentClass : inactiveSegmentClass}`}>
                {t('options_firewall_denyList_header')}
              </Button>
            </div>
          </div>

          <div className="mb-4 flex space-x-2">
            <input
              id="url-input"
              type="text"
              value={newUrl}
              onChange={e => setNewUrl(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') {
                  handleAddUrl();
                }
              }}
              placeholder={t('options_firewall_placeholders_domainUrl')}
              className="browd-input flex-1 px-3 py-2 text-sm"
            />
            <Button
              onClick={handleAddUrl}
              className="rounded-md bg-[var(--browd-text)] px-4 py-2 text-sm font-medium text-[var(--browd-bg)] hover:opacity-90">
              {t('options_firewall_btnAdd')}
            </Button>
          </div>

          <div className="max-h-64 overflow-y-auto">
            {activeList === 'allow' ? (
              allowList.length > 0 ? (
                <ul className="space-y-2">
                  {allowList.map(url => (
                    <li
                      key={url}
                      className="flex items-center justify-between rounded-md bg-[var(--browd-panel-strong)] p-2 pr-0">
                      <span className="text-sm text-[var(--browd-text)]">{url}</span>
                      <Button
                        onClick={() => handleRemoveUrl(url, 'allow')}
                        className="rounded-l-none bg-transparent px-3 py-1 text-[12px] font-normal text-[var(--browd-muted)] shadow-none hover:bg-transparent hover:text-[hsl(var(--browd-danger-400))]">
                        {t('options_firewall_btnRemove')}
                      </Button>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className={`text-center text-sm ${mutedClass}`}>{t('options_firewall_allowList_empty')}</p>
              )
            ) : denyList.length > 0 ? (
              <ul className="space-y-2">
                {denyList.map(url => (
                  <li
                    key={url}
                    className="flex items-center justify-between rounded-md bg-[var(--browd-panel-strong)] p-2 pr-0">
                    <span className="text-sm text-[var(--browd-text)]">{url}</span>
                    <Button
                      onClick={() => handleRemoveUrl(url, 'deny')}
                      className="rounded-l-none bg-transparent px-3 py-1 text-[12px] font-normal text-[var(--browd-muted)] shadow-none hover:bg-transparent hover:text-[hsl(var(--browd-danger-400))]">
                      {t('options_firewall_btnRemove')}
                    </Button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className={`text-center text-sm ${mutedClass}`}>{t('options_firewall_denyList_empty')}</p>
            )}
          </div>
        </div>
      </div>

      <div className={cardClass}>
        <header className={cardHeaderClass}>
          <h2 className={titleClass}>{t('options_firewall_howItWorks_header')}</h2>
          <p className={titleLeadClass}>{t('options_firewall_howItWorks_lead')}</p>
        </header>
        <ul className="list-none space-y-2 text-left text-[13px] leading-[1.55] text-[var(--browd-muted)]">
          {t('options_firewall_howItWorks')
            .split('\n')
            .map((rule, index) => (
              <li key={index} className="flex gap-3">
                <span aria-hidden="true" className="select-none text-[var(--browd-border-strong)]">
                  —
                </span>
                <span>{rule}</span>
              </li>
            ))}
        </ul>
      </div>
    </section>
  );
};
