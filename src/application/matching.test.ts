import { describe, expect, it } from 'vitest';
import { anEvent, aSubscription } from '../../tests/support/factories.js';
import { InMemorySubscriptionRepository } from '../infrastructure/memory/in-memory-repositories.js';
import {
  findSubscriptionsForEvent,
  selectMatchingSubscriptions,
  subscriptionMatchesEvent,
} from './matching.js';

describe('subscriptionMatchesEvent', () => {
  it('matches when eventType equals the event type', () => {
    // Arrange
    const subscription = aSubscription({ eventType: 'order.created' });
    const event = anEvent({ type: 'order.created' });

    // Act
    const matches = subscriptionMatchesEvent(subscription, event);

    // Assert
    expect(matches).toBe(true);
  });

  it.each([
    { eventType: 'order.updated', reason: 'different type' },
    { eventType: 'Order.Created', reason: 'different case' },
    { eventType: 'order.created ', reason: 'trailing space' },
  ])('does not match on $reason', ({ eventType }) => {
    // Arrange
    const subscription = aSubscription({ eventType });
    const event = anEvent({ type: 'order.created' });

    // Act
    const matches = subscriptionMatchesEvent(subscription, event);

    // Assert
    expect(matches).toBe(false);
  });
});

describe('selectMatchingSubscriptions', () => {
  const event = anEvent({ type: 'order.created' });

  it('returns nothing when no subscription matches', () => {
    // Arrange
    const subscriptions = [
      aSubscription({ eventType: 'order.updated' }),
      aSubscription({ eventType: 'customer.created' }),
    ];

    // Act
    const matched = selectMatchingSubscriptions(subscriptions, event);

    // Assert
    expect(matched).toEqual([]);
  });

  it('returns the single matching subscription', () => {
    // Arrange
    const target = aSubscription({ eventType: 'order.created' });
    const subscriptions = [aSubscription({ eventType: 'order.updated' }), target];

    // Act
    const matched = selectMatchingSubscriptions(subscriptions, event);

    // Assert
    expect(matched).toEqual([target]);
  });

  it('returns every matching subscription and no others', () => {
    // Arrange
    const a = aSubscription({ eventType: 'order.created' });
    const b = aSubscription({ eventType: 'order.created' });
    const c = aSubscription({ eventType: 'order.created' });
    const other = aSubscription({ eventType: 'order.deleted' });

    // Act
    const matched = selectMatchingSubscriptions([a, other, b, c], event);

    // Assert
    expect(matched).toEqual([a, b, c]);
  });

  it('preserves input order (deterministic)', () => {
    // Arrange
    const first = aSubscription({ id: 'sub_first', eventType: 'order.created' });
    const second = aSubscription({ id: 'sub_second', eventType: 'order.created' });

    // Act
    const matched = selectMatchingSubscriptions([first, second], event);

    // Assert
    expect(matched.map((subscription) => subscription.id)).toEqual(['sub_first', 'sub_second']);
  });
});

describe('findSubscriptionsForEvent', () => {
  it('returns only the subscriptions whose eventType matches the event', async () => {
    // Arrange
    const repository = new InMemorySubscriptionRepository();
    await repository.save(aSubscription({ id: 'sub_a', eventType: 'order.created' }));
    await repository.save(aSubscription({ id: 'sub_b', eventType: 'order.created' }));
    await repository.save(aSubscription({ id: 'sub_c', eventType: 'order.deleted' }));

    // Act
    const matched = await findSubscriptionsForEvent(repository, anEvent({ type: 'order.created' }));

    // Assert
    expect(matched.map((subscription) => subscription.id).sort()).toEqual(['sub_a', 'sub_b']);
  });

  it('returns an empty list when nothing matches', async () => {
    // Arrange
    const repository = new InMemorySubscriptionRepository();
    await repository.save(aSubscription({ eventType: 'order.created' }));

    // Act
    const matched = await findSubscriptionsForEvent(repository, anEvent({ type: 'nothing.here' }));

    // Assert
    expect(matched).toEqual([]);
  });

  it('returns an empty list when nothing matches despite *', async () => {
    // Arrange
    const repository = new InMemorySubscriptionRepository();
    await repository.save(aSubscription({ eventType: 'order.*' }));

    // Act
    const matched = await findSubscriptionsForEvent(repository, anEvent({ type: 'user.updated' }));

    // Assert
    expect(matched).toEqual([]);
  });

  it('returns the subscription using * matches the event', async () => {
    // Arrange
    const repository = new InMemorySubscriptionRepository();
    await repository.save(aSubscription({ eventType: 'order.*' }));

    // Act
    const matched = await findSubscriptionsForEvent(repository, anEvent({ type: 'order.updated' }));

    // Assert
    expect(matched.map((subscription) => subscription.eventType).sort()).toEqual(['order.*']);
  });

  it('does not return the subscription when not enough *', async () => {
    // Arrange
    const repository = new InMemorySubscriptionRepository();
    await repository.save(aSubscription({ eventType: 'order.*' }));

    // Act
    const matched = await findSubscriptionsForEvent(repository, anEvent({ type: 'order.updated.status' }));

    // Assert
    expect(matched).toEqual([]);
  });

  it('does not return the subscription when mismatched part', async () => {
    // Arrange
    const repository = new InMemorySubscriptionRepository();
    await repository.save(aSubscription({ eventType: 'order.*.foo' }));

    // Act
    const matched = await findSubscriptionsForEvent(repository, anEvent({ type: 'order.updated.status' }));

    // Assert
    expect(matched).toEqual([]);
  });

  it('returns the subscription when enough *', async () => {
    // Arrange
    const repository = new InMemorySubscriptionRepository();
    await repository.save(aSubscription({ eventType: 'order.*.*.*' }));

    // Act
    const matched = await findSubscriptionsForEvent(repository, anEvent({ type: 'order.updated.status' }));

    // Assert
    expect(matched).toEqual([]);
  });

  it('returns the subscription when * is in middle', async () => {
    // Arrange
    const repository = new InMemorySubscriptionRepository();
    await repository.save(aSubscription({ eventType: 'order.*.status'}));

    // Act
    const matched = await findSubscriptionsForEvent(repository, anEvent({ type: 'order.updated.status' }));

    // Assert
    expect(matched.map((subscription) => subscription.eventType).sort()).toEqual(['order.*.status']);
  });

  it('returns the subscription when * is at end', async () => {
    // Arrange
    const repository = new InMemorySubscriptionRepository();
    await repository.save(aSubscription({ eventType: 'order.updated.*'}));

    // Act
    const matched = await findSubscriptionsForEvent(repository, anEvent({ type: 'order.updated.status' }));

    // Assert
    expect(matched.map((subscription) => subscription.eventType).sort()).toEqual(['order.updated.*']);
  });

  it('does not return the subscription when mismatched ending', async () => {
    // Arrange
    const repository = new InMemorySubscriptionRepository();
    await repository.save(aSubscription({ eventType: 'order.updated.somethingelse'}));

    // Act
    const matched = await findSubscriptionsForEvent(repository, anEvent({ type: 'order.updated.status' }));

    // Assert
    expect(matched).toEqual([]);
  });
});
