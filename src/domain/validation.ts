/**
 * Small, dependency-free validation primitives shared by the domain models.
 */

import { ValidationError } from './errors.js';

/** Accumulates validation problems so a request can report all of them at once. */
export class ProblemCollector {
  private readonly problems: string[] = [];

  add(problem: string): void {
    this.problems.push(problem);
  }

  get hasProblems(): boolean {
    return this.problems.length > 0;
  }

  list(): readonly string[] {
    return [...this.problems];
  }

  /** Throws a {@link ValidationError} if any problem has been recorded. */
  throwIfAny(): void {
    if (this.hasProblems) {
      throw new ValidationError(this.problems);
    }
  }
}

/**
 * Narrowing guard for "plain JSON object": a non-null object that is not an
 * array. Used for request bodies and event payloads.
 */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Immediately throws a {@link ValidationError} for the given problem(s). */
export function failValidation(...problems: string[]): never {
  throw new ValidationError(problems);
}

/**
 * Asserts a value the validators have already checked is present. Reaching the
 * `undefined` branch means a validator recorded a problem but the caller did not
 * call {@link ProblemCollector.throwIfAny} first — a programming error.
 */
export function assertProvided<T>(value: T | undefined, fieldName: string): T {
  if (value === undefined) {
    throw new Error(`internal error: ${fieldName} used before validation completed`);
  }
  return value;
}

export const MAX_EVENT_TYPE_LENGTH = 100;

/**
 * Event types are dot/underscore/hyphen separated alphanumeric segments,
 * e.g. `order.created`. Deliberately conservative so the same string is safe as
 * a log field, a DynamoDB key, and a query-string filter value.
 */
export const EVENT_TYPE_PATTERN = /^[A-Za-z0-9]+([._-][A-Za-z0-9]+)*$/;

/**
 * Validates and normalizes an event-type string (used for both a subscription's
 * `eventType` and an event's `type`). Returns the trimmed value, or `undefined`
 * after recording a problem.
 */
export function validateEventType(
  value: unknown,
  fieldName: string,
  problems: ProblemCollector,
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    problems.add(`${fieldName} is required and must be a non-empty string`);
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > MAX_EVENT_TYPE_LENGTH) {
    problems.add(`${fieldName} must be at most ${MAX_EVENT_TYPE_LENGTH} characters`);
    return undefined;
  }
  if (!EVENT_TYPE_PATTERN.test(trimmed)) {
    problems.add(
      `${fieldName} must be dot/underscore/hyphen separated alphanumeric segments (e.g. "order.created")`,
    );
    return undefined;
  }
  return trimmed;
}
