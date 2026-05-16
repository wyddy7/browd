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
  /**
   * Cache telemetry (optional — zero when provider/wrapper doesn't expose it).
   * `cacheRead` is the cumulative token count served from the provider's KV
   * cache (cheap, ~10% of base input cost). `cacheCreation` is the count
   * written into cache this session (Anthropic charges 1.25-2× for these).
   * `inputTokens` is the total cumulative input (cached + new) — needed to
   * compute the displayed hit rate.
   */
  cacheRead?: number;
  cacheCreation?: number;
  inputTokens?: number;
}

const SIZE = 28;
const STROKE = 4;
const RADIUS = (SIZE - STROKE) / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 10_000) return `${Math.round(n / 1_000)}k`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

export const TokenRing = memo(function TokenRing({
  used,
  contextWindow,
  cacheRead = 0,
  cacheCreation = 0,
  inputTokens = 0,
}: TokenRingProps) {
  const safeMax = Math.max(1, contextWindow);
  const progress = Math.max(0, Math.min(1, used / safeMax));
  const dashOffset = CIRCUMFERENCE * (1 - progress);
  const pct = Math.round(progress * 100);
  const colorClass =
    progress < 0.6 ? 'browd-token-ring-ok' : progress < 0.85 ? 'browd-token-ring-warn' : 'browd-token-ring-crit';
  // Cache line shown only when telemetry actually arrived (any non-zero).
  // Hit rate = cache_read / total_input — provider-agnostic, works for
  // Anthropic / OpenAI / Gemini / OpenRouter as long as the wrapper
  // populated usage_metadata.input_token_details.cache_read (or one of
  // the equivalent paths parsed in runReactAgent.ts).
  // Hit rate formula — provider-agnostic. LangChain JS convention:
  // `input_tokens` is NEW (uncached) tokens only; `cache_read` and
  // `cache_creation` are SEPARATE accumulators. The full prompt size
  // is the sum of all three. Hit rate = fraction of the full prompt
  // that came from cache. Naive `cacheRead / inputTokens` can exceed
  // 100% when cache_read > new input (large cached prefix, small new
  // suffix — exactly the healthy steady-state for an agent loop).
  const totalPrompt = inputTokens + cacheRead + cacheCreation;
  const hitRate = totalPrompt > 0 ? Math.round((cacheRead / totalPrompt) * 100) : 0;
  const hasCache = cacheRead > 0 || cacheCreation > 0;
  // Codex-style stacked tooltip — grows UP, never sideways. Header label,
  // big metric, detail line; optional cache section as a separated block
  // below. Provider-agnostic — cache block only renders when telemetry
  // arrived (see runReactAgent.ts parser).
  const ariaLabel = hasCache
    ? `Context ${pct}%, ${formatTokens(used)} of ${formatTokens(contextWindow)} tokens, cache ${hitRate}% hit rate`
    : `Context ${pct}%, ${formatTokens(used)} of ${formatTokens(contextWindow)} tokens`;
  return (
    <div className={`browd-token-ring ${colorClass}`} role="img" aria-label={ariaLabel} tabIndex={0}>
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
      <div className="browd-token-ring-tooltip" role="tooltip">
        {/* Context line — no "% used" duplicate (the ring fill IS the %). */}
        <div className="browd-token-ring-tooltip-line">
          {formatTokens(used)} / {formatTokens(contextWindow)} tokens
        </div>
        {hasCache && (
          <div className="browd-token-ring-tooltip-line browd-token-ring-tooltip-cache">
            cache {hitRate}% hit · {formatTokens(cacheRead)} reused
          </div>
        )}
      </div>
    </div>
  );
});
