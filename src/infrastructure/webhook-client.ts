/**
 * Outbound webhook HTTP client.
 *
 * Every request carries an explicit timeout (via `AbortController`). The client
 * never throws: it maps success, non-2xx, timeout, and transport failures to an
 * {@link AttemptOutcome} so the dispatcher can classify and record uniformly.
 *
 * Redirects are not followed — the target is user-supplied and a redirect could
 * point at an internal address (see the SSRF note in `docs/4`). A 3xx is treated
 * as a permanent delivery failure.
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
  send(request: WebhookRequest): Promise<AttemptOutcome>;
}

export function createHttpWebhookClient(): WebhookClient {
  return {
    async send(request: WebhookRequest): Promise<AttemptOutcome> {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), request.timeoutMs);
      try {
        const response = await fetch(request.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...request.headers },
          body: JSON.stringify(request.payload),
          signal: controller.signal,
          redirect: 'manual',
        });
        // The response body is irrelevant to delivery success; release it.
        void response.body?.cancel().catch(() => {});

        if (response.status >= 200 && response.status < 300) {
          return { kind: 'success', statusCode: response.status };
        }
        return { kind: 'http-error', statusCode: response.status };
      } catch (error) {
        if (controller.signal.aborted) {
          return { kind: 'timeout' };
        }
        return { kind: 'network-error', message: errorMessage(error) };
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause;
    if (cause instanceof Error && cause.message !== '') {
      return `${error.message} (${cause.message})`;
    }
    return error.message;
  }
  return String(error);
}
