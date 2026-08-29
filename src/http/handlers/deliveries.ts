/**
 * HTTP routes for `/deliveries` (bonus, read-only).
 *
 *   GET /deliveries           optional ?eventId= &subscriptionId= &status=
 *   GET /deliveries/{id}
 *
 * The full delivery record is returned, which carries enough to see whether a
 * delivery succeeded, failed, or is pending/retrying (status, attempts,
 * lastStatusCode, lastError, nextAttemptAt, timestamps).
 */

import type { DeliveryService } from '../../application/delivery-service.js';
import { DELIVERY_STATUSES, isDeliveryStatus } from '../../domain/delivery.js';
import { failValidation } from '../../domain/validation.js';
import type { DeliveryListFilter } from '../../application/ports.js';
import { requiredParam, type Router } from '../router.js';

export function registerDeliveryRoutes(router: Router, service: DeliveryService): void {
  router.add('GET', '/deliveries', async (context) => {
    // LIMITATION (review S8, `docs/12`): returns every matching delivery, no
    // `?limit=` / cursor. A hot `eventId` would load the whole set into one
    // response. Acceptable at the challenge's scale; production needs pagination.
    const deliveries = await service.list(parseFilter(context.query));
    return { status: 200, body: { deliveries } };
  });

  router.add('GET', '/deliveries/:id', async (context) => {
    const delivery = await service.get(requiredParam(context, 'id'));
    return { status: 200, body: delivery };
  });
}

function parseFilter(query: URLSearchParams): DeliveryListFilter {
  const status = query.get('status');
  if (status !== null && status !== '' && !isDeliveryStatus(status)) {
    failValidation(`status must be one of: ${DELIVERY_STATUSES.join(', ')}`);
  }
  return {
    eventId: query.get('eventId') || undefined,
    subscriptionId: query.get('subscriptionId') || undefined,
    status: status && isDeliveryStatus(status) ? status : undefined,
  };
}
