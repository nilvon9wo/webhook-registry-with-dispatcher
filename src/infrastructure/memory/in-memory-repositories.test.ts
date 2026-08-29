import { describe, expect, it } from 'vitest';
import {
  runDeliveryRepositoryContract,
  runEventRepositoryContract,
  runSubscriptionRepositoryContract,
} from '../../../tests/support/repository-contract.js';
import { aSubscription } from '../../../tests/support/factories.js';
import {
  InMemoryDeliveryRepository,
  InMemoryEventRepository,
  InMemorySubscriptionRepository,
} from './in-memory-repositories.js';

runSubscriptionRepositoryContract('in-memory', () => new InMemorySubscriptionRepository());
runEventRepositoryContract('in-memory', () => new InMemoryEventRepository());
runDeliveryRepositoryContract('in-memory', () => new InMemoryDeliveryRepository());

describe('InMemorySubscriptionRepository isolation', () => {
  it('does not let a caller mutate stored state through the object passed to save', async () => {
    // Arrange
    const repository = new InMemorySubscriptionRepository();
    const subscription = aSubscription();
    await repository.save(subscription);

    // Act
    (subscription as { targetUrl: string }).targetUrl = 'https://evil.example/hook';

    // Assert
    expect((await repository.get(subscription.id))?.targetUrl).toBe(
      'https://subscriber.example/webhooks/orders',
    );
  });

  it('returns an independent array from list()', async () => {
    // Arrange
    const repository = new InMemorySubscriptionRepository();
    await repository.save(aSubscription());

    // Act
    const firstList = await repository.list();

    // Assert — mutating the returned array must not affect the repository
    firstList.pop();
    expect(await repository.list()).toHaveLength(1);
  });
});
