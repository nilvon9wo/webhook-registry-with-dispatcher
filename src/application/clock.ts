/**
 * Time source abstraction so application logic can be tested without wall-clock
 * dependence. Production wiring uses {@link systemClock}; tests supply a fixed
 * or controllable clock.
 */

export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};

/** A clock fixed at a single instant. */
export function fixedClock(instant: Date): Clock {
  return { now: () => new Date(instant) };
}
