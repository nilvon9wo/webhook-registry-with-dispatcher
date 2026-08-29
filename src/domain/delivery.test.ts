import { describe, expect, it } from 'vitest';
import { captureError } from '../../tests/support/capture-error.js';
import { InvalidDeliveryTransitionError } from './errors.js';
import {
  beginAttempt,
  completeDelivered,
  completeFailed,
  createDelivery,
  type Delivery,
  type DeliveryStatus,
  isTerminal,
  reclaimStuck,
  scheduleRetry,
} from './delivery.js';

const T0 = new Date('2026-08-28T10:00:00.000Z');
const T1 = new Date('2026-08-28T10:00:05.000Z');
const T2 = new Date('2026-08-28T10:00:20.000Z');

function newPendingDelivery(): Delivery {
  return createDelivery({
    id: 'del_1',
    eventId: 'evt_1',
    subscriptionId: 'sub_1',
    targetUrl: 'https://subscriber.example/hook',
    now: T0,
  });
}

describe('createDelivery', () => {
  it('starts pending, zero attempts, immediately eligible', () => {
    // Arrange — none: createDelivery takes only its params.

    // Act
    const delivery = newPendingDelivery();

    // Assert
    expect(delivery.status).toBe('pending');
    expect(delivery.attempts).toBe(0);
    expect(delivery.nextAttemptAt).toBe(T0.toISOString());
    expect(delivery.completedAt).toBeNull();
    expect(delivery.targetUrl).toBe('https://subscriber.example/hook');
  });
});

describe('beginAttempt', () => {
  it('moves pending → delivering and increments attempts', () => {
    // Arrange
    const pending = newPendingDelivery();

    // Act
    const delivering = beginAttempt(pending, T1);

    // Assert
    expect(delivering.status).toBe('delivering');
    expect(delivering.attempts).toBe(1);
    expect(delivering.lastAttemptAt).toBe(T1.toISOString());
    expect(delivering.nextAttemptAt).toBeNull();
  });

  it('rejects starting an attempt on an already-delivering record', () => {
    // Arrange
    const delivering = beginAttempt(newPendingDelivery(), T1);

    // Act
    const error = captureError(() => beginAttempt(delivering, T2));

    // Assert
    expect(error).toBeInstanceOf(InvalidDeliveryTransitionError);
  });
});

describe('completeDelivered', () => {
  it('moves delivering → delivered (terminal) and records the status code', () => {
    // Arrange
    const delivering = beginAttempt(newPendingDelivery(), T1);

    // Act
    const delivered = completeDelivered(delivering, 200, T2);

    // Assert
    expect(delivered.status).toBe('delivered');
    expect(delivered.lastStatusCode).toBe(200);
    expect(delivered.completedAt).toBe(T2.toISOString());
    expect(isTerminal(delivered.status)).toBe(true);
  });

  it('cannot be applied to a pending record', () => {
    // Arrange
    const pending = newPendingDelivery();

    // Act
    const error = captureError(() => completeDelivered(pending, 200, T2));

    // Assert
    expect(error).toBeInstanceOf(InvalidDeliveryTransitionError);
  });
});

describe('scheduleRetry', () => {
  it('moves delivering → pending with a future nextAttemptAt and the failure detail', () => {
    // Arrange
    const delivering = beginAttempt(newPendingDelivery(), T1);
    const nextAttemptAt = new Date('2026-08-28T10:00:10.000Z');

    // Act
    const retrying = scheduleRetry(delivering, {
      statusCode: 503,
      error: 'HTTP 503',
      nextAttemptAt,
      now: T2,
    });

    // Assert
    expect(retrying.status).toBe('pending');
    expect(retrying.attempts).toBe(1);
    expect(retrying.nextAttemptAt).toBe(nextAttemptAt.toISOString());
    expect(retrying.lastStatusCode).toBe(503);
    expect(retrying.lastError).toBe('HTTP 503');
    expect(retrying.completedAt).toBeNull();
  });

  it('supports a full pending → delivering → pending → delivering → delivered cycle', () => {
    // Arrange
    const firstAttempt = beginAttempt(newPendingDelivery(), T1);
    const retrying = scheduleRetry(firstAttempt, {
      statusCode: 500,
      error: 'HTTP 500',
      nextAttemptAt: T2,
      now: T2,
    });

    // Act
    const delivered = completeDelivered(beginAttempt(retrying, T2), 200, T2);

    // Assert
    expect(delivered.status).toBe('delivered');
    expect(delivered.attempts).toBe(2);
  });
});

describe('completeFailed', () => {
  it('moves delivering → failed (terminal) and retains the failure detail', () => {
    // Arrange
    const delivering = beginAttempt(newPendingDelivery(), T1);

    // Act
    const failed = completeFailed(delivering, { statusCode: 404, error: 'HTTP 404', now: T2 });

    // Assert
    expect(failed.status).toBe('failed');
    expect(failed.lastStatusCode).toBe(404);
    expect(failed.lastError).toBe('HTTP 404');
    expect(failed.completedAt).toBe(T2.toISOString());
    expect(isTerminal(failed.status)).toBe(true);
  });
});

describe('reclaimStuck', () => {
  it('moves an abandoned delivering record back to pending without rewinding attempts', () => {
    // Arrange
    const delivering = beginAttempt(newPendingDelivery(), T1);

    // Act
    const reclaimed = reclaimStuck(delivering, T2);

    // Assert
    expect(reclaimed.status).toBe('pending');
    expect(reclaimed.attempts).toBe(1);
    expect(reclaimed.nextAttemptAt).toBe(T2.toISOString());
    expect(reclaimed.lastError).toContain('reclaimed by recovery');
  });

  it('refuses to reclaim a terminal delivery', () => {
    // Arrange
    const delivered = completeDelivered(beginAttempt(newPendingDelivery(), T1), 200, T2);

    // Act
    const error = captureError(() => reclaimStuck(delivered, T2));

    // Assert
    expect(error).toBeInstanceOf(InvalidDeliveryTransitionError);
  });
});

describe('delivery history across repeated attempts', () => {
  const T3 = new Date('2026-08-28T10:00:40.000Z');

  it('accumulates attempts and always reflects the latest attempt outcome', () => {
    // Arrange — attempt 1 fails (503), attempt 2 fails (500), attempt 3 succeeds.
    const attempt1 = beginAttempt(newPendingDelivery(), T1);
    const afterRetry1 = scheduleRetry(attempt1, {
      statusCode: 503,
      error: 'HTTP 503',
      nextAttemptAt: T2,
      now: T1,
    });
    const attempt2 = beginAttempt(afterRetry1, T2);
    const afterRetry2 = scheduleRetry(attempt2, {
      statusCode: 500,
      error: 'HTTP 500',
      nextAttemptAt: T3,
      now: T2,
    });

    // Act
    const delivered = completeDelivered(beginAttempt(afterRetry2, T3), 200, T3);

    // Assert
    expect(delivered.attempts).toBe(3);
    expect(delivered.status).toBe('delivered');
    expect(delivered.lastAttemptAt).toBe(T3.toISOString());
    expect(delivered.lastStatusCode).toBe(200);
    expect(delivered.lastError).toBeNull(); // cleared once delivery finally succeeds
    expect(delivered.completedAt).toBe(T3.toISOString());
  });

  it('retains the final failure detail when attempts are exhausted', () => {
    // Arrange
    const attempt1 = beginAttempt(newPendingDelivery(), T1);
    const afterRetry = scheduleRetry(attempt1, {
      statusCode: 500,
      error: 'HTTP 500',
      nextAttemptAt: T2,
      now: T1,
    });

    // Act
    const failed = completeFailed(beginAttempt(afterRetry, T2), {
      statusCode: 503,
      error: 'HTTP 503',
      now: T2,
    });

    // Assert
    expect(failed.attempts).toBe(2);
    expect(failed.status).toBe('failed');
    expect(failed.lastStatusCode).toBe(503);
    expect(failed.lastError).toBe('HTTP 503');
    expect(failed.completedAt).toBe(T2.toISOString());
  });

  it('advances updatedAt on every transition', () => {
    // Arrange
    const created = newPendingDelivery();
    const delivering = beginAttempt(created, T1);
    const retrying = scheduleRetry(delivering, {
      statusCode: 500,
      error: 'HTTP 500',
      nextAttemptAt: T2,
      now: T2,
    });
    const deliveredAt = new Date('2026-08-28T10:01:00.000Z');
    const delivered = completeDelivered(beginAttempt(retrying, T2), 200, deliveredAt);

    // Act
    const updatedAts = [created, delivering, retrying, delivered].map((d) => d.updatedAt);

    // Assert
    expect(updatedAts).toEqual([
      T0.toISOString(),
      T1.toISOString(),
      T2.toISOString(),
      deliveredAt.toISOString(),
    ]);
  });
});

describe('terminal states are frozen', () => {
  it.each(['delivered', 'failed'] as const)(
    'no transition function accepts a %s record',
    (status: DeliveryStatus) => {
      // Arrange
      const delivering = beginAttempt(newPendingDelivery(), T1);
      const terminal =
        status === 'delivered'
          ? completeDelivered(delivering, 200, T2)
          : completeFailed(delivering, { statusCode: 500, error: 'x', now: T2 });

      // Act
      const errors = [
        captureError(() => beginAttempt(terminal, T2)),
        captureError(() => completeDelivered(terminal, 200, T2)),
        captureError(() =>
          scheduleRetry(terminal, { statusCode: 500, error: 'x', nextAttemptAt: T2, now: T2 }),
        ),
        captureError(() => completeFailed(terminal, { statusCode: 500, error: 'x', now: T2 })),
      ];

      // Assert
      expect(errors.every((error) => error instanceof InvalidDeliveryTransitionError)).toBe(true);
    },
  );
});
