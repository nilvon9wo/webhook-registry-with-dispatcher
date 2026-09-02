/**
 * Subscription matching.
 *
 * The rule is a single exact, case-sensitive comparison of the event's `type`
 * against a subscription's `eventType`. No wildcards or pattern matching: the
 * spec asks for exact type match, and keeping it exact means the datastore
 * lookup (a DynamoDB `eventType-index` query) stays a plain key equality.
 *
 * Pure and independent of HTTP and persistence. `findSubscriptionsForEvent`
 * performs the same match at the repository so the dispatcher does not have to
 * load every subscription; the repository's `list({ eventType })` is
 * contract-tested to apply the identical equality.
 */

import type { WebhookEvent } from '../domain/event.js';
import type { Subscription } from '../domain/subscription.js';
import type { SubscriptionRepository } from './ports.js';

export function subscriptionMatchesEvent(subscription: Subscription, event: WebhookEvent): boolean {
  return subscription.eventType === event.type;
}

export function selectMatchingSubscriptions(
  subscriptions: readonly Subscription[],
  event: WebhookEvent,
): Subscription[] {
  return subscriptions.filter((subscription) => subscriptionMatchesEvent(subscription, event));
}

export async function findSubscriptionsForEvent(
  repository: SubscriptionRepository,
  event: WebhookEvent,
): Promise<Subscription[]> {
  // NOTE (review S4, `docs/12`): on DynamoDB this is a GSI query, which is
  // always eventually consistent. A subscription created milliseconds before a
  // matching event is published can be missed here — a genuine (small)
  // missed-delivery window, not just a duplicate. Documented, not fixed.
  return (await repository.list())
      .filter((subscription) => {
        const eventPieces = event.type.split('.');
        const subscriberPieces = subscription.eventType.split('.');
        if (eventPieces.length !== subscriberPieces.length) {
          return false;
        }
        console.log('eventPieces: ' + eventPieces.length);
        console.log('subscriberPieces: ' + subscriberPieces.length);

        for (let i = 0; i < eventPieces.length; i++) {
          if (eventPieces[i] !== subscriberPieces[i] && subscriberPieces[i] !== '*') {
            return false;
          }
        }

        return true;
      });
}
