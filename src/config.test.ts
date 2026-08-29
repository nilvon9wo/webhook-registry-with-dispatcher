import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { captureError } from '../tests/support/capture-error.js';
import {
  ConfigError,
  configSummary,
  configWarnings,
  KNOWN_CONFIG_ENV_KEYS,
  loadConfig,
} from './config.js';

describe('loadConfig', () => {
  it('returns safe defaults for every setting when the environment is empty', () => {
    // Arrange — none: an empty environment is itself the input under test.

    // Act
    const config = loadConfig({});

    // Assert
    expect(config).toEqual({
      nodeEnv: 'development',
      port: 3000,
      logLevel: 'info',
      logFormat: 'auto',
      persistence: 'memory',
      aws: {
        region: 'eu-central-1',
        dynamoEndpoint: undefined,
        tables: {
          subscriptions: 'webhook-registry-subscriptions',
          events: 'webhook-registry-events',
          deliveries: 'webhook-registry-deliveries',
        },
      },
      http: { maxRequestBodyBytes: 1_048_576 },
      delivery: {
        webhookTimeoutMs: 5000,
        maxAttempts: 5,
        retryBaseDelayMs: 500,
        retryMaxDelayMs: 30_000,
      },
      recovery: {
        intervalMs: 60_000,
        stuckDeliveringThresholdMs: 60_000,
        batchLimit: 100,
      },
      security: {
        allowInsecureTargetUrls: false,
        ssrfGuardEnabled: true,
      },
    });
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

  it('reads the LOG_FORMAT setting', () => {
    // Arrange
    const env = { LOG_FORMAT: 'pretty' };

    // Act
    const config = loadConfig(env);

    // Assert
    expect(config.logFormat).toBe('pretty');
  });

  it('rejects an unknown log format', () => {
    // Arrange
    const env = { LOG_FORMAT: 'fancy' };

    // Act
    const error = captureError(() => loadConfig(env));

    // Assert
    expect((error as ConfigError).problems).toContainEqual(
      expect.stringContaining('LOG_FORMAT must be one of'),
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

describe('configSummary', () => {
  it('contains the operational settings and no credential-like fields', () => {
    // Arrange
    const config = loadConfig({ AWS_REGION: 'us-east-1' });

    // Act
    const summary = configSummary(config);

    // Assert
    expect(summary).toMatchObject({
      port: 3000,
      persistence: 'memory',
      awsRegion: 'us-east-1',
      webhookTimeoutMs: 5000,
      maxDeliveryAttempts: 5,
      recoveryIntervalMs: 60_000,
    });
    expect(JSON.stringify(summary).toLowerCase()).not.toMatch(/secret|password|token|credential/);
  });
});

describe('configWarnings', () => {
  it('is empty for a safe non-default configuration (dynamodb, guards on)', () => {
    // Arrange
    const config = loadConfig({ PERSISTENCE: 'dynamodb' });

    // Act
    const warnings = configWarnings(config);

    // Assert
    expect(warnings).toEqual([]);
  });

  it('flags insecure target URLs, a disabled SSRF guard, and a disabled recovery sweep', () => {
    // Arrange
    const config = loadConfig({
      PERSISTENCE: 'dynamodb',
      ALLOW_INSECURE_TARGET_URLS: 'true',
      SSRF_GUARD_ENABLED: 'false',
      RECOVERY_INTERVAL_MS: '0',
    });

    // Act
    const warnings = configWarnings(config);

    // Assert
    expect(warnings).toHaveLength(3);
    expect(warnings.join(' ')).toMatch(/ALLOW_INSECURE_TARGET_URLS/);
    expect(warnings.join(' ')).toMatch(/SSRF_GUARD_ENABLED/);
    expect(warnings.join(' ')).toMatch(/RECOVERY_INTERVAL_MS/);
  });

  it('flags in-memory persistence in every environment', () => {
    // Arrange
    const config = loadConfig({ PERSISTENCE: 'memory', NODE_ENV: 'development' });

    // Act
    const warnings = configWarnings(config);

    // Assert
    expect(warnings.join(' ')).toMatch(/PERSISTENCE=memory/);
  });

  it('escalates the in-memory warning in production', () => {
    // Arrange
    const config = loadConfig({ PERSISTENCE: 'memory', NODE_ENV: 'production' });

    // Act
    const warnings = configWarnings(config);

    // Assert
    expect(warnings.join(' ')).toMatch(/PERSISTENCE=memory in production/);
  });
});

describe('config ↔ .env.example ↔ source are in sync', () => {
  const configSource = readFileSync(new URL('./config.ts', import.meta.url), 'utf8');
  const exampleKeys = new Set(
    readFileSync(new URL('../.env.example', import.meta.url), 'utf8')
      .split('\n')
      .map((line) => /^#?\s*([A-Z][A-Z0-9_]+)=/.exec(line)?.[1])
      .filter((key): key is string => key !== undefined),
  );

  it('KNOWN_CONFIG_ENV_KEYS lists every UPPER_SNAKE key referenced in config.ts', () => {
    // Arrange — env keys used in `config.ts` (string literals + `env.KEY` access).
    const referenced = new Set<string>();
    for (const match of configSource.matchAll(
      /(?:'([A-Z][A-Z0-9_]{2,})'|env\.([A-Z][A-Z0-9_]{2,}))/g,
    )) {
      referenced.add(match[1] ?? (match[2] as string));
    }
    referenced.delete('KNOWN_CONFIG_ENV_KEYS'); // the export itself

    // Act — keys config.ts uses but the canonical list omits.
    const undocumented = [...referenced].filter((key) => !KNOWN_CONFIG_ENV_KEYS.includes(key));

    // Assert
    expect(undocumented).toEqual([]);
  });

  it.each(KNOWN_CONFIG_ENV_KEYS)('.env.example documents %s', (key) => {
    // Arrange — none.

    // Act — membership check.
    const documented = exampleKeys.has(key);

    // Assert
    expect(documented).toBe(true);
  });
});
