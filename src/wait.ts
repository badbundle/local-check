export interface WaitOptions {
  /** Give up after this many milliseconds. Defaults to a minute. */
  timeout?: number;
  /** Milliseconds between attempts. Defaults to half a second. */
  interval?: number;
  /** Stop waiting when this is aborted, such as a check's `ctx.signal`. */
  signal?: AbortSignal;
  /** Names what's being waited for, in the timeout error. */
  description?: string;
}

/**
 * Calls `condition` until it returns something truthy, and returns that.
 * Throws if the timeout passes first or the signal is aborted.
 */
export async function waitFor<T>(
  condition: () => T | Promise<T>,
  options: WaitOptions = {},
): Promise<NonNullable<T>> {
  const { timeout = 60_000, interval = 500, signal, description = "condition" } = options;
  const deadline = Date.now() + timeout;
  for (;;) {
    signal?.throwIfAborted();
    const value = await condition();
    if (value) {
      return value;
    }
    if (Date.now() + interval > deadline) {
      throw new Error(`Timed out after ${timeout}ms waiting for ${description}`);
    }
    await sleep(interval, signal);
  }
}

/** Resolves after `ms`, or rejects as soon as `signal` is aborted. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
