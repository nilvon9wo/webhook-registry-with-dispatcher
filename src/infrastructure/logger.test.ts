import { describe, expect, it } from 'vitest';
import type { LogLevel } from '../config.js';
import { createLogger, type Logger } from './logger.js';

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

  it('suppresses lines below the configured level', () => {
    // Arrange
    const { logger, lines } = loggerCapturing('warn');

    // Act
    logger.debug('d');
    logger.info('i');
    logger.warn('w');
    logger.error('e');

    // Assert
    expect(lines.map((entry) => entry.line.level)).toEqual(['warn', 'error']);
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

  it('routes warn and error to the stderr sink classification', () => {
    // Arrange
    const { logger, lines } = loggerCapturing('debug');

    // Act
    logger.info('i');
    logger.error('e');

    // Assert
    expect(lines.map((entry) => entry.level)).toEqual(['info', 'error']);
  });
});
