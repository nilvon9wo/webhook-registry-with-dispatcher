import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Delivery } from '../../src/domain/delivery.js';
import { aDelivery } from '../support/factories.js';
import { startTestApp, type TestApp } from '../support/test-app.js';

let app: TestApp;

beforeEach(async () => {
  app = await startTestApp();
});

afterEach(async () => {
  await app.close();
});

interface DeliveriesBody {
  readonly deliveries: Delivery[];
}

async function seed(deliveries: Delivery[]): Promise<void> {
  for (const delivery of deliveries) {
    await app.application.repositories.deliveries.save(delivery);
  }
}

describe('GET /deliveries', () => {
  it('lists every delivery when no filter is given', async () => {
    // Arrange
    await seed([aDelivery(), aDelivery(), aDelivery()]);

    // Act
    const response = await app.request<DeliveriesBody>('GET', '/deliveries');

    // Assert
    expect(response.status).toBe(200);
    expect(response.body.deliveries).toHaveLength(3);
  });

  it.each([
    { query: 'eventId=evt_target', matches: 2 },
    { query: 'subscriptionId=sub_target', matches: 1 },
    { query: 'status=failed', matches: 1 },
    { query: 'eventId=evt_target&status=delivered', matches: 1 },
  ])('filters with ?$query -> $matches result(s)', async ({ query, matches }) => {
    // Arrange
    await seed([
      aDelivery({ eventId: 'evt_target', subscriptionId: 'sub_target', status: 'failed' }),
      aDelivery({ eventId: 'evt_target', subscriptionId: 'sub_other', status: 'delivered' }),
      aDelivery({ eventId: 'evt_other', subscriptionId: 'sub_other', status: 'pending' }),
    ]);

    // Act
    const response = await app.request<DeliveriesBody>('GET', `/deliveries?${query}`);

    // Assert
    expect(response.status).toBe(200);
    expect(response.body.deliveries).toHaveLength(matches);
  });

  it('rejects an unknown status filter with 400', async () => {
    // Arrange — nothing seeded.

    // Act
    const response = await app.request('GET', '/deliveries?status=bogus');

    // Assert
    expect(response.status).toBe(400);
  });
});

describe('GET /deliveries/{id}', () => {
  it('returns the full delivery record', async () => {
    // Arrange
    const delivery = aDelivery({
      id: 'del_1',
      status: 'failed',
      attempts: 3,
      lastStatusCode: 503,
      lastError: 'HTTP 503',
      completedAt: '2026-08-28T10:20:00.000Z',
    });
    await seed([delivery]);

    // Act
    const response = await app.request<Delivery>('GET', '/deliveries/del_1');

    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual(delivery);
  });

  it('returns 404 for an unknown id', async () => {
    // Arrange — nothing seeded.

    // Act
    const response = await app.request('GET', '/deliveries/del_missing');

    // Assert
    expect(response.status).toBe(404);
  });
});
