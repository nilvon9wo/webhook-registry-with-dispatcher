/**
 * Minimal HTTP router.
 *
 * Enough for this service's handful of routes and nothing more: exact segment
 * matching with `:name` path parameters. No regex routes, no wildcards, no
 * middleware chain. Distinguishes "no such path" (404) from "path exists, wrong
 * method" (405).
 */

export interface RequestContext {
  readonly method: string;
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  /** Parsed JSON request body, or `undefined` when there was no body. */
  readonly body: unknown;
}

export interface HandlerResult {
  readonly status: number;
  /** JSON-serialised into the response with `Content-Type: application/json`. */
  readonly body?: unknown;
  /** A pre-formatted response body (e.g. HTML, YAML); set `Content-Type` in `headers`. */
  readonly rawBody?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

export type RouteHandler = (context: RequestContext) => Promise<HandlerResult> | HandlerResult;

interface Route {
  readonly method: string;
  readonly segments: readonly string[];
  readonly handler: RouteHandler;
}

export type RouteMatch =
  | {
      readonly outcome: 'matched';
      readonly handler: RouteHandler;
      readonly params: Record<string, string>;
    }
  | { readonly outcome: 'method-not-allowed'; readonly allowed: readonly string[] }
  | { readonly outcome: 'not-found' };

export class Router {
  private readonly routes: Route[] = [];

  add(method: string, pattern: string, handler: RouteHandler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: splitPath(pattern),
      handler,
    });
    return this;
  }

  match(method: string, path: string): RouteMatch {
    const pathSegments = splitPath(path);
    const pathMatches = this.routes.filter((route) => segmentsMatch(route.segments, pathSegments));

    if (pathMatches.length === 0) {
      return { outcome: 'not-found' };
    }

    const methodMatch = pathMatches.find((route) => route.method === method.toUpperCase());
    if (methodMatch === undefined) {
      return {
        outcome: 'method-not-allowed',
        allowed: pathMatches.map((route) => route.method),
      };
    }

    return {
      outcome: 'matched',
      handler: methodMatch.handler,
      params: extractParams(methodMatch.segments, pathSegments),
    };
  }
}

/**
 * Reads a path parameter the router guaranteed is present. A missing value here
 * is a routing bug, not user error, hence the throw.
 */
export function requiredParam(context: RequestContext, name: string): string {
  const value = context.params[name];
  if (value === undefined || value === '') {
    throw new Error(`route parameter ":${name}" was not captured`);
  }
  return value;
}

function splitPath(path: string): string[] {
  return path.split('/').filter((segment) => segment.length > 0);
}

function segmentsMatch(routeSegments: readonly string[], pathSegments: readonly string[]): boolean {
  if (routeSegments.length !== pathSegments.length) {
    return false;
  }
  return routeSegments.every((segment, index) => {
    if (segment.startsWith(':')) {
      return pathSegments[index] !== undefined && pathSegments[index] !== '';
    }
    return segment === pathSegments[index];
  });
}

function extractParams(
  routeSegments: readonly string[],
  pathSegments: readonly string[],
): Record<string, string> {
  const params: Record<string, string> = {};
  routeSegments.forEach((segment, index) => {
    if (segment.startsWith(':')) {
      params[segment.slice(1)] = decodeURIComponent(pathSegments[index] ?? '');
    }
  });
  return params;
}
