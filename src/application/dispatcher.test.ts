import { describe, expect, it } from 'vitest';
import { aSubscription } from '../../tests/support/factories.js';
import { drainScheduler, ManualScheduler } from '../../tests/support/manual-scheduler.js';
import { isTerminal } from '../domain/delivery.js';
import { createEvent, type WebhookEvent } from '../domain/event.js';
import type { IdGenerator, IdKind } from '../domain/ids.js';
import type { AttemptOutcome, RetryPolicy } from '../domain/retry-policy.js';
import {
  InMemoryDeliveryRepository,
  InMemoryEventRepository,
  InMemorySubscriptionRepository,
} from '../infrastructure/memory/in-memory-repositories.js';
import { silentLogger } from '../infrastructure/logger.js';
import type { WebhookClient, WebhookRequest } from '../infrastructure/webhook-client.js';
import { fixedClock } from './clock.js';
import { Dispatcher } from './dispatcher.js';

/** Default: a single attempt (no retries), so outcome-class tests stay direct. */
const NO_RETRY: RetryPolicy = { maxAttempts: 1, baseDelayMs: 500, maxDelayMs: 30_000 };

const CLOCK = fixedClock(new Date('2026-08-28T10:15:00.000Z'));

function sequentialIds(): IdGenerator {
  let n = 0;
  return {
    next: (kind: IdKind) => {
      n += 1;
      return `${kind}_${n}`;
    },
  };
}

class FakeWebhookClient implements WebhookClient {
  readonly requests: WebhookRequest[] = [];
  responder: (request: WebhookRequest) => AttemptOutcome | Promise<AttemptOutcome> = () => ({
    kind: 'success',
    statusCode: 200,
  });

  async send(request: WebhookRequest): Promise<AttemptOutcome> {
    this.requests.push(request);
    return this.responder(request);
  }
}

interface Harness {
  readonly dispatcher: Dispatcher;
  readonly subscriptions: InMemorySubscriptionRepository;
  readonly events: InMemoryEventRepository;
  readonly deliveries: InMemoryDeliveryRepository;
  readonly webhookClient: FakeWebhookClient;
  readonly scheduler: ManualScheduler;
}

const EVENT: WebhookEvent = createEvent(
  { type: 'order.created', data: { orderId: '12345' } },
  'evt_1',
  new Date('2026-08-28T10:15:00.000Z'),
);

function newHarness(retryPolicy: RetryPolicy = NO_RETRY): Harness {
  const subscriptions = new InMemorySubscriptionRepository();
  const events = new InMemoryEventRepository();
  void events.save(EVENT); // in-memory save populates synchronously
  const deliveries = new InMemoryDeliveryRepository();
  const webhookClient = new FakeWebhookClient();
  const scheduler = new ManualScheduler();
  const dispatcher = new Dispatcher({
    subscriptions,
    events,
    deliveries,
    webhookClient,
    scheduler,
    clock: CLOCK,
    ids: sequentialIds(),
    logger: silentLogger,
    config: { webhookTimeoutMs: 5000, retryPolicy },
    // Full jitter (random() === 1) makes the backoff delay deterministic: the cap.
    random: () => 1,
  });
  return { dispatcher, subscriptions, events, deliveries, webhookClient, scheduler };
}

describe('Dispatcher.dispatchEvent', () => {
  it('creates no deliveries when nothing matches', async () => {
    // Arrange
    const { dispatcher, subscriptions, deliveries, webhookClient } = newHarness();
    await subscriptions.save(aSubscription({ eventType: 'other.type' }));

    // Act
    await dispatcher.dispatchEvent(EVENT);

    // Assert
    expect(await deliveries.list()).toEqual([]);
    expect(webhookClient.requests).toHaveLength(0);
  });

  it('creates one delivery per matching subscription', async () => {
    // Arrange
    const { dispatcher, subscriptions, deliveries } = newHarness();
    await subscriptions.save(aSubscription({ id: 'sub_a', eventType: 'order.created' }));
    await subscriptions.save(aSubscription({ id: 'sub_b', eventType: 'order.created' }));
    await subscriptions.save(aSubscription({ id: 'sub_c', eventType: 'order.created' }));

    // Act
    await dispatcher.dispatchEvent(EVENT);

    // Assert
    const created = await deliveries.list({ eventId: 'evt_1' });
    expect(created).toHaveLength(3);
    expect(created.map((delivery) => delivery.subscriptionId).sort()).toEqual([
      'sub_a',
      'sub_b',
      'sub_c',
    ]);
  });

  it('marks a delivery delivered on a 2xx response', async () => {
    // Arrange
    const { dispatcher, subscriptions, deliveries, webhookClient } = newHarness();
    await subscriptions.save(aSubscription({ id: 'sub_a', eventType: 'order.created' }));
    webhookClient.responder = () => ({ kind: 'success', statusCode: 202 });

    // Act
    await dispatcher.dispatchEvent(EVENT);

    // Assert
    const [delivery] = await deliveries.list();
    expect(delivery?.status).toBe('delivered');
    expect(delivery?.attempts).toBe(1);
    expect(delivery?.lastStatusCode).toBe(202);
    expect(delivery?.completedAt).not.toBeNull();
  });

  it.each([
    { outcome: { kind: 'http-error', statusCode: 404 }, label: '4xx' },
    { outcome: { kind: 'http-error', statusCode: 503 }, label: '5xx' },
    { outcome: { kind: 'timeout' }, label: 'timeout' },
    { outcome: { kind: 'network-error', message: 'ECONNREFUSED' }, label: 'network error' },
  ] as { outcome: AttemptOutcome; label: string }[])(
    'records a failed delivery on a $label when no retry is configured',
    async ({ outcome }) => {
      // Arrange
      const { dispatcher, subscriptions, deliveries, webhookClient } = newHarness();
      await subscriptions.save(aSubscription({ id: 'sub_a', eventType: 'order.created' }));
      webhookClient.responder = () => outcome;

      // Act
      await dispatcher.dispatchEvent(EVENT);

      // Assert
      const [delivery] = await deliveries.list();
      expect(delivery?.status).toBe('failed');
      expect(delivery?.lastError).not.toBeNull();
      expect(isTerminal(delivery?.status ?? 'pending')).toBe(true);
    },
  );

  it('isolates subscribers: one failure does not stop the others', async () => {
    // Arrange
    const { dispatcher, subscriptions, deliveries, webhookClient } = newHarness();
    await subscriptions.save(
      aSubscription({
        id: 'sub_a',
        eventType: 'order.created',
        targetUrl: 'https://a.example/hook',
      }),
    );
    await subscriptions.save(
      aSubscription({
        id: 'sub_b',
        eventType: 'order.created',
        targetUrl: 'https://b.example/hook',
      }),
    );
    await subscriptions.save(
      aSubscription({
        id: 'sub_c',
        eventType: 'order.created',
        targetUrl: 'https://c.example/hook',
      }),
    );
    webhookClient.responder = (request) =>
      request.url === 'https://b.example/hook'
        ? { kind: 'http-error', statusCode: 500 }
        : { kind: 'success', statusCode: 200 };

    // Act
    await dispatcher.dispatchEvent(EVENT);

    // Assert
    const bySubscription = async (id: string): Promise<string | undefined> =>
      (await deliveries.list({ subscriptionId: id }))[0]?.status;
    expect(await bySubscription('sub_a')).toBe('delivered');
    expect(await bySubscription('sub_b')).toBe('failed');
    expect(await bySubscription('sub_c')).toBe('delivered');
    expect(webhookClient.requests).toHaveLength(3);
  });

  it('persists the delivering state before making the HTTP call (so a crash is recoverable)', async () => {
    // Arrange
    const { dispatcher, subscriptions, deliveries, webhookClient } = newHarness();
    await subscriptions.save(aSubscription({ id: 'sub_a', eventType: 'order.created' }));
    let statusDuringCall: string | undefined;
    webhookClient.responder = async () => {
      statusDuringCall = (await deliveries.list())[0]?.status;
      return { kind: 'success', statusCode: 200 };
    };

    // Act
    await dispatcher.dispatchEvent(EVENT);

    // Assert
    expect(statusDuringCall).toBe('delivering');
  });

  it('sends the spec payload shape and correlation headers', async () => {
    // Arrange
    const { dispatcher, subscriptions, webhookClient } = newHarness();
    await subscriptions.save(aSubscription({ id: 'sub_a', eventType: 'order.created' }));

    // Act
    await dispatcher.dispatchEvent(EVENT);

    // Assert
    const [request] = webhookClient.requests;
    expect(request?.payload).toEqual({
      id: 'evt_1',
      type: 'order.created',
      timestamp: '2026-08-28T10:15:00.000Z',
      data: { orderId: '12345' },
    });
    expect(request?.headers['X-Webhook-Event-Id']).toBe('evt_1');
    expect(request?.headers['X-Webhook-Attempt']).toBe('1');
    expect(request?.headers['X-Webhook-Delivery-Id']).toMatch(/^delivery_/);
  });
});

describe('Dispatcher.dispatch (fire-and-forget)', () => {
  it('returns synchronously and never throws, then settles via whenIdle', async () => {
    // Arrange
    const { dispatcher, subscriptions, deliveries } = newHarness();
    await subscriptions.save(aSubscription({ id: 'sub_a', eventType: 'order.created' }));

    // Act
    dispatcher.dispatch(EVENT);
    await dispatcher.whenIdle();

    // Assert
    expect((await deliveries.list())[0]?.status).toBe('delivered');
  });

  it('swallows a background failure instead of raising an unhandled rejection', async () => {
    // Arrange
    const { dispatcher, subscriptions, webhookClient } = newHarness();
    await subscriptions.save(aSubscription({ id: 'sub_a', eventType: 'order.created' }));
    webhookClient.responder = () => {
      throw new Error('client blew up');
    };

    // Act
    dispatcher.dispatch(EVENT);
    const settle = dispatcher.whenIdle();

    // Assert
    await expect(settle).resolves.toBeUndefined();
  });
});

const RETRY_5: RetryPolicy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 30_000 };

describe('Dispatcher retry behaviour', () => {
  async function withOneSubscription(retryPolicy: RetryPolicy): Promise<Harness> {
    const harness = newHarness(retryPolicy);
    await harness.subscriptions.save(aSubscription({ id: 'sub_a', eventType: 'order.created' }));
    return harness;
  }

  it('schedules a retry (does not fail) on a retryable outcome with attempts remaining', async () => {
    // Arrange
    const { dispatcher, deliveries, scheduler, webhookClient } = await withOneSubscription(RETRY_5);
    webhookClient.responder = () => ({ kind: 'http-error', statusCode: 503 });

    // Act
    await dispatcher.dispatchEvent(EVENT);

    // Assert
    const [delivery] = await deliveries.list();
    expect(delivery?.status).toBe('pending');
    expect(delivery?.attempts).toBe(1);
    expect(delivery?.lastStatusCode).toBe(503);
    expect(delivery?.nextAttemptAt).not.toBeNull();
    expect(scheduler.pendingCount).toBe(1);
    expect(scheduler.pendingDelays).toEqual([500]);
  });

  it('does not retry a permanent (4xx) failure', async () => {
    // Arrange
    const { dispatcher, deliveries, scheduler, webhookClient } = await withOneSubscription(RETRY_5);
    webhookClient.responder = () => ({ kind: 'http-error', statusCode: 400 });

    // Act
    await dispatcher.dispatchEvent(EVENT);

    // Assert
    expect((await deliveries.list())[0]?.status).toBe('failed');
    expect(scheduler.pendingCount).toBe(0);
  });

  it('succeeds on a later attempt: 503, 503, then 200 → delivered after 3 attempts', async () => {
    // Arrange
    const { dispatcher, deliveries, scheduler, webhookClient } = await withOneSubscription(RETRY_5);
    const statuses = [503, 503, 200];
    let call = 0;
    webhookClient.responder = () => {
      const status = statuses[call] ?? 200;
      call += 1;
      return status < 300
        ? { kind: 'success', statusCode: status }
        : { kind: 'http-error', statusCode: status };
    };

    // Act
    await dispatcher.dispatchEvent(EVENT);
    await drainScheduler(scheduler, dispatcher);

    // Assert
    const [delivery] = await deliveries.list();
    expect(delivery?.status).toBe('delivered');
    expect(delivery?.attempts).toBe(3);
    expect(delivery?.lastStatusCode).toBe(200);
    expect(delivery?.lastError).toBeNull();
  });

  it('enforces the maximum attempt count and then records a permanent failure', async () => {
    // Arrange
    const { dispatcher, deliveries, scheduler, webhookClient } = await withOneSubscription(RETRY_5);
    webhookClient.responder = () => ({ kind: 'timeout' });

    // Act
    await dispatcher.dispatchEvent(EVENT);
    await drainScheduler(scheduler, dispatcher);

    // Assert
    const [delivery] = await deliveries.list();
    expect(delivery?.status).toBe('failed');
    expect(delivery?.attempts).toBe(5);
    expect(delivery?.lastError).toBe('request timed out');
    expect(webhookClient.requests).toHaveLength(5);
    expect(scheduler.pendingCount).toBe(0);
  });

  it('grows the backoff exponentially, capped at maxDelayMs', async () => {
    // Arrange
    const policy: RetryPolicy = { maxAttempts: 6, baseDelayMs: 500, maxDelayMs: 3000 };
    const { dispatcher, scheduler, webhookClient } = await withOneSubscription(policy);
    webhookClient.responder = () => ({ kind: 'network-error', message: 'ECONNRESET' });
    const observedDelays: number[] = [];

    // Act
    await dispatcher.dispatchEvent(EVENT);
    for (let round = 0; round < 5 && scheduler.pendingCount > 0; round += 1) {
      observedDelays.push(...scheduler.pendingDelays);
      scheduler.runPending();
      await dispatcher.whenIdle();
    }

    // Assert — 500, 1000, 2000, then capped at 3000, 3000
    expect(observedDelays).toEqual([500, 1000, 2000, 3000, 3000]);
  });

  it('isolates retries: a permanently-failing subscriber does not disturb a healthy one', async () => {
    // Arrange
    const harness = newHarness(RETRY_5);
    const { dispatcher, deliveries, scheduler, webhookClient } = harness;
    await harness.subscriptions.save(
      aSubscription({
        id: 'sub_ok',
        eventType: 'order.created',
        targetUrl: 'https://ok.example/h',
      }),
    );
    await harness.subscriptions.save(
      aSubscription({
        id: 'sub_bad',
        eventType: 'order.created',
        targetUrl: 'https://bad.example/h',
      }),
    );
    webhookClient.responder = (request) =>
      request.url === 'https://bad.example/h'
        ? { kind: 'http-error', statusCode: 503 }
        : { kind: 'success', statusCode: 200 };

    // Act
    await dispatcher.dispatchEvent(EVENT);
    await drainScheduler(scheduler, dispatcher);

    // Assert
    const statusOf = async (subscriptionId: string): Promise<string | undefined> =>
      (await deliveries.list({ subscriptionId }))[0]?.status;
    expect(await statusOf('sub_ok')).toBe('delivered');
    expect(await statusOf('sub_bad')).toBe('failed');
    expect((await deliveries.list({ subscriptionId: 'sub_bad' }))[0]?.attempts).toBe(5);
  });

  it('cancelScheduledRetries stops pending retries but leaves the delivery pending for recovery', async () => {
    // Arrange
    const { dispatcher, deliveries, scheduler, webhookClient } = await withOneSubscription(RETRY_5);
    webhookClient.responder = () => ({ kind: 'http-error', statusCode: 503 });
    await dispatcher.dispatchEvent(EVENT);

    // Act
    dispatcher.cancelScheduledRetries();
    scheduler.runPending();
    await dispatcher.whenIdle();

    // Assert
    expect(dispatcher.scheduledRetryCount).toBe(0);
    const [delivery] = await deliveries.list();
    expect(delivery?.status).toBe('pending');
    expect(delivery?.nextAttemptAt).not.toBeNull();
    expect(webhookClient.requests).toHaveLength(1);
  });
});
