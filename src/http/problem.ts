/**
 * Maps errors to HTTP responses with a consistent JSON body:
 *
 *   { "error": { "message": string, "details"?: string[] } }
 */

import { ResourceNotFoundError } from '../application/errors.js';
import { ValidationError } from '../domain/errors.js';
import type { HandlerResult } from './router.js';

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
  if (error instanceof ValidationError) {
    return {
      response: errorResponse(400, 'Validation failed', error.problems),
      serverFault: false,
    };
  }
  if (error instanceof ResourceNotFoundError) {
    return { response: errorResponse(404, error.message), serverFault: false };
  }
  // Anything else (incl. InvalidDeliveryTransitionError, which would be a
  // state-machine misuse bug) is an internal fault: generic body, details logged.
  return { response: errorResponse(500, 'Internal server error'), serverFault: true };
}
