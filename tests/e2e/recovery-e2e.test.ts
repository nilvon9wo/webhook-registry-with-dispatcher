import { describe, expect, it } from 'vitest';
import { createDelivery } from '../../src/domain/delivery.js';
import { aDelivery, anEvent, aSubscription } from '../support/factories.js';
import { startTestApp } from '../support/test-app.js';
import { startWebhookRecorder } from '../support/webhook-recorder.js';

describe('end-to-end: recovery of an abandoned delivery', () => {
  it('re-delivers a delivery left stuck in "delivering" by a crash', async () => {
    // Arrange — a subscriber, its event, and a delivery abandoned mid-attempt.
    const recorder = await startWebhookRecorder({ status: 200 });
    const app = await startTestApp({ env: { STUCK_DELIVERING_THRESHOLD_MS: '1000' } });
    try {
      const subscription = aSubscription({ id: 'sub_1', targetUrl: recorder.url });
      const event = anEvent({ id: 'evt_1' });
      await app.application.repositories.subscriptions.save(subscription);
      await app.application.repositories.events.save(event);

      const abandoned = {
        ...createDelivery({
          id: 'del_1',
          eventId: 'evt_1',
          subscriptionId: 'sub_1',
          targetUrl: recorder.url,
          now: new Date('2020-01-01T00:00:00.000Z'),
        }),
        status: 'delivering' as const,
        attempts: 1,
        nextAttemptAt: null,
        lastAttemptAt: '2020-01-01T00:00:00.000Z',
      };
      await app.application.repositories.deliveries.save(abandoned);

      // Act
      const summary = await app.application.recovery.runOnce();

      // Assert
      expect(summary).toEqual({ reclaimed: 1, resumed: 1 });
      expect(recorder.received).toHaveLength(1);
      expect(recorder.received[0]?.headers['x-webhook-event-id']).toBe('evt_1');
      const delivery = await app.application.repositories.deliveries.get('del_1');
      expect(delivery?.status).toBe('delivered');
      expect(delivery?.attempts).toBe(2);
    } finally {
      await app.close();
      await recorder.close();
    }
  });

  it('does not re-deliver an already-completed delivery', async () => {
    // Arrange
    const recorder = await startWebhookRecorder({ status: 200 });
    const app = await startTestApp();
    try {
      await app.application.repositories.subscriptions.save(aSubscription({ id: 'sub_1' }));
      await app.application.repositories.events.save(anEvent({ id: 'evt_1' }));
      await app.application.repositories.deliveries.save(
        aDelivery({
          id: 'del_done',
          eventId: 'evt_1',
          subscriptionId: 'sub_1',
          targetUrl: recorder.url,
          status: 'delivered',
          attempts: 1,
          nextAttemptAt: null,
          completedAt: '2026-08-28T10:20:00.000Z',
        }),
      );

      // Act
      const summary = await app.application.recovery.runOnce();

      // Assert
      expect(summary).toEqual({ reclaimed: 0, resumed: 0 });
      expect(recorder.received).toHaveLength(0);
    } finally {
      await app.close();
      await recorder.close();
    }
  });
});
