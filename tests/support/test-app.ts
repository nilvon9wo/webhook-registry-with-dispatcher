/**
 * Boots the real application (in-memory persistence) on an ephemeral port for
 * integration and E2E tests, and provides a small fetch-based client.
 */

import type { AddressInfo } from 'node:net';
import type { Application, BuildApplicationOptions } from '../../src/container.js';
import { buildApplication } from '../../src/container.js';
import { loadConfig } from '../../src/config.js';

export interface TestResponse<T = unknown> {
  readonly status: number;
  readonly body: T;
  readonly headers: Headers;
}

export interface TestApp {
  readonly baseUrl: string;
  readonly application: Application;
  request<T = unknown>(method: string, path: string, body?: unknown): Promise<TestResponse<T>>;
  close(): Promise<void>;
}

export interface StartTestAppOptions extends BuildApplicationOptions {
  readonly env?: Record<string, string>;
}

export async function startTestApp(options: StartTestAppOptions = {}): Promise<TestApp> {
  const { env, ...buildOptions } = options;
  const config = loadConfig({
    PERSISTENCE: 'memory',
    ALLOW_INSECURE_TARGET_URLS: 'true',
    LOG_LEVEL: 'error',
    RECOVERY_INTERVAL_MS: '0',
    ...env,
  });
  const application = buildApplication(config, buildOptions);

  await new Promise<void>((resolve) => {
    application.httpServer.listen(0, '127.0.0.1', resolve);
  });
  const address = application.httpServer.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;

  return {
    baseUrl,
    application,
    async request<T>(method: string, path: string, body?: unknown): Promise<TestResponse<T>> {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      return {
        status: response.status,
        body: (text.length > 0 ? JSON.parse(text) : undefined) as T,
        headers: response.headers,
      };
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) => {
        application.httpServer.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}
