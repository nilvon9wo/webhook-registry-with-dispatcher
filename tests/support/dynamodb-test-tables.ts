/**
 * Provisions and tears down throwaway DynamoDB tables for the opt-in repository
 * integration tests. The key/index shapes come from the shared
 * `tableDefinitions` (also used by `src/provision.ts` and mirrored in
 * `infrastructure/cloudformation.yaml`).
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
import { tableDefinitions } from '../../src/infrastructure/dynamodb/table-schema.js';

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
  for (const definition of tableDefinitions(names)) {
    await client.send(new CreateTableCommand(definition));
  }
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
