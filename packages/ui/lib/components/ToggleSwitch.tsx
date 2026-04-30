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
        className={cn(
          'relative block h-6 w-11 rounded-full transition-colors peer-focus-visible:outline-none peer-focus-visible:ring-4 peer-focus-visible:ring-[var(--browd-accent-soft)]',
          checked ? 'bg-[var(--browd-info)]' : 'bg-[var(--browd-toggle-track-off)]',
          disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        )}>
        <span className="sr-only">{label}</span>
        <span
          className={cn(
            'absolute top-[2px] block size-5 rounded-full border bg-[var(--browd-toggle-thumb)] shadow-sm transition-all duration-200 ease-out',
            checked ? 'left-[22px] border-transparent' : 'left-[2px] border border-[var(--browd-border)]',
          )}
        />
      </label>
    </div>
  );
}
