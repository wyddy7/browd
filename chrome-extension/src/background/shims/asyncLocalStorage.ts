/**
 * MV3 service-worker shim for `node:async_hooks`.
 *
 * `@langchain/langgraph` calls `new AsyncLocalStorage()` at module load
 * to set up its global context-propagation singleton. AsyncLocalStorage
 * lives in `node:async_hooks` and does not exist in the browser /
 * service-worker runtime — that is the build-time error that blocks
 * T2d-4. This module ships a synchronous stub that satisfies the
 * surface langchain actually uses (`run`, `getStore`, `enterWith`,
 * `disable`) without true cross-await context propagation.
 *
 * Trade-off: in MV3 background SW the agent loop is effectively
 * single-flight (one task at a time per Executor instance), so the
 * lack of real per-async-stack isolation is a non-issue. If we ever
 * run multiple unified agents concurrently in the same SW, we will
 * need a real polyfill.
 */

export class AsyncLocalStorage<T = unknown> {
  private store: T | undefined = undefined;

  run<R>(store: T, callback: () => R): R {
    const prev = this.store;
    this.store = store;
    try {
      return callback();
    } finally {
      this.store = prev;
    }
  }

  getStore(): T | undefined {
    return this.store;
  }

  enterWith(store: T): void {
    this.store = store;
  }

  disable(): void {
    this.store = undefined;
  }

  exit<R>(callback: () => R): R {
    const prev = this.store;
    this.store = undefined;
    try {
      return callback();
    } finally {
      this.store = prev;
    }
  }
}

/**
 * AsyncResource is also exported by node:async_hooks. Some langchain
 * paths reference it; provide a no-op constructor.
 */
export class AsyncResource {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_type: string, _options?: unknown) {}
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  bind<T extends (...args: unknown[]) => unknown>(fn: T): T {
    return fn;
  }
  runInAsyncScope<R>(callback: () => R): R {
    return callback();
  }
  emitDestroy(): void {}
  asyncId(): number {
    return 0;
  }
  triggerAsyncId(): number {
    return 0;
  }
  static bind<T extends (...args: unknown[]) => unknown>(fn: T): T {
    return fn;
  }
}

export default { AsyncLocalStorage, AsyncResource };
