import { afterEach, describe, expect, it, vi } from 'vitest';
import { withStateDeadline } from '../stateDeadline';

describe('withStateDeadline', () => {
  afterEach(() => vi.useRealTimers());

  it('returns null at the deadline instead of waiting on a build that never finishes', async () => {
    vi.useFakeTimers();
    let buildSignal: AbortSignal | undefined;
    const pending = withStateDeadline(
      signal => {
        buildSignal = signal;
        return new Promise<string>(() => {});
      },
      undefined,
      20_000,
    );

    await vi.advanceTimersByTimeAsync(20_000);

    await expect(pending).resolves.toBeNull();
    expect(buildSignal?.aborted).toBe(true);
  });

  it('returns the state when the build finishes in time', async () => {
    await expect(withStateDeadline(async () => 'state', undefined, 1_000)).resolves.toBe('state');
  });

  it('still rejects when the caller aborts (tab gone), so tab-gone handling is unchanged', async () => {
    const caller = new AbortController();
    const pending = withStateDeadline(
      signal =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('tab gone')));
        }),
      caller.signal,
      20_000,
    );
    caller.abort();
    await expect(pending).rejects.toThrow('tab gone');
  });

  it('swallows the late rejection of an abandoned build', async () => {
    vi.useFakeTimers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    const pending = withStateDeadline(
      signal =>
        new Promise<string>((_, reject) => {
          signal.addEventListener('abort', () => reject(new Error('aborted build')));
        }),
      undefined,
      5_000,
    );
    await vi.advanceTimersByTimeAsync(5_000);
    await expect(pending).resolves.toBeNull();
    await vi.runAllTimersAsync();
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
  });
});
