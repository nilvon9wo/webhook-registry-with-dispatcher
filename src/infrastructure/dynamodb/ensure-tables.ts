/**
 * Creates the application's DynamoDB tables if they are missing, then waits for
 * them to become `ACTIVE`. Idempotent — an existing table is left alone.
 *
 * For **local development against a DynamoDB-compatible endpoint** only. On real
 * AWS, tables are provisioned by `infrastructure/cloudformation.yaml`; the guard
 * in `provision.ts` refuses to run without `DYNAMODB_ENDPOINT` set.
 */

import {
  CreateTableCommand,
  type DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import type { Logger } from '../../application/logging.js';
import type { DynamoTableNames } from './dynamodb-client.js';
import { tableDefinitions } from './table-schema.js';

export async function ensureTables(
  client: DynamoDBClient,
  names: DynamoTableNames,
  logger: Logger,
): Promise<void> {
  for (const definition of tableDefinitions(names)) {
    const tableName = definition.TableName as string;
    try {
      await client.send(new CreateTableCommand(definition));
      logger.info('dynamodb.table.created', { tableName });
    } catch (error) {
      if ((error as { name?: string }).name === 'ResourceInUseException') {
        logger.info('dynamodb.table.exists', { tableName });
      } else {
        throw error;
      }
    }
    await waitUntilTableExists({ client, maxWaitTime: 60 }, { TableName: tableName });
  }
}
