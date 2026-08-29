/**
 * Provisions and tears down throwaway DynamoDB tables for the opt-in repository
 * integration tests. The key/index shapes mirror `infrastructure/cloudformation.yaml`.
 *
 * Table names are prefixed with a per-run uuid so a run never touches another
 * run's (or the real application's) data, and `deleteTestTables` runs in
 * `afterAll` regardless of test outcome.
 */

import { randomUUID } from 'node:crypto';
import {
  CreateTableCommand,
  DeleteTableCommand,
  type DynamoDBClient,
  waitUntilTableExists,
  waitUntilTableNotExists,
} from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, type DynamoDBDocumentClient, ScanCommand } from '@aws-sdk/lib-dynamodb';
import type { DynamoTableNames } from '../../src/infrastructure/dynamodb/dynamodb-client.js';

export function testTableNames(): DynamoTableNames {
  const prefix = `test-${randomUUID()}`;
  return {
    subscriptions: `${prefix}-subscriptions`,
    events: `${prefix}-events`,
    deliveries: `${prefix}-deliveries`,
  };
}

export async function createTestTables(
  client: DynamoDBClient,
  names: DynamoTableNames,
): Promise<void> {
  await client.send(
    new CreateTableCommand({
      TableName: names.subscriptions,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'id', AttributeType: 'S' },
        { AttributeName: 'eventType', AttributeType: 'S' },
      ],
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [
        {
          IndexName: 'eventType-index',
          KeySchema: [
            { AttributeName: 'eventType', KeyType: 'HASH' },
            { AttributeName: 'id', KeyType: 'RANGE' },
          ],
          Projection: { ProjectionType: 'ALL' },
        },
      ],
    }),
  );

  await client.send(
    new CreateTableCommand({
      TableName: names.events,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    }),
  );

  await client.send(
    new CreateTableCommand({
      TableName: names.deliveries,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [
        { AttributeName: 'id', AttributeType: 'S' },
        { AttributeName: 'eventId', AttributeType: 'S' },
        { AttributeName: 'subscriptionId', AttributeType: 'S' },
        { AttributeName: 'status', AttributeType: 'S' },
        { AttributeName: 'createdAt', AttributeType: 'S' },
      ],
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
      GlobalSecondaryIndexes: [
        gsi('eventId-index', 'eventId'),
        gsi('subscriptionId-index', 'subscriptionId'),
        gsi('status-index', 'status'),
      ],
    }),
  );

  for (const tableName of Object.values(names)) {
    await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName: tableName });
  }
}

/**
 * Deletes every test table. Idempotent: a table that is already gone (e.g. after
 * a partial `createTestTables` failure) is skipped rather than throwing, so this
 * is safe to call unconditionally from `afterAll`.
 */
export async function deleteTestTables(
  client: DynamoDBClient,
  names: DynamoTableNames,
): Promise<void> {
  for (const tableName of Object.values(names)) {
    try {
      await client.send(new DeleteTableCommand({ TableName: tableName }));
      await waitUntilTableNotExists({ client, maxWaitTime: 60 }, { TableName: tableName });
    } catch (error) {
      if ((error as { name?: string }).name !== 'ResourceNotFoundException') {
        throw error;
      }
    }
  }
}

/** Removes every item from each table between tests (id is the partition key of all three). */
export async function clearTestTables(
  documentClient: DynamoDBDocumentClient,
  names: DynamoTableNames,
): Promise<void> {
  for (const tableName of Object.values(names)) {
    const scan = await documentClient.send(
      new ScanCommand({ TableName: tableName, ProjectionExpression: 'id' }),
    );
    const ids = (scan.Items ?? []).map((item) => item.id as string);
    for (let offset = 0; offset < ids.length; offset += 25) {
      await documentClient.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: ids
              .slice(offset, offset + 25)
              .map((id) => ({ DeleteRequest: { Key: { id } } })),
          },
        }),
      );
    }
  }
}

function gsi(
  indexName: string,
  hashAttribute: string,
): {
  IndexName: string;
  KeySchema: { AttributeName: string; KeyType: 'HASH' | 'RANGE' }[];
  Projection: { ProjectionType: 'ALL' };
} {
  return {
    IndexName: indexName,
    KeySchema: [
      { AttributeName: hashAttribute, KeyType: 'HASH' },
      { AttributeName: 'createdAt', KeyType: 'RANGE' },
    ],
    Projection: { ProjectionType: 'ALL' },
  };
}
