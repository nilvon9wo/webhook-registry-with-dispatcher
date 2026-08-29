/**
 * Syntactic and protocol validation for subscriber target URLs.
 *
 * Network-level SSRF protection (resolving the host and rejecting loopback /
 * private / link-local / metadata addresses) lives in the infrastructure layer
 * because it requires DNS. This module only enforces what can be decided from
 * the URL string itself.
 */

import type { ProblemCollector } from './validation.js';

export interface TargetUrlPolicy {
  /** When true, `http:` targets are accepted in addition to `https:`. */
  readonly allowInsecure: boolean;
}

/**
 * Validates a subscriber target URL and returns its normalized string form, or
 * `undefined` after recording a problem.
 */
export function validateTargetUrl(
  value: unknown,
  policy: TargetUrlPolicy,
  problems: ProblemCollector,
  fieldName = 'targetUrl',
): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') {
    problems.add(`${fieldName} is required and must be a non-empty string`);
    return undefined;
  }

  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    problems.add(`${fieldName} must be a valid absolute URL`);
    return undefined;
  }

  const allowedProtocols = policy.allowInsecure ? ['https:', 'http:'] : ['https:'];
  if (!allowedProtocols.includes(url.protocol)) {
    problems.add(
      policy.allowInsecure
        ? `${fieldName} must use the http or https scheme`
        : `${fieldName} must use the https scheme`,
    );
    return undefined;
  }

  if (url.username !== '' || url.password !== '') {
    problems.add(`${fieldName} must not embed credentials`);
    return undefined;
  }

  if (url.hostname === '') {
    problems.add(`${fieldName} must include a host`);
    return undefined;
  }

  return url.toString();
}
