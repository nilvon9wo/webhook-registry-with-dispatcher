import { describe, expect, it } from 'vitest';
import { ProblemCollector } from './validation.js';
import { validateTargetUrl } from './target-url.js';

const HTTPS_ONLY = { allowInsecure: false } as const;
const ALLOW_INSECURE = { allowInsecure: true } as const;

describe('validateTargetUrl', () => {
  it('accepts an https URL and returns its normalized form', () => {
    // Arrange
    const problems = new ProblemCollector();

    // Act
    const result = validateTargetUrl(
      'https://customer.example.com/webhooks/orders',
      HTTPS_ONLY,
      problems,
    );

    // Assert
    expect(result).toBe('https://customer.example.com/webhooks/orders');
    expect(problems.hasProblems).toBe(false);
  });

  it('rejects an http URL when only https is allowed', () => {
    // Arrange
    const problems = new ProblemCollector();

    // Act
    const result = validateTargetUrl('http://customer.example.com/hook', HTTPS_ONLY, problems);

    // Assert
    expect(result).toBeUndefined();
    expect(problems.list()).toContainEqual(expect.stringContaining('https'));
  });

  it('accepts an http URL when insecure targets are allowed', () => {
    // Arrange
    const problems = new ProblemCollector();

    // Act
    const result = validateTargetUrl('http://localhost:4000/hook', ALLOW_INSECURE, problems);

    // Assert
    expect(result).toBe('http://localhost:4000/hook');
    expect(problems.hasProblems).toBe(false);
  });

  it.each([
    { raw: 'not a url', reason: 'unparseable' },
    { raw: '/relative/path', reason: 'relative' },
    { raw: 'ftp://example.com/x', reason: 'wrong scheme' },
    { raw: 'https://user:pass@example.com/x', reason: 'embedded credentials' },
    { raw: '', reason: 'empty' },
    { raw: 42, reason: 'not a string' },
  ])('rejects $reason', ({ raw }) => {
    // Arrange
    const problems = new ProblemCollector();

    // Act
    const result = validateTargetUrl(raw, HTTPS_ONLY, problems);

    // Assert
    expect(result).toBeUndefined();
    expect(problems.hasProblems).toBe(true);
  });
});
