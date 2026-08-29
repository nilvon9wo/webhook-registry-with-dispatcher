import { describe, expect, it } from 'vitest';
import {
  createCapturingLogger,
  type CapturedLine,
  type CapturingLogger,
} from '../../tests/support/capturing-logger.js';
import { aSubscription } from '../../tests/support/factories.js';
import { drainScheduler, ManualScheduler } from '../../tests/support/manual-scheduler.js';
import { createEvent, type WebhookEvent } from '../domain/event.js';
import type { IdGenerator, IdKind } from '../domain/ids.js';
import type { AttemptOutcome, RetryPolicy } from '../domain/retry-policy.js';
import {
  InMemoryDeliveryRepository,
  InMemoryEventRepository,
  InMemorySubscriptionRepository,
} from '../infrastructure/memory/in-memory-repositories.js';
import { allowAllTargetUrlGuard } from './target-url-guard.js';
import type { WebhookClient, WebhookRequest } from './webhook-client.js';
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

interface ObservabilityHarness {
  readonly logger: CapturingLogger;
  readonly dispatcher: Dispatcher;
  readonly scheduler: ManualScheduler;
}

/** Arrange: a one-subscription dispatcher wired to a capturing logger. */
async function newObservabilityHarness(outcome: AttemptOutcome): Promise<ObservabilityHarness> {
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
  return { logger, dispatcher, scheduler };
}

/** Act: dispatch the event and play every scheduled retry to completion. */
async function dispatchAndLog(harness: ObservabilityHarness): Promise<void> {
  await harness.dispatcher.dispatchEvent(EVENT);
  await drainScheduler(harness.scheduler, harness.dispatcher);
}

const lineNamed = (lines: readonly CapturedLine[], message: string): CapturedLine | undefined =>
  lines.find((line) => line.message === message);

describe('dispatch logging — conventions', () => {
  it('names every line with a stable dotted identifier and a component', async () => {
    // Arrange
    const harness = await newObservabilityHarness({ kind: 'http-error', statusCode: 503 });

    // Act
    await dispatchAndLog(harness);

    // Assert
    for (const line of harness.logger.lines) {
      expect(line.message).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
      expect(line.fields.component).toBe('dispatcher');
    }
    expect(harness.logger.lines.map((line) => line.message)).toEqual(
      expect.arrayContaining(['dispatch.started', 'delivery.retry_scheduled', 'delivery.failed']),
    );
  });

  it('tags every delivery-scoped line with the correlation fields', async () => {
    // Arrange — a delivery that fails once then is retried.
    const harness = await newObservabilityHarness({ kind: 'http-error', statusCode: 503 });

    // Act
    await dispatchAndLog(harness);

    // Assert
    const deliveryLines = harness.logger.lines.filter(
      (line) => line.fields.deliveryId !== undefined,
    );
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

  it('logs delivery.retry_scheduled with the dictionary field names', async () => {
    // Arrange
    const harness = await newObservabilityHarness({ kind: 'http-error', statusCode: 503 });

    // Act
    await dispatchAndLog(harness);

    // Assert
    expect(lineNamed(harness.logger.lines, 'delivery.retry_scheduled')?.fields).toMatchObject({
      outcome: 'retryable',
      httpStatus: 503,
      backoffMs: 1,
      maxAttempts: 2,
    });
  });

  it('logs delivery.failed with the dictionary field names and a reason code', async () => {
    // Arrange
    const harness = await newObservabilityHarness({ kind: 'http-error', statusCode: 503 });

    // Act
    await dispatchAndLog(harness);

    // Assert
    expect(lineNamed(harness.logger.lines, 'delivery.failed')?.fields).toMatchObject({
      outcome: 'retryable',
      reason: 'retry_budget_exhausted',
      attempt: 2,
      maxAttempts: 2,
    });
  });
});

describe('dispatch logging — no matching subscribers', () => {
  it('logs a distinct dispatch.no_subscribers warning and creates no deliveries', async () => {
    // Arrange — a dispatcher with an empty subscription repository.
    const logger = createCapturingLogger();
    const deliveries = new InMemoryDeliveryRepository();
    const events = new InMemoryEventRepository();
    await events.save(EVENT);
    const dispatcher = new Dispatcher({
      subscriptions: new InMemorySubscriptionRepository(),
      events,
      deliveries,
      webhookClient: new FakeWebhookClient(),
      targetUrlGuard: allowAllTargetUrlGuard,
      scheduler: new ManualScheduler(),
      clock: CLOCK,
      ids: ids(),
      logger,
      config: { webhookTimeoutMs: 5000, retryPolicy: RETRY_2 },
      random: () => 1,
    });

    // Act
    await dispatcher.dispatchEvent(EVENT);

    // Assert
    expect(lineNamed(logger.lines, 'dispatch.started')?.fields).toMatchObject({ matchedCount: 0 });
    expect(lineNamed(logger.lines, 'dispatch.no_subscribers')).toMatchObject({
      level: 'warn',
      fields: { eventId: 'evt_1', eventType: 'order.created', component: 'dispatcher' },
    });
    expect(await deliveries.list()).toEqual([]);
  });
});

describe('dispatch logging — no sensitive data', () => {
  it('never writes the event payload or the full target URL into a log line', async () => {
    // Arrange
    const harness = await newObservabilityHarness({ kind: 'success', statusCode: 200 });

    // Act
    await dispatchAndLog(harness);

    // Assert
    const serialized = JSON.stringify(harness.logger.lines);
    expect(serialized).not.toContain('do-not-log-me');
    expect(serialized).not.toContain('/inbox'); // path of the target URL
    expect(serialized).toContain('hooks.customer.example'); // host only is fine
  });
});
