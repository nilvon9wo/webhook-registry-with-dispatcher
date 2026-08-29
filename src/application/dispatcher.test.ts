import { describe, expect, it } from 'vitest';
import { aSubscription } from '../../tests/support/factories.js';
import { isTerminal } from '../domain/delivery.js';
import { createEvent, type WebhookEvent } from '../domain/event.js';
import type { IdGenerator, IdKind } from '../domain/ids.js';
import type { AttemptOutcome } from '../domain/retry-policy.js';
import {
  InMemoryDeliveryRepository,
  InMemorySubscriptionRepository,
} from '../infrastructure/memory/in-memory-repositories.js';
import { silentLogger } from '../infrastructure/logger.js';
import type { WebhookClient, WebhookRequest } from '../infrastructure/webhook-client.js';
import { fixedClock } from './clock.js';
import { Dispatcher } from './dispatcher.js';

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
  readonly deliveries: InMemoryDeliveryRepository;
  readonly webhookClient: FakeWebhookClient;
}

function newHarness(): Harness {
  const subscriptions = new InMemorySubscriptionRepository();
  const deliveries = new InMemoryDeliveryRepository();
  const webhookClient = new FakeWebhookClient();
  const dispatcher = new Dispatcher({
    subscriptions,
    deliveries,
    webhookClient,
    clock: CLOCK,
    ids: sequentialIds(),
    logger: silentLogger,
    config: { webhookTimeoutMs: 5000 },
  });
  return { dispatcher, subscriptions, deliveries, webhookClient };
}

const EVENT: WebhookEvent = createEvent(
  { type: 'order.created', data: { orderId: '12345' } },
  'evt_1',
  new Date('2026-08-28T10:15:00.000Z'),
);

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
    'records a failed delivery on a $label (single-attempt step)',
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
