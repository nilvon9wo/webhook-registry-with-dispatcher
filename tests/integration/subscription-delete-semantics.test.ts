import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Delivery } from '../../src/domain/delivery.js';
import type { WebhookEvent } from '../../src/domain/event.js';
import { startTestApp, type TestApp } from '../support/test-app.js';
import { startWebhookRecorder, type WebhookRecorder } from '../support/webhook-recorder.js';
import { waitFor } from '../support/wait-for.js';

let app: TestApp;
let recorder: WebhookRecorder;

beforeEach(async () => {
  recorder = await startWebhookRecorder({ status: 200 });
  app = await startTestApp();
});

afterEach(async () => {
  await app.close();
  await recorder.close();
});

async function createSubscription(eventType = 'order.created'): Promise<string> {
  const created = await app.request<{ id: string }>('POST', '/subscriptions', {
    eventType,
    targetUrl: recorder.url,
  });
  return created.body.id;
}

/** Publishes an event and waits until any resulting deliveries have settled (or none appear). */
async function publish(type = 'order.created'): Promise<string> {
  const published = await app.request<WebhookEvent>('POST', '/events', { type });
  const eventId = published.body.id;
  await waitFor(async () => {
    const deliveries = await app.application.repositories.deliveries.list({ eventId });
    return deliveries.length > 0 && deliveries.every((d: Delivery) => d.completedAt !== null);
  }).catch(() => {
    // "no deliveries" is a valid outcome for the deleted-subscription case.
  });
  return eventId;
}

const deliveriesFor = (filter: {
  eventId?: string;
  subscriptionId?: string;
}): Promise<Delivery[]> => app.application.repositories.deliveries.list(filter);

describe('DELETE /subscriptions/{id} semantics (spec section 3)', () => {
  it('prevents deliveries for events published after the deletion', async () => {
    // Arrange — a subscription that has already received one event.
    const subscriptionId = await createSubscription();
    await publish();

    // Act
    const deleted = await app.request('DELETE', `/subscriptions/${subscriptionId}`);

    // Assert
    expect(deleted.status).toBe(204);
    const laterEventId = await publish();
    expect(await deliveriesFor({ eventId: laterEventId })).toEqual([]);
    expect(recorder.received).toHaveLength(1);
  });

  it('leaves historical delivery records untouched', async () => {
    // Arrange — a subscription with one settled delivery on record.
    const subscriptionId = await createSubscription();
    await publish();
    const [historical] = await deliveriesFor({ subscriptionId });

    // Sanity Check — the historical delivery must exist for this test to mean anything.
    expect(historical).toBeDefined();

    // Act
    await app.request('DELETE', `/subscriptions/${subscriptionId}`);

    // Assert
    const afterDelete = await deliveriesFor({ subscriptionId });
    expect(afterDelete).toEqual([historical]);
  });
});

describe('PUT /subscriptions/{id} re-routes matching', () => {
  it('an event of the old type no longer matches after the eventType is replaced', async () => {
    // Arrange
    const subscriptionId = await createSubscription('order.created');

    // Act
    await app.request('PUT', `/subscriptions/${subscriptionId}`, {
      eventType: 'order.updated',
      targetUrl: recorder.url,
    });

    // Assert
    const oldTypeEventId = await publish('order.created');
    const newTypeEventId = await publish('order.updated');
    await waitFor(async () => {
      const deliveries = await deliveriesFor({ eventId: newTypeEventId });
      return deliveries.some((d: Delivery) => d.status === 'delivered');
    });
    expect(await deliveriesFor({ eventId: oldTypeEventId })).toEqual([]);
  });
});
