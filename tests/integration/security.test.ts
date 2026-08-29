import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/test-app.js';

let app: TestApp;

beforeEach(async () => {
  // Production-like: https-only target URLs and the SSRF guard on.
  app = await startTestApp({
    env: { ALLOW_INSECURE_TARGET_URLS: 'true', SSRF_GUARD_ENABLED: 'true' },
  });
});

afterEach(async () => {
  await app.close();
});

describe('SSRF guard on the /subscriptions endpoint', () => {
  it.each([
    'http://127.0.0.1:9000/hook',
    'http://169.254.169.254/latest/meta-data',
    'https://[::1]/hook',
    'http://10.0.0.5/hook',
  ])('rejects a target that points at %s', async (targetUrl) => {
    // Arrange — the parameterized blocked target.

    // Act
    const response = await app.request('POST', '/subscriptions', {
      eventType: 'order.created',
      targetUrl,
    });

    // Assert
    expect(response.status).toBe(400);
    expect(JSON.stringify(response.body)).toMatch(/targetUrl rejected/);
  });
});

describe('request hardening', () => {
  it('rejects a body larger than the configured limit with 413', async () => {
    // Arrange
    const smallLimitApp = await startTestApp({ env: { MAX_REQUEST_BODY_BYTES: '100' } });
    try {
      const oversized = JSON.stringify({ eventType: 'order.created', targetUrl: 'x'.repeat(500) });

      // Act
      const response = await fetch(`${smallLimitApp.baseUrl}/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: oversized,
      });

      // Assert
      expect(response.status).toBe(413);
    } finally {
      await smallLimitApp.close();
    }
  });

  it('does not leak internals in a 500 response', async () => {
    // Arrange — force an internal error by breaking the repository (SSRF guard
    // off so the request reaches the failing save).
    const brokenApp = await startTestApp();
    brokenApp.application.repositories.subscriptions.save = async () => {
      throw new Error('database is on fire at /secret/path');
    };
    try {
      // Act
      const response = await brokenApp.request('POST', '/subscriptions', {
        eventType: 'order.created',
        targetUrl: 'https://customer.example.com/hook',
      });

      // Assert
      expect(response.status).toBe(500);
      expect(JSON.stringify(response.body)).toBe('{"error":{"message":"Internal server error"}}');
    } finally {
      await brokenApp.close();
    }
  });
});
