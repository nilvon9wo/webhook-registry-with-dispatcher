/**
 * In-memory repository implementations.
 *
 * Used by the unit/integration tests and as the default local-development store
 * (`PERSISTENCE=memory`). Values are deep-cloned on the way in and out so a
 * caller cannot mutate stored state by holding onto a reference.
 *
 * These implementations are intentionally simple linear scans — correctness and
 * readability matter here, not throughput.
 */

import type { Delivery } from '../../domain/delivery.js';
import type { WebhookEvent } from '../../domain/event.js';
import type { Subscription } from '../../domain/subscription.js';
import type {
  DeliveryListFilter,
  DeliveryRepository,
  EventRepository,
  SubscriptionListFilter,
  SubscriptionRepository,
} from '../../application/ports.js';
import { applyLimit, byIsoAscending } from '../repository-support.js';

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class InMemorySubscriptionRepository implements SubscriptionRepository {
  private readonly byId = new Map<string, Subscription>();

  async save(subscription: Subscription): Promise<void> {
    this.byId.set(subscription.id, clone(subscription));
  }

  async get(id: string): Promise<Subscription | undefined> {
    const found = this.byId.get(id);
    return found === undefined ? undefined : clone(found);
  }

  async list(filter: SubscriptionListFilter = {}): Promise<Subscription[]> {
    const all = [...this.byId.values()];
    const matched =
      filter.eventType === undefined
        ? all
        : all.filter((subscription) => subscription.eventType === filter.eventType);
    return matched.map(clone);
  }

  async delete(id: string): Promise<boolean> {
    return this.byId.delete(id);
  }
}

export class InMemoryEventRepository implements EventRepository {
  private readonly byId = new Map<string, WebhookEvent>();

  async save(event: WebhookEvent): Promise<void> {
    this.byId.set(event.id, clone(event));
  }

  async get(id: string): Promise<WebhookEvent | undefined> {
    const found = this.byId.get(id);
    return found === undefined ? undefined : clone(found);
  }
}

export class InMemoryDeliveryRepository implements DeliveryRepository {
  private readonly byId = new Map<string, Delivery>();

  async save(delivery: Delivery): Promise<void> {
    this.byId.set(delivery.id, clone(delivery));
  }

  async get(id: string): Promise<Delivery | undefined> {
    const found = this.byId.get(id);
    return found === undefined ? undefined : clone(found);
  }

  async list(filter: DeliveryListFilter = {}): Promise<Delivery[]> {
    const matched = [...this.byId.values()].filter(
      (delivery) =>
        (filter.eventId === undefined || delivery.eventId === filter.eventId) &&
        (filter.subscriptionId === undefined ||
          delivery.subscriptionId === filter.subscriptionId) &&
        (filter.status === undefined || delivery.status === filter.status),
    );
    return matched.map(clone);
  }

  async listPendingDue(now: Date, limit?: number): Promise<Delivery[]> {
    const dueAt = now.getTime();
    const due = [...this.byId.values()]
      .filter(
        (delivery) =>
          delivery.status === 'pending' &&
          delivery.nextAttemptAt !== null &&
          Date.parse(delivery.nextAttemptAt) <= dueAt,
      )
      .sort(byIsoAscending((delivery) => delivery.nextAttemptAt));
    return applyLimit(due, limit).map(clone);
  }

  async listStuckDelivering(before: Date, limit?: number): Promise<Delivery[]> {
    const cutoff = before.getTime();
    const stuck = [...this.byId.values()]
      .filter(
        (delivery) =>
          delivery.status === 'delivering' &&
          delivery.lastAttemptAt !== null &&
          Date.parse(delivery.lastAttemptAt) <= cutoff,
      )
      .sort(byIsoAscending((delivery) => delivery.lastAttemptAt));
    return applyLimit(stuck, limit).map(clone);
  }
}
