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
 * This step performs a single attempt per delivery. Bounded retry with backoff
 * is layered on in a later step; the outcome handling is already structured for
 * it (`classifyOutcome` → success / retryable / permanent).
 */

import {
  beginAttempt,
  completeDelivered,
  completeFailed,
  createDelivery,
  type Delivery,
} from '../domain/delivery.js';
import { toDeliveryPayload, type WebhookEvent } from '../domain/event.js';
import type { IdGenerator } from '../domain/ids.js';
import { classifyOutcome, type AttemptOutcome } from '../domain/retry-policy.js';
import type { Subscription } from '../domain/subscription.js';
import type { Logger } from '../infrastructure/logger.js';
import type { WebhookClient } from '../infrastructure/webhook-client.js';
import type { Clock } from './clock.js';
import type { EventDispatcher } from './event-service.js';
import { findSubscriptionsForEvent } from './matching.js';
import type { DeliveryRepository, SubscriptionRepository } from './ports.js';

export interface DispatcherConfig {
  readonly webhookTimeoutMs: number;
}

export interface DispatcherDeps {
  readonly subscriptions: SubscriptionRepository;
  readonly deliveries: DeliveryRepository;
  readonly webhookClient: WebhookClient;
  readonly clock: Clock;
  readonly ids: IdGenerator;
  readonly logger: Logger;
  readonly config: DispatcherConfig;
}

export class Dispatcher implements EventDispatcher {
  private readonly deps: DispatcherDeps;
  /** Tracks in-flight background dispatches so a shutdown can await them. */
  private readonly inFlight = new Set<Promise<void>>();

  constructor(deps: DispatcherDeps) {
    this.deps = deps;
  }

  dispatch(event: WebhookEvent): void {
    const task = this.dispatchEvent(event).catch((error: unknown) => {
      this.deps.logger.error('event dispatch failed', {
        eventId: event.id,
        error: error instanceof Error ? error.message : String(error),
      });
    });
    this.inFlight.add(task);
    void task.finally(() => this.inFlight.delete(task));
  }

  /** Resolves once every dispatch started so far has settled. */
  async whenIdle(): Promise<void> {
    // allSettled consumes the set synchronously, so dispatches started later are
    // intentionally not awaited here.
    await Promise.allSettled(this.inFlight);
  }

  /**
   * Runs matching + delivery for one event. Exposed (not just via `dispatch`)
   * so recovery can re-drive an event and tests can await completion.
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

  /** One delivery attempt: mark delivering, POST, record the outcome. */
  private async attemptDelivery(delivery: Delivery, event: WebhookEvent): Promise<void> {
    const attempting = beginAttempt(delivery, this.deps.clock.now());
    await this.deps.deliveries.save(attempting);

    const log = this.deps.logger.child({
      eventId: event.id,
      subscriptionId: delivery.subscriptionId,
      deliveryId: delivery.id,
      attempt: attempting.attempts,
    });

    const startedAt = Date.now();
    const outcome = await this.deps.webhookClient.send({
      url: delivery.targetUrl,
      payload: toDeliveryPayload(event),
      headers: {
        'X-Webhook-Event-Id': event.id,
        'X-Webhook-Delivery-Id': delivery.id,
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

    const failed = completeFailed(attempting, {
      statusCode: outcomeStatusCode(outcome),
      error: describeOutcome(outcome),
      now: this.deps.clock.now(),
    });
    await this.deps.deliveries.save(failed);
    log.warn('delivery failed', {
      classification,
      statusCode: failed.lastStatusCode,
      error: failed.lastError,
      elapsedMs,
    });
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
