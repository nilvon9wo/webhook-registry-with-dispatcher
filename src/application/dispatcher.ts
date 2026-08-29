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
  abandonDelivery,
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
import { deliveryFields, outcomeFields } from './log-fields.js';
import { errorFields, LOG_COMPONENTS, type Logger } from './logging.js';
import { SsrfBlockedError, type TargetUrlGuard } from './target-url-guard.js';
import type { WebhookClient } from './webhook-client.js';
import type { Clock } from './clock.js';
import type { EventDispatcher } from './event-service.js';
import { findSubscriptionsForEvent } from './matching.js';
import type { DeliveryRepository, EventRepository, SubscriptionRepository } from './ports.js';
import type { Scheduler } from './scheduler.js';

export interface DispatcherConfig {
  readonly webhookTimeoutMs: number;
  readonly retryPolicy: RetryPolicy;
}

export interface DispatcherDeps {
  readonly subscriptions: SubscriptionRepository;
  readonly events: EventRepository;
  readonly deliveries: DeliveryRepository;
  readonly webhookClient: WebhookClient;
  readonly targetUrlGuard: TargetUrlGuard;
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
  private readonly log: Logger;
  private readonly random: () => number;
  /** In-flight background dispatches + retry attempts, so shutdown/tests can await them. */
  private readonly inFlight = new Set<Promise<void>>();
  /** Cancel handles for retries waiting out their backoff. */
  private readonly scheduledRetries = new Set<() => void>();

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
    this.log = deps.logger.child({ component: LOG_COMPONENTS.dispatcher });
    this.random = deps.random ?? Math.random;
  }

  dispatch(event: WebhookEvent): void {
    this.track(
      this.dispatchEvent(event).catch((error: unknown) => {
        this.log.error('dispatch.failed', { eventId: event.id, ...errorFields(error) });
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
    this.log.info('dispatch.started', {
      eventId: event.id,
      eventType: event.type,
      matchedCount: subscriptions.length,
    });

    const results = await Promise.allSettled(
      subscriptions.map((subscription) => this.deliverToSubscription(event, subscription)),
    );

    const failedRecordCount = results.filter((result) => result.status === 'rejected').length;
    if (failedRecordCount > 0) {
      this.log.error('dispatch.partial_failure', { eventId: event.id, failedRecordCount });
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
    this.deps.logger
      .child({ component: LOG_COMPONENTS.dispatcher, ...deliveryFields(delivery) })
      .debug('delivery.created');
    await this.attemptDelivery(delivery, event);
  }

  /** A logger scoped to one delivery attempt: correlation ids + target host + attempt number. */
  private attemptLogger(delivery: Delivery): Logger {
    return this.log.child({ ...deliveryFields(delivery), attempt: delivery.attempts });
  }

  /** One delivery attempt: mark delivering, POST, then deliver / retry / fail. */
  private async attemptDelivery(delivery: Delivery, event: WebhookEvent): Promise<void> {
    const attempting = beginAttempt(delivery, this.deps.clock.now());
    await this.deps.deliveries.save(attempting);

    const log = this.attemptLogger(attempting);

    // Re-check the target at delivery time: the subscription may have been
    // registered when the host resolved to a public address and now resolve to a
    // private one. A blocked target is a permanent failure.
    try {
      await this.deps.targetUrlGuard.assertAllowed(attempting.targetUrl);
    } catch (error) {
      if (error instanceof SsrfBlockedError) {
        const failed = completeFailed(attempting, {
          statusCode: null,
          error: `target blocked: ${error.reason}`,
          now: this.deps.clock.now(),
        });
        await this.deps.deliveries.save(failed);
        log.warn('delivery.blocked', { reason: error.reason });
        return;
      }
      throw error;
    }

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
    const durationMs = Date.now() - startedAt;
    const classification = classifyOutcome(outcome);

    if (classification === 'success' && outcome.kind === 'success') {
      const delivered = completeDelivered(attempting, outcome.statusCode, this.deps.clock.now());
      await this.deps.deliveries.save(delivered);
      log.info('delivery.succeeded', { ...outcomeFields(outcome), durationMs });
      return;
    }

    if (
      classification === 'retryable' &&
      hasAttemptsRemaining(attempting.attempts, this.deps.config.retryPolicy)
    ) {
      await this.scheduleRetryAttempt(attempting, event, outcome, log, durationMs);
      return;
    }

    const failed = completeFailed(attempting, {
      statusCode: outcomeStatusCode(outcome),
      error: describeOutcome(outcome),
      now: this.deps.clock.now(),
    });
    await this.deps.deliveries.save(failed);
    log.warn('delivery.failed', {
      ...outcomeFields(outcome),
      reason: classification === 'permanent' ? 'non_retryable_response' : 'retry_budget_exhausted',
      error: failed.lastError,
      attempt: failed.attempts,
      maxAttempts: this.deps.config.retryPolicy.maxAttempts,
      durationMs,
    });
  }

  private async scheduleRetryAttempt(
    attempting: Delivery,
    event: WebhookEvent,
    outcome: AttemptOutcome,
    log: Logger,
    durationMs: number,
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
    log.warn('delivery.retry_scheduled', {
      ...outcomeFields(outcome),
      error: retrying.lastError,
      durationMs,
      backoffMs: delayMs,
      nextAttemptAt: retrying.nextAttemptAt,
      maxAttempts: this.deps.config.retryPolicy.maxAttempts,
    });

    let cancel: () => void = () => {};
    cancel = this.deps.scheduler.schedule(() => {
      this.scheduledRetries.delete(cancel);
      this.track(
        this.resumeDelivery(retrying.id).catch((error: unknown) => {
          log.error('delivery.retry_error', errorFields(error));
        }),
      );
    }, delayMs);
    this.scheduledRetries.add(cancel);
  }

  /**
   * Resumes one `pending` delivery by its id: re-loads it, and either abandons
   * it (retry budget spent, or the source event is gone) or runs another
   * attempt. Used by the in-process retry timer and by recovery. A no-op if the
   * delivery is no longer `pending` (already handled elsewhere).
   */
  async resumeDelivery(deliveryId: string): Promise<void> {
    const delivery = await this.deps.deliveries.get(deliveryId);
    if (delivery === undefined || delivery.status !== 'pending') {
      return;
    }
    const log = this.log.child(deliveryFields(delivery));

    if (!hasAttemptsRemaining(delivery.attempts, this.deps.config.retryPolicy)) {
      await this.deps.deliveries.save(
        abandonDelivery(delivery, 'retry limit reached', this.deps.clock.now()),
      );
      log.warn('delivery.abandoned', {
        reason: 'retry_budget_exhausted',
        attempt: delivery.attempts,
        maxAttempts: this.deps.config.retryPolicy.maxAttempts,
      });
      return;
    }

    const event = await this.deps.events.get(delivery.eventId);
    if (event === undefined) {
      await this.deps.deliveries.save(
        abandonDelivery(delivery, 'source event no longer available', this.deps.clock.now()),
      );
      log.warn('delivery.abandoned', { reason: 'source_event_missing' });
      return;
    }

    await this.attemptDelivery(delivery, event);
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
