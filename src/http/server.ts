/**
 * HTTP server built on `node:http`.
 *
 * Responsibilities: read the body under a size cap, parse JSON, route the
 * request, serialize the handler result, and translate thrown errors into a
 * consistent response. Business logic lives in handlers/services, not here.
 */

import * as http from 'node:http';
import { errorFields, LOG_COMPONENTS, type Logger } from '../infrastructure/logger.js';
import { errorResponse, toErrorResponse } from './problem.js';
import type { HandlerResult, RequestContext, Router } from './router.js';

export interface HttpServerDeps {
  readonly router: Router;
  readonly logger: Logger;
  readonly maxRequestBodyBytes: number;
}

export function createHttpServer(deps: HttpServerDeps): http.Server {
  const scoped: HttpServerDeps = {
    ...deps,
    logger: deps.logger.child({ component: LOG_COMPONENTS.http }),
  };
  return http.createServer((request, response) => {
    void handleRequest(scoped, request, response);
  });
}

async function handleRequest(
  deps: HttpServerDeps,
  request: http.IncomingMessage,
  response: http.ServerResponse,
): Promise<void> {
  const startedAt = process.hrtime.bigint();
  const method = request.method ?? 'GET';
  const url = new URL(request.url ?? '/', 'http://localhost');
  const path = url.pathname;

  let result: HandlerResult;
  try {
    result = await route(deps, request, method, path, url.searchParams);
  } catch (error) {
    const mapped = toErrorResponse(error);
    if (mapped.serverFault) {
      deps.logger.error('http.request_error', {
        httpMethod: method,
        httpPath: path,
        ...errorFields(error),
      });
    }
    result = mapped.response;
  }

  writeResult(response, result);

  const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
  deps.logger.info('http.request', {
    httpMethod: method,
    httpPath: path,
    httpStatus: result.status,
    durationMs: Math.round(durationMs * 100) / 100,
  });
}

async function route(
  deps: HttpServerDeps,
  request: http.IncomingMessage,
  method: string,
  path: string,
  query: URLSearchParams,
): Promise<HandlerResult> {
  const bodyResult = await readBody(request, deps.maxRequestBodyBytes);
  if (!bodyResult.ok) {
    return { ...errorResponse(413, 'Request body too large'), headers: { Connection: 'close' } };
  }

  let body: unknown;
  if (bodyResult.text.length > 0) {
    try {
      body = JSON.parse(bodyResult.text);
    } catch {
      return errorResponse(400, 'Request body must be valid JSON');
    }
  }

  const match = deps.router.match(method, path);
  if (match.outcome === 'not-found') {
    return errorResponse(404, `No route for ${method} ${path}`);
  }
  if (match.outcome === 'method-not-allowed') {
    return {
      ...errorResponse(405, `Method ${method} not allowed for ${path}`),
      headers: { Allow: match.allowed.join(', ') },
    };
  }

  const context: RequestContext = { method, path, params: match.params, query, body };
  return match.handler(context);
}

type ReadBodyResult = { readonly ok: true; readonly text: string } | { readonly ok: false };

async function readBody(request: http.IncomingMessage, maxBytes: number): Promise<ReadBodyResult> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let tooLarge = false;

    request.on('data', (chunk: Buffer) => {
      if (tooLarge) {
        return;
      }
      size += chunk.length;
      if (size > maxBytes) {
        tooLarge = true;
        // Stop buffering but keep draining the socket so the 413 response can
        // still be written and the connection stays consistent.
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (!tooLarge) {
        resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') });
      }
    });
    request.on('error', reject);
  });
}

function writeResult(response: http.ServerResponse, result: HandlerResult): void {
  const headers: Record<string, string> = { ...result.headers };
  const hasBody = result.body !== undefined;
  if (hasBody) {
    headers['Content-Type'] = 'application/json';
  }
  response.writeHead(result.status, headers);
  response.end(hasBody ? JSON.stringify(result.body) : undefined);
}
