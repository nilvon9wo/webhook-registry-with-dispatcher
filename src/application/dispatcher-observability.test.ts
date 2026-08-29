import { describe, expect, it } from 'vitest';
import {
  createCapturingLogger,
  type CapturingLogger,
} from '../../tests/support/capturing-logger.js';
import { aSubscription } from '../../tests/support/factories.js';
import { ManualScheduler } from '../../tests/support/manual-scheduler.js';
import { createEvent, type WebhookEvent } from '../domain/event.js';
import type { IdGenerator, IdKind } from '../domain/ids.js';
import type { AttemptOutcome, RetryPolicy } from '../domain/retry-policy.js';
import {
  InMemoryDeliveryRepository,
  InMemoryEventRepository,
  InMemorySubscriptionRepository,
} from '../infrastructure/memory/in-memory-repositories.js';
import { allowAllTargetUrlGuard } from '../infrastructure/ssrf-guard.js';
import type { WebhookClient, WebhookRequest } from '../infrastructure/webhook-client.js';
import { fixedClock } from './clock.js';
import { Dispatcher } from './dispatcher.js';

const CLOCK = fixedClock(new Date('2026-08-28T10:15:00.000Z'));
const RETRY_2: RetryPolicy = { maxAttempts: 2, baseDelayMs: 1, maxDelayMs: 1 };

function ids(): IdGenerator {
  let n = 0;
  return {
    next: (kind: IdKind) => {
      n += 1;
      return `${kind}_${n}`;
    },
  };
}

class FakeWebhookClient implements WebhookClient {
  outcome: AttemptOutcome = { kind: 'success', statusCode: 200 };
  async send(_request: WebhookRequest): Promise<AttemptOutcome> {
    return this.outcome;
  }
}

const EVENT: WebhookEvent = createEvent(
  { type: 'order.created', data: { secret: 'do-not-log-me', orderId: '12345' } },
  'evt_1',
  new Date('2026-08-28T10:15:00.000Z'),
);

async function runDispatch(outcome: AttemptOutcome): Promise<CapturingLogger> {
  const logger = createCapturingLogger();
  const subscriptions = new InMemorySubscriptionRepository();
  const events = new InMemoryEventRepository();
  await events.save(EVENT);
  await subscriptions.save(
    aSubscription({
      id: 'sub_1',
      eventType: 'order.created',
      targetUrl: 'https://hooks.customer.example/inbox',
    }),
  );
  const webhookClient = new FakeWebhookClient();
  webhookClient.outcome = outcome;
  const scheduler = new ManualScheduler();
  const dispatcher = new Dispatcher({
    subscriptions,
    events,
    deliveries: new InMemoryDeliveryRepository(),
    webhookClient,
    targetUrlGuard: allowAllTargetUrlGuard,
    scheduler,
    clock: CLOCK,
    ids: ids(),
    logger,
    config: { webhookTimeoutMs: 5000, retryPolicy: RETRY_2 },
    random: () => 1,
  });

  await dispatcher.dispatchEvent(EVENT);
  scheduler.runPending();
  await dispatcher.whenIdle();
  return logger;
}

describe('dispatch logging — correlation', () => {
  it('tags every delivery-scoped line with eventId, subscriptionId, deliveryId and attempt', async () => {
    // Arrange — a delivery that fails once then is retried.
    const logger = await runDispatch({ kind: 'http-error', statusCode: 503 });

    // Act
    const deliveryLines = logger.lines.filter((line) => line.fields.deliveryId !== undefined);

    // Assert
    expect(deliveryLines.length).toBeGreaterThan(0);
    for (const line of deliveryLines) {
      expect(line.fields).toMatchObject({
        eventId: 'evt_1',
        subscriptionId: 'sub_1',
        deliveryId: 'delivery_1',
        targetHost: 'hooks.customer.example',
      });
    }
    expect(deliveryLines.some((line) => line.fields.attempt === 1)).toBe(true);
    expect(deliveryLines.some((line) => line.fields.attempt === 2)).toBe(true);
  });

  it('records attempt outcome with status/classification/elapsed, and a retry with its backoff', async () => {
    // Arrange
    const logger = await runDispatch({ kind: 'http-error', statusCode: 503 });

    // Act
    const retryLine = logger.lines.find((line) => line.message.includes('scheduling retry'));
    const failLine = logger.lines.find((line) => line.message.includes('failed permanently'));

    // Assert
    expect(retryLine?.fields).toMatchObject({ classification: 'retryable', backoffMs: 1 });
    expect(failLine?.fields).toMatchObject({ reason: 'retry budget exhausted', attempts: 2 });
  });
});

describe('dispatch logging — no sensitive data', () => {
  it('never writes the event payload or the full target URL into a log line', async () => {
    // Arrange
    const logger = await runDispatch({ kind: 'success', statusCode: 200 });

    // Act
    const serialized = JSON.stringify(logger.lines);

    // Assert
    expect(serialized).not.toContain('do-not-log-me');
    expect(serialized).not.toContain('/inbox'); // path of the target URL
    expect(serialized).toContain('hooks.customer.example'); // host only is fine
  });
});
