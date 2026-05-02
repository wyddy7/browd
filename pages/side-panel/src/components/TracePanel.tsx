/**
 * Trace panel — shows the live tool-call stream from the agent.
 *
 * Two entry shapes are supported:
 *   - Legacy: `{ icon, label }` — used by string-only events.
 *   - Structured: `{ tool, ok, durationMs, args, resultSummary, kind }` —
 *     written by the background tracer (auto-docs/browd-agent-evolution.md
 *     T0). Renders one row per tool call with timing and a truncated
 *     args/result preview.
 */

export interface LegacyTraceEntry {
  icon: '✓' | '✗' | '→';
  label: string;
}

export interface StructuredTraceEntry {
  tool: string;
  ok: boolean;
  durationMs: number;
  args: string;
  resultSummary: string;
  kind?: 'browser' | 'web' | 'meta';
  stepNumber?: number;
  /** T2f-1.5: inline thumbnail for the screenshot tool. */
  imageThumbBase64?: string;
  imageThumbMime?: string;
  /** T2f-final-fix: full-resolution payload for the lightbox. */
  imageFullBase64?: string;
  imageFullMime?: string;
}

export type TraceEntry = LegacyTraceEntry | StructuredTraceEntry;

interface TracePanelProps {
  entries: TraceEntry[];
  /** Called when the user clicks the export button. */
  onExport?: () => void;
  /**
   * T2f-final-3 — invoked when the user clicks an inline thumbnail in
   * a structured trace entry. SidePanel hosts the lightbox modal so
   * one overlay serves both MessageList and TracePanel previews.
   */
  onThumbClick?: (url: string) => void;
}

function isStructured(entry: TraceEntry): entry is StructuredTraceEntry {
  return (entry as StructuredTraceEntry).tool !== undefined;
}

const KIND_BADGE: Record<NonNullable<StructuredTraceEntry['kind']>, string> = {
  browser: 'text-sky-400',
  web: 'text-violet-400',
  meta: 'text-amber-400',
};

export function TracePanel({ entries, onExport, onThumbClick }: TracePanelProps) {
  if (entries.length === 0) return null;

  return (
    <div className="border-b border-[var(--browd-border)] text-xs font-mono text-[var(--browd-muted)]">
      {onExport ? (
        <div className="flex items-center justify-between px-3 pt-1.5">
          <span className="text-[10px] uppercase tracking-wider text-[var(--browd-muted)]/60">trace</span>
          <button
            type="button"
            onClick={onExport}
            className="text-[10px] uppercase tracking-wider text-[var(--browd-muted)]/60 hover:text-[var(--browd-text)] transition-colors">
            copy json
          </button>
        </div>
      ) : null}
      <div className="px-3 py-1.5 max-h-32 overflow-y-auto">
        {entries.map((entry, i) => {
          if (!isStructured(entry)) {
            return (
              <div
                key={i}
                className={`leading-snug ${
                  entry.icon === '✓'
                    ? 'text-emerald-400'
                    : entry.icon === '✗'
                      ? 'text-red-400'
                      : 'text-[var(--browd-muted)]'
                }`}>
                {entry.icon} {entry.label}
              </div>
            );
          }
          const okIcon = entry.ok ? '✓' : '✗';
          const okColor = entry.ok ? 'text-emerald-400' : 'text-red-400';
          const kindColor = entry.kind ? KIND_BADGE[entry.kind] : 'text-[var(--browd-muted)]';
          const thumb = entry.imageThumbBase64
            ? `data:${entry.imageThumbMime ?? 'image/jpeg'};base64,${entry.imageThumbBase64}`
            : null;
          // T2f-final-fix: open the full-res frame in the lightbox if
          // the live trace event carried it. Falls back to the thumb
          // for historical entries (storage strips the full payload).
          const lightboxUrl = entry.imageFullBase64
            ? `data:${entry.imageFullMime ?? 'image/jpeg'};base64,${entry.imageFullBase64}`
            : thumb;
          return (
            <div key={i} className="leading-snug flex gap-2 items-center">
              <span className={okColor}>{okIcon}</span>
              <span className={`${kindColor} font-semibold`}>{entry.tool}</span>
              {thumb ? (
                <button
                  type="button"
                  onClick={() => lightboxUrl && onThumbClick?.(lightboxUrl)}
                  className="rounded border border-[var(--browd-border)] overflow-hidden hover:opacity-80 transition-opacity"
                  title="click to enlarge"
                  aria-label="open screenshot preview">
                  <img src={thumb} alt="screenshot" className="block h-5 w-auto" />
                </button>
              ) : null}
              <span className="text-[var(--browd-muted)]/60 truncate">{entry.args}</span>
              <span className="text-[var(--browd-muted)]/60 ml-auto whitespace-nowrap">{entry.durationMs}ms</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
