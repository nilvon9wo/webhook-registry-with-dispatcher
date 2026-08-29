/**
 * Maps errors to HTTP responses with a consistent JSON body:
 *
 *   { "error": { "message": string, "details"?: string[] } }
 */

import { ResourceNotFoundError } from '../application/errors.js';
import { InvalidDeliveryTransitionError, ValidationError } from '../domain/errors.js';
import type { HandlerResult } from './router.js';

export class HttpError extends Error {
  readonly status: number;
  readonly details: readonly string[] | undefined;

  constructor(status: number, message: string, details?: readonly string[]) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
    this.details = details;
  }
}

export function errorResponse(
  status: number,
  message: string,
  details?: readonly string[],
): HandlerResult {
  return {
    status,
    body: { error: details ? { message, details } : { message } },
  };
}

/**
 * Translates a thrown value into a response. Known domain/application errors map
 * to 4xx; anything else is a 500 with a generic message (details are logged, not
 * returned).
 */
export function toErrorResponse(error: unknown): { response: HandlerResult; serverFault: boolean } {
  if (error instanceof HttpError) {
    return {
      response: errorResponse(error.status, error.message, error.details),
      serverFault: error.status >= 500,
    };
  }
  if (error instanceof ValidationError) {
    return {
      response: errorResponse(400, 'Validation failed', error.problems),
      serverFault: false,
    };
  }
  if (error instanceof ResourceNotFoundError) {
    return { response: errorResponse(404, error.message), serverFault: false };
  }
  if (error instanceof InvalidDeliveryTransitionError) {
    // Reaching HTTP means a programming error in the state machine usage.
    return { response: errorResponse(500, 'Internal server error'), serverFault: true };
  }
  return { response: errorResponse(500, 'Internal server error'), serverFault: true };
}
