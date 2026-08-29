/**
 * Reusable repository contract suites.
 *
 * These describe the behaviour every implementation of a repository port must
 * satisfy, expressed against the interface only. The in-memory implementation
 * runs them as unit tests; the DynamoDB implementation runs the same suites as
 * opt-in integration tests (`RUN_DYNAMODB_TESTS=1`).
 *
 * Each `factory` must return a fresh, empty repository.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import type {
  DeliveryRepository,
  EventRepository,
  SubscriptionRepository,
} from '../../src/application/ports.js';
import {
  beginAttempt,
  completeDelivered,
  createDelivery,
  scheduleRetry,
} from '../../src/domain/delivery.js';
import { aDelivery, anEvent, aSubscription } from './factories.js';

export function runSubscriptionRepositoryContract(
  label: string,
  factory: () => SubscriptionRepository,
): void {
  describe(`SubscriptionRepository contract: ${label}`, () => {
    let repository: SubscriptionRepository;

    beforeEach(() => {
      repository = factory();
    });

    it('saves and retrieves a subscription by id', async () => {
      // Arrange
      const subscription = aSubscription();

      // Act
      await repository.save(subscription);

      // Assert
      expect(await repository.get(subscription.id)).toEqual(subscription);
    });

    it('returns undefined for an unknown id', async () => {
      // Arrange — none: the repository is empty.

      // Act
      const found = await repository.get('sub_missing');

      // Assert
      expect(found).toBeUndefined();
    });

    it('save replaces an existing subscription', async () => {
      // Arrange
      const original = aSubscription({ eventType: 'order.created' });
      await repository.save(original);

      // Act
      await repository.save({ ...original, eventType: 'order.updated' });

      // Assert
      expect((await repository.get(original.id))?.eventType).toBe('order.updated');
    });

    it('lists all subscriptions when no filter is given', async () => {
      // Arrange
      await repository.save(aSubscription());
      await repository.save(aSubscription());

      // Act
      const all = await repository.list();

      // Assert
      expect(all).toHaveLength(2);
    });

    it('filters the list by event type', async () => {
      // Arrange
      await repository.save(aSubscription({ eventType: 'order.created' }));
      await repository.save(aSubscription({ eventType: 'order.created' }));
      await repository.save(aSubscription({ eventType: 'order.deleted' }));

      // Act
      const created = await repository.list({ eventType: 'order.created' });

      // Assert
      expect(created).toHaveLength(2);
      expect(created.every((s) => s.eventType === 'order.created')).toBe(true);
    });

    it('delete reports whether the subscription existed', async () => {
      // Arrange
      const subscription = aSubscription();
      await repository.save(subscription);

      // Act
      const first = await repository.delete(subscription.id);
      const second = await repository.delete(subscription.id);

      // Assert
      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(await repository.get(subscription.id)).toBeUndefined();
    });

    it('does not expose stored state through a returned reference', async () => {
      // Arrange
      const subscription = aSubscription();
      await repository.save(subscription);

      // Act
      const retrieved = await repository.get(subscription.id);
      (retrieved as { eventType: string }).eventType = 'mutated';

      // Assert
      expect((await repository.get(subscription.id))?.eventType).toBe(subscription.eventType);
    });
  });
}

export function runEventRepositoryContract(label: string, factory: () => EventRepository): void {
  describe(`EventRepository contract: ${label}`, () => {
    let repository: EventRepository;

    beforeEach(() => {
      repository = factory();
    });

    it('saves and retrieves an event by id', async () => {
      // Arrange
      const event = anEvent();

      // Act
      await repository.save(event);

      // Assert
      expect(await repository.get(event.id)).toEqual(event);
    });

    it('returns undefined for an unknown id', async () => {
      // Arrange — none: the repository is empty.

      // Act
      const found = await repository.get('evt_missing');

      // Assert
      expect(found).toBeUndefined();
    });

    it('preserves the event payload verbatim, including nested data', async () => {
      // Arrange
      const event = anEvent({ data: { nested: { a: 1, b: [2, 3] }, when: null } });

      // Act
      await repository.save(event);

      // Assert
      expect(await repository.get(event.id)).toEqual(event);
    });
  });
}

export function runDeliveryRepositoryContract(
  label: string,
  factory: () => DeliveryRepository,
): void {
  describe(`DeliveryRepository contract: ${label}`, () => {
    let repository: DeliveryRepository;

    beforeEach(() => {
      repository = factory();
    });

    it('saves and retrieves a delivery by id', async () => {
      // Arrange
      const delivery = aDelivery();

      // Act
      await repository.save(delivery);

      // Assert
      expect(await repository.get(delivery.id)).toEqual(delivery);
    });

    it('save persists state transitions', async () => {
      // Arrange
      const now = new Date('2026-08-28T10:15:00.000Z');
      const delivery = createDelivery({
        id: 'del_x',
        eventId: 'evt_x',
        subscriptionId: 'sub_x',
        targetUrl: 'https://subscriber.example/hook',
        now,
      });
      await repository.save(delivery);

      // Act
      await repository.save(completeDelivered(beginAttempt(delivery, now), 200, now));

      // Assert
      const stored = await repository.get('del_x');
      expect(stored?.status).toBe('delivered');
      expect(stored?.attempts).toBe(1);
    });

    it('lists deliveries by event, by subscription, and by status', async () => {
      // Arrange
      await repository.save(aDelivery({ eventId: 'evt_1', subscriptionId: 'sub_a' }));
      await repository.save(aDelivery({ eventId: 'evt_1', subscriptionId: 'sub_b' }));
      await repository.save(
        aDelivery({ eventId: 'evt_2', subscriptionId: 'sub_a', status: 'failed' }),
      );

      // Act
      const byEvent = await repository.list({ eventId: 'evt_1' });
      const bySubscription = await repository.list({ subscriptionId: 'sub_a' });
      const byStatus = await repository.list({ status: 'failed' });

      // Assert
      expect(byEvent).toHaveLength(2);
      expect(bySubscription).toHaveLength(2);
      expect(byStatus).toHaveLength(1);
    });

    it('combines filter fields with AND semantics', async () => {
      // Arrange
      await repository.save(
        aDelivery({ eventId: 'evt_1', subscriptionId: 'sub_a', status: 'pending' }),
      );
      await repository.save(
        aDelivery({ eventId: 'evt_1', subscriptionId: 'sub_a', status: 'delivered' }),
      );

      // Act
      const result = await repository.list({
        eventId: 'evt_1',
        subscriptionId: 'sub_a',
        status: 'delivered',
      });

      // Assert
      expect(result).toHaveLength(1);
      expect(result[0]?.status).toBe('delivered');
    });

    it('listPendingDue returns only pending deliveries due at or before now, oldest first', async () => {
      // Arrange
      await repository.save(
        aDelivery({
          id: 'del_due_old',
          status: 'pending',
          nextAttemptAt: '2026-08-28T10:00:00.000Z',
        }),
      );
      await repository.save(
        aDelivery({
          id: 'del_due_new',
          status: 'pending',
          nextAttemptAt: '2026-08-28T10:00:30.000Z',
        }),
      );
      await repository.save(
        aDelivery({
          id: 'del_future',
          status: 'pending',
          nextAttemptAt: '2026-08-28T11:00:00.000Z',
        }),
      );
      await repository.save(
        aDelivery({ id: 'del_delivering', status: 'delivering', nextAttemptAt: null }),
      );

      // Act
      const due = await repository.listPendingDue(new Date('2026-08-28T10:01:00.000Z'));

      // Assert
      expect(due.map((d) => d.id)).toEqual(['del_due_old', 'del_due_new']);
    });

    it('listStuckDelivering returns delivering deliveries last attempted at or before the cutoff', async () => {
      // Arrange
      await repository.save(
        aDelivery({
          id: 'del_stuck',
          status: 'delivering',
          nextAttemptAt: null,
          lastAttemptAt: '2026-08-28T10:00:00.000Z',
        }),
      );
      await repository.save(
        aDelivery({
          id: 'del_recent',
          status: 'delivering',
          nextAttemptAt: null,
          lastAttemptAt: '2026-08-28T10:04:30.000Z',
        }),
      );
      await repository.save(aDelivery({ id: 'del_pending', status: 'pending' }));

      // Act
      const stuck = await repository.listStuckDelivering(new Date('2026-08-28T10:01:00.000Z'));

      // Assert
      expect(stuck.map((d) => d.id)).toEqual(['del_stuck']);
    });

    it('recovery queries respect the limit', async () => {
      // Arrange
      const scheduled = scheduleRetry(beginAttempt(aDelivery({ status: 'pending' }), new Date()), {
        statusCode: 500,
        error: 'x',
        nextAttemptAt: new Date('2000-01-01T00:00:00.000Z'),
        now: new Date(),
      });
      await repository.save(scheduled);
      await repository.save({ ...scheduled, id: 'del_second' });

      // Act
      const limited = await repository.listPendingDue(new Date(), 1);

      // Assert
      expect(limited).toHaveLength(1);
    });
  });
}
