import { MoonStarIcon, SunIcon } from 'lucide-react';
import { motion } from 'framer-motion';
import type { ButtonHTMLAttributes } from 'react';
import { cn } from '../utils';

type ThemeValue = 'light' | 'dark';

type ThemeOption = {
  icon: typeof SunIcon;
  value: ThemeValue;
  label: string;
};

const THEME_OPTIONS: ThemeOption[] = [
  { icon: SunIcon, value: 'light', label: 'Light theme' },
  { icon: MoonStarIcon, value: 'dark', label: 'Dark theme' },
];

type ToggleThemeProps = {
  value: ThemeValue;
  onValueChange: (value: ThemeValue) => void;
  className?: string;
  labels?: Partial<Record<ThemeValue, string>>;
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'onChange'>;

export function ToggleTheme({ value, onValueChange, className, labels, ...props }: ToggleThemeProps) {
  return (
    <div
      className={cn(
        'inline-flex items-center rounded-md border border-[var(--browd-border)] bg-[var(--browd-surface-overlay)] p-0.5',
        className,
      )}
      role="radiogroup"
      aria-label="Theme selection">
      {THEME_OPTIONS.map(option => {
        const Icon = option.icon;
        const isSelected = value === option.value;
        const label = labels?.[option.value] ?? option.label;

        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={isSelected}
            aria-label={label}
            onClick={() => onValueChange(option.value)}
            className={cn(
              'relative flex size-8 items-center justify-center rounded-[6px] transition-colors',
              isSelected ? 'text-[var(--browd-text)]' : 'text-[var(--browd-muted)] hover:text-[var(--browd-text)]',
            )}
            {...props}>
            {isSelected && (
              <motion.div
                layoutId="browd-theme-option"
                transition={{ type: 'spring', bounce: 0.15, duration: 0.45 }}
                className="absolute inset-0 rounded-[6px] border border-[var(--browd-border-strong)] bg-[var(--browd-panel)] shadow-sm"
              />
            )}
            <Icon className="relative z-10 size-4" />
          </button>
        );
      })}
    </div>
  );
}
