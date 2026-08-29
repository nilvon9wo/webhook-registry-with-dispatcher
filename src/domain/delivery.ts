/**
 * Delivery domain model.
 *
 * A delivery is one event-to-subscription attempt record, with its own status
 * and history. Transitions are pure functions that return a new {@link Delivery}
 * and reject illegal moves, so the state machine cannot be corrupted by callers.
 *
 * State machine:
 *
 *   pending ──beginAttempt──▶ delivering ──completeDelivered──▶ delivered (terminal)
 *      ▲                          │
 *      │                          ├──scheduleRetry────▶ pending   (attempts remain)
 *      └──────────────────────────┤
 *      │                          └──completeFailed───▶ failed    (terminal)
 *      │
 *   reclaimStuck  (recovery: delivering abandoned by a crash ──▶ pending)
 *   abandonDelivery (recovery: pending that cannot progress ──▶ failed, terminal)
 */

import { InvalidDeliveryTransitionError } from './errors.js';

export const DELIVERY_STATUSES = ['pending', 'delivering', 'delivered', 'failed'] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

export interface Delivery {
  readonly id: string;
  readonly eventId: string;
  readonly subscriptionId: string;
  /**
   * Target URL captured when the delivery was created. Snapshotting it keeps the
   * historical record intact and lets recovery retry even if the subscription
   * was later changed or deleted.
   */
  readonly targetUrl: string;
  readonly status: DeliveryStatus;
  /** Number of attempts started (incremented by {@link beginAttempt}). */
  readonly attempts: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** When the next attempt becomes eligible; `null` while delivering or terminal. */
  readonly nextAttemptAt: string | null;
  readonly lastAttemptAt: string | null;
  readonly lastStatusCode: number | null;
  readonly lastError: string | null;
  readonly completedAt: string | null;
}

export function isTerminal(status: DeliveryStatus): boolean {
  return status === 'delivered' || status === 'failed';
}

export function isDeliveryStatus(value: string): value is DeliveryStatus {
  return (DELIVERY_STATUSES as readonly string[]).includes(value);
}

export interface CreateDeliveryParams {
  readonly id: string;
  readonly eventId: string;
  readonly subscriptionId: string;
  readonly targetUrl: string;
  readonly now: Date;
}

export function createDelivery(params: CreateDeliveryParams): Delivery {
  const timestamp = params.now.toISOString();
  return {
    id: params.id,
    eventId: params.eventId,
    subscriptionId: params.subscriptionId,
    targetUrl: params.targetUrl,
    status: 'pending',
    attempts: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
    nextAttemptAt: timestamp,
    lastAttemptAt: null,
    lastStatusCode: null,
    lastError: null,
    completedAt: null,
  };
}

/** pending ▶ delivering. Increments the attempt counter. */
export function beginAttempt(delivery: Delivery, now: Date): Delivery {
  assertTransition(delivery, 'delivering', ['pending']);
  const timestamp = now.toISOString();
  return {
    ...delivery,
    status: 'delivering',
    attempts: delivery.attempts + 1,
    lastAttemptAt: timestamp,
    updatedAt: timestamp,
    nextAttemptAt: null,
  };
}

/** delivering ▶ delivered (terminal). */
export function completeDelivered(delivery: Delivery, statusCode: number, now: Date): Delivery {
  assertTransition(delivery, 'delivered', ['delivering']);
  const timestamp = now.toISOString();
  return {
    ...delivery,
    status: 'delivered',
    lastStatusCode: statusCode,
    lastError: null,
    updatedAt: timestamp,
    completedAt: timestamp,
    nextAttemptAt: null,
  };
}

export interface RetryParams {
  readonly statusCode: number | null;
  readonly error: string;
  readonly nextAttemptAt: Date;
  readonly now: Date;
}

/** delivering ▶ pending, scheduled for another attempt after a backoff. */
export function scheduleRetry(delivery: Delivery, params: RetryParams): Delivery {
  assertTransition(delivery, 'pending', ['delivering']);
  const timestamp = params.now.toISOString();
  return {
    ...delivery,
    status: 'pending',
    lastStatusCode: params.statusCode,
    lastError: params.error,
    updatedAt: timestamp,
    nextAttemptAt: params.nextAttemptAt.toISOString(),
  };
}

export interface FailParams {
  readonly statusCode: number | null;
  readonly error: string;
  readonly now: Date;
}

/** delivering ▶ failed (terminal). */
export function completeFailed(delivery: Delivery, params: FailParams): Delivery {
  assertTransition(delivery, 'failed', ['delivering']);
  const timestamp = params.now.toISOString();
  return {
    ...delivery,
    status: 'failed',
    lastStatusCode: params.statusCode,
    lastError: params.error,
    updatedAt: timestamp,
    completedAt: timestamp,
    nextAttemptAt: null,
  };
}

/**
 * Recovery: give up on a `pending` delivery that cannot make progress — its
 * retry budget is spent, or the source event is gone. Terminal `failed`.
 */
export function abandonDelivery(delivery: Delivery, reason: string, now: Date): Delivery {
  assertTransition(delivery, 'failed', ['pending']);
  const timestamp = now.toISOString();
  return {
    ...delivery,
    status: 'failed',
    lastError: reason,
    updatedAt: timestamp,
    completedAt: timestamp,
    nextAttemptAt: null,
  };
}

/**
 * Recovery: a delivery left in `delivering` past the stuck threshold is assumed
 * abandoned (the process crashed mid-attempt) and returns to `pending`. The
 * attempt counter is not rewound — that attempt was spent, and it may even have
 * reached the subscriber (hence at-least-once semantics).
 */
export function reclaimStuck(delivery: Delivery, now: Date): Delivery {
  assertTransition(delivery, 'pending', ['delivering']);
  const timestamp = now.toISOString();
  return {
    ...delivery,
    status: 'pending',
    lastError: 'attempt abandoned mid-flight; reclaimed by recovery',
    updatedAt: timestamp,
    nextAttemptAt: timestamp,
  };
}

function assertTransition(
  delivery: Delivery,
  to: DeliveryStatus,
  allowedFrom: readonly DeliveryStatus[],
): void {
  if (!allowedFrom.includes(delivery.status)) {
    throw new InvalidDeliveryTransitionError(delivery.status, to);
  }
}
