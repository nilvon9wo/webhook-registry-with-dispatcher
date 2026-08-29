/** A {@link Logger} that records every line for assertions in observability tests. */

import type { LogFields, Logger } from '../../src/application/logging.js';

export interface CapturedLine {
  readonly level: 'debug' | 'info' | 'warn' | 'error';
  readonly message: string;
  readonly fields: LogFields;
}

export interface CapturingLogger extends Logger {
  readonly lines: CapturedLine[];
}

export function createCapturingLogger(base: LogFields = {}): CapturingLogger {
  const lines: CapturedLine[] = [];

  const build = (context: LogFields): CapturingLogger => {
    const record =
      (level: CapturedLine['level']) =>
      (message: string, fields: LogFields = {}): void => {
        lines.push({ level, message, fields: { ...context, ...fields } });
      };
    return {
      lines,
      debug: record('debug'),
      info: record('info'),
      warn: record('warn'),
      error: record('error'),
      child: (fields: LogFields) => build({ ...context, ...fields }),
    };
  };

  return build(base);
}
