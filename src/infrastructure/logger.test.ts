import { describe, expect, it, vi } from 'vitest';
import type { LogLevel } from '../config.js';
import type { Logger } from '../application/logging.js';
import { createLogger } from './logger.js';

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

describe('createLogger pretty format', () => {
  const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

  /** Captures what the default sink writes (stdout + stderr), colour codes removed. */
  function capturePretty(emit: (logger: Logger) => void): string {
    const written: string[] = [];
    const sink = ((chunk: unknown): boolean => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stdout.write;
    const outSpy = vi.spyOn(process.stdout, 'write').mockImplementation(sink);
    const errSpy = vi.spyOn(process.stderr, 'write').mockImplementation(sink);
    try {
      emit(
        createLogger({
          level: 'debug',
          format: 'pretty',
          now: () => new Date('2026-08-28T10:00:00.000Z'),
        }),
      );
    } finally {
      outSpy.mockRestore();
      errSpy.mockRestore();
    }
    return written.join('').replace(ANSI_PATTERN, '').trimEnd();
  }

  it('renders one line as: LEVEL, message, then key=value fields', () => {
    // Arrange — the emit callback is the input under test.
    const emit = (logger: Logger): void => {
      logger.child({ component: 'dispatcher' }).info('delivery.succeeded', {
        deliveryId: 'del_1',
        attempt: 1,
      });
    };

    // Act
    const line = capturePretty(emit);

    // Assert
    expect(line).toBe(
      'INFO   delivery.succeeded  deliveryId=del_1 attempt=1  dispatcher 10:00:00.000',
    );
  });

  it('puts the timestamp last, not first', () => {
    // Arrange
    const emit = (logger: Logger): void => logger.warn('config.warning', { detail: 'x' });

    // Act
    const line = capturePretty(emit);

    // Assert
    expect(line.indexOf('10:00:00.000')).toBeGreaterThan(line.indexOf('config.warning'));
  });

  it('uppercases and pads the level so columns align', () => {
    // Arrange
    const emit = (logger: Logger): void => logger.error('boom');

    // Act
    const line = capturePretty(emit);

    // Assert
    expect(line.startsWith('ERROR  boom')).toBe(true);
  });
});
