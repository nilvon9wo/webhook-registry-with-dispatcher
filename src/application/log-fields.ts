/**
 * Builders for recurring structured-log field groups, so the same concept always
 * serialises to the same field names. See `docs/11 - logging.md` for the full
 * field dictionary.
 */

import type { Delivery } from '../domain/delivery.js';
import type { WebhookEvent } from '../domain/event.js';
import { classifyOutcome, type AttemptOutcome } from '../domain/retry-policy.js';
import type { Subscription } from '../domain/subscription.js';
import type { LogFields } from './logging.js';

/** Hostname of a URL for logging — never the full URL (its path may be a secret). */
export function targetHost(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return 'invalid-url';
  }
}

export function eventFields(event: WebhookEvent): LogFields {
  return { eventId: event.id, eventType: event.type };
}

export function subscriptionFields(subscription: Subscription): LogFields {
  return { subscriptionId: subscription.id, eventType: subscription.eventType };
}

/** Stable correlation fields for one delivery (no volatile status/attempt). */
export function deliveryFields(delivery: Delivery): LogFields {
  return {
    deliveryId: delivery.id,
    eventId: delivery.eventId,
    subscriptionId: delivery.subscriptionId,
    targetHost: targetHost(delivery.targetUrl),
  };
}

export function outcomeFields(outcome: AttemptOutcome): LogFields {
  return {
    outcome: classifyOutcome(outcome),
    httpStatus:
      outcome.kind === 'success' || outcome.kind === 'http-error' ? outcome.statusCode : null,
  };
}
