import { describe, expect, it } from 'vitest';
import type { Delivery } from '../../src/domain/delivery.js';
import { startTestApp } from '../support/test-app.js';
import { startWebhookRecorder } from '../support/webhook-recorder.js';
import { waitFor } from '../support/wait-for.js';

interface CreatedId {
  readonly id: string;
}

describe('end-to-end: publish event -> webhook delivery', () => {
  it('delivers a published event to a matching subscriber and marks it delivered', async () => {
    // Arrange
    const recorder = await startWebhookRecorder({ status: 200 });
    const app = await startTestApp();
    try {
      const subscription = await app.request<CreatedId>('POST', '/subscriptions', {
        eventType: 'order.created',
        targetUrl: recorder.url,
      });

      // Act
      const published = await app.request<CreatedId>('POST', '/events', {
        type: 'order.created',
        data: { orderId: '12345' },
      });
      const eventId = published.body.id;

      // Assert
      expect(published.status).toBe(202);
      await waitFor(
        async () => {
          const [delivery] = await app.application.repositories.deliveries.list({ eventId });
          return delivery?.status === 'delivered';
        },
        { description: 'delivery to become delivered' },
      );

      expect(recorder.received).toHaveLength(1);
      const received = recorder.received[0];
      expect(received?.method).toBe('POST');
      expect(received?.headers['content-type']).toBe('application/json');
      expect(received?.headers['x-webhook-event-id']).toBe(eventId);
      expect(received?.body).toEqual({
        id: eventId,
        type: 'order.created',
        timestamp: expect.any(String),
        data: { orderId: '12345' },
      });

      const deliveriesResponse = await app.request<{ items: unknown[] }>(
        'GET',
        `/deliveries?eventId=${eventId}`,
      );
      expect(deliveriesResponse.status).toBe(200);
      expect(deliveriesResponse.body.items).toHaveLength(1);
      expect(deliveriesResponse.body.items[0]).toMatchObject({
        subscriptionId: subscription.body.id,
        status: 'delivered',
        attempts: 1,
        lastStatusCode: 200,
      });
    } finally {
      await app.close();
      await recorder.close();
    }
  });

  it('retries a transient failure: webhook returns 500 then 200, delivery ends delivered', async () => {
    // Arrange — subscriber fails once (500) then succeeds (200).
    const recorder = await startWebhookRecorder({ status: [500, 200] });
    const app = await startTestApp({
      env: { RETRY_BASE_DELAY_MS: '0', MAX_DELIVERY_ATTEMPTS: '5' },
    });
    try {
      await app.request('POST', '/subscriptions', {
        eventType: 'order.created',
        targetUrl: recorder.url,
      });

      // Act
      const published = await app.request<CreatedId>('POST', '/events', { type: 'order.created' });
      const eventId = published.body.id;

      // Assert
      await waitFor(
        async () => {
          const [delivery] = await app.application.repositories.deliveries.list({ eventId });
          return delivery?.status === 'delivered';
        },
        { description: 'delivery to succeed after a retry' },
      );

      expect(recorder.received).toHaveLength(2);
      const [delivery] = await app.application.repositories.deliveries.list({ eventId });
      expect(delivery).toMatchObject({ status: 'delivered', attempts: 2, lastStatusCode: 200 });
    } finally {
      await app.close();
      await recorder.close();
    }
  });

  it('isolates a failing subscriber from a healthy one', async () => {
    // Arrange — no retries, so the broken subscriber fails fast and the test
    // stays about parallel delivery + failure isolation, not backoff timing.
    const healthy = await startWebhookRecorder({ status: 200 });
    const broken = await startWebhookRecorder({ status: 500 });
    const app = await startTestApp({ env: { MAX_DELIVERY_ATTEMPTS: '1' } });
    try {
      await app.request('POST', '/subscriptions', {
        eventType: 'order.created',
        targetUrl: healthy.url,
      });
      await app.request('POST', '/subscriptions', {
        eventType: 'order.created',
        targetUrl: broken.url,
      });

      // Act
      const published = await app.request<CreatedId>('POST', '/events', { type: 'order.created' });
      const eventId = published.body.id;

      // Assert
      await waitFor(async () => {
        const deliveries = await app.application.repositories.deliveries.list({ eventId });
        return deliveries.length === 2 && deliveries.every((d: Delivery) => d.completedAt !== null);
      });

      const deliveries = await app.application.repositories.deliveries.list({ eventId });
      expect(deliveries.map((delivery) => delivery.status).sort()).toEqual(['delivered', 'failed']);
      expect(healthy.received).toHaveLength(1);
      expect(broken.received).toHaveLength(1);
    } finally {
      await app.close();
      await healthy.close();
      await broken.close();
    }
  });

  it('fails the delivery when the subscriber is slower than the webhook timeout', async () => {
    // Arrange — the subscriber takes 500ms; the timeout is 50ms; no retries.
    const recorder = await startWebhookRecorder({ status: 200, delayMs: 500 });
    const app = await startTestApp({
      env: { WEBHOOK_TIMEOUT_MS: '50', MAX_DELIVERY_ATTEMPTS: '1' },
    });
    try {
      await app.request('POST', '/subscriptions', {
        eventType: 'order.created',
        targetUrl: recorder.url,
      });

      // Act
      const published = await app.request<CreatedId>('POST', '/events', { type: 'order.created' });
      const eventId = published.body.id;

      // Assert
      await waitFor(async () => {
        const [delivery] = await app.application.repositories.deliveries.list({ eventId });
        return delivery?.status === 'failed';
      });
      const [delivery] = await app.application.repositories.deliveries.list({ eventId });
      expect(delivery).toMatchObject({ status: 'failed', attempts: 1 });
      expect(delivery?.lastError).toBe('request timed out');
    } finally {
      await app.close();
      await recorder.close();
    }
  });
});
