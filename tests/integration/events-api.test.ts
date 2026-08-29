import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WebhookEvent } from '../../src/domain/event.js';
import type { EventDispatcher } from '../../src/application/event-service.js';
import { startTestApp, type TestApp } from '../support/test-app.js';

class SpyDispatcher implements EventDispatcher {
  readonly dispatched: WebhookEvent[] = [];
  dispatch(event: WebhookEvent): void {
    this.dispatched.push(event);
  }
}

let dispatcher: SpyDispatcher;
let app: TestApp;

beforeEach(async () => {
  dispatcher = new SpyDispatcher();
  app = await startTestApp({ eventDispatcher: dispatcher });
});

afterEach(async () => {
  await app.close();
});

describe('POST /events', () => {
  it('accepts a valid event with 202 and returns the assigned id and timestamp', async () => {
    // Arrange
    const body = { type: 'order.created', data: { orderId: '12345' } };

    // Act
    const response = await app.request<WebhookEvent>('POST', '/events', body);

    // Assert
    expect(response.status).toBe(202);
    expect(response.body.id.startsWith('evt_')).toBe(true);
    expect(response.body.type).toBe('order.created');
    expect(response.body.data).toEqual({ orderId: '12345' });
    expect(typeof response.body.createdAt).toBe('string');
  });

  it('persists the event so it survives a crash before dispatch', async () => {
    // Arrange
    const response = await app.request<WebhookEvent>('POST', '/events', { type: 'order.created' });

    // Act
    const persisted = await app.application.repositories.events.get(response.body.id);

    // Assert
    expect(persisted).toEqual(response.body);
  });

  it('defaults a missing payload to an empty object', async () => {
    // Arrange — body with no data field.

    // Act
    const response = await app.request<WebhookEvent>('POST', '/events', { type: 'order.created' });

    // Assert
    expect(response.body.data).toEqual({});
  });

  it('initiates dispatch with the persisted event', async () => {
    // Arrange
    const response = await app.request<WebhookEvent>('POST', '/events', { type: 'order.created' });

    // Act
    const dispatched = dispatcher.dispatched;

    // Assert
    expect(dispatched).toEqual([response.body]);
  });

  it('returns 202 without waiting for dispatch to finish', async () => {
    // Arrange — a dispatcher whose background work completes only after 200ms.
    let dispatchWorkFinished = false;
    const slowDispatcher: EventDispatcher = {
      dispatch: () => {
        setTimeout(() => {
          dispatchWorkFinished = true;
        }, 200);
      },
    };
    const slowApp = await startTestApp({ eventDispatcher: slowDispatcher });

    try {
      // Act
      const response = await slowApp.request('POST', '/events', { type: 'order.created' });

      // Assert — the response came back before the async dispatch work completed
      expect(response.status).toBe(202);
      expect(dispatchWorkFinished).toBe(false);
    } finally {
      await slowApp.close();
    }
  });

  it.each([
    { body: {}, reason: 'missing type' },
    { body: { type: '' }, reason: 'empty type' },
    { body: { type: 'order.created', data: [1, 2] }, reason: 'array payload' },
    { body: 'nope', reason: 'non-object body' },
  ])('rejects $reason with 400 and does not dispatch', async ({ body }) => {
    // Arrange — the parameterized invalid body.

    // Act
    const response = await app.request('POST', '/events', body);

    // Assert
    expect(response.status).toBe(400);
    expect(dispatcher.dispatched).toHaveLength(0);
  });
});

describe('GET /events/{id}', () => {
  it('returns a previously published event', async () => {
    // Arrange
    const published = await app.request<WebhookEvent>('POST', '/events', {
      type: 'order.created',
      data: { orderId: '12345' },
    });

    // Act
    const response = await app.request<WebhookEvent>('GET', `/events/${published.body.id}`);

    // Assert
    expect(response.status).toBe(200);
    expect(response.body).toEqual(published.body);
  });

  it('returns 404 for an unknown id', async () => {
    // Arrange — nothing published.

    // Act
    const response = await app.request('GET', '/events/evt_does_not_exist');

    // Assert
    expect(response.status).toBe(404);
  });
});
