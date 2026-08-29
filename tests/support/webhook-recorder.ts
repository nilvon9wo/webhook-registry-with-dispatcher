/**
 * A real local HTTP server standing in for a subscriber endpoint in
 * integration/E2E tests. Records every request it receives and lets the test
 * control the response — a fixed status, or a queued sequence of statuses (for
 * retry scenarios), optionally with a delay (to exercise timeouts).
 */

import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface RecordedRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: http.IncomingHttpHeaders;
  readonly body: unknown;
}

export interface WebhookRecorderOptions {
  /** Response status(es). A single number repeats; an array is consumed then the last value repeats. */
  readonly status?: number | number[];
  /** Delay before responding, in ms (to trigger client timeouts). */
  readonly delayMs?: number;
}

export interface WebhookRecorder {
  readonly url: string;
  readonly received: RecordedRequest[];
  setStatus(status: number | number[]): void;
  setDelayMs(delayMs: number): void;
  close(): Promise<void>;
}

export async function startWebhookRecorder(
  options: WebhookRecorderOptions = {},
): Promise<WebhookRecorder> {
  const received: RecordedRequest[] = [];
  let statuses: number[] = normalizeStatus(options.status ?? 200);
  let delayMs = options.delayMs ?? 0;

  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      received.push({
        method: request.method ?? '',
        path: request.url ?? '',
        headers: request.headers,
        body: raw.length > 0 ? safeJsonParse(raw) : undefined,
      });
      const status = statuses.length > 1 ? (statuses.shift() ?? 200) : (statuses[0] ?? 200);
      const respond = (): void => {
        response.writeHead(status);
        response.end();
      };
      if (delayMs > 0) {
        setTimeout(respond, delayMs);
      } else {
        respond();
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/webhook`,
    received,
    setStatus: (status) => {
      statuses = normalizeStatus(status);
    },
    setDelayMs: (value) => {
      delayMs = value;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        if (!server.listening) {
          resolve();
          return;
        }
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function normalizeStatus(status: number | number[]): number[] {
  return Array.isArray(status) ? [...status] : [status];
}

function safeJsonParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
