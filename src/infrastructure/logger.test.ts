import { describe, expect, it } from 'vitest';
import type { LogLevel } from '../config.js';
import { createLogger, errorFields, type Logger } from './logger.js';

interface Captured {
  readonly level: LogLevel;
  readonly line: Record<string, unknown>;
}

function loggerCapturing(level: LogLevel): { logger: Logger; lines: Captured[] } {
  const lines: Captured[] = [];
  const logger = createLogger({
    level,
    now: () => new Date('2026-08-28T10:00:00.000Z'),
    write: (line, lvl) =>
      lines.push({ level: lvl, line: JSON.parse(line) as Record<string, unknown> }),
  });
  return { logger, lines };
}

/** Emits one line at each of the four levels, using the level name as the message. */
function emitAtEveryLevel(logger: Logger): void {
  logger.debug('debug');
  logger.info('info');
  logger.warn('warn');
  logger.error('error');
}

describe('createLogger', () => {
  it('emits a structured line with time, level, and message', () => {
    // Arrange
    const { logger, lines } = loggerCapturing('debug');

    // Act
    logger.info('hello', { subscriptionId: 'sub_1' });

    // Assert
    expect(lines).toHaveLength(1);
    expect(lines[0]?.line).toEqual({
      time: '2026-08-28T10:00:00.000Z',
      level: 'info',
      message: 'hello',
      subscriptionId: 'sub_1',
    });
  });

  it.each([
    { threshold: 'debug', emitted: ['debug', 'info', 'warn', 'error'] },
    { threshold: 'info', emitted: ['info', 'warn', 'error'] },
    { threshold: 'warn', emitted: ['warn', 'error'] },
    { threshold: 'error', emitted: ['error'] },
  ] as const)('at level "$threshold" emits only $emitted', ({ threshold, emitted }) => {
    // Arrange
    const { logger, lines } = loggerCapturing(threshold);

    // Act
    emitAtEveryLevel(logger);

    // Assert
    expect(lines.map((entry) => entry.line.level)).toEqual(emitted);
  });

  it('child loggers merge their fields into every line', () => {
    // Arrange
    const { logger, lines } = loggerCapturing('info');
    const child = logger.child({ deliveryId: 'del_1' }).child({ attempt: 2 });

    // Act
    child.info('delivering');

    // Assert
    expect(lines[0]?.line).toMatchObject({
      deliveryId: 'del_1',
      attempt: 2,
      message: 'delivering',
    });
  });

  it('passes each line to the sink tagged with its own level', () => {
    // Arrange
    const { logger, lines } = loggerCapturing('debug');

    // Act
    logger.error('error');

    // Assert
    expect(lines[0]?.level).toBe('error');
  });
});

describe('errorFields', () => {
  it('extracts message and stack from an Error', () => {
    // Arrange
    const error = new Error('boom');

    // Act
    const fields = errorFields(error);

    // Assert
    expect(fields.error).toBe('boom');
    expect(fields.errorStack).toContain('Error: boom');
  });

  it('stringifies a non-Error and omits the stack', () => {
    // Arrange
    const thrown = 'just a string';

    // Act
    const fields = errorFields(thrown);

    // Assert
    expect(fields).toEqual({ error: 'just a string' });
  });
});
