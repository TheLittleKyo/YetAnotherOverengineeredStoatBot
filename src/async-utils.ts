/**
 * Small async primitives shared across the codebase.
 *
 * `sleep` had seven identical copies (backup, sync, both schedulers, the reset
 * and ticket commands); it lives here so a pause is spelled the same way
 * everywhere.
 */

/** Resolve after `ms` milliseconds. Used to pace bulk API work. */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Reject with `message` if `promise` has not settled within `ms`. The
 * underlying work keeps running; pass `onLate` to clean up a result that
 * arrives after the deadline (an open stream, a connection).
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, message: string, onLate?: (value: T) => void): Promise<T> {
  let timer: NodeJS.Timeout | null = null;
  let timedOut = false;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(message));
    }, ms);
  });
  promise.then(
    (value) => {
      if (timedOut) onLate?.(value);
    },
    () => {},
  );
  return Promise.race([promise, deadline]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Wrap `task` so at most `max` calls run at once; the rest wait their turn in
 * arrival order. A finishing call hands its slot straight to the next waiter,
 * so a caller arriving in between can never push the count past `max`.
 */
export function limitConcurrency<A extends unknown[], R>(max: number, task: (...args: A) => Promise<R>): (...args: A) => Promise<R> {
  let active = 0;
  const waiting: Array<() => void> = [];
  return async (...args: A) => {
    if (active >= max) await new Promise<void>((resolve) => waiting.push(resolve));
    else active += 1;
    try {
      return await task(...args);
    } finally {
      const next = waiting.shift();
      if (next) next();
      else active -= 1;
    }
  };
}
