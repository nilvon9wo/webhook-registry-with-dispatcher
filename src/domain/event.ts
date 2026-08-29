/**
 * Event domain model.
 *
 * An event is a notification submitted to this service. It is persisted with a
 * service-assigned ID and timestamp before any dispatch is attempted, so an
 * accepted event survives a process crash.
 *
 * Named `WebhookEvent` rather than `Event` to avoid colliding with the Node
 * global `Event`.
 */

import {
  assertProvided,
  failValidation,
  isPlainObject,
  ProblemCollector,
  validateEventType,
} from './validation.js';

export interface WebhookEvent {
  readonly id: string;
  readonly type: string;
  readonly data: Record<string, unknown>;
  readonly createdAt: string;
}

/** Client-supplied, validated fields for `POST /events`. */
export interface EventInput {
  readonly type: string;
  readonly data: Record<string, unknown>;
}

/**
 * Validates a raw request body into an {@link EventInput}. `data` is optional
 * and defaults to `{}`; when present it must be a JSON object.
 */
export function parseEventInput(raw: unknown): EventInput {
  if (!isPlainObject(raw)) {
    failValidation('request body must be a JSON object');
  }

  const problems = new ProblemCollector();
  const type = validateEventType(raw.type, 'type', problems);

  let data: Record<string, unknown> = {};
  if (raw.data !== undefined) {
    if (isPlainObject(raw.data)) {
      data = raw.data;
    } else {
      problems.add('data must be a JSON object when provided');
    }
  }

  problems.throwIfAny();
  return { type: assertProvided(type, 'type'), data };
}

export function createEvent(input: EventInput, id: string, now: Date): WebhookEvent {
  return {
    id,
    type: input.type,
    data: input.data,
    createdAt: now.toISOString(),
  };
}

/** The JSON body POSTed to a subscriber (spec section 4). */
export interface WebhookDeliveryPayload {
  readonly id: string;
  readonly type: string;
  readonly timestamp: string;
  readonly data: Record<string, unknown>;
}

export function toDeliveryPayload(event: WebhookEvent): WebhookDeliveryPayload {
  return {
    id: event.id,
    type: event.type,
    timestamp: event.createdAt,
    data: event.data,
  };
}
