/**
 * Application configuration.
 *
 * All operational settings are environment-driven with safe development
 * defaults (see `docs/1 - spec.md` section 12). `loadConfig` is pure: it takes
 * an environment record and returns a validated {@link AppConfig} or throws a
 * {@link ConfigError} describing every problem found. Environment-file loading
 * happens in the process entry point, not here, so tests can pass explicit
 * values.
 */

export type PersistenceMode = 'memory' | 'dynamodb';

export interface AppConfig {
  readonly nodeEnv: string;
  readonly port: number;
  readonly logLevel: LogLevel;
  readonly logFormat: LogFormat;

  readonly persistence: PersistenceMode;
  readonly aws: {
    readonly region: string;
    /** Optional override, e.g. `http://localhost:8000` for DynamoDB Local. */
    readonly dynamoEndpoint: string | undefined;
    readonly tables: {
      readonly subscriptions: string;
      readonly events: string;
      readonly deliveries: string;
    };
  };

  readonly http: {
    /** Maximum accepted request body size, in bytes. */
    readonly maxRequestBodyBytes: number;
  };

  readonly delivery: {
    /** Per-attempt outbound webhook timeout, in milliseconds. */
    readonly webhookTimeoutMs: number;
    /** Total attempts allowed per delivery (initial attempt + retries). */
    readonly maxAttempts: number;
    /** Base delay for exponential backoff, in milliseconds. */
    readonly retryBaseDelayMs: number;
    /** Upper bound applied to any single backoff delay, in milliseconds. */
    readonly retryMaxDelayMs: number;
  };

  readonly recovery: {
    /** Recovery sweep interval, in milliseconds. `0` disables the sweeper. */
    readonly intervalMs: number;
    /**
     * A delivery left in `delivering` for longer than this is considered
     * abandoned (crashed mid-attempt) and eligible for recovery, in ms.
     */
    readonly stuckDeliveringThresholdMs: number;
    /** Maximum deliveries a single sweep will handle. */
    readonly batchLimit: number;
  };

  readonly security: {
    /** When false, only `https:` target URLs are accepted. */
    readonly allowInsecureTargetUrls: boolean;
    /**
     * When true, reject target URLs that resolve to loopback, private,
     * link-local, or cloud-metadata addresses (basic SSRF guard).
     */
    readonly ssrfGuardEnabled: boolean;
  };
}

export const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/**
 * Log rendering. `json` is the machine contract (one JSON object per line);
 * `pretty` is a coloured, human-readable line for a local terminal; `auto`
 * picks `pretty` when stdout is a TTY and `json` otherwise.
 */
export const LOG_FORMATS = ['auto', 'json', 'pretty'] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

export class ConfigError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(`Invalid configuration:\n- ${problems.join('\n- ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const DEFAULTS = {
  NODE_ENV: 'development',
  PORT: 3000,
  LOG_LEVEL: 'info',
  LOG_FORMAT: 'auto',
  PERSISTENCE: 'memory',
  AWS_REGION: 'eu-central-1',
  DYNAMODB_SUBSCRIPTIONS_TABLE: 'webhook-registry-subscriptions',
  DYNAMODB_EVENTS_TABLE: 'webhook-registry-events',
  DYNAMODB_DELIVERIES_TABLE: 'webhook-registry-deliveries',
  MAX_REQUEST_BODY_BYTES: 1_048_576,
  WEBHOOK_TIMEOUT_MS: 5_000,
  MAX_DELIVERY_ATTEMPTS: 5,
  RETRY_BASE_DELAY_MS: 500,
  RETRY_MAX_DELAY_MS: 30_000,
  RECOVERY_INTERVAL_MS: 60_000,
  STUCK_DELIVERING_THRESHOLD_MS: 60_000,
  RECOVERY_BATCH_LIMIT: 100,
  ALLOW_INSECURE_TARGET_URLS: false,
  SSRF_GUARD_ENABLED: true,
} as const;

type EnvRecord = Record<string, string | undefined>;

export function loadConfig(env: EnvRecord = process.env): AppConfig {
  const problems: string[] = [];

  const nodeEnv = env.NODE_ENV?.trim() || DEFAULTS.NODE_ENV;
  const port = readInt(env, 'PORT', DEFAULTS.PORT, problems, { min: 1, max: 65_535 });
  const logLevel = readEnum(env, 'LOG_LEVEL', DEFAULTS.LOG_LEVEL, LOG_LEVELS, problems);
  const logFormat = readEnum(env, 'LOG_FORMAT', DEFAULTS.LOG_FORMAT, LOG_FORMATS, problems);
  const persistence = readEnum(
    env,
    'PERSISTENCE',
    DEFAULTS.PERSISTENCE,
    ['memory', 'dynamodb'] as const,
    problems,
  );

  const config: AppConfig = {
    nodeEnv,
    port,
    logLevel,
    logFormat,
    persistence,
    aws: {
      region: env.AWS_REGION?.trim() || DEFAULTS.AWS_REGION,
      dynamoEndpoint: env.DYNAMODB_ENDPOINT?.trim() || undefined,
      tables: {
        subscriptions:
          env.DYNAMODB_SUBSCRIPTIONS_TABLE?.trim() || DEFAULTS.DYNAMODB_SUBSCRIPTIONS_TABLE,
        events: env.DYNAMODB_EVENTS_TABLE?.trim() || DEFAULTS.DYNAMODB_EVENTS_TABLE,
        deliveries: env.DYNAMODB_DELIVERIES_TABLE?.trim() || DEFAULTS.DYNAMODB_DELIVERIES_TABLE,
      },
    },
    http: {
      maxRequestBodyBytes: readInt(
        env,
        'MAX_REQUEST_BODY_BYTES',
        DEFAULTS.MAX_REQUEST_BODY_BYTES,
        problems,
        { min: 1 },
      ),
    },
    delivery: {
      webhookTimeoutMs: readInt(env, 'WEBHOOK_TIMEOUT_MS', DEFAULTS.WEBHOOK_TIMEOUT_MS, problems, {
        min: 1,
      }),
      maxAttempts: readInt(env, 'MAX_DELIVERY_ATTEMPTS', DEFAULTS.MAX_DELIVERY_ATTEMPTS, problems, {
        min: 1,
        max: 20,
      }),
      retryBaseDelayMs: readInt(
        env,
        'RETRY_BASE_DELAY_MS',
        DEFAULTS.RETRY_BASE_DELAY_MS,
        problems,
        {
          min: 0,
        },
      ),
      retryMaxDelayMs: readInt(env, 'RETRY_MAX_DELAY_MS', DEFAULTS.RETRY_MAX_DELAY_MS, problems, {
        min: 0,
      }),
    },
    recovery: {
      intervalMs: readInt(env, 'RECOVERY_INTERVAL_MS', DEFAULTS.RECOVERY_INTERVAL_MS, problems, {
        min: 0,
      }),
      stuckDeliveringThresholdMs: readInt(
        env,
        'STUCK_DELIVERING_THRESHOLD_MS',
        DEFAULTS.STUCK_DELIVERING_THRESHOLD_MS,
        problems,
        { min: 0 },
      ),
      batchLimit: readInt(env, 'RECOVERY_BATCH_LIMIT', DEFAULTS.RECOVERY_BATCH_LIMIT, problems, {
        min: 1,
      }),
    },
    security: {
      allowInsecureTargetUrls: readBool(
        env,
        'ALLOW_INSECURE_TARGET_URLS',
        DEFAULTS.ALLOW_INSECURE_TARGET_URLS,
        problems,
      ),
      ssrfGuardEnabled: readBool(env, 'SSRF_GUARD_ENABLED', DEFAULTS.SSRF_GUARD_ENABLED, problems),
    },
  };

  if (config.delivery.retryMaxDelayMs < config.delivery.retryBaseDelayMs) {
    problems.push('RETRY_MAX_DELAY_MS must be greater than or equal to RETRY_BASE_DELAY_MS');
  }

  if (problems.length > 0) {
    throw new ConfigError(problems);
  }
  return config;
}

/**
 * The effective operational settings, safe to log at startup. Contains no
 * secrets (there are none in config) — AWS credentials come from the SDK
 * provider chain, never from here.
 */
export function configSummary(config: AppConfig): Record<string, unknown> {
  return {
    nodeEnv: config.nodeEnv,
    port: config.port,
    logLevel: config.logLevel,
    logFormat: config.logFormat,
    persistence: config.persistence,
    awsRegion: config.aws.region,
    dynamoEndpoint: config.aws.dynamoEndpoint ?? null,
    maxRequestBodyBytes: config.http.maxRequestBodyBytes,
    webhookTimeoutMs: config.delivery.webhookTimeoutMs,
    maxDeliveryAttempts: config.delivery.maxAttempts,
    retryBaseDelayMs: config.delivery.retryBaseDelayMs,
    retryMaxDelayMs: config.delivery.retryMaxDelayMs,
    recoveryIntervalMs: config.recovery.intervalMs,
    stuckDeliveringThresholdMs: config.recovery.stuckDeliveringThresholdMs,
    allowInsecureTargetUrls: config.security.allowInsecureTargetUrls,
    ssrfGuardEnabled: config.security.ssrfGuardEnabled,
  };
}

/**
 * Operationally risky configuration combinations — logged as warnings at
 * startup rather than rejected, since each is legitimate in some context.
 */
export function configWarnings(config: AppConfig): string[] {
  const warnings: string[] = [];
  const isProduction = config.nodeEnv === 'production';

  if (isProduction && config.persistence === 'memory') {
    warnings.push('PERSISTENCE=memory in production: all data is lost on restart');
  }
  if (config.security.allowInsecureTargetUrls) {
    warnings.push(
      'ALLOW_INSECURE_TARGET_URLS is enabled: plain http:// webhook targets are accepted',
    );
  }
  if (!config.security.ssrfGuardEnabled) {
    warnings.push(
      'SSRF_GUARD_ENABLED is off: webhook targets are not checked against private ranges',
    );
  }
  if (config.recovery.intervalMs === 0) {
    warnings.push('RECOVERY_INTERVAL_MS=0: abandoned/retryable deliveries will not be recovered');
  }
  return warnings;
}

interface IntBounds {
  readonly min?: number;
  readonly max?: number;
}

function readInt(
  env: EnvRecord,
  key: string,
  fallback: number,
  problems: string[],
  bounds: IntBounds = {},
): number {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isInteger(value)) {
    problems.push(`${key} must be an integer (received "${raw}")`);
    return fallback;
  }
  if (bounds.min !== undefined && value < bounds.min) {
    problems.push(`${key} must be >= ${bounds.min} (received ${value})`);
    return fallback;
  }
  if (bounds.max !== undefined && value > bounds.max) {
    problems.push(`${key} must be <= ${bounds.max} (received ${value})`);
    return fallback;
  }
  return value;
}

function readBool(env: EnvRecord, key: string, fallback: boolean, problems: string[]): boolean {
  const raw = env[key]?.trim().toLowerCase();
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (raw === 'true' || raw === '1' || raw === 'yes') {
    return true;
  }
  if (raw === 'false' || raw === '0' || raw === 'no') {
    return false;
  }
  problems.push(`${key} must be a boolean (true/false) (received "${raw}")`);
  return fallback;
}

function readEnum<const T extends readonly string[]>(
  env: EnvRecord,
  key: string,
  fallback: T[number],
  allowed: T,
  problems: string[],
): T[number] {
  const raw = env[key]?.trim();
  if (raw === undefined || raw === '') {
    return fallback;
  }
  if (!allowed.includes(raw)) {
    problems.push(`${key} must be one of ${allowed.join(', ')} (received "${raw}")`);
    return fallback;
  }
  return raw as T[number];
}
