import type { ComponentPropsWithoutRef } from 'react';
import { cn } from '../utils';

export type ButtonProps = {
  theme?: 'light' | 'dark';
  variant?: 'primary' | 'secondary' | 'danger';
  disabled?: boolean;
} & ComponentPropsWithoutRef<'button'>;

export function Button({ theme, variant = 'primary', className, disabled, children, ...props }: ButtonProps) {
  return (
    <button
      className={cn(
        'py-1 px-4 rounded shadow transition-all',
        {
          // Primary variant
          'bg-[var(--browd-accent)] hover:bg-[var(--browd-accent-hover)] text-[var(--browd-accent-text)] hover:scale-105':
            variant === 'primary' && !disabled,
          // Secondary variant
          'bg-[var(--browd-panel-strong)] hover:bg-[var(--browd-accent-soft)] text-[var(--browd-text)] hover:scale-105':
            variant === 'secondary' && !disabled,
          'bg-[var(--browd-panel-strong)] text-[var(--browd-faint)] cursor-not-allowed':
            (variant === 'primary' || variant === 'secondary') && disabled,

          // Danger variant
          'bg-[var(--browd-danger)] hover:bg-[var(--browd-danger-hover)] text-white hover:scale-105':
            variant === 'danger' && !disabled && theme !== 'dark',
          'bg-[var(--browd-danger)] hover:bg-[var(--browd-danger-hover)] text-[var(--browd-text-inverse)] hover:scale-105':
            variant === 'danger' && !disabled && theme === 'dark',
          'bg-[var(--browd-danger-soft)] text-[var(--browd-danger)] cursor-not-allowed':
            variant === 'danger' && disabled,
        },
        className,
      )}
      disabled={disabled}
      {...props}>
      {children}
    </button>
  );
}
