import { describe, expect, it } from 'vitest';
import { captureError } from '../../tests/support/capture-error.js';
import { Router, requiredParam, type RequestContext } from './router.js';

const noopHandler = (): { status: number } => ({ status: 200 });

function contextWith(params: Record<string, string>): RequestContext {
  return {
    method: 'GET',
    path: '/x',
    params,
    query: new URLSearchParams(),
    body: undefined,
  };
}

describe('Router.match', () => {
  it('matches a static route', () => {
    // Arrange
    const router = new Router().add('GET', '/subscriptions', noopHandler);

    // Act
    const match = router.match('GET', '/subscriptions');

    // Assert
    expect(match.outcome).toBe('matched');
  });

  it('captures a path parameter', () => {
    // Arrange
    const router = new Router().add('GET', '/subscriptions/:id', noopHandler);

    // Act
    const match = router.match('GET', '/subscriptions/sub_123');

    // Assert
    expect(match).toMatchObject({ outcome: 'matched', params: { id: 'sub_123' } });
  });

  it('url-decodes captured parameters', () => {
    // Arrange
    const router = new Router().add('GET', '/things/:name', noopHandler);

    // Act
    const match = router.match('GET', '/things/a%20b');

    // Assert
    expect(match).toMatchObject({ params: { name: 'a b' } });
  });

  it('reports not-found for an unknown path', () => {
    // Arrange
    const router = new Router().add('GET', '/subscriptions', noopHandler);

    // Act
    const match = router.match('GET', '/unknown');

    // Assert
    expect(match.outcome).toBe('not-found');
  });

  it('reports method-not-allowed with the allowed methods when only the method differs', () => {
    // Arrange
    const router = new Router()
      .add('GET', '/subscriptions/:id', noopHandler)
      .add('DELETE', '/subscriptions/:id', noopHandler);

    // Act
    const match = router.match('POST', '/subscriptions/sub_1');

    // Assert
    expect(match).toEqual({ outcome: 'method-not-allowed', allowed: ['GET', 'DELETE'] });
  });

  it('does not match when segment counts differ', () => {
    // Arrange
    const router = new Router().add('GET', '/subscriptions/:id', noopHandler);

    // Act
    const match = router.match('GET', '/subscriptions/sub_1/extra');

    // Assert
    expect(match.outcome).toBe('not-found');
  });
});

describe('requiredParam', () => {
  it('returns a captured parameter', () => {
    // Arrange
    const context = contextWith({ id: 'sub_1' });

    // Act
    const value = requiredParam(context, 'id');

    // Assert
    expect(value).toBe('sub_1');
  });

  it('throws when the parameter is absent', () => {
    // Arrange
    const context = contextWith({});

    // Act
    const error = captureError(() => requiredParam(context, 'id'));

    // Assert
    expect((error as Error).message).toContain('id');
  });
});
