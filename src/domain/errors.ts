/**
 * Domain-level error types.
 *
 * These are independent of HTTP and persistence. The HTTP layer maps them to
 * status codes; repositories raise their own infrastructure errors.
 */

/** One or more domain validation problems in a single caller-facing error. */
export class ValidationError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Validation failed:\n- ${problems.join('\n- ')}`);
    this.name = 'ValidationError';
    this.problems = problems;
  }
}

/** Raised when code attempts an illegal delivery status transition. */
export class InvalidDeliveryTransitionError extends Error {
  readonly from: string;
  readonly to: string;

  constructor(from: string, to: string) {
    super(`Invalid delivery status transition: ${from} -> ${to}`);
    this.name = 'InvalidDeliveryTransitionError';
    this.from = from;
    this.to = to;
  }
}
