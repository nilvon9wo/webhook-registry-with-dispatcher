import { describe, expect, it } from 'vitest';
import { captureError } from '../tests/support/capture-error.js';
import { ConfigError, loadConfig } from './config.js';

describe('loadConfig', () => {
  it('returns safe defaults when the environment is empty', () => {
    // Arrange — none: an empty environment is itself the input under test.

    // Act
    const config = loadConfig({});

    // Assert
    expect(config.port).toBe(3000);
    expect(config.logLevel).toBe('info');
    expect(config.persistence).toBe('memory');
    expect(config.aws.region).toBe('eu-central-1');
    expect(config.aws.dynamoEndpoint).toBeUndefined();
    expect(config.delivery.webhookTimeoutMs).toBe(5000);
    expect(config.delivery.maxAttempts).toBe(5);
    expect(config.delivery.retryBaseDelayMs).toBe(500);
    expect(config.recovery.intervalMs).toBe(60_000);
    expect(config.security.allowInsecureTargetUrls).toBe(false);
    expect(config.security.ssrfGuardEnabled).toBe(true);
  });

  it('parses overrides from the environment', () => {
    // Arrange
    const env = {
      PORT: '8080',
      LOG_LEVEL: 'debug',
      PERSISTENCE: 'dynamodb',
      AWS_REGION: 'us-east-1',
      DYNAMODB_ENDPOINT: 'http://localhost:8000',
      DYNAMODB_EVENTS_TABLE: 'custom-events',
      WEBHOOK_TIMEOUT_MS: '1500',
      MAX_DELIVERY_ATTEMPTS: '3',
      RECOVERY_INTERVAL_MS: '0',
      ALLOW_INSECURE_TARGET_URLS: 'true',
      SSRF_GUARD_ENABLED: 'false',
    };

    // Act
    const config = loadConfig(env);

    // Assert
    expect(config.port).toBe(8080);
    expect(config.logLevel).toBe('debug');
    expect(config.persistence).toBe('dynamodb');
    expect(config.aws.region).toBe('us-east-1');
    expect(config.aws.dynamoEndpoint).toBe('http://localhost:8000');
    expect(config.aws.tables.events).toBe('custom-events');
    expect(config.delivery.webhookTimeoutMs).toBe(1500);
    expect(config.delivery.maxAttempts).toBe(3);
    expect(config.recovery.intervalMs).toBe(0);
    expect(config.security.allowInsecureTargetUrls).toBe(true);
    expect(config.security.ssrfGuardEnabled).toBe(false);
  });

  it.each([
    { raw: 'true', expected: true },
    { raw: '1', expected: true },
    { raw: 'yes', expected: true },
    { raw: 'YES', expected: true },
    { raw: 'false', expected: false },
    { raw: '0', expected: false },
    { raw: 'no', expected: false },
  ])('reads the boolean setting "$raw" as $expected', ({ raw, expected }) => {
    // Arrange
    const env = { SSRF_GUARD_ENABLED: raw };

    // Act
    const config = loadConfig(env);

    // Assert
    expect(config.security.ssrfGuardEnabled).toBe(expected);
  });

  it('rejects a non-integer numeric setting', () => {
    // Arrange
    const env = { PORT: 'abc' };

    // Act
    const error = captureError(() => loadConfig(env));

    // Assert
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toContainEqual(expect.stringMatching(/^PORT must be/));
  });

  it('rejects an out-of-range port', () => {
    // Arrange
    const env = { PORT: '70000' };

    // Act
    const error = captureError(() => loadConfig(env));

    // Assert
    expect((error as ConfigError).problems).toContainEqual(
      expect.stringContaining('PORT must be <= 65535'),
    );
  });

  it('rejects an unknown persistence mode', () => {
    // Arrange
    const env = { PERSISTENCE: 'postgres' };

    // Act
    const error = captureError(() => loadConfig(env));

    // Assert
    expect((error as ConfigError).problems).toContainEqual(
      expect.stringContaining('PERSISTENCE must be one of'),
    );
  });

  it('rejects an invalid boolean', () => {
    // Arrange
    const env = { SSRF_GUARD_ENABLED: 'maybe' };

    // Act
    const error = captureError(() => loadConfig(env));

    // Assert
    expect((error as ConfigError).problems).toContainEqual(
      expect.stringContaining('must be a boolean'),
    );
  });

  it('rejects a retry max delay below the base delay', () => {
    // Arrange
    const env = { RETRY_BASE_DELAY_MS: '5000', RETRY_MAX_DELAY_MS: '1000' };

    // Act
    const error = captureError(() => loadConfig(env));

    // Assert
    expect((error as ConfigError).problems).toContainEqual(
      'RETRY_MAX_DELAY_MS must be greater than or equal to RETRY_BASE_DELAY_MS',
    );
  });

  it('aggregates every problem into one error rather than failing on the first', () => {
    // Arrange
    const env = { PORT: 'abc', LOG_LEVEL: 'verbose' };

    // Act
    const error = captureError(() => loadConfig(env));

    // Assert
    expect(error).toBeInstanceOf(ConfigError);
    expect((error as ConfigError).problems).toHaveLength(2);
  });
});
