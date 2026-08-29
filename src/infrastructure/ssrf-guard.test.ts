import { describe, expect, it } from 'vitest';
import { captureRejection } from '../../tests/support/capture-error.js';
import { SsrfBlockedError } from '../application/target-url-guard.js';
import { classifyAddress, createDnsTargetUrlGuard, type AddressLookup } from './ssrf-guard.js';

describe('classifyAddress', () => {
  it.each([
    { address: '203.0.113.10', expected: 'public' },
    { address: '8.8.8.8', expected: 'public' },
    { address: '127.0.0.1', expected: 'loopback' },
    { address: '10.1.2.3', expected: 'private' },
    { address: '172.16.0.1', expected: 'private' },
    { address: '172.31.255.255', expected: 'private' },
    { address: '172.32.0.1', expected: 'public' },
    { address: '192.168.1.1', expected: 'private' },
    { address: '100.64.0.1', expected: 'private' },
    { address: '169.254.10.10', expected: 'link-local' },
    { address: '169.254.169.254', expected: 'cloud-metadata' },
    { address: '0.0.0.0', expected: 'unspecified' },
    { address: '::1', expected: 'loopback' },
    { address: '::', expected: 'unspecified' },
    { address: 'fe80::1', expected: 'link-local' },
    { address: 'fd00::1', expected: 'private' },
    { address: '2606:4700:4700::1111', expected: 'public' },
    { address: '::ffff:10.0.0.1', expected: 'private' },
    { address: '::ffff:8.8.8.8', expected: 'public' },
  ])('classifies $address as $expected', ({ address, expected }) => {
    // Arrange — none: the address is the sole input.

    // Act
    const category = classifyAddress(address);

    // Assert
    expect(category).toBe(expected);
  });
});

describe('createDnsTargetUrlGuard', () => {
  const lookupReturning = (addresses: string[]): AddressLookup => {
    return async () => addresses.map((address) => ({ address }));
  };

  it('allows a host that resolves only to public addresses', async () => {
    // Arrange
    const guard = createDnsTargetUrlGuard({ lookup: lookupReturning(['203.0.113.10']) });

    // Act
    const act = guard.assertAllowed('https://customer.example.com/hook');

    // Assert
    await expect(act).resolves.toBeUndefined();
  });

  it('blocks a host that resolves to any private address', async () => {
    // Arrange
    const guard = createDnsTargetUrlGuard({
      lookup: lookupReturning(['203.0.113.10', '10.0.0.9']),
    });

    // Act
    const error = await captureRejection(guard.assertAllowed('https://sneaky.example.com/hook'));

    // Assert
    expect(error).toBeInstanceOf(SsrfBlockedError);
    expect((error as SsrfBlockedError).reason).toMatch(/private/);
  });

  it('blocks an IP-literal target without any DNS lookup', async () => {
    // Arrange — lookup would throw if called.
    const guard = createDnsTargetUrlGuard({
      lookup: async () => {
        throw new Error('lookup should not be called for an IP literal');
      },
    });

    // Act
    const error = await captureRejection(
      guard.assertAllowed('http://169.254.169.254/latest/meta-data'),
    );

    // Assert
    expect(error).toBeInstanceOf(SsrfBlockedError);
    expect((error as SsrfBlockedError).reason).toMatch(/cloud-metadata/);
  });

  it('blocks a bracketed IPv6 loopback literal', async () => {
    // Arrange
    const guard = createDnsTargetUrlGuard({ lookup: lookupReturning(['203.0.113.1']) });

    // Act
    const error = await captureRejection(guard.assertAllowed('https://[::1]:8443/hook'));

    // Assert
    expect(error).toBeInstanceOf(SsrfBlockedError);
  });

  it('blocks a host that does not resolve', async () => {
    // Arrange
    const guard = createDnsTargetUrlGuard({
      lookup: async () => {
        throw new Error('ENOTFOUND');
      },
    });

    // Act
    const error = await captureRejection(guard.assertAllowed('https://nope.invalid/hook'));

    // Assert
    expect(error).toBeInstanceOf(SsrfBlockedError);
    expect((error as SsrfBlockedError).reason).toMatch(/does not resolve/);
  });
});
