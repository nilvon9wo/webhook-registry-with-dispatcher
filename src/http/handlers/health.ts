/** Liveness endpoint. Intentionally does not probe the datastore. */

import type { Router } from '../router.js';

export function registerHealthRoute(router: Router): void {
  router.add('GET', '/health', () => ({ status: 200, body: { status: 'ok' } }));
}
