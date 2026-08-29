/**
 * Concrete logger.
 *
 * Default (machine) rendering: one JSON object per line, to stdout
 * (`debug`/`info`) or stderr (`warn`/`error`). This is the contract downstream
 * log processors depend on.
 *
 * `pretty` rendering: a single coloured line per entry —
 * `LEVEL  message  key=value …  component time` — for a human watching a local
 * terminal. It is a convenience for the built-in sink only; supplying a custom
 * `write` always gets JSON, so tests and downstream code see structured data.
 *
 * The `Logger` port, conventions, `LOG_COMPONENTS`, `errorFields`, and
 * `silentLogger` live in `src/application/logging.ts`.
 */

import type { LogFormat, LogLevel } from '../config.js';
import type { LogFields, Logger } from '../application/logging.js';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };
const ESC = String.fromCharCode(27); // ANSI escape; kept out of source as a literal

export interface LoggerOptions {
  readonly level: LogLevel;
  /**
   * `json` (default) | `pretty` | `auto` (pretty when stdout is a TTY).
   * Ignored when `write` is set — a custom sink always receives JSON.
   */
  readonly format?: LogFormat;
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

  const format = options.format ?? 'auto';
  const isTty = Boolean(process.stdout.isTTY);
  // `pretty` only makes sense for the built-in sink; a custom `write` gets JSON.
  const pretty =
    options.write === undefined && (format === 'pretty' || (format === 'auto' && isTty));
  // Colour when the terminal can show it (explicit `pretty` opts in even if the
  // TTY check is unreliable, e.g. behind `tsx watch`); `NO_COLOR` always wins.
  const color =
    pretty &&
    !('NO_COLOR' in process.env) &&
    (isTty || format === 'pretty' || 'FORCE_COLOR' in process.env);
  const render = pretty
    ? (record: LogRecord): string => prettyLine(record, color)
    : (record: LogRecord): string => JSON.stringify(record);

  function emit(level: LogLevel, base: LogFields, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < threshold) {
      return;
    }
    const record: LogRecord = {
      time: now().toISOString(),
      level,
      message,
      ...base,
      ...fields,
    };
    write(render(record), level);
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

interface LogRecord extends LogFields {
  readonly time: string;
  readonly level: LogLevel;
  readonly message: string;
}

// --- pretty rendering -------------------------------------------------------

const ANSI: Record<LogLevel, string> = {
  debug: '2', // dim
  info: '36', // cyan
  warn: '33;1', // bold yellow
  error: '31;1', // bold red
};
const DIM = '2';

function paint(code: string, text: string, color: boolean): string {
  return color ? `${ESC}[${code}m${text}${ESC}[0m` : text;
}

function formatValue(value: unknown): string {
  if (typeof value === 'string') {
    return /\s/.test(value) ? JSON.stringify(value) : value;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  return JSON.stringify(value);
}

function prettyLine(record: LogRecord, color: boolean): string {
  const { time, level, message, component, ...rest } = record;
  const parts = [paint(ANSI[level], level.toUpperCase().padEnd(5), color), message];

  const fields = Object.entries(rest)
    .map(([key, value]) => `${paint(DIM, `${key}=`, color)}${formatValue(value)}`)
    .join(' ');
  if (fields) {
    parts.push(fields);
  }

  const trailer = [component, time.slice(11, 23)].filter(Boolean).join(' ');
  parts.push(paint(DIM, trailer, color));

  return parts.join('  ');
}
