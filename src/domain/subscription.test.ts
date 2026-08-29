import { describe, expect, it } from 'vitest';
import { captureError } from '../../tests/support/capture-error.js';
import { ValidationError } from './errors.js';
import {
  createSubscription,
  parseSubscriptionInput,
  replaceSubscription,
  type Subscription,
} from './subscription.js';

const HTTPS_ONLY = { allowInsecure: false } as const;
const VALID_BODY = {
  eventType: 'order.created',
  targetUrl: 'https://customer.example.com/webhooks/orders',
};

describe('parseSubscriptionInput', () => {
  it('accepts a well-formed body', () => {
    // Arrange — the shared valid body.

    // Act
    const input = parseSubscriptionInput(VALID_BODY, HTTPS_ONLY);

    // Assert
    expect(input).toEqual({
      eventType: 'order.created',
      targetUrl: 'https://customer.example.com/webhooks/orders',
    });
  });

  it('ignores unknown fields', () => {
    // Arrange
    const body = { ...VALID_BODY, id: 'sub_client_supplied', createdAt: '2000-01-01' };

    // Act
    const input = parseSubscriptionInput(body, HTTPS_ONLY);

    // Assert
    expect(input).toEqual({
      eventType: 'order.created',
      targetUrl: 'https://customer.example.com/webhooks/orders',
    });
  });

  it.each([
    { body: { targetUrl: VALID_BODY.targetUrl }, reason: 'missing eventType' },
    { body: { eventType: 'order.created' }, reason: 'missing targetUrl' },
    { body: { eventType: '', targetUrl: VALID_BODY.targetUrl }, reason: 'empty eventType' },
    {
      body: { eventType: 'order.created', targetUrl: 'http://insecure.example/x' },
      reason: 'non-https targetUrl',
    },
    { body: { eventType: 'order.created', targetUrl: 'nonsense' }, reason: 'malformed targetUrl' },
    { body: [], reason: 'array body' },
    { body: 'string', reason: 'non-object body' },
  ])('rejects $reason', ({ body }) => {
    // Arrange — the parameterized invalid body.

    // Act
    const error = captureError(() => parseSubscriptionInput(body, HTTPS_ONLY));

    // Assert
    expect(error).toBeInstanceOf(ValidationError);
  });

  it('reports multiple problems together', () => {
    // Arrange
    const body = { eventType: '', targetUrl: 'nonsense' };

    // Act
    const error = captureError(() => parseSubscriptionInput(body, HTTPS_ONLY));

    // Assert
    expect((error as ValidationError).problems).toHaveLength(2);
  });
});

describe('createSubscription', () => {
  it('assigns the id and equal created/updated timestamps', () => {
    // Arrange
    const input = parseSubscriptionInput(VALID_BODY, HTTPS_ONLY);
    const now = new Date('2026-08-28T10:00:00.000Z');

    // Act
    const subscription = createSubscription(input, 'sub_generated', now);

    // Assert
    expect(subscription).toEqual({
      id: 'sub_generated',
      eventType: 'order.created',
      targetUrl: 'https://customer.example.com/webhooks/orders',
      createdAt: '2026-08-28T10:00:00.000Z',
      updatedAt: '2026-08-28T10:00:00.000Z',
    });
  });
});

describe('replaceSubscription', () => {
  it('keeps id and createdAt, updates the mutable fields and updatedAt', () => {
    // Arrange
    const existing: Subscription = {
      id: 'sub_1',
      eventType: 'order.created',
      targetUrl: 'https://old.example.com/hook',
      createdAt: '2026-08-28T10:00:00.000Z',
      updatedAt: '2026-08-28T10:00:00.000Z',
    };
    const replacement = parseSubscriptionInput(
      { eventType: 'order.updated', targetUrl: 'https://new.example.com/hook' },
      HTTPS_ONLY,
    );
    const now = new Date('2026-08-29T09:30:00.000Z');

    // Act
    const updated = replaceSubscription(existing, replacement, now);

    // Assert
    expect(updated).toEqual({
      id: 'sub_1',
      eventType: 'order.updated',
      targetUrl: 'https://new.example.com/hook',
      createdAt: '2026-08-28T10:00:00.000Z',
      updatedAt: '2026-08-29T09:30:00.000Z',
    });
  });
});
