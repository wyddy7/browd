/**
 * T2s-3 — Permission-mode selector. Codex-style three-tier dropdown
 * for the side-panel input toolbar. Pill button shows the active
 * mode; click opens a dropdown growing UP with three options.
 *
 * Three tiers (see `packages/storage/lib/settings/generalSettings.ts`
 * `PermissionMode`):
 *   - default — every HITL approval prompts the user
 *   - auto    — skip take_over_user_tab approval (agent freely cross-overs)
 *   - full    — same as auto today (reserved for future broader auto-resolve)
 *
 * Visual design:
 *   - 'full' is rendered in `--browd-danger` (consistent with other
 *     warning surfaces in browd). Soft danger background on the pill.
 *   - 'auto' uses a shield icon — middle ground, no colour warning.
 *   - 'default' uses the hand icon — calm baseline.
 *
 * Presentational only — state is owned by SidePanel via
 * `generalSettingsStore`.
 */
import { useEffect, useRef, useState } from 'react';
import { FaCheck, FaHandPaper, FaShieldAlt, FaExclamationCircle, FaChevronDown } from 'react-icons/fa';
import { t } from '@extension/i18n';
import type { PermissionMode } from '@extension/storage';

interface PermissionModeSelectorProps {
  mode: PermissionMode;
  onChange: (mode: PermissionMode) => void;
  disabled?: boolean;
}

interface ModeOption {
  value: PermissionMode;
  labelKey: 'chat_permissionMode_default' | 'chat_permissionMode_auto' | 'chat_permissionMode_full';
  descKey: 'chat_permissionMode_default_desc' | 'chat_permissionMode_auto_desc' | 'chat_permissionMode_full_desc';
  Icon: React.ComponentType<{ className?: string }>;
  danger: boolean;
}

const MODES: ReadonlyArray<ModeOption> = [
  {
    value: 'default',
    labelKey: 'chat_permissionMode_default',
    descKey: 'chat_permissionMode_default_desc',
    Icon: FaHandPaper,
    danger: false,
  },
  {
    value: 'auto',
    labelKey: 'chat_permissionMode_auto',
    descKey: 'chat_permissionMode_auto_desc',
    Icon: FaShieldAlt,
    danger: false,
  },
  {
    value: 'full',
    labelKey: 'chat_permissionMode_full',
    descKey: 'chat_permissionMode_full_desc',
    Icon: FaExclamationCircle,
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
        <FaChevronDown className="size-2.5 opacity-60" />
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
                onClick={() => {
                  onChange(opt.value);
                  setOpen(false);
                }}
                className={`browd-permission-menu-item ${opt.danger ? 'is-danger' : ''} ${selected ? 'is-selected' : ''}`}>
                <Icon className="size-4 shrink-0" />
                <span className="flex-1 text-left">
                  <span className="block font-medium">{t(opt.labelKey)}</span>
                  <span className="block text-[10px] opacity-70 leading-tight mt-0.5">{t(opt.descKey)}</span>
                </span>
                {selected && <FaCheck className="size-3 shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
