/**
 * Bounds one page-state build. The DOM-tree build on some pages never
 * returns (2026-09-27: 172 s of silence on justice.gov until the harness
 * cancelled), and before this nothing but a tab-gone abort could stop it.
 *
 * `build` receives a signal that aborts when the caller's signal aborts
 * (tab gone) or when the deadline passes. Returns the build result, or
 * `null` on deadline — the caller then serves a degraded state instead of
 * waiting. A caller abort still rejects, so tab-gone handling is unchanged.
 */
export const STATE_BUILD_DEADLINE_MS = 20_000;

export async function withStateDeadline<T>(
  build: (signal: AbortSignal) => Promise<T>,
  callerSignal: AbortSignal | undefined,
  deadlineMs = STATE_BUILD_DEADLINE_MS,
): Promise<T | null> {
  const inner = new AbortController();
  const forwardAbort = () => inner.abort(callerSignal?.reason);
  if (callerSignal?.aborted) inner.abort(callerSignal.reason);
  else callerSignal?.addEventListener('abort', forwardAbort, { once: true });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), deadlineMs);
  });
  const work = build(inner.signal);
  try {
    const result = await Promise.race([work, deadline]);
    if (result === null) {
      // Stop the abandoned build at its next abort check; its late
      // rejection is expected and must not surface.
      inner.abort(new Error('page state build deadline'));
      work.catch(() => {});
    }
    return result;
  } finally {
    clearTimeout(timer);
    callerSignal?.removeEventListener('abort', forwardAbort);
  }
}
