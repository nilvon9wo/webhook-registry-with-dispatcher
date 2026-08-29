import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/test-app.js';

let app: TestApp;

beforeEach(async () => {
  app = await startTestApp();
});

afterEach(async () => {
  await app.close();
});

const VALID_BODY = {
  eventType: 'order.created',
  targetUrl: 'https://customer.example.com/webhooks/orders',
};

describe('/subscriptions lifecycle', () => {
  it('creates, reads, updates, and deletes a subscription', async () => {
    // Arrange — a valid subscription body.

    // Act
    const created = await app.request('POST', '/subscriptions', VALID_BODY);

    // Assert — creation
    expect(created.status).toBe(201);
    expect(created.headers.get('location')).toBe(
      `/subscriptions/${(created.body as { id: string }).id}`,
    );
    const id = (created.body as { id: string }).id;
    expect(id.startsWith('sub_')).toBe(true);

    // Act + Assert — read back
    const fetched = await app.request('GET', `/subscriptions/${id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body).toEqual(created.body);

    // Act + Assert — replace
    const replaced = await app.request('PUT', `/subscriptions/${id}`, {
      eventType: 'order.updated',
      targetUrl: 'https://customer.example.com/webhooks/v2',
    });
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ id, eventType: 'order.updated' });

    // Act + Assert — delete, then confirm gone
    const deleted = await app.request('DELETE', `/subscriptions/${id}`);
    expect(deleted.status).toBe(204);
    expect((await app.request('GET', `/subscriptions/${id}`)).status).toBe(404);
  });

  it('lists subscriptions and filters by event type', async () => {
    // Arrange
    await app.request('POST', '/subscriptions', VALID_BODY);
    await app.request('POST', '/subscriptions', { ...VALID_BODY, eventType: 'order.deleted' });

    // Act
    const filtered = await app.request('GET', '/subscriptions?eventType=order.deleted');

    // Assert
    expect(filtered.status).toBe(200);
    expect((filtered.body as { items: unknown[] }).items).toHaveLength(1);
  });

  it.each([
    { body: { targetUrl: VALID_BODY.targetUrl }, reason: 'missing eventType' },
    { body: { eventType: 'order.created' }, reason: 'missing targetUrl' },
    {
      body: { eventType: 'bad type', targetUrl: VALID_BODY.targetUrl },
      reason: 'malformed eventType',
    },
    {
      body: { eventType: 'order.created', targetUrl: 'not-a-url' },
      reason: 'malformed targetUrl',
    },
  ])('rejects $reason with 400 and a details array', async ({ body }) => {
    // Arrange — the parameterized invalid body.

    // Act
    const response = await app.request('POST', '/subscriptions', body);

    // Assert
    expect(response.status).toBe(400);
    expect(
      (response.body as { error: { details: string[] } }).error.details.length,
    ).toBeGreaterThan(0);
  });

  it('rejects a non-https target url when the strict URL policy is in effect', async () => {
    // Arrange — a second app with the production default (https only).
    const strictApp = await startTestApp({ env: { ALLOW_INSECURE_TARGET_URLS: 'false' } });

    // Act
    const response = await strictApp.request('POST', '/subscriptions', {
      eventType: 'order.created',
      targetUrl: 'http://insecure.example/hook',
    });
    await strictApp.close();

    // Assert
    expect(response.status).toBe(400);
  });

  it('returns 400 for a non-JSON body', async () => {
    // Arrange
    const raw = await fetch(`${app.baseUrl}/subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{ not json',
    });

    // Act
    const status = raw.status;

    // Assert
    expect(status).toBe(400);
  });

  it('returns 404 for an unknown subscription and 405 for an unsupported method', async () => {
    // Arrange — nothing created.

    // Act
    const missing = await app.request('GET', '/subscriptions/sub_nope');
    const badMethod = await app.request('PATCH', '/subscriptions/sub_nope');

    // Assert
    expect(missing.status).toBe(404);
    expect(badMethod.status).toBe(405);
    expect(badMethod.headers.get('allow')).toContain('GET');
  });

  it('exposes a health endpoint', async () => {
    // Arrange — none.

    // Act
    const health = await app.request('GET', '/health');

    // Assert
    expect(health.status).toBe(200);
    expect(health.body).toEqual({ status: 'ok' });
  });
});
