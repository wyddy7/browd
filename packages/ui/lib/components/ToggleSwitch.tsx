import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../utils';

type ToggleSwitchProps = Omit<ComponentPropsWithoutRef<'input'>, 'type'> & {
  label?: string;
  className?: string;
};

export function ToggleSwitch({ id, checked, onChange, disabled, label, className, ...props }: ToggleSwitchProps) {
  return (
    <div className={cn('relative inline-flex items-center', className)}>
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        className="peer sr-only"
        {...props}
      />
      <label
        htmlFor={id}
        className="block h-6 w-11 cursor-pointer rounded-full bg-[var(--browd-toggle-track-off)] transition-colors peer-checked:bg-[var(--browd-info)] peer-focus-visible:outline-none peer-focus-visible:ring-4 peer-focus-visible:ring-[var(--browd-accent-soft)] peer-disabled:cursor-not-allowed peer-disabled:opacity-50">
        <span className="sr-only">{label}</span>
        <span className="block size-5 translate-x-[2px] translate-y-[2px] rounded-full border border-[var(--browd-border)] bg-[var(--browd-toggle-thumb)] shadow-sm transition-transform peer-checked:translate-x-6 peer-checked:border-transparent" />
      </label>
    </div>
  );
}
