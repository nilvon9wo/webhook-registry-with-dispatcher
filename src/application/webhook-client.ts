/**
 * Outbound webhook client port. The concrete `fetch`-based implementation is
 * `src/infrastructure/webhook-client.ts` (`createHttpWebhookClient`); tests
 * inject a fake.
 */

import type { WebhookDeliveryPayload } from '../domain/event.js';
import type { AttemptOutcome } from '../domain/retry-policy.js';

export interface WebhookRequest {
  readonly url: string;
  readonly payload: WebhookDeliveryPayload;
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface WebhookClient {
  /**
   * POSTs the payload to the target and maps success, non-2xx, timeout, and
   * transport failures to an {@link AttemptOutcome}. Never throws.
   */
  send(request: WebhookRequest): Promise<AttemptOutcome>;
}
