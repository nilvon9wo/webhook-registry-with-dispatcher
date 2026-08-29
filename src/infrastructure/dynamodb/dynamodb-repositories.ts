/**
 * DynamoDB implementations of the repository ports.
 *
 * Key/index design (see `docs/9 - decisions.md` and `infrastructure/cloudformation.yaml`):
 *
 *   Subscriptions   PK id
 *                   GSI eventType-index  PK eventType  SK id
 *   Events          PK id
 *   Deliveries      PK id
 *                   GSI eventId-index         PK eventId         SK createdAt
 *                   GSI subscriptionId-index  PK subscriptionId  SK createdAt
 *                   GSI status-index          PK status          SK createdAt
 *
 * The `status-index` sort key is `createdAt`, NOT `nextAttemptAt`: a delivery
 * that is `delivering` or terminal has `nextAttemptAt = null`, and DynamoDB
 * omits an item from a GSI when its sort-key attribute is absent — which would
 * hide exactly the "stuck in delivering" records that recovery must find.
 * `createdAt` is always present, so every delivery is indexed; the cheap
 * timing comparison is done after the query instead.
 */

import {
  DeleteCommand,
  type DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Delivery, DeliveryStatus } from '../../domain/delivery.js';
import type { WebhookEvent } from '../../domain/event.js';
import type { Subscription } from '../../domain/subscription.js';
import type {
  DeliveryListFilter,
  DeliveryRepository,
  EventRepository,
  SubscriptionListFilter,
  SubscriptionRepository,
} from '../../application/ports.js';
import { applyLimit, byIsoAscending } from '../repository-support.js';

export interface DynamoRepositoryDeps {
  readonly client: DynamoDBDocumentClient;
  readonly tableName: string;
}

export class DynamoSubscriptionRepository implements SubscriptionRepository {
  constructor(private readonly deps: DynamoRepositoryDeps) {}

  async save(subscription: Subscription): Promise<void> {
    await this.deps.client.send(
      new PutCommand({ TableName: this.deps.tableName, Item: subscription }),
    );
  }

  async get(id: string): Promise<Subscription | undefined> {
    const result = await this.deps.client.send(
      new GetCommand({ TableName: this.deps.tableName, Key: { id } }),
    );
    return result.Item as Subscription | undefined;
  }

  async list(filter: SubscriptionListFilter = {}): Promise<Subscription[]> {
    if (filter.eventType !== undefined) {
      return collectPages<Subscription>((exclusiveStartKey) =>
        this.deps.client.send(
          new QueryCommand({
            TableName: this.deps.tableName,
            IndexName: 'eventType-index',
            KeyConditionExpression: 'eventType = :eventType',
            ExpressionAttributeValues: { ':eventType': filter.eventType },
            ExclusiveStartKey: exclusiveStartKey,
          }),
        ),
      );
    }
    return collectPages<Subscription>((exclusiveStartKey) =>
      this.deps.client.send(
        new ScanCommand({ TableName: this.deps.tableName, ExclusiveStartKey: exclusiveStartKey }),
      ),
    );
  }

  async delete(id: string): Promise<boolean> {
    const result = await this.deps.client.send(
      new DeleteCommand({
        TableName: this.deps.tableName,
        Key: { id },
        ReturnValues: 'ALL_OLD',
      }),
    );
    return result.Attributes !== undefined;
  }
}

export class DynamoEventRepository implements EventRepository {
  constructor(private readonly deps: DynamoRepositoryDeps) {}

  async save(event: WebhookEvent): Promise<void> {
    await this.deps.client.send(new PutCommand({ TableName: this.deps.tableName, Item: event }));
  }

  async get(id: string): Promise<WebhookEvent | undefined> {
    const result = await this.deps.client.send(
      new GetCommand({ TableName: this.deps.tableName, Key: { id } }),
    );
    return result.Item as WebhookEvent | undefined;
  }
}

export class DynamoDeliveryRepository implements DeliveryRepository {
  constructor(private readonly deps: DynamoRepositoryDeps) {}

  async save(delivery: Delivery): Promise<void> {
    await this.deps.client.send(new PutCommand({ TableName: this.deps.tableName, Item: delivery }));
  }

  async get(id: string): Promise<Delivery | undefined> {
    const result = await this.deps.client.send(
      new GetCommand({ TableName: this.deps.tableName, Key: { id } }),
    );
    return result.Item as Delivery | undefined;
  }

  async list(filter: DeliveryListFilter = {}): Promise<Delivery[]> {
    const primary = await this.queryByBestIndex(filter);
    return primary.filter(
      (delivery) =>
        (filter.eventId === undefined || delivery.eventId === filter.eventId) &&
        (filter.subscriptionId === undefined ||
          delivery.subscriptionId === filter.subscriptionId) &&
        (filter.status === undefined || delivery.status === filter.status),
    );
  }

  async listPendingDue(now: Date, limit?: number): Promise<Delivery[]> {
    const dueAt = now.getTime();
    const pending = await this.queryByStatus('pending');
    const due = pending
      .filter(
        (delivery) =>
          delivery.nextAttemptAt !== null && Date.parse(delivery.nextAttemptAt) <= dueAt,
      )
      .sort(byIsoAscending((delivery) => delivery.nextAttemptAt));
    return applyLimit(due, limit);
  }

  async listStuckDelivering(before: Date, limit?: number): Promise<Delivery[]> {
    const cutoff = before.getTime();
    const delivering = await this.queryByStatus('delivering');
    const stuck = delivering
      .filter(
        (delivery) =>
          delivery.lastAttemptAt !== null && Date.parse(delivery.lastAttemptAt) <= cutoff,
      )
      .sort(byIsoAscending((delivery) => delivery.lastAttemptAt));
    return applyLimit(stuck, limit);
  }

  private async queryByBestIndex(filter: DeliveryListFilter): Promise<Delivery[]> {
    if (filter.eventId !== undefined) {
      return this.queryIndex('eventId-index', 'eventId', filter.eventId);
    }
    if (filter.subscriptionId !== undefined) {
      return this.queryIndex('subscriptionId-index', 'subscriptionId', filter.subscriptionId);
    }
    if (filter.status !== undefined) {
      return this.queryByStatus(filter.status);
    }
    return collectPages<Delivery>((exclusiveStartKey) =>
      this.deps.client.send(
        new ScanCommand({ TableName: this.deps.tableName, ExclusiveStartKey: exclusiveStartKey }),
      ),
    );
  }

  private async queryByStatus(status: DeliveryStatus): Promise<Delivery[]> {
    return this.queryIndex('status-index', 'status', status);
  }

  private async queryIndex(
    indexName: string,
    attribute: string,
    value: string,
  ): Promise<Delivery[]> {
    return collectPages<Delivery>((exclusiveStartKey) =>
      this.deps.client.send(
        new QueryCommand({
          TableName: this.deps.tableName,
          IndexName: indexName,
          KeyConditionExpression: '#attr = :value',
          ExpressionAttributeNames: { '#attr': attribute },
          ExpressionAttributeValues: { ':value': value },
          ExclusiveStartKey: exclusiveStartKey,
          // GSI sort key is createdAt; ascending order gives oldest-first.
          ScanIndexForward: true,
        }),
      ),
    );
  }
}

interface Page {
  readonly Items?: Record<string, unknown>[];
  readonly LastEvaluatedKey?: Record<string, unknown>;
}

/** Follows `LastEvaluatedKey` pagination and concatenates every page's items. */
async function collectPages<T>(
  fetchPage: (exclusiveStartKey: Record<string, unknown> | undefined) => Promise<Page>,
): Promise<T[]> {
  const items: T[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await fetchPage(exclusiveStartKey);
    for (const item of page.Items ?? []) {
      items.push(item as T);
    }
    exclusiveStartKey = page.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return items;
}
