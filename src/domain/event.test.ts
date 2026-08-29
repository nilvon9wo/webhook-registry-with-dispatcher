import { describe, expect, it } from 'vitest';
import { captureError } from '../../tests/support/capture-error.js';
import { ValidationError } from './errors.js';
import { createEvent, parseEventInput, toDeliveryPayload, type WebhookEvent } from './event.js';

describe('parseEventInput', () => {
  it('accepts type with an object payload', () => {
    // Arrange
    const body = { type: 'order.created', data: { orderId: '12345' } };

    // Act
    const input = parseEventInput(body);

    // Assert
    expect(input).toEqual({ type: 'order.created', data: { orderId: '12345' } });
  });

  it('defaults data to an empty object when omitted', () => {
    // Arrange
    const body = { type: 'order.created' };

    // Act
    const input = parseEventInput(body);

    // Assert
    expect(input.data).toEqual({});
  });

  it.each([
    { body: {}, reason: 'missing type' },
    { body: { type: '' }, reason: 'empty type' },
    { body: { type: 'order.created', data: [] }, reason: 'array data' },
    { body: { type: 'order.created', data: 'x' }, reason: 'string data' },
    { body: { type: 'order.created', data: null }, reason: 'null data' },
    { body: 'not-an-object', reason: 'non-object body' },
  ])('rejects $reason', ({ body }) => {
    // Arrange — the parameterized invalid body.

    // Act
    const error = captureError(() => parseEventInput(body));

    // Assert
    expect(error).toBeInstanceOf(ValidationError);
  });
});

describe('createEvent', () => {
  it('assigns the id and an ISO timestamp', () => {
    // Arrange
    const input = parseEventInput({ type: 'order.created', data: { orderId: '12345' } });
    const now = new Date('2026-08-28T10:15:00.000Z');

    // Act
    const event = createEvent(input, 'evt_generated', now);

    // Assert
    expect(event).toEqual({
      id: 'evt_generated',
      type: 'order.created',
      data: { orderId: '12345' },
      createdAt: '2026-08-28T10:15:00.000Z',
    });
  });
});

describe('toDeliveryPayload', () => {
  it('maps an event to the subscriber-facing shape (createdAt becomes timestamp)', () => {
    // Arrange
    const event: WebhookEvent = {
      id: 'evt_123',
      type: 'order.created',
      data: { orderId: '12345' },
      createdAt: '2026-08-28T10:15:00.000Z',
    };

    // Act
    const payload = toDeliveryPayload(event);

    // Assert
    expect(payload).toEqual({
      id: 'evt_123',
      type: 'order.created',
      timestamp: '2026-08-28T10:15:00.000Z',
      data: { orderId: '12345' },
    });
  });
});
