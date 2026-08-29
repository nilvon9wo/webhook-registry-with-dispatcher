/**
 * Subscription domain model.
 *
 * A subscription is a persistent registration: "deliver events of type X to
 * URL Y". IDs and timestamps are assigned by the service, never the client.
 */

import type { TargetUrlPolicy } from './target-url.js';
import { validateTargetUrl } from './target-url.js';
import {
  assertProvided,
  failValidation,
  isPlainObject,
  ProblemCollector,
  validateEventType,
} from './validation.js';

export interface Subscription {
  readonly id: string;
  readonly eventType: string;
  readonly targetUrl: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Client-supplied, validated fields for creating or replacing a subscription. */
export interface SubscriptionInput {
  readonly eventType: string;
  readonly targetUrl: string;
}

/**
 * Validates a raw request body into a {@link SubscriptionInput}.
 * Throws {@link ValidationError} listing every problem found.
 */
export function parseSubscriptionInput(raw: unknown, policy: TargetUrlPolicy): SubscriptionInput {
  if (!isPlainObject(raw)) {
    failValidation('request body must be a JSON object');
  }

  const problems = new ProblemCollector();
  const eventType = validateEventType(raw.eventType, 'eventType', problems);
  const targetUrl = validateTargetUrl(raw.targetUrl, policy, problems);
  problems.throwIfAny();

  return {
    eventType: assertProvided(eventType, 'eventType'),
    targetUrl: assertProvided(targetUrl, 'targetUrl'),
  };
}

export function createSubscription(input: SubscriptionInput, id: string, now: Date): Subscription {
  const timestamp = now.toISOString();
  return {
    id,
    eventType: input.eventType,
    targetUrl: input.targetUrl,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

/**
 * Produces the replaced subscription for `PUT /subscriptions/{id}`. `id` and
 * `createdAt` are preserved; `updatedAt` advances.
 */
export function replaceSubscription(
  existing: Subscription,
  input: SubscriptionInput,
  now: Date,
): Subscription {
  return {
    ...existing,
    eventType: input.eventType,
    targetUrl: input.targetUrl,
    updatedAt: now.toISOString(),
  };
}
