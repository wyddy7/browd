/**
 * T2s-3 — Permission-mode selector. Compact two-tier pill in the
 * input toolbar. Pill = icon + short label; full description appears
 * only on hover (title attribute). Click opens a tiny dropdown
 * growing UP with two options (label-only, hover for explanation).
 *
 * Two tiers (see `PermissionMode` in generalSettings.ts):
 *   - default — every HITL approval prompts. FiLock icon.
 *   - full    — skip in-app HITL. FiAlertTriangle icon in danger colour.
 *
 * Visual contract:
 *   - Pill height matches the other toolbar icons (~24px).
 *   - 'full' renders in `--browd-danger` (consistent with other
 *     warning surfaces in browd).
 *   - Menu items are single-line label only; description hides
 *     in the native title tooltip.
 */
import { useEffect, useRef, useState } from 'react';
import { FiLock, FiAlertTriangle, FiCheck } from 'react-icons/fi';
import { t } from '@extension/i18n';
import type { PermissionMode } from '@extension/storage';

interface PermissionModeSelectorProps {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  disabled?: boolean;
}

interface ModeOption {
  value: PermissionMode;
  labelKey: 'chat_permissionMode_default' | 'chat_permissionMode_full';
  descKey: 'chat_permissionMode_default_desc' | 'chat_permissionMode_full_desc';
  Icon: React.ComponentType<{ className?: string }>;
  danger: boolean;
}

const MODES: ReadonlyArray<ModeOption> = [
  {
    value: 'default',
    labelKey: 'chat_permissionMode_default',
    descKey: 'chat_permissionMode_default_desc',
    Icon: FiLock,
    danger: false,
  },
  {
    value: 'full',
    labelKey: 'chat_permissionMode_full',
    descKey: 'chat_permissionMode_full_desc',
    Icon: FiAlertTriangle,
    danger: true,
  },
];

export function PermissionModeSelector({ mode, onChange, disabled = false }: PermissionModeSelectorProps) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // Click-outside / Escape to close.
  useEffect(() => {
    if (!open) return;
    const onDocClick = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDocClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDocClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const active = MODES.find(m => m.value === mode) ?? MODES[0];
  const ActiveIcon = active.Icon;

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={t(active.descKey)}
        className={`browd-permission-pill ${active.danger ? 'is-danger' : ''}`}>
        <ActiveIcon className="size-3.5" />
        <span>{t(active.labelKey)}</span>
      </button>
      {open && (
        <div role="menu" className="browd-permission-menu">
          {MODES.map(opt => {
            const Icon = opt.Icon;
            const selected = opt.value === mode;
            return (
              <button
                key={opt.value}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                title={t(opt.descKey)}
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`browd-permission-menu-item ${opt.danger ? 'is-danger' : ''} ${selected ? 'is-selected' : ''}`}>
                <Icon className="size-3.5 shrink-0" />
                <span className="flex-1 text-left font-medium">{t(opt.labelKey)}</span>
                {selected && <FiCheck className="size-3 shrink-0 opacity-70" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
