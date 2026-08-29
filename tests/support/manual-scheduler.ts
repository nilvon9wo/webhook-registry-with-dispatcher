/**
 * A {@link Scheduler} whose deferred callbacks fire only when the test tells
 * them to. Makes retry timing deterministic and exposes the backoff delays the
 * dispatcher chose.
 */

import type { Scheduler } from '../../src/application/scheduler.js';

interface Task {
  readonly callback: () => void;
  readonly delayMs: number;
}

export class ManualScheduler implements Scheduler {
  private readonly tasks = new Map<object, Task>();

  schedule(callback: () => void, delayMs: number): () => void {
    const key = {};
    this.tasks.set(key, { callback, delayMs });
    return () => {
      this.tasks.delete(key);
    };
  }

  /** Delays of the currently-pending tasks, in scheduling order. */
  get pendingDelays(): number[] {
    return [...this.tasks.values()].map((task) => task.delayMs);
  }

  get pendingCount(): number {
    return this.tasks.size;
  }

  /** Fires every currently-pending task once (not tasks those callbacks schedule). */
  runPending(): void {
    const snapshot = [...this.tasks.values()];
    this.tasks.clear();
    for (const task of snapshot) {
      task.callback();
    }
  }
}

interface AwaitableDispatcher {
  whenIdle(): Promise<void>;
}

/**
 * Repeatedly fires pending scheduled tasks and awaits the resulting work until
 * the scheduler is empty and the dispatcher is idle (or a safety cap is hit).
 */
export async function drainScheduler(
  scheduler: ManualScheduler,
  dispatcher: AwaitableDispatcher,
  maxRounds = 50,
): Promise<void> {
  for (let round = 0; round < maxRounds; round += 1) {
    await dispatcher.whenIdle();
    if (scheduler.pendingCount === 0) {
      return;
    }
    scheduler.runPending();
  }
  throw new Error('drainScheduler did not settle within the round cap');
}
