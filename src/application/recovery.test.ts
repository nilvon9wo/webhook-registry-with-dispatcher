import { afterEach, describe, expect, it, vi } from 'vitest';
import { aDelivery, anEvent, aSubscription } from '../../tests/support/factories.js';
import { ManualScheduler } from '../../tests/support/manual-scheduler.js';
import type { WebhookEvent } from '../domain/event.js';
import type { IdGenerator, IdKind } from '../domain/ids.js';
import type { AttemptOutcome, RetryPolicy } from '../domain/retry-policy.js';
import {
  InMemoryDeliveryRepository,
  InMemoryEventRepository,
  InMemorySubscriptionRepository,
} from '../infrastructure/memory/in-memory-repositories.js';
import { createCapturingLogger } from '../../tests/support/capturing-logger.js';
import { silentLogger, type Logger } from './logging.js';
import { allowAllTargetUrlGuard } from './target-url-guard.js';
import type { WebhookClient, WebhookRequest } from './webhook-client.js';
import { fixedClock } from './clock.js';
import { Dispatcher } from './dispatcher.js';
import { RecoveryService } from './recovery.js';

const NOW = new Date('2026-08-28T12:00:00.000Z');
const CLOCK = fixedClock(NOW);
const RETRY_5: RetryPolicy = { maxAttempts: 5, baseDelayMs: 500, maxDelayMs: 30_000 };
const STUCK_THRESHOLD_MS = 60_000;

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
  outcome: AttemptOutcome = { kind: 'success', statusCode: 200 };
  async send(request: WebhookRequest): Promise<AttemptOutcome> {
    this.requests.push(request);
    return this.outcome;
  }
}

interface Harness {
  readonly recovery: RecoveryService;
  readonly subscriptions: InMemorySubscriptionRepository;
  readonly events: InMemoryEventRepository;
  readonly deliveries: InMemoryDeliveryRepository;
  readonly webhookClient: FakeWebhookClient;
}

function newHarness(logger: Logger = silentLogger): Harness {
  const subscriptions = new InMemorySubscriptionRepository();
  const events = new InMemoryEventRepository();
  const deliveries = new InMemoryDeliveryRepository();
  const webhookClient = new FakeWebhookClient();
  const dispatcher = new Dispatcher({
    subscriptions,
    events,
    deliveries,
    webhookClient,
    targetUrlGuard: allowAllTargetUrlGuard,
    scheduler: new ManualScheduler(),
    clock: CLOCK,
    ids: sequentialIds(),
    logger: silentLogger,
    config: { webhookTimeoutMs: 5000, retryPolicy: RETRY_5 },
    random: () => 1,
  });
  const recovery = new RecoveryService({
    deliveries,
    resumer: dispatcher,
    clock: CLOCK,
    logger,
    config: { stuckDeliveringThresholdMs: STUCK_THRESHOLD_MS, batchLimit: 100 },
  });
  return { recovery, subscriptions, events, deliveries, webhookClient };
}

async function seedSubscriptionAndEvent(harness: Harness): Promise<WebhookEvent> {
  const subscription = aSubscription({ id: 'sub_1', eventType: 'order.created' });
  const event = anEvent({ id: 'evt_1', type: 'order.created' });
  await harness.subscriptions.save(subscription);
  await harness.events.save(event);
  return event;
}

const iso = (offsetMs: number): string => new Date(NOW.getTime() + offsetMs).toISOString();

afterEach(() => {
  vi.useRealTimers();
});

describe('RecoveryService.runOnce', () => {
  it('reclaims a delivery stuck in delivering and re-delivers it', async () => {
    // Arrange — a delivery whose attempt started well before the stuck threshold.
    const harness = newHarness();
    await seedSubscriptionAndEvent(harness);
    await harness.deliveries.save(
      aDelivery({
        id: 'del_1',
        eventId: 'evt_1',
        subscriptionId: 'sub_1',
        status: 'delivering',
        attempts: 1,
        nextAttemptAt: null,
        lastAttemptAt: iso(-STUCK_THRESHOLD_MS - 1000),
      }),
    );

    // Act
    const summary = await harness.recovery.runOnce();

    // Assert
    expect(summary).toEqual({ reclaimed: 1, resumed: 1 });
    expect((await harness.deliveries.get('del_1'))?.status).toBe('delivered');
    expect(harness.webhookClient.requests).toHaveLength(1);
  });

  it('re-drives a pending delivery whose backoff was due when the process stopped', async () => {
    // Arrange
    const harness = newHarness();
    await seedSubscriptionAndEvent(harness);
    await harness.deliveries.save(
      aDelivery({
        id: 'del_1',
        eventId: 'evt_1',
        subscriptionId: 'sub_1',
        status: 'pending',
        attempts: 2,
        nextAttemptAt: iso(-5000),
      }),
    );

    // Act
    const summary = await harness.recovery.runOnce();

    // Assert
    expect(summary.resumed).toBe(1);
    const delivery = await harness.deliveries.get('del_1');
    expect(delivery?.status).toBe('delivered');
    expect(delivery?.attempts).toBe(3);
  });

  it('does not touch completed deliveries', async () => {
    // Arrange
    const harness = newHarness();
    await seedSubscriptionAndEvent(harness);
    await harness.deliveries.save(
      aDelivery({ id: 'del_ok', status: 'delivered', completedAt: iso(-1) }),
    );
    await harness.deliveries.save(
      aDelivery({ id: 'del_bad', status: 'failed', completedAt: iso(-1) }),
    );

    // Act
    const summary = await harness.recovery.runOnce();

    // Assert
    expect(summary).toEqual({ reclaimed: 0, resumed: 0 });
    expect(harness.webhookClient.requests).toHaveLength(0);
    expect((await harness.deliveries.get('del_ok'))?.status).toBe('delivered');
  });

  it('does not reclaim a delivery that is still within the stuck threshold', async () => {
    // Arrange
    const harness = newHarness();
    await harness.deliveries.save(
      aDelivery({
        id: 'del_1',
        status: 'delivering',
        nextAttemptAt: null,
        lastAttemptAt: iso(-1000),
      }),
    );

    // Act
    const summary = await harness.recovery.runOnce();

    // Assert
    expect(summary.reclaimed).toBe(0);
    expect((await harness.deliveries.get('del_1'))?.status).toBe('delivering');
  });

  it('enforces the retry limit: a due pending delivery at the attempt cap is failed, not retried', async () => {
    // Arrange
    const harness = newHarness();
    await seedSubscriptionAndEvent(harness);
    await harness.deliveries.save(
      aDelivery({
        id: 'del_1',
        eventId: 'evt_1',
        subscriptionId: 'sub_1',
        status: 'pending',
        attempts: 5,
        nextAttemptAt: iso(-1000),
      }),
    );

    // Act
    await harness.recovery.runOnce();

    // Assert
    const delivery = await harness.deliveries.get('del_1');
    expect(delivery?.status).toBe('failed');
    expect(delivery?.attempts).toBe(5);
    expect(delivery?.lastError).toContain('retry limit');
    expect(harness.webhookClient.requests).toHaveLength(0);
  });

  it('reclaims a delivery stuck at the attempt cap and then abandons it', async () => {
    // Arrange
    const harness = newHarness();
    await seedSubscriptionAndEvent(harness);
    await harness.deliveries.save(
      aDelivery({
        id: 'del_1',
        eventId: 'evt_1',
        subscriptionId: 'sub_1',
        status: 'delivering',
        attempts: 5,
        nextAttemptAt: null,
        lastAttemptAt: iso(-STUCK_THRESHOLD_MS - 1),
      }),
    );

    // Act
    const summary = await harness.recovery.runOnce();

    // Assert
    expect(summary).toEqual({ reclaimed: 1, resumed: 1 });
    expect((await harness.deliveries.get('del_1'))?.status).toBe('failed');
    expect(harness.webhookClient.requests).toHaveLength(0);
  });

  it('abandons a due pending delivery whose source event no longer exists', async () => {
    // Arrange — subscription present, event NOT seeded.
    const harness = newHarness();
    await harness.subscriptions.save(aSubscription({ id: 'sub_1', eventType: 'order.created' }));
    await harness.deliveries.save(
      aDelivery({
        id: 'del_1',
        eventId: 'evt_gone',
        subscriptionId: 'sub_1',
        status: 'pending',
        attempts: 1,
        nextAttemptAt: iso(-1000),
      }),
    );

    // Act
    await harness.recovery.runOnce();

    // Assert
    const delivery = await harness.deliveries.get('del_1');
    expect(delivery?.status).toBe('failed');
    expect(delivery?.lastError).toContain('event no longer available');
  });

  it('is reentrancy-guarded: an overlapping run does nothing', async () => {
    // Arrange — a repository whose listStuckDelivering blocks until released.
    const harness = newHarness();
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = harness.deliveries.listStuckDelivering.bind(harness.deliveries);
    harness.deliveries.listStuckDelivering = async (before, limit) => {
      await gate;
      return original(before, limit);
    };

    // Act — the two runs must overlap for the guard to be exercised: start the
    // first (it blocks in the gated repo), then start the second while it is
    // still in flight.
    const first = harness.recovery.runOnce();
    const second = await harness.recovery.runOnce();

    // Assert
    expect(second).toEqual({ reclaimed: 0, resumed: 0 });
    release();
    expect(await first).toEqual({ reclaimed: 0, resumed: 0 });
  });
});

describe('RecoveryService.runOnce — sweep logging', () => {
  const sweepLine = (logger: ReturnType<typeof createCapturingLogger>, message: string) =>
    logger.lines.find((line) => line.message === message);

  it('logs recovery.sweep.completed at debug when the sweeper goes idle', async () => {
    // Arrange
    const logger = createCapturingLogger();
    const harness = newHarness(logger);

    // Act
    await harness.recovery.runOnce();

    // Assert
    expect(sweepLine(logger, 'recovery.sweep.completed')).toMatchObject({
      level: 'debug',
      fields: { reclaimedCount: 0, resumedCount: 0 },
    });
  });

  it('logs the idle sweep once, not on every subsequent no-op sweep', async () => {
    // Arrange
    const logger = createCapturingLogger();
    const harness = newHarness(logger);

    // Act — three consecutive no-op sweeps.
    await harness.recovery.runOnce();
    await harness.recovery.runOnce();
    await harness.recovery.runOnce();

    // Assert
    const completions = logger.lines.filter((line) => line.message === 'recovery.sweep.completed');
    expect(completions).toHaveLength(1);
  });

  it('logs recovery.sweep.completed at info when the sweep re-drives a delivery', async () => {
    // Arrange — a due pending delivery.
    const logger = createCapturingLogger();
    const harness = newHarness(logger);
    await seedSubscriptionAndEvent(harness);
    await harness.deliveries.save(
      aDelivery({
        id: 'del_1',
        eventId: 'evt_1',
        subscriptionId: 'sub_1',
        status: 'pending',
        attempts: 1,
        nextAttemptAt: iso(-5000),
      }),
    );

    // Act
    await harness.recovery.runOnce();

    // Assert
    expect(sweepLine(logger, 'recovery.sweep.completed')).toMatchObject({
      level: 'info',
      fields: { resumedCount: 1 },
    });
  });

  it('logs recovery.sweep.skipped when a sweep overlaps a running one', async () => {
    // Arrange — gate the first sweep so it is still in flight for the second.
    const logger = createCapturingLogger();
    const harness = newHarness(logger);
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const original = harness.deliveries.listStuckDelivering.bind(harness.deliveries);
    harness.deliveries.listStuckDelivering = async (before, limit) => {
      await gate;
      return original(before, limit);
    };
    const first = harness.recovery.runOnce();

    // Act
    await harness.recovery.runOnce();

    // Assert
    expect(sweepLine(logger, 'recovery.sweep.skipped')).toMatchObject({
      level: 'debug',
      fields: { reason: 'previous_sweep_in_progress' },
    });
    release();
    await first;
  });
});

describe('RecoveryService.start / stop', () => {
  it('start(0) does not schedule a sweep', () => {
    // Arrange
    vi.useFakeTimers();
    const harness = newHarness();
    const spy = vi.spyOn(harness.recovery, 'runOnce');

    // Act
    harness.recovery.start(0);

    // Assert — no timer, so advancing the clock changes nothing
    vi.advanceTimersByTime(600_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it('runs a sweep on every interval while started', async () => {
    // Arrange
    vi.useFakeTimers();
    const harness = newHarness();
    const spy = vi
      .spyOn(harness.recovery, 'runOnce')
      .mockResolvedValue({ reclaimed: 0, resumed: 0 });
    harness.recovery.start(1000);

    // Act
    await vi.advanceTimersByTimeAsync(3500);

    // Assert
    expect(spy).toHaveBeenCalledTimes(3);
  });

  it('stops sweeping after stop()', async () => {
    // Arrange
    vi.useFakeTimers();
    const harness = newHarness();
    const spy = vi
      .spyOn(harness.recovery, 'runOnce')
      .mockResolvedValue({ reclaimed: 0, resumed: 0 });
    harness.recovery.start(1000);
    await vi.advanceTimersByTimeAsync(2500);

    // Act
    harness.recovery.stop();

    // Assert — no further sweeps however far the clock advances
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spy).toHaveBeenCalledTimes(2);
  });
});
