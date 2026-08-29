import { describe, expect, it } from 'vitest';
import { captureError } from '../../tests/support/capture-error.js';
import { ValidationError } from './errors.js';
import {
  assertProvided,
  failValidation,
  isPlainObject,
  MAX_EVENT_TYPE_LENGTH,
  ProblemCollector,
  validateEventType,
} from './validation.js';

describe('ProblemCollector', () => {
  it('does not throw when nothing was recorded', () => {
    // Arrange
    const collector = new ProblemCollector();

    // Act
    const act = (): void => collector.throwIfAny();

    // Assert
    expect(act).not.toThrow();
    expect(collector.hasProblems).toBe(false);
  });

  it('throws a ValidationError carrying every recorded problem', () => {
    // Arrange
    const collector = new ProblemCollector();
    collector.add('first problem');
    collector.add('second problem');

    // Act
    const error = captureError(() => collector.throwIfAny());

    // Assert
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).problems).toEqual(['first problem', 'second problem']);
  });
});

describe('isPlainObject', () => {
  it.each([
    { value: {}, expected: true },
    { value: { a: 1 }, expected: true },
    { value: [], expected: false },
    { value: null, expected: false },
    { value: 'x', expected: false },
    { value: 42, expected: false },
  ])('returns $expected for $value', ({ value, expected }) => {
    // Arrange — none: the value is the sole input.

    // Act
    const result = isPlainObject(value);

    // Assert
    expect(result).toBe(expected);
  });
});

describe('failValidation', () => {
  it('throws a ValidationError with the given problems', () => {
    // Arrange
    const problems = ['bad body'];

    // Act
    const error = captureError(() => failValidation(...problems));

    // Assert
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).problems).toEqual(problems);
  });
});

describe('assertProvided', () => {
  it('returns the value when it is defined', () => {
    // Arrange
    const value = 'present';

    // Act
    const result = assertProvided(value, 'field');

    // Assert
    expect(result).toBe('present');
  });

  it('throws an internal error when the value is undefined', () => {
    // Arrange
    const value: string | undefined = undefined;

    // Act
    const error = captureError(() => assertProvided(value, 'field'));

    // Assert
    expect((error as Error).message).toContain('field');
  });
});

describe('validateEventType', () => {
  it.each(['order.created', 'user_signed_up', 'ab', 'a-b-c', 'A1.B2'])(
    'accepts and trims a valid type: %s',
    (raw) => {
      // Arrange
      const problems = new ProblemCollector();

      // Act
      const result = validateEventType(`  ${raw}  `, 'eventType', problems);

      // Assert
      expect(result).toBe(raw);
      expect(problems.hasProblems).toBe(false);
    },
  );

  it.each([
    { raw: '', reason: 'empty' },
    { raw: '   ', reason: 'blank' },
    { raw: undefined, reason: 'missing' },
    { raw: 42, reason: 'not a string' },
    { raw: 'order..created', reason: 'double separator' },
    { raw: '.order', reason: 'leading separator' },
    { raw: 'order.', reason: 'trailing separator' },
    { raw: 'order/created', reason: 'illegal character' },
    { raw: 'order created', reason: 'space' },
  ])('rejects $reason', ({ raw }) => {
    // Arrange
    const problems = new ProblemCollector();

    // Act
    const result = validateEventType(raw, 'eventType', problems);

    // Assert
    expect(result).toBeUndefined();
    expect(problems.hasProblems).toBe(true);
  });

  it('rejects a type longer than the maximum', () => {
    // Arrange
    const problems = new ProblemCollector();
    const tooLong = 'a'.repeat(MAX_EVENT_TYPE_LENGTH + 1);

    // Act
    const result = validateEventType(tooLong, 'eventType', problems);

    // Assert
    expect(result).toBeUndefined();
    expect(problems.list()).toContainEqual(expect.stringContaining('at most'));
  });
});
