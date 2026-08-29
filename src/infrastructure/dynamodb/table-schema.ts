/**
 * The canonical DynamoDB table shapes — keys and GSIs the repositories query.
 *
 * This is the single source of truth, used by:
 *   - `ensureTables` (local development against a DynamoDB-compatible endpoint);
 *   - the opt-in repository contract tests (`tests/support/dynamodb-test-tables.ts`).
 *
 * `infrastructure/cloudformation.yaml` provisions the same shapes for AWS; it is
 * kept in sync by hand (a mismatch fails the repository contract tests).
 */

import type { CreateTableCommandInput } from '@aws-sdk/client-dynamodb';
import type { DynamoTableNames } from './dynamodb-client.js';

/** GSIs on the deliveries table sort on `createdAt` (see the repo header for why). */
function timeSortedGsi(indexName: string, hashAttribute: string) {
  return {
    IndexName: indexName,
    KeySchema: [
      { AttributeName: hashAttribute, KeyType: 'HASH' as const },
      { AttributeName: 'createdAt', KeyType: 'RANGE' as const },
    ],
    Projection: { ProjectionType: 'ALL' as const },
  };
}

export function tableDefinitions(names: DynamoTableNames): CreateTableCommandInput[] {
  return [
    {
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
    },
    {
      TableName: names.events,
      BillingMode: 'PAY_PER_REQUEST',
      AttributeDefinitions: [{ AttributeName: 'id', AttributeType: 'S' }],
      KeySchema: [{ AttributeName: 'id', KeyType: 'HASH' }],
    },
    {
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
        timeSortedGsi('eventId-index', 'eventId'),
        timeSortedGsi('subscriptionId-index', 'subscriptionId'),
        timeSortedGsi('status-index', 'status'),
      ],
    },
  ];
}
