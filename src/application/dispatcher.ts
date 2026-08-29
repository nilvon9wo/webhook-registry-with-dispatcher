/**
 * In-process asynchronous dispatcher.
 *
 * For each event: find matching subscriptions, create one delivery record per
 * subscription, then attempt each delivery independently. One subscriber failing
 * (slow, error status, timeout, unreachable) never blocks or fails another —
 * deliveries run under `Promise.allSettled`.
 *
 * `dispatch()` is fire-and-forget: it returns immediately and never throws into
 * the caller (the HTTP response for `POST /events` must not wait on subscriber
 * latency). Background failures are logged, not propagated.
 *
 * Retry: a `retryable` outcome (network error, timeout, selected 5xx/4xx — see
 * `classifyOutcome`) with attempts remaining is re-scheduled after a bounded
 * exponential backoff via the injected {@link Scheduler}. A `permanent` outcome,
 * or a retryable one that has exhausted `maxAttempts`, is recorded as `failed`.
 * The delivery is persisted as `pending` with a `nextAttemptAt` between attempts,
 * so a crash during the backoff window is picked up by recovery rather than lost.
 */

import {
  beginAttempt,
  completeDelivered,
  completeFailed,
  createDelivery,
  scheduleRetry,
  type Delivery,
} from '../domain/delivery.js';
import { toDeliveryPayload, type WebhookEvent } from '../domain/event.js';
import type { IdGenerator } from '../domain/ids.js';
import {
  classifyOutcome,
  computeBackoffMs,
  hasAttemptsRemaining,
  type AttemptOutcome,
  type RetryPolicy,
} from '../domain/retry-policy.js';
import type { Subscription } from '../domain/subscription.js';
import type { Logger } from '../infrastructure/logger.js';
import type { WebhookClient } from '../infrastructure/webhook-client.js';
import type { Clock } from './clock.js';
import type { EventDispatcher } from './event-service.js';
import { findSubscriptionsForEvent } from './matching.js';
import type { DeliveryRepository, SubscriptionRepository } from './ports.js';
import type { Scheduler } from './scheduler.js';

export interface DispatcherConfig {
  readonly webhookTimeoutMs: number;
  readonly retryPolicy: RetryPolicy;
}

export interface DispatcherDeps {
  readonly subscriptions: SubscriptionRepository;
  readonly deliveries: DeliveryRepository;
  readonly webhookClient: WebhookClient;
  readonly scheduler: Scheduler;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly config: DispatcherConfig;
  /** Source of jitter for backoff; defaults to `Math.random`. */
  readonly random?: () => number;
}

export class Dispatcher implements EventDispatcher {
  private readonly deps: DispatcherDeps;
  private readonly random: () => number;
  /** In-flight background dispatches + retry attempts, so shutdown/tests can await them. */
  private readonly inFlight = new Set<Promise<void>>();
  /** Cancel handles for retries waiting out their backoff. */
  private readonly scheduledRetries = new Set<() => void>();

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
    this.random = deps.random ?? Math.random;
  }

  dispatch(event: WebhookEvent): void {
    this.track(
      this.dispatchEvent(event).catch((error: unknown) => {
        this.deps.logger.error('event dispatch failed', {
          eventId: event.id,
          error: errorText(error),
        });
      }),
    );
  }

  /** Resolves once every dispatch/retry started so far has settled. */
  async whenIdle(): Promise<void> {
    await Promise.allSettled(this.inFlight);
  }

  /** Number of retries currently waiting out their backoff. */
  get scheduledRetryCount(): number {
    return this.scheduledRetries.size;
  }

  /**
   * Cancels retries still in their backoff window. The deliveries remain
   * persisted as `pending` with a `nextAttemptAt`, so recovery will resume them.
   * Used on shutdown.
   */
  cancelScheduledRetries(): void {
    for (const cancel of this.scheduledRetries) {
      cancel();
    }
    this.scheduledRetries.clear();
  }

  /**
   * Runs matching + delivery for one event. Public (not only via `dispatch`) so
   * recovery can re-drive an event and tests can await completion.
   */
  async dispatchEvent(event: WebhookEvent): Promise<void> {
    const subscriptions = await findSubscriptionsForEvent(this.deps.subscriptions, event);
    this.deps.logger.info('dispatching event', {
      eventId: event.id,
      type: event.type,
      matchedSubscriptions: subscriptions.length,
    });

    const results = await Promise.allSettled(
      subscriptions.map((subscription) => this.deliverToSubscription(event, subscription)),
    );

    const failedToRecord = results.filter((result) => result.status === 'rejected').length;
    if (failedToRecord > 0) {
      this.deps.logger.error('some deliveries could not be recorded', {
        eventId: event.id,
        count: failedToRecord,
      });
    }
  }

  private async deliverToSubscription(
    event: WebhookEvent,
    subscription: Subscription,
  ): Promise<void> {
    const delivery = createDelivery({
      id: this.deps.ids.next('delivery'),
      eventId: event.id,
      subscriptionId: subscription.id,
      targetUrl: subscription.targetUrl,
      now: this.deps.clock.now(),
    });
    await this.deps.deliveries.save(delivery);
    await this.attemptDelivery(delivery, event);
  }

  /** One delivery attempt: mark delivering, POST, then deliver / retry / fail. */
  private async attemptDelivery(delivery: Delivery, event: WebhookEvent): Promise<void> {
    const attempting = beginAttempt(delivery, this.deps.clock.now());
    await this.deps.deliveries.save(attempting);

    const log = this.deps.logger.child({
      eventId: event.id,
      subscriptionId: attempting.subscriptionId,
      deliveryId: attempting.id,
      attempt: attempting.attempts,
    });

    const startedAt = Date.now();
    const outcome = await this.deps.webhookClient.send({
      url: attempting.targetUrl,
      payload: toDeliveryPayload(event),
      headers: {
        'X-Webhook-Event-Id': event.id,
        'X-Webhook-Delivery-Id': attempting.id,
        'X-Webhook-Attempt': String(attempting.attempts),
      },
      timeoutMs: this.deps.config.webhookTimeoutMs,
    });
    const elapsedMs = Date.now() - startedAt;
    const classification = classifyOutcome(outcome);

    if (classification === 'success' && outcome.kind === 'success') {
      const delivered = completeDelivered(attempting, outcome.statusCode, this.deps.clock.now());
      await this.deps.deliveries.save(delivered);
      log.info('delivery succeeded', { statusCode: outcome.statusCode, elapsedMs });
      return;
    }

    if (
      classification === 'retryable' &&
      hasAttemptsRemaining(attempting.attempts, this.deps.config.retryPolicy)
    ) {
      await this.scheduleRetryAttempt(attempting, event, outcome, log, elapsedMs);
      return;
    }

    const failed = completeFailed(attempting, {
      statusCode: outcomeStatusCode(outcome),
      error: describeOutcome(outcome),
      now: this.deps.clock.now(),
    });
    await this.deps.deliveries.save(failed);
    log.warn('delivery failed permanently', {
      classification,
      statusCode: failed.lastStatusCode,
      error: failed.lastError,
      attempts: failed.attempts,
      elapsedMs,
    });
  }

  private async scheduleRetryAttempt(
    attempting: Delivery,
    event: WebhookEvent,
    outcome: AttemptOutcome,
    log: Logger,
    elapsedMs: number,
  ): Promise<void> {
    const delayMs = computeBackoffMs(
      attempting.attempts,
      this.deps.config.retryPolicy,
      this.random,
    );
    const nextAttemptAt = new Date(this.deps.clock.now().getTime() + delayMs);
    const retrying = scheduleRetry(attempting, {
      statusCode: outcomeStatusCode(outcome),
      error: describeOutcome(outcome),
      nextAttemptAt,
      now: this.deps.clock.now(),
    });
    await this.deps.deliveries.save(retrying);
    log.warn('delivery attempt failed; scheduling retry', {
      classification: 'retryable',
      statusCode: retrying.lastStatusCode,
      error: retrying.lastError,
      elapsedMs,
      backoffMs: delayMs,
      nextAttemptAt: retrying.nextAttemptAt,
    });

    let cancel: () => void = () => {};
    cancel = this.deps.scheduler.schedule(() => {
      this.scheduledRetries.delete(cancel);
      this.track(
        this.reattemptDelivery(retrying.id, event).catch((error: unknown) => {
          log.error('retry attempt failed to run', { error: errorText(error) });
        }),
      );
    }, delayMs);
    this.scheduledRetries.add(cancel);
  }

  private async reattemptDelivery(deliveryId: string, event: WebhookEvent): Promise<void> {
    const current = await this.deps.deliveries.get(deliveryId);
    if (current === undefined || current.status !== 'pending') {
      // Already terminal, or reclaimed/handled elsewhere (e.g. recovery).
      return;
    }
    await this.attemptDelivery(current, event);
  }

  private track(task: Promise<void>): void {
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }
}

function outcomeStatusCode(outcome: AttemptOutcome): number | null {
  return outcome.kind === 'success' || outcome.kind === 'http-error' ? outcome.statusCode : null;
}

function describeOutcome(outcome: AttemptOutcome): string {
  switch (outcome.kind) {
    case 'success':
    case 'http-error':
      return `HTTP ${outcome.statusCode}`;
    case 'timeout':
      return 'request timed out';
    case 'network-error':
      return `network error: ${outcome.message}`;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
