/**
 * HTTP routes for `/events`:
 *   POST /events       — accept an event, return `202 Accepted` once persisted;
 *                        dispatch to subscribers happens asynchronously.
 *   GET  /events/{id}   — read back a persisted event (events are immutable, so
 *                        there is no update or delete).
 */

import type { EventService } from '../../application/event-service.js';
import { requiredParam, type Router } from '../router.js';

export function registerEventRoutes(router: Router, service: EventService): void {
  router.add('POST', '/events', async (context) => {
    const event = await service.ingest(context.body);
    return { status: 202, body: event };
  });

  router.add('GET', '/events/:id', async (context) => {
    const event = await service.getById(requiredParam(context, 'id'));
    return { status: 200, body: event };
  });
}
