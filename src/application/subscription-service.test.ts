import { describe, expect, it } from 'vitest';
import { captureRejection } from '../../tests/support/capture-error.js';
import { ValidationError } from '../domain/errors.js';
import type { IdGenerator, IdKind } from '../domain/ids.js';
import { InMemorySubscriptionRepository } from '../infrastructure/memory/in-memory-repositories.js';
import { createDnsTargetUrlGuard } from '../infrastructure/ssrf-guard.js';
import { allowAllTargetUrlGuard, SsrfBlockedError } from './target-url-guard.js';
import { fixedClock } from './clock.js';
import { ResourceNotFoundError } from './errors.js';
import { SubscriptionService } from './subscription-service.js';

const CLOCK = fixedClock(new Date('2026-08-28T10:00:00.000Z'));

function sequentialIds(): IdGenerator {
  let n = 0;
  return {
    next: (kind: IdKind) => {
      n += 1;
      return `${kind}_${n}`;
    },
  };
}

function newService(clock = CLOCK): SubscriptionService {
  return new SubscriptionService({
    repository: new InMemorySubscriptionRepository(),
    clock,
    ids: sequentialIds(),
    targetUrlPolicy: { allowInsecure: false },
    targetUrlGuard: allowAllTargetUrlGuard,
  });
}

const VALID_BODY = {
  eventType: 'order.created',
  targetUrl: 'https://customer.example.com/webhooks/orders',
};

describe('SubscriptionService.create', () => {
  it('assigns a server-generated id and equal timestamps', async () => {
    // Arrange
    const service = newService();

    // Act
    const created = await service.create(VALID_BODY);

    // Assert
    expect(created).toEqual({
      id: 'subscription_1',
      eventType: 'order.created',
      targetUrl: 'https://customer.example.com/webhooks/orders',
      createdAt: '2026-08-28T10:00:00.000Z',
      updatedAt: '2026-08-28T10:00:00.000Z',
    });
  });

  it('rejects an invalid body without persisting anything', async () => {
    // Arrange
    const service = newService();

    // Act
    const error = await captureRejection(service.create({ eventType: 'order.created' }));

    // Assert
    expect(error).toBeInstanceOf(ValidationError);
    expect(await service.list()).toHaveLength(0);
  });

  it('rejects a non-https target url under the default policy', async () => {
    // Arrange
    const service = newService();

    // Act
    const error = await captureRejection(
      service.create({ eventType: 'order.created', targetUrl: 'http://plain.example/hook' }),
    );

    // Assert
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('rejects a target URL that resolves to a private address (SSRF guard)', async () => {
    // Arrange — a guard whose DNS lookup returns a private IP.
    const service = new SubscriptionService({
      repository: new InMemorySubscriptionRepository(),
      clock: CLOCK,
      ids: sequentialIds(),
      targetUrlPolicy: { allowInsecure: false },
      targetUrlGuard: createDnsTargetUrlGuard({
        lookup: async () => [{ address: '10.0.0.5' }],
      }),
    });

    // Act
    const error = await captureRejection(
      service.create({
        eventType: 'order.created',
        targetUrl: 'https://internal.example.com/hook',
      }),
    );

    // Assert
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).problems.join(' ')).toMatch(/private/);
    expect(error).not.toBeInstanceOf(SsrfBlockedError);
  });
});

describe('SubscriptionService.get / list', () => {
  it('retrieves a stored subscription', async () => {
    // Arrange
    const service = newService();
    const created = await service.create(VALID_BODY);

    // Act
    const fetched = await service.get(created.id);

    // Assert
    expect(fetched).toEqual(created);
  });

  it('throws ResourceNotFoundError for an unknown id', async () => {
    // Arrange
    const service = newService();

    // Act
    const error = await captureRejection(service.get('subscription_missing'));

    // Assert
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  it('filters the list by event type', async () => {
    // Arrange
    const service = newService();
    await service.create(VALID_BODY);
    await service.create({ ...VALID_BODY, eventType: 'order.deleted' });

    // Act
    const deleted = await service.list({ eventType: 'order.deleted' });

    // Assert
    expect(deleted).toHaveLength(1);
    expect(deleted[0]?.eventType).toBe('order.deleted');
  });
});

describe('SubscriptionService.replace', () => {
  it('replaces fields, preserves id and createdAt, advances updatedAt', async () => {
    // Arrange
    const service = newService(fixedClock(new Date('2026-08-29T12:00:00.000Z')));
    const created = await service.create(VALID_BODY);

    // Act
    const updated = await service.replace(created.id, {
      eventType: 'order.updated',
      targetUrl: 'https://customer.example.com/webhooks/v2',
    });

    // Assert
    expect(updated.id).toBe(created.id);
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.eventType).toBe('order.updated');
    expect(updated.updatedAt).toBe('2026-08-29T12:00:00.000Z');
  });

  it('throws ResourceNotFoundError when the id is unknown (no upsert)', async () => {
    // Arrange
    const service = newService();

    // Act
    const error = await captureRejection(service.replace('subscription_missing', VALID_BODY));

    // Assert
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });

  it('validates the replacement body', async () => {
    // Arrange
    const service = newService();
    const created = await service.create(VALID_BODY);

    // Act
    const error = await captureRejection(service.replace(created.id, { eventType: '' }));

    // Assert
    expect(error).toBeInstanceOf(ValidationError);
  });
});

describe('SubscriptionService.delete', () => {
  it('removes an existing subscription', async () => {
    // Arrange
    const service = newService();
    const created = await service.create(VALID_BODY);

    // Act
    await service.delete(created.id);

    // Assert
    expect(await service.list()).toHaveLength(0);
  });

  it('throws ResourceNotFoundError when the id is unknown', async () => {
    // Arrange
    const service = newService();

    // Act
    const error = await captureRejection(service.delete('subscription_missing'));

    // Assert
    expect(error).toBeInstanceOf(ResourceNotFoundError);
  });
});
