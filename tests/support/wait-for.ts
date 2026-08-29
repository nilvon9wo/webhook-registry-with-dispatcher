/**
 * Polls `predicate` until it is truthy or the timeout elapses. Used to
 * synchronize tests with asynchronous, fire-and-forget work (dispatch,
 * recovery) on observable application state — never a fixed sleep.
 */
export async function waitFor(
  predicate: () => boolean | Promise<boolean>,
  options: { timeoutMs?: number; intervalMs?: number; description?: string } = {},
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const intervalMs = options.intervalMs ?? 10;
  const deadline = Date.now() + timeoutMs;

  for (;;) {
    if (await predicate()) {
      return;
    }
    if (Date.now() >= deadline) {
      throw new Error(
        `waitFor timed out after ${timeoutMs}ms${options.description ? `: ${options.description}` : ''}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
