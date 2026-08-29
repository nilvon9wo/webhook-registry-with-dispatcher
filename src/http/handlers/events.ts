/**
 * HTTP route for `/events`. Accepts an event and returns `202 Accepted` once it
 * is persisted — dispatch to subscribers happens asynchronously afterwards.
 */

import type { EventService } from '../../application/event-service.js';
import type { Router } from '../router.js';

export function registerEventRoutes(router: Router, service: EventService): void {
  router.add('POST', '/events', async (context) => {
    const event = await service.ingest(context.body);
    return { status: 202, body: event };
  });
}
