/**
 * Minimal structured logger: one JSON object per line to stdout (`debug`/`info`)
 * or stderr (`warn`/`error`). No dependency, proportional to the challenge.
 *
 * `child(fields)` returns a logger that merges `fields` into every line, used to
 * carry correlation ids (eventId, subscriptionId, deliveryId, attempt) through
 * the dispatch path.
 */

import type { LogLevel } from '../config.js';

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(fields: LogFields): Logger;
}

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LoggerOptions {
  readonly level: LogLevel;
  /** Sink for a formatted line; defaults to stdout/stderr by severity. */
  readonly write?: (line: string, level: LogLevel) => void;
  readonly now?: () => Date;
}

export function createLogger(options: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[options.level];
  const now = options.now ?? ((): Date => new Date());
  const write =
    options.write ??
    ((line: string, level: LogLevel): void => {
      const stream = LEVEL_ORDER[level] >= LEVEL_ORDER.warn ? process.stderr : process.stdout;
      stream.write(`${line}\n`);
    });

  function emit(level: LogLevel, base: LogFields, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < threshold) {
      return;
    }
    const line = JSON.stringify({
      time: now().toISOString(),
      level,
      message,
      ...base,
      ...fields,
    });
    write(line, level);
  }

  function build(base: LogFields): Logger {
    return {
      debug: (message, fields) => emit('debug', base, message, fields),
      info: (message, fields) => emit('info', base, message, fields),
      warn: (message, fields) => emit('warn', base, message, fields),
      error: (message, fields) => emit('error', base, message, fields),
      child: (fields) => build({ ...base, ...fields }),
    };
  }

  return build({});
}

/** Consistent `{ error, stack }` fields for logging a caught value. */
export function errorFields(error: unknown): { error: string; stack?: string } {
  if (error instanceof Error) {
    return error.stack !== undefined
      ? { error: error.message, stack: error.stack }
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
