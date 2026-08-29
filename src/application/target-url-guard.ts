/**
 * SSRF guard port. The concrete DNS-resolving implementation is
 * `src/infrastructure/ssrf-guard.ts` (`createDnsTargetUrlGuard`).
 */

export interface TargetUrlGuard {
  /** Resolves if the URL's host is allowed; throws {@link SsrfBlockedError} otherwise. */
  assertAllowed(rawUrl: string): Promise<void>;
}

export class SsrfBlockedError extends Error {
  readonly host: string;
  readonly reason: string;

  constructor(host: string, reason: string) {
    super(`webhook target host "${host}" is not allowed (${reason})`);
    this.name = 'SsrfBlockedError';
    this.host = host;
    this.reason = reason;
  }
}

/** No-op guard used when `SSRF_GUARD_ENABLED=false` and in unit tests. */
export const allowAllTargetUrlGuard: TargetUrlGuard = {
  assertAllowed: async () => {},
};
