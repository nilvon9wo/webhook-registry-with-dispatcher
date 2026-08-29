import { afterEach, describe, expect, it } from 'vitest';
import type { WebhookEvent } from '../../src/domain/event.js';
import { startTestApp, type TestApp } from '../support/test-app.js';
import { startWebhookRecorder, type WebhookRecorder } from '../support/webhook-recorder.js';
import { waitFor } from '../support/wait-for.js';

let app: TestApp;
let recorder: WebhookRecorder;

afterEach(async () => {
  await app.close();
  await recorder.close();
});

describe('Application.drain (graceful shutdown)', () => {
  it('cancels pending retries and leaves the delivery pending for recovery', async () => {
    // Arrange — a subscriber that always 500s, so a retry is scheduled with a
    // long backoff we will never let elapse.
    recorder = await startWebhookRecorder({ status: 500 });
    app = await startTestApp({
      env: {
        MAX_DELIVERY_ATTEMPTS: '5',
        RETRY_BASE_DELAY_MS: '60000',
        RETRY_MAX_DELAY_MS: '120000',
      },
    });
    await app.request('POST', '/subscriptions', {
      eventType: 'order.created',
      targetUrl: recorder.url,
    });
    const published = await app.request<WebhookEvent>('POST', '/events', { type: 'order.created' });
    const eventId = published.body.id;
    await waitFor(async () => {
      const [delivery] = await app.application.repositories.deliveries.list({ eventId });
      return delivery?.status === 'pending' && delivery.attempts === 1;
    });
    expect(app.application.dispatcher.scheduledRetryCount).toBe(1);

    // Act
    await app.application.drain();

    // Assert — the retry timer is gone; the delivery is still recoverable.
    expect(app.application.dispatcher.scheduledRetryCount).toBe(0);
    const [delivery] = await app.application.repositories.deliveries.list({ eventId });
    expect(delivery).toMatchObject({ status: 'pending', attempts: 1 });
    expect(delivery?.nextAttemptAt).not.toBeNull();
  });
});
