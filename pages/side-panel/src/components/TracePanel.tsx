export interface TraceEntry {
  icon: '✓' | '✗' | '→';
  label: string;
}

interface TracePanelProps {
  entries: TraceEntry[];
}

export function TracePanel({ entries }: TracePanelProps) {
  if (entries.length === 0) return null;

  return (
    <div className="px-3 py-1.5 border-b border-[var(--browd-border)] text-xs font-mono text-[var(--browd-muted)] max-h-24 overflow-y-auto">
      {entries.map((entry, i) => (
        <div
          key={i}
          className={`leading-snug ${
            entry.icon === '✓' ? 'text-emerald-400' : entry.icon === '✗' ? 'text-red-400' : 'text-[var(--browd-muted)]'
          }`}>
          {entry.icon} {entry.label}
        </div>
      ))}
    </div>
  );
}
