import { describe, expect, it } from 'vitest';
import { errorFields } from './logging.js';

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
