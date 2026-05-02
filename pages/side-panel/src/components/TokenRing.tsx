/**
 * T2f-final-2 — live token-usage ring shown in the side-panel header.
 *
 * SVG progress ring (border-only, no fill) drawn with stroke-dasharray
 * + stroke-dashoffset — the standard CSS-only progress-ring pattern.
 * Starts at 12 o'clock and fills clockwise as input+output token totals
 * accumulate against the Navigator model's context window.
 *
 * Colour thresholds match the de-facto SaaS convention used by GitHub,
 * Linear, OpenAI Playground and similar:
 *   < 60% — accent (calm), no warning yet.
 *   60-85% — amber, "watch this".
 *   ≥ 85% — red, near saturation.
 *
 * Numeric value is shown on hover via the title attribute so the
 * compact 28px footprint stays readable. Click is a no-op — the ring
 * is informational only.
 */
import { memo } from 'react';

interface TokenRingProps {
  used: number;
  contextWindow: number;
}

const SIZE = 28;
const STROKE = 2.5;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export const TokenRing = memo(function TokenRing({ used, contextWindow }: TokenRingProps) {
  const safeMax = Math.max(1, contextWindow);
  const progress = Math.max(0, Math.min(1, used / safeMax));
  const dashOffset = CIRCUMFERENCE * (1 - progress);
  const pct = Math.round(progress * 100);
  const colorClass =
    progress < 0.6 ? 'browd-token-ring-ok' : progress < 0.85 ? 'browd-token-ring-warn' : 'browd-token-ring-crit';
  const tooltipText = `${formatTokens(used)} / ${formatTokens(contextWindow)} (${pct}%)`;
  // T2f-final-fix-3: minimal — just the ring at 0.9 scale, numbers
  // surface only on hover via a small floating tooltip. No inline
  // label, keeps the input row uncluttered.
  return (
    <div className={`browd-token-ring ${colorClass}`} role="img" aria-label={`token usage ${tooltipText}`} tabIndex={0}>
      <svg width={SIZE} height={SIZE} viewBox={`0 0 ${SIZE} ${SIZE}`} aria-hidden="true">
        <circle
          className="browd-token-ring-track"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
        />
        <circle
          className="browd-token-ring-fill"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={RADIUS}
          fill="none"
          strokeWidth={STROKE}
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={dashOffset}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
        />
      </svg>
      <span className="browd-token-ring-tooltip" role="tooltip">
        {tooltipText}
      </span>
    </div>
  );
});
