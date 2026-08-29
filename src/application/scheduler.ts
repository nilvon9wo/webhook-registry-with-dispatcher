/**
 * Deferred-execution seam.
 *
 * The dispatcher schedules a retry attempt for `delayMs` in the future. In
 * production this is `setTimeout`; tests inject a manual scheduler so retry
 * timing is deterministic and the chosen backoff delays can be asserted.
 */

export interface Scheduler {
  /**
   * Invokes `callback` after roughly `delayMs`. Returns a function that cancels
   * the pending invocation.
   */
  schedule(callback: () => void, delayMs: number): () => void;
}

export const realScheduler: Scheduler = {
  schedule(callback: () => void, delayMs: number): () => void {
    const timer = setTimeout(callback, delayMs);
    // A pending retry should not by itself keep the process alive.
    timer.unref();
    return () => clearTimeout(timer);
  },
};
