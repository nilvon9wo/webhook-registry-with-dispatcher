/**
 * Retry classification and backoff.
 *
 * Pure functions with no dependency on configuration objects — the dispatcher
 * passes a {@link RetryPolicy} assembled from `AppConfig`.
 */

export type AttemptOutcome =
  | { readonly kind: 'success'; readonly statusCode: number }
  | { readonly kind: 'http-error'; readonly statusCode: number }
  | { readonly kind: 'timeout' }
  | { readonly kind: 'network-error'; readonly message: string };

export type OutcomeClassification = 'success' | 'retryable' | 'permanent';

/**
 * Status codes worth retrying even though they are below 500 or would otherwise
 * be ambiguous: request timeout, too-early, and rate-limited.
 */
const EXPLICITLY_RETRYABLE_STATUS_CODES = new Set([408, 425, 429]);

export function classifyOutcome(outcome: AttemptOutcome): OutcomeClassification {
  switch (outcome.kind) {
    case 'success':
      return 'success';
    case 'timeout':
    case 'network-error':
      return 'retryable';
    case 'http-error':
      return outcome.statusCode >= 500 || EXPLICITLY_RETRYABLE_STATUS_CODES.has(outcome.statusCode)
        ? 'retryable'
        : 'permanent';
  }
}

export interface RetryPolicy {
  /** Total attempts allowed per delivery (initial attempt + retries). */
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
}

/** True if another attempt is permitted after `attemptsMade` attempts. */
export function hasAttemptsRemaining(attemptsMade: number, policy: RetryPolicy): boolean {
  return attemptsMade < policy.maxAttempts;
}

/**
 * Backoff before the next attempt, using capped exponential backoff with full
 * jitter (`random` is injectable for deterministic tests).
 *
 * `attemptsMade` is the number of attempts already completed — so `1` after the
 * first failure gives a delay in `[0, baseDelayMs]`, `2` gives `[0, 2·base]`,
 * and so on, each capped at `maxDelayMs`.
 */
export function computeBackoffMs(
  attemptsMade: number,
  policy: RetryPolicy,
  random: () => number = Math.random,
): number {
  const exponent = Math.max(0, attemptsMade - 1);
  const uncapped = policy.baseDelayMs * 2 ** exponent;
  const capped = Math.min(uncapped, policy.maxDelayMs);
  return Math.round(random() * capped);
}
