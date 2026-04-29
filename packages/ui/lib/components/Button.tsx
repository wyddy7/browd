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
        'rounded px-4 py-1 transition-colors',
        {
          'bg-[var(--browd-panel-strong)] text-[var(--browd-text)] hover:bg-[var(--browd-control-hover)]':
            (variant === 'primary' || variant === 'secondary') && !disabled,
          'bg-[var(--browd-panel-strong)] text-[var(--browd-faint)] cursor-not-allowed':
            (variant === 'primary' || variant === 'secondary') && disabled,

          // Danger variant
          'bg-[var(--browd-danger)] text-white hover:bg-[var(--browd-danger-hover)]':
            variant === 'danger' && !disabled && theme !== 'dark',
          'bg-[var(--browd-danger)] text-[var(--browd-text-inverse)] hover:bg-[var(--browd-danger-hover)]':
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
