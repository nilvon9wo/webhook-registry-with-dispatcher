/**
 * Recovery sweep.
 *
 * NOT the normal dispatch path — `POST /events` still persists and dispatches
 * immediately. Recovery is a safety net for work abandoned by a crash, restart,
 * or transient outage:
 *
 *   - deliveries stuck in `delivering` past the stuck threshold → reclaimed to
 *     `pending` (an attempt spent, process died before recording the result);
 *   - `pending` deliveries whose `nextAttemptAt` is due → re-driven (their
 *     in-process backoff timer was lost when the process stopped).
 *
 * Re-driving goes through `Dispatcher.resumeDelivery`, which enforces the retry
 * cap and abandons deliveries that can no longer progress, so recovery cannot
 * retry indefinitely.
 */

import { reclaimStuck } from '../domain/delivery.js';
import { errorFields, type Logger } from '../infrastructure/logger.js';
import type { Clock } from './clock.js';
import type { DeliveryRepository } from './ports.js';

export interface DeliveryResumer {
  resumeDelivery(deliveryId: string): Promise<void>;
}

export interface RecoveryConfig {
  /** A `delivering` delivery older than this (by last attempt) is treated as abandoned. */
  readonly stuckDeliveringThresholdMs: number;
  /** Max deliveries handled per sweep, to bound the work of one run. */
  readonly batchLimit: number;
}

export interface RecoveryDeps {
  readonly deliveries: DeliveryRepository;
  readonly resumer: DeliveryResumer;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly config: RecoveryConfig;
}

export interface RecoverySummary {
  readonly reclaimed: number;
  readonly resumed: number;
}

export class RecoveryService {
  private readonly deps: RecoveryDeps;
  private timer: ReturnType<typeof setInterval> | undefined;
  private running = false;

  constructor(deps: RecoveryDeps) {
    this.deps = deps;
  }

  /** Starts the periodic sweep. `intervalMs <= 0` disables it (no-op). */
  start(intervalMs: number): void {
    if (intervalMs <= 0 || this.timer !== undefined) {
      return;
    }
    this.deps.logger.info('recovery sweep enabled', {
      intervalMs,
      stuckThresholdMs: this.deps.config.stuckDeliveringThresholdMs,
    });
    this.timer = setInterval(() => {
      void this.runOnce().catch((error: unknown) => {
        this.deps.logger.error('recovery sweep failed', errorFields(error));
      });
    }, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer !== undefined) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /**
   * Runs one sweep. Reentrancy-guarded: if a sweep is already in progress (a
   * slow run overlapping the next tick), this returns an empty summary.
   */
  async runOnce(): Promise<RecoverySummary> {
    if (this.running) {
      return { reclaimed: 0, resumed: 0 };
    }
    this.running = true;
    try {
      const reclaimed = await this.reclaimStuckDeliveries();
      const resumed = await this.resumeDueDeliveries();
      if (reclaimed > 0 || resumed > 0) {
        this.deps.logger.info('recovery sweep', { reclaimed, resumed });
      }
      return { reclaimed, resumed };
    } finally {
      this.running = false;
    }
  }

  private async reclaimStuckDeliveries(): Promise<number> {
    const cutoff = new Date(
      this.deps.clock.now().getTime() - this.deps.config.stuckDeliveringThresholdMs,
    );
    const stuck = await this.deps.deliveries.listStuckDelivering(
      cutoff,
      this.deps.config.batchLimit,
    );
    for (const delivery of stuck) {
      await this.deps.deliveries.save(reclaimStuck(delivery, this.deps.clock.now()));
      this.deps.logger.debug('reclaimed stuck delivery', {
        deliveryId: delivery.id,
        eventId: delivery.eventId,
        subscriptionId: delivery.subscriptionId,
        lastAttemptAt: delivery.lastAttemptAt,
      });
    }
    return stuck.length;
  }

  private async resumeDueDeliveries(): Promise<number> {
    const due = await this.deps.deliveries.listPendingDue(
      this.deps.clock.now(),
      this.deps.config.batchLimit,
    );
    for (const delivery of due) {
      await this.deps.resumer.resumeDelivery(delivery.id);
    }
    return due.length;
  }
}
