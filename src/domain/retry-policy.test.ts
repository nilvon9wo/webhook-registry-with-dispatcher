import { describe, expect, it } from 'vitest';
import {
  type AttemptOutcome,
  classifyOutcome,
  computeBackoffMs,
  hasAttemptsRemaining,
  type RetryPolicy,
} from './retry-policy.js';

const POLICY: RetryPolicy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 30_000 };

describe('classifyOutcome', () => {
  it.each([
    { outcome: { kind: 'success', statusCode: 200 }, expected: 'success' },
    { outcome: { kind: 'success', statusCode: 204 }, expected: 'success' },
    { outcome: { kind: 'timeout' }, expected: 'retryable' },
    { outcome: { kind: 'network-error', message: 'ECONNRESET' }, expected: 'retryable' },
    { outcome: { kind: 'http-error', statusCode: 500 }, expected: 'retryable' },
    { outcome: { kind: 'http-error', statusCode: 502 }, expected: 'retryable' },
    { outcome: { kind: 'http-error', statusCode: 503 }, expected: 'retryable' },
    { outcome: { kind: 'http-error', statusCode: 429 }, expected: 'retryable' },
    { outcome: { kind: 'http-error', statusCode: 408 }, expected: 'retryable' },
    { outcome: { kind: 'http-error', statusCode: 400 }, expected: 'permanent' },
    { outcome: { kind: 'http-error', statusCode: 401 }, expected: 'permanent' },
    { outcome: { kind: 'http-error', statusCode: 404 }, expected: 'permanent' },
    { outcome: { kind: 'http-error', statusCode: 410 }, expected: 'permanent' },
    { outcome: { kind: 'http-error', statusCode: 301 }, expected: 'permanent' },
  ] as { outcome: AttemptOutcome; expected: string }[])(
    'classifies $outcome.kind/$outcome.statusCode as $expected',
    ({ outcome, expected }) => {
      // Arrange — none: the outcome is the sole input.

      // Act
      const classification = classifyOutcome(outcome);

      // Assert
      expect(classification).toBe(expected);
    },
  );
});

describe('hasAttemptsRemaining', () => {
  it.each([
    { attemptsMade: 0, expected: true },
    { attemptsMade: 4, expected: true },
    { attemptsMade: 5, expected: false },
    { attemptsMade: 6, expected: false },
  ])('with $attemptsMade of 5 attempts made → $expected', ({ attemptsMade, expected }) => {
    // Arrange — the shared 5-attempt policy.

    // Act
    const result = hasAttemptsRemaining(attemptsMade, POLICY);

    // Assert
    expect(result).toBe(expected);
  });
});

describe('computeBackoffMs', () => {
  it.each([
    { attemptsMade: 1, expected: 500 },
    { attemptsMade: 2, expected: 1000 },
    { attemptsMade: 3, expected: 2000 },
    { attemptsMade: 4, expected: 4000 },
  ])(
    'grows exponentially: attempt $attemptsMade with jitter=1 → the full window of $expected ms',
    ({ attemptsMade, expected }) => {
      // Arrange
      const random = (): number => 1;

      // Act
      const delay = computeBackoffMs(attemptsMade, POLICY, random);

      // Assert
      expect(delay).toBe(expected);
    },
  );

  it('equal jitter: half fixed, half random — jitter=0 gives half the window', () => {
    // Arrange — attempt 3 window is 2000ms.
    const random = (): number => 0;

    // Act
    const delay = computeBackoffMs(3, POLICY, random);

    // Assert
    expect(delay).toBe(1000);
  });

  it('jitter=0.25 lands a quarter of the way into the random half', () => {
    // Arrange — attempt 3 window 2000ms: 1000 fixed + 0.25 * 1000.
    const random = (): number => 0.25;

    // Act
    const delay = computeBackoffMs(3, POLICY, random);

    // Assert
    expect(delay).toBe(1250);
  });

  it('never exceeds maxDelayMs however large the exponent', () => {
    // Arrange
    const random = (): number => 1;

    // Act
    const delay = computeBackoffMs(20, POLICY, random);

    // Assert
    expect(delay).toBe(POLICY.maxDelayMs);
  });
});
