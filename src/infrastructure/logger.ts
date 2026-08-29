/**
 * Concrete logger: one JSON object per line, to stdout (`debug`/`info`) or
 * stderr (`warn`/`error`). No dependency, proportional to the challenge.
 *
 * The `Logger` port, conventions, `LOG_COMPONENTS`, `errorFields`, and
 * `silentLogger` live in `src/application/logging.ts`.
 */

import type { LogLevel } from '../config.js';
import type { LogFields, Logger } from '../application/logging.js';

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
