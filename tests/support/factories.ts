/**
 * Explicit, readable test-data builders. Each returns a fully-formed domain
 * object; pass an override object to change only the fields a test cares about.
 */

import type { Delivery, DeliveryStatus } from '../../src/domain/delivery.js';
import type { WebhookEvent } from '../../src/domain/event.js';
import type { Subscription } from '../../src/domain/subscription.js';

let counter = 0;
const uniqueSuffix = (): string => {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}`;
};

export function aSubscription(overrides: Partial<Subscription> = {}): Subscription {
  const suffix = uniqueSuffix();
  return {
    id: `sub_${suffix}`,
    eventType: 'order.created',
    targetUrl: 'https://subscriber.example/webhooks/orders',
    createdAt: '2026-08-28T10:00:00.000Z',
    updatedAt: '2026-08-28T10:00:00.000Z',
    ...overrides,
  };
}

export function anEvent(overrides: Partial<WebhookEvent> = {}): WebhookEvent {
  const suffix = uniqueSuffix();
  return {
    id: `evt_${suffix}`,
    type: 'order.created',
    data: { orderId: '12345' },
    createdAt: '2026-08-28T10:15:00.000Z',
    ...overrides,
  };
}

export function aDelivery(overrides: Partial<Delivery> = {}): Delivery {
  const suffix = uniqueSuffix();
  const status: DeliveryStatus = overrides.status ?? 'pending';
  return {
    id: `del_${suffix}`,
    eventId: `evt_${suffix}`,
    subscriptionId: `sub_${suffix}`,
    targetUrl: 'https://subscriber.example/webhooks/orders',
    status,
    attempts: 0,
    createdAt: '2026-08-28T10:15:00.000Z',
    updatedAt: '2026-08-28T10:15:00.000Z',
    nextAttemptAt: status === 'pending' ? '2026-08-28T10:15:00.000Z' : null,
    lastAttemptAt: null,
    lastStatusCode: null,
    lastError: null,
    completedAt: null,
    ...overrides,
  };
}
