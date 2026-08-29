/**
 * Composition root.
 *
 * Builds the object graph from configuration and returns the pieces the process
 * entry point needs. This is the only place concrete implementations are chosen;
 * everything else depends on interfaces.
 */

import type { AppConfig } from './config.js';
import type {
  DeliveryRepository,
  EventRepository,
  SubscriptionRepository,
} from './application/ports.js';
import { SubscriptionService } from './application/subscription-service.js';
import { EventService, type EventDispatcher } from './application/event-service.js';
import { DeliveryService } from './application/delivery-service.js';
import { Dispatcher } from './application/dispatcher.js';
import { RecoveryService } from './application/recovery.js';
import { realScheduler, type Scheduler } from './application/scheduler.js';
import { systemClock, type Clock } from './application/clock.js';
import { randomIdGenerator } from './domain/ids.js';
import { createHttpWebhookClient, type WebhookClient } from './infrastructure/webhook-client.js';
import {
  allowAllTargetUrlGuard,
  createDnsTargetUrlGuard,
  type TargetUrlGuard,
} from './infrastructure/ssrf-guard.js';
import {
  InMemoryDeliveryRepository,
  InMemoryEventRepository,
  InMemorySubscriptionRepository,
} from './infrastructure/memory/in-memory-repositories.js';
import { createDynamoDocumentClient } from './infrastructure/dynamodb/dynamodb-client.js';
import {
  DynamoDeliveryRepository,
  DynamoEventRepository,
  DynamoSubscriptionRepository,
} from './infrastructure/dynamodb/dynamodb-repositories.js';
import { createLogger, LOG_COMPONENTS, type Logger } from './infrastructure/logger.js';
import { registerHealthRoute } from './http/handlers/health.js';
import { registerEventRoutes } from './http/handlers/events.js';
import { registerSubscriptionRoutes } from './http/handlers/subscriptions.js';
import { registerDeliveryRoutes } from './http/handlers/deliveries.js';
import { createHttpServer } from './http/server.js';
import { Router } from './http/router.js';
import * as http from 'node:http';

export interface Repositories {
  readonly subscriptions: SubscriptionRepository;
  readonly events: EventRepository;
  readonly deliveries: DeliveryRepository;
}

export interface Application {
  readonly config: AppConfig;
  readonly logger: Logger;
  readonly repositories: Repositories;
  /** The dispatcher wired into event ingestion, exposed for recovery and tests. */
  readonly eventDispatcher: EventDispatcher;
  /** Periodic recovery sweep (started/stopped by the process entry point). */
  readonly recovery: RecoveryService;
  readonly httpServer: http.Server;
}

export function buildRepositories(config: AppConfig, logger: Logger): Repositories {
  const log = logger.child({ component: LOG_COMPONENTS.persistence });
  switch (config.persistence) {
    case 'memory':
      log.info('persistence.selected', { persistence: 'memory' });
      return {
        subscriptions: new InMemorySubscriptionRepository(),
        events: new InMemoryEventRepository(),
        deliveries: new InMemoryDeliveryRepository(),
      };
    case 'dynamodb': {
      log.info('persistence.selected', {
        persistence: 'dynamodb',
        awsRegion: config.aws.region,
        dynamoEndpoint: config.aws.dynamoEndpoint ?? null,
      });
      const client = createDynamoDocumentClient({
        region: config.aws.region,
        endpoint: config.aws.dynamoEndpoint,
      });
      return {
        subscriptions: new DynamoSubscriptionRepository({
          client,
          tableName: config.aws.tables.subscriptions,
        }),
        events: new DynamoEventRepository({ client, tableName: config.aws.tables.events }),
        deliveries: new DynamoDeliveryRepository({
          client,
          tableName: config.aws.tables.deliveries,
        }),
      };
    }
  }
}

export interface BuildApplicationOptions {
  readonly clock?: Clock;
  /** Replaces the real {@link Dispatcher} (tests inject a spy or a fake). */
  readonly eventDispatcher?: EventDispatcher;
  /** Replaces the real HTTP webhook client (tests inject a fake). */
  readonly webhookClient?: WebhookClient;
  /** Replaces the real (setTimeout) retry scheduler (tests inject a manual one). */
  readonly scheduler?: Scheduler;
  /** Replaces the SSRF guard (tests inject one with a fake DNS lookup). */
  readonly targetUrlGuard?: TargetUrlGuard;
}

export function buildApplication(
  config: AppConfig,
  options: BuildApplicationOptions = {},
): Application {
  const logger = createLogger({ level: config.logLevel });
  const clock = options.clock ?? systemClock;
  const repositories = buildRepositories(config, logger);

  const targetUrlGuard =
    options.targetUrlGuard ??
    (config.security.ssrfGuardEnabled ? createDnsTargetUrlGuard() : allowAllTargetUrlGuard);

  const subscriptionService = new SubscriptionService({
    repository: repositories.subscriptions,
    clock,
    ids: randomIdGenerator,
    targetUrlPolicy: { allowInsecure: config.security.allowInsecureTargetUrls },
    targetUrlGuard,
  });

  const dispatcher = new Dispatcher({
    subscriptions: repositories.subscriptions,
    events: repositories.events,
    deliveries: repositories.deliveries,
    webhookClient: options.webhookClient ?? createHttpWebhookClient(),
    targetUrlGuard,
    scheduler: options.scheduler ?? realScheduler,
    clock,
    ids: randomIdGenerator,
    logger,
    config: {
      webhookTimeoutMs: config.delivery.webhookTimeoutMs,
      retryPolicy: {
        maxAttempts: config.delivery.maxAttempts,
        baseDelayMs: config.delivery.retryBaseDelayMs,
        maxDelayMs: config.delivery.retryMaxDelayMs,
      },
    },
  });
  const eventDispatcher = options.eventDispatcher ?? dispatcher;

  const eventService = new EventService({
    repository: repositories.events,
    dispatcher: eventDispatcher,
    clock,
    ids: randomIdGenerator,
    logger,
  });

  const deliveryService = new DeliveryService(repositories.deliveries);

  const recovery = new RecoveryService({
    deliveries: repositories.deliveries,
    resumer: dispatcher,
    clock,
    logger,
    config: {
      stuckDeliveringThresholdMs: config.recovery.stuckDeliveringThresholdMs,
      batchLimit: config.recovery.batchLimit,
    },
  });

  const router = new Router();
  registerHealthRoute(router);
  registerSubscriptionRoutes(router, subscriptionService);
  registerEventRoutes(router, eventService);
  registerDeliveryRoutes(router, deliveryService);

  const httpServer = createHttpServer({
    router,
    logger,
    maxRequestBodyBytes: config.http.maxRequestBodyBytes,
  });

  return { config, logger, repositories, eventDispatcher, recovery, httpServer };
}
