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

async function publishAndSettle(): Promise<string> {
  const published = await app.request<WebhookEvent>('POST', '/events', { type: 'order.created' });
  const eventId = published.body.id;
  await waitFor(async () => {
    const deliveries = await app.application.repositories.deliveries.list({ eventId });
    return deliveries.length > 0 && deliveries.every((d: Delivery) => d.completedAt !== null);
  }).catch(() => {
    // No deliveries at all is a valid outcome for one of these tests.
  });
  return eventId;
}

describe('DELETE /subscriptions/{id} semantics (spec section 3)', () => {
  it('prevents future deliveries but leaves historical delivery records intact', async () => {
    // Arrange — subscription receives one event, then is deleted.
    const created = await app.request<{ id: string }>('POST', '/subscriptions', {
      eventType: 'order.created',
      targetUrl: recorder.url,
    });
    const subscriptionId = created.body.id;
    const firstEventId = await publishAndSettle();

    const historical = await app.application.repositories.deliveries.list({ subscriptionId });
    expect(historical).toHaveLength(1);

    // Act
    const deleted = await app.request('DELETE', `/subscriptions/${subscriptionId}`);
    const secondEventId = await publishAndSettle();

    // Assert — no new delivery for the deleted subscription...
    expect(deleted.status).toBe(204);
    expect(await app.application.repositories.deliveries.list({ eventId: secondEventId })).toEqual(
      [],
    );
    expect(recorder.received).toHaveLength(1);

    // ...and the historical record is unchanged.
    const afterDelete = await app.application.repositories.deliveries.list({ subscriptionId });
    expect(afterDelete).toHaveLength(1);
    expect(afterDelete[0]).toEqual(historical[0]);
    expect((afterDelete[0] as Delivery).eventId).toBe(firstEventId);
  });
});

describe('PUT /subscriptions/{id} re-routes matching', () => {
  it('an event of the old type no longer matches after the eventType is replaced', async () => {
    // Arrange
    const created = await app.request<{ id: string }>('POST', '/subscriptions', {
      eventType: 'order.created',
      targetUrl: recorder.url,
    });

    // Act
    await app.request('PUT', `/subscriptions/${created.body.id}`, {
      eventType: 'order.updated',
      targetUrl: recorder.url,
    });
    const oldTypeEvent = await app.request<WebhookEvent>('POST', '/events', {
      type: 'order.created',
    });
    const newTypeEvent = await app.request<WebhookEvent>('POST', '/events', {
      type: 'order.updated',
    });

    // Assert
    await waitFor(async () => {
      const deliveries = await app.application.repositories.deliveries.list({
        eventId: newTypeEvent.body.id,
      });
      return deliveries.some((d: Delivery) => d.status === 'delivered');
    });
    expect(
      await app.application.repositories.deliveries.list({ eventId: oldTypeEvent.body.id }),
    ).toEqual([]);
  });
});
