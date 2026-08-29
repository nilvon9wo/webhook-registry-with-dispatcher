import { describe, expect, it } from 'vitest';
import { newId } from './ids.js';

describe('newId', () => {
  it.each([
    { kind: 'subscription', prefix: 'sub_' },
    { kind: 'event', prefix: 'evt_' },
    { kind: 'delivery', prefix: 'del_' },
  ] as const)('prefixes a $kind id with "$prefix"', ({ kind, prefix }) => {
    // Arrange — none: the kind is the only input.

    // Act
    const id = newId(kind);

    // Assert
    expect(id.startsWith(prefix)).toBe(true);
    expect(id.slice(prefix.length)).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('returns a distinct value on each call', () => {
    // Arrange
    const count = 1000;

    // Act
    const ids = new Set(Array.from({ length: count }, () => newId('event')));

    // Assert
    expect(ids.size).toBe(count);
  });
});
