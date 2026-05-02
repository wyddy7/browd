/**
 * T2f-plan-pinned — compact pinned checklist that lives ABOVE the
 * messages stream. Emitted by the planner at task start and updated
 * by the agent node (each step flips done immediately) and the
 * replanner (subgoal rewrites). Replaces the inline planItems
 * message that used to scroll out of view.
 *
 * Visual: collapsible <details> like the thinking group, default
 * open while the run is in flight. Each item is a compact row with
 * an accent-filled circle when done, line-through text when done.
 * Anthropic-style minimal — no border, no card, just a left rule
 * inside the body when expanded.
 */
import { memo } from 'react';

interface PlanPinnedProps {
  items: { text: string; done: boolean; inProgress?: boolean }[];
}

export const PlanPinned = memo(function PlanPinned({ items }: PlanPinnedProps) {
  const doneCount = items.filter(i => i.done).length;
  const total = items.length;
  return (
    <details className="browd-plan-pinned-group" open>
      <summary className="browd-plan-pinned-summary flex cursor-pointer select-none items-center gap-2 text-[var(--browd-muted)] hover:text-[var(--browd-text)] transition-colors">
        <span className="browd-plan-pinned-chevron">⌄</span>
        <span className="text-xs uppercase tracking-wider opacity-70">plan</span>
        <span className="text-[var(--browd-faint)] text-xs">
          {doneCount} / {total}
        </span>
      </summary>
      <ul className="browd-plan-pinned-list mt-1 space-y-0.5 pl-3">
        {items.map((it, i) => {
          const ringClass = it.done
            ? 'border-[var(--browd-accent)] bg-[var(--browd-accent)]'
            : it.inProgress
              ? 'border-[var(--browd-accent)] bg-transparent browd-plan-item-pulse'
              : 'border-[var(--browd-border-strong)] bg-transparent';
          const textClass = it.done
            ? 'text-[var(--browd-muted)] line-through'
            : it.inProgress
              ? 'text-[var(--browd-text)] font-medium'
              : 'text-[var(--browd-text)]';
          return (
            <li key={i} className={`flex items-start gap-2 text-sm leading-5 ${it.done ? 'opacity-70' : ''}`}>
              <span
                aria-hidden="true"
                className={`mt-1 inline-flex h-3 w-3 shrink-0 items-center justify-center rounded-full border ${ringClass}`}>
                {it.done ? <span className="text-[8px] leading-none text-[var(--browd-bg)]">✓</span> : null}
              </span>
              <span className={textClass}>{it.text}</span>
            </li>
          );
        })}
      </ul>
    </details>
  );
});
