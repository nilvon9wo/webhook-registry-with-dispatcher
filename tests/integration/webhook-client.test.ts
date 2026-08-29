import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createHttpWebhookClient } from '../../src/infrastructure/webhook-client.js';
import { startWebhookRecorder, type WebhookRecorder } from '../support/webhook-recorder.js';

const client = createHttpWebhookClient();
let recorder: WebhookRecorder;

beforeEach(async () => {
  recorder = await startWebhookRecorder();
});

afterEach(async () => {
  await recorder.close();
});

const payload = {
  id: 'evt_1',
  type: 'order.created',
  timestamp: '2026-08-28T10:15:00.000Z',
  data: { orderId: '12345' },
} as const;

function request(url: string, timeoutMs = 2000): Parameters<typeof client.send>[0] {
  return { url, payload, headers: { 'X-Webhook-Event-Id': 'evt_1' }, timeoutMs };
}

describe('createHttpWebhookClient', () => {
  it('POSTs JSON with the given headers and reports success on 2xx', async () => {
    // Arrange
    recorder.setStatus(202);

    // Act
    const outcome = await client.send(request(recorder.url));

    // Assert
    expect(outcome).toEqual({ kind: 'success', statusCode: 202 });
    expect(recorder.received[0]?.method).toBe('POST');
    expect(recorder.received[0]?.headers['content-type']).toBe('application/json');
    expect(recorder.received[0]?.headers['x-webhook-event-id']).toBe('evt_1');
    expect(recorder.received[0]?.body).toEqual(payload);
  });

  it.each([400, 404, 500, 503])('reports an http-error outcome for status %i', async (status) => {
    // Arrange
    recorder.setStatus(status);

    // Act
    const outcome = await client.send(request(recorder.url));

    // Assert
    expect(outcome).toEqual({ kind: 'http-error', statusCode: status });
  });

  it('reports a timeout when the subscriber responds slower than the timeout', async () => {
    // Arrange
    recorder.setDelayMs(300);

    // Act
    const outcome = await client.send(request(recorder.url, 50));

    // Assert
    expect(outcome).toEqual({ kind: 'timeout' });
  });

  it('reports a network error when the target is unreachable', async () => {
    // Arrange — a port with nothing listening.
    await recorder.close();

    // Act
    const outcome = await client.send(request(recorder.url));

    // Assert
    expect(outcome.kind).toBe('network-error');
  });
});
