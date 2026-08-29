/**
 * Logging port.
 *
 * The application and domain layers depend only on this interface. The concrete
 * JSON-lines implementation is `src/infrastructure/logger.ts`
 * (`createLogger`); tests inject silent or capturing loggers.
 *
 * Conventions (full reference: `docs/11 - logging.md`):
 *
 *   - Every line is `{ time, level, message, component, ...fields }`.
 *   - `message` is a stable, dot-namespaced event identifier — never a sentence.
 *   - `component` names the subsystem (see {@link LOG_COMPONENTS}); set once per
 *     subsystem with `logger.child({ component })`.
 *   - Field names come from the shared dictionary in `docs/11`; recurring field
 *     groups are built with the helpers in `./log-fields.ts`.
 *   - `child(fields)` merges `fields` into every subsequent line — used to carry
 *     correlation ids (`eventId`, `subscriptionId`, `deliveryId`, `attempt`).
 */

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

/** Canonical `component` values. */
export const LOG_COMPONENTS = {
  bootstrap: 'bootstrap',
  http: 'http',
  eventService: 'event-service',
  dispatcher: 'dispatcher',
  recovery: 'recovery',
  persistence: 'persistence',
} as const;

export type LogComponent = (typeof LOG_COMPONENTS)[keyof typeof LOG_COMPONENTS];

/** Consistent `{ error, errorStack }` fields for logging a caught value. */
export function errorFields(error: unknown): { error: string; errorStack?: string } {
  if (error instanceof Error) {
    return error.stack !== undefined
      ? { error: error.message, errorStack: error.stack }
      : { error: error.message };
  }
  return { error: String(error) };
}

/** A logger that discards everything — for tests that do not assert on logs. */
export const silentLogger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => silentLogger,
};
