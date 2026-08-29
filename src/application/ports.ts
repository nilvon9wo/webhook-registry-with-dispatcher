/**
 * Persistence ports.
 *
 * The application and domain layers depend only on these interfaces, never on a
 * concrete store. Implementations live in `src/infrastructure/*` (an in-memory
 * store for tests and local development, DynamoDB for the real service).
 *
 * The method set is derived directly from the access patterns in
 * `docs/4 - architecture.md`:
 *
 *   - get subscription by id                       → SubscriptionRepository.get
 *   - list subscriptions / filter by event type    → SubscriptionRepository.list
 *   - get event by id                              → EventRepository.get
 *   - get delivery by id                           → DeliveryRepository.get
 *   - deliveries by event / subscription / status  → DeliveryRepository.list
 *   - retryable + abandoned deliveries (recovery)  → DeliveryRepository.listPendingDue
 *                                                    + listStuckDelivering
 */

import type { Delivery, DeliveryStatus } from '../domain/delivery.js';
import type { WebhookEvent } from '../domain/event.js';
import type { Subscription } from '../domain/subscription.js';

export interface SubscriptionListFilter {
  readonly eventType?: string;
}

export interface SubscriptionRepository {
  /** Insert or replace a subscription by its id. */
  save(subscription: Subscription): Promise<void>;
  get(id: string): Promise<Subscription | undefined>;
  /** All subscriptions, optionally narrowed to one event type. Insertion order. */
  list(filter?: SubscriptionListFilter): Promise<Subscription[]>;
  /** Removes the subscription. Resolves `true` if it existed, `false` otherwise. */
  delete(id: string): Promise<boolean>;
}

export interface EventRepository {
  save(event: WebhookEvent): Promise<void>;
  get(id: string): Promise<WebhookEvent | undefined>;
}

export interface DeliveryListFilter {
  readonly eventId?: string;
  readonly subscriptionId?: string;
  readonly status?: DeliveryStatus;
}

export interface DeliveryRepository {
  /** Insert or replace a delivery by its id (used for every state transition). */
  save(delivery: Delivery): Promise<void>;
  get(id: string): Promise<Delivery | undefined>;
  /** Deliveries matching every provided filter field. Insertion order. */
  list(filter?: DeliveryListFilter): Promise<Delivery[]>;
  /**
   * Recovery query: `pending` deliveries whose `nextAttemptAt` is at or before
   * `now`, ordered by `nextAttemptAt` ascending (longest-overdue first).
   */
  listPendingDue(now: Date, limit?: number): Promise<Delivery[]>;
  /**
   * Recovery query: `delivering` deliveries whose last attempt started at or
   * before `before` (abandoned by a crash mid-attempt), ordered by
   * `lastAttemptAt` ascending (longest-stuck first).
   */
  listStuckDelivering(before: Date, limit?: number): Promise<Delivery[]>;
}
