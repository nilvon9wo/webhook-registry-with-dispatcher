/**
 * HTTP routes for `/subscriptions`. Thin adapter: read the request, call the
 * service, shape the response. Validation and persistence live in the service.
 */

import type { SubscriptionService } from '../../application/subscription-service.js';
import { requiredParam, type Router } from '../router.js';

export function registerSubscriptionRoutes(router: Router, service: SubscriptionService): void {
  router.add('POST', '/subscriptions', async (context) => {
    const created = await service.create(context.body);
    return {
      status: 201,
      body: created,
      headers: { Location: `/subscriptions/${created.id}` },
    };
  });

  router.add('GET', '/subscriptions', async (context) => {
    const eventType = context.query.get('eventType') ?? undefined;
    const items = await service.list({ eventType });
    return { status: 200, body: { items } };
  });

  router.add('GET', '/subscriptions/:id', async (context) => {
    const subscription = await service.get(requiredParam(context, 'id'));
    return { status: 200, body: subscription };
  });

  router.add('PUT', '/subscriptions/:id', async (context) => {
    const updated = await service.replace(requiredParam(context, 'id'), context.body);
    return { status: 200, body: updated };
  });

  router.add('DELETE', '/subscriptions/:id', async (context) => {
    await service.delete(requiredParam(context, 'id'));
    return { status: 204 };
  });
}
