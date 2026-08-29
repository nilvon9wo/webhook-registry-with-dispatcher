import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startTestApp, type TestApp } from '../support/test-app.js';

let app: TestApp;
/** Extra apps started by individual tests; closed in afterEach regardless of outcome. */
const extraApps: TestApp[] = [];

beforeEach(async () => {
  app = await startTestApp();
});

afterEach(async () => {
  await app.close();
  await Promise.all(extraApps.splice(0).map((extra) => extra.close()));
});

const VALID_BODY = {
  eventType: 'order.created',
  targetUrl: 'https://customer.example.com/webhooks/orders',
};

/** Creates a subscription and returns its id — the shared precondition for the lifecycle tests. */
async function createSubscription(): Promise<string> {
  const created = await app.request<{ id: string }>('POST', '/subscriptions', VALID_BODY);
  return created.body.id;
}

describe('/subscriptions lifecycle', () => {
  it('POST creates with 201, a sub_ id and a Location header', async () => {
    // Arrange — the shared valid body.

    // Act
    const created = await app.request<{ id: string }>('POST', '/subscriptions', VALID_BODY);

    // Assert
    expect(created.status).toBe(201);
    expect(created.body.id.startsWith('sub_')).toBe(true);
    expect(created.headers.get('location')).toBe(`/subscriptions/${created.body.id}`);
  });

  it('GET /{id} returns the created subscription', async () => {
    // Arrange
    const id = await createSubscription();

    // Act
    const fetched = await app.request('GET', `/subscriptions/${id}`);

    // Assert
    expect(fetched.status).toBe(200);
    expect(fetched.body).toMatchObject({ id, eventType: VALID_BODY.eventType });
  });

  it('PUT /{id} replaces the subscription and returns 200', async () => {
    // Arrange
    const id = await createSubscription();

    // Act
    const replaced = await app.request('PUT', `/subscriptions/${id}`, {
      eventType: 'order.updated',
      targetUrl: 'https://customer.example.com/webhooks/v2',
    });

    // Assert
    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({ id, eventType: 'order.updated' });
  });

  it('DELETE /{id} returns 204 and the subscription is then gone', async () => {
    // Arrange
    const id = await createSubscription();

    // Act
    const deleted = await app.request('DELETE', `/subscriptions/${id}`);

    // Assert
    expect(deleted.status).toBe(204);
    expect((await app.request('GET', `/subscriptions/${id}`)).status).toBe(404);
  });

  it('lists all subscriptions when no filter is given', async () => {
    // Arrange
    await app.request('POST', '/subscriptions', VALID_BODY);
    await app.request('POST', '/subscriptions', { ...VALID_BODY, eventType: 'order.deleted' });

    // Act
    const all = await app.request('GET', '/subscriptions');

    // Assert
    expect(all.status).toBe(200);
    expect((all.body as { subscriptions: unknown[] }).subscriptions).toHaveLength(2);
  });

  it('filters the list by event type', async () => {
    // Arrange
    await app.request('POST', '/subscriptions', VALID_BODY);
    await app.request('POST', '/subscriptions', { ...VALID_BODY, eventType: 'order.deleted' });

    // Act
    const filtered = await app.request('GET', '/subscriptions?eventType=order.deleted');

    // Assert
    expect(filtered.status).toBe(200);
    expect((filtered.body as { subscriptions: unknown[] }).subscriptions).toHaveLength(1);
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
    extraApps.push(strictApp);

    // Act
    const response = await strictApp.request('POST', '/subscriptions', {
      eventType: 'order.created',
      targetUrl: 'http://insecure.example/hook',
    });

    // Assert
    expect(response.status).toBe(400);
  });

  it('returns 400 for a non-JSON body', async () => {
    // Arrange
    const send = (): Promise<Response> =>
      fetch(`${app.baseUrl}/subscriptions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{ not json',
      });

    // Act
    const response = await send();

    // Assert
    expect(response.status).toBe(400);
  });

  it('returns 404 for an unknown subscription id', async () => {
    // Arrange — nothing created.

    // Act
    const response = await app.request('GET', '/subscriptions/sub_nope');

    // Assert
    expect(response.status).toBe(404);
  });

  it('returns 405 with an Allow header for an unsupported method on a known path', async () => {
    // Arrange — nothing created.

    // Act
    const response = await app.request('PATCH', '/subscriptions/sub_nope');

    // Assert
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toContain('GET');
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
