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
import {
  EventService,
  noopEventDispatcher,
  type EventDispatcher,
} from './application/event-service.js';
import { systemClock, type Clock } from './application/clock.js';
import { randomIdGenerator } from './domain/ids.js';
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
import { createLogger, type Logger } from './infrastructure/logger.js';
import { registerHealthRoute } from './http/handlers/health.js';
import { registerEventRoutes } from './http/handlers/events.js';
import { registerSubscriptionRoutes } from './http/handlers/subscriptions.js';
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
  readonly httpServer: http.Server;
}

export function buildRepositories(config: AppConfig, logger: Logger): Repositories {
  switch (config.persistence) {
    case 'memory':
      logger.info('using in-memory persistence');
      return {
        subscriptions: new InMemorySubscriptionRepository(),
        events: new InMemoryEventRepository(),
        deliveries: new InMemoryDeliveryRepository(),
      };
    case 'dynamodb': {
      logger.info('using DynamoDB persistence', {
        region: config.aws.region,
        endpoint: config.aws.dynamoEndpoint ?? 'aws',
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
  /** Overrides the event dispatcher (tests inject a spy; real dispatcher wired in a later step). */
  readonly eventDispatcher?: EventDispatcher;
}

export function buildApplication(
  config: AppConfig,
  options: BuildApplicationOptions = {},
): Application {
  const logger = createLogger({ level: config.logLevel });
  const clock = options.clock ?? systemClock;
  const repositories = buildRepositories(config, logger);

  const subscriptionService = new SubscriptionService({
    repository: repositories.subscriptions,
    clock,
    ids: randomIdGenerator,
    targetUrlPolicy: { allowInsecure: config.security.allowInsecureTargetUrls },
  });

  const eventService = new EventService({
    repository: repositories.events,
    dispatcher: options.eventDispatcher ?? noopEventDispatcher,
    clock,
    ids: randomIdGenerator,
    logger,
  });

  const router = new Router();
  registerHealthRoute(router);
  registerSubscriptionRoutes(router, subscriptionService);
  registerEventRoutes(router, eventService);

  const httpServer = createHttpServer({
    router,
    logger,
    maxRequestBodyBytes: config.http.maxRequestBodyBytes,
  });

  return { config, logger, repositories, httpServer };
}
