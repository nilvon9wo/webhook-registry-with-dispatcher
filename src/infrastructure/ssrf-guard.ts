/**
 * DNS-resolving implementation of the {@link TargetUrlGuard} port.
 *
 * Resolves the target host and rejects addresses that should never be a
 * legitimate webhook: loopback, private (RFC 1918 / ULA / CGNAT), link-local,
 * unspecified, and the cloud metadata endpoint.
 *
 * Limitations (documented in `docs/10 - security.md`, not solved here):
 *   - DNS rebinding: there is a TOCTOU gap between this lookup and `fetch`'s own
 *     lookup. Full protection needs pinning the resolved IP and connecting to it.
 *   - Only the resolved A/AAAA records are checked; exotic redirect/NAT64 paths
 *     are out of scope.
 */

import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { SsrfBlockedError, type TargetUrlGuard } from '../application/target-url-guard.js';

export type AddressLookup = (hostname: string) => Promise<readonly { readonly address: string }[]>;

const systemLookup: AddressLookup = (hostname) => lookup(hostname, { all: true });

export function createDnsTargetUrlGuard(
  options: { readonly lookup?: AddressLookup } = {},
): TargetUrlGuard {
  const resolve = options.lookup ?? systemLookup;

  return {
    async assertAllowed(rawUrl: string): Promise<void> {
      const host = new URL(rawUrl).hostname;
      const asLiteral = host.replace(/^\[|\]$/g, '');

      if (isIP(asLiteral) !== 0) {
        rejectIfBlocked(host, asLiteral);
        return;
      }

      let records: readonly { readonly address: string }[];
      try {
        records = await resolve(host);
      } catch {
        throw new SsrfBlockedError(host, 'host does not resolve');
      }
      if (records.length === 0) {
        throw new SsrfBlockedError(host, 'host does not resolve');
      }
      for (const record of records) {
        rejectIfBlocked(host, record.address);
      }
    },
  };
}

function rejectIfBlocked(host: string, address: string): void {
  const category = classifyAddress(address);
  if (category !== 'public') {
    throw new SsrfBlockedError(host, `resolves to a ${category} address (${address})`);
  }
}

type AddressCategory =
  'public' | 'loopback' | 'private' | 'link-local' | 'unspecified' | 'cloud-metadata';

export function classifyAddress(address: string): AddressCategory {
  const version = isIP(address);
  if (version === 4) {
    return classifyIpv4(address);
  }
  if (version === 6) {
    return classifyIpv6(address.toLowerCase());
  }
  // Not an IP we can reason about — refuse rather than allow.
  return 'private';
}

function classifyIpv4(address: string): AddressCategory {
  const octets = address.split('.').map(Number);
  const [a, b] = octets as [number, number, number, number];

  if (address === '0.0.0.0') return 'unspecified';
  if (address === '169.254.169.254') return 'cloud-metadata';
  if (a === 127) return 'loopback';
  if (a === 10) return 'private';
  if (a === 172 && b >= 16 && b <= 31) return 'private';
  if (a === 192 && b === 168) return 'private';
  if (a === 169 && b === 254) return 'link-local';
  if (a === 100 && b >= 64 && b <= 127) return 'private'; // CGNAT
  return 'public';
}

function classifyIpv6(address: string): AddressCategory {
  if (address === '::' || address === '::0') return 'unspecified';
  if (address === '::1') return 'loopback';

  const mapped = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(address);
  if (mapped?.[1] !== undefined) {
    return classifyIpv4(mapped[1]);
  }

  const firstHextet = Number.parseInt(address.split(':')[0] ?? '0', 16);
  if (firstHextet >= 0xfe80 && firstHextet <= 0xfebf) return 'link-local';
  if (firstHextet >= 0xfc00 && firstHextet <= 0xfdff) return 'private'; // ULA
  return 'public';
}
