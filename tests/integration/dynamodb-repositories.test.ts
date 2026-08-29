/**
 * Opt-in DynamoDB repository integration tests.
 *
 * Skipped unless `RUN_DYNAMODB_TESTS=1`. Point `DYNAMODB_ENDPOINT` at a running
 * DynamoDB Local (e.g. `docker run -p 8000:8000 amazon/dynamodb-local`):
 *
 *   RUN_DYNAMODB_TESTS=1 DYNAMODB_ENDPOINT=http://localhost:8000 \
 *     AWS_REGION=eu-central-1 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
 *     npm run test:integration
 *
 * The suite creates its own uuid-prefixed tables, runs the shared repository
 * contracts against the DynamoDB implementations, and deletes those tables in
 * afterAll whether the tests pass or fail.
 */

import { afterAll, beforeAll, beforeEach, describe } from 'vitest';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { createDynamoDocumentClient } from '../../src/infrastructure/dynamodb/dynamodb-client.js';
import {
  DynamoDeliveryRepository,
  DynamoEventRepository,
  DynamoSubscriptionRepository,
} from '../../src/infrastructure/dynamodb/dynamodb-repositories.js';
import {
  clearTestTables,
  createTestTables,
  deleteTestTables,
  testTableNames,
} from '../support/dynamodb-test-tables.js';
import {
  runDeliveryRepositoryContract,
  runEventRepositoryContract,
  runSubscriptionRepositoryContract,
} from '../support/repository-contract.js';

const enabled = ['1', 'true'].includes(process.env.RUN_DYNAMODB_TESTS ?? '');
const suite = enabled ? describe : describe.skip;

suite('DynamoDB repositories (contract)', () => {
  const region = process.env.AWS_REGION ?? 'eu-central-1';
  const endpoint = process.env.DYNAMODB_ENDPOINT;
  const names = testTableNames();

  let lowLevelClient: DynamoDBClient;
  let documentClient: DynamoDBDocumentClient;

  beforeAll(async () => {
    lowLevelClient = new DynamoDBClient({ region, ...(endpoint ? { endpoint } : {}) });
    documentClient = createDynamoDocumentClient({ region, endpoint });
    await createTestTables(lowLevelClient, names);
  }, 90_000);

  afterAll(async () => {
    await deleteTestTables(lowLevelClient, names);
    documentClient.destroy();
    lowLevelClient.destroy();
  }, 90_000);

  beforeEach(async () => {
    await clearTestTables(documentClient, names);
  });

  runSubscriptionRepositoryContract(
    'dynamodb',
    () =>
      new DynamoSubscriptionRepository({ client: documentClient, tableName: names.subscriptions }),
  );
  runEventRepositoryContract(
    'dynamodb',
    () => new DynamoEventRepository({ client: documentClient, tableName: names.events }),
  );
  runDeliveryRepositoryContract(
    'dynamodb',
    () => new DynamoDeliveryRepository({ client: documentClient, tableName: names.deliveries }),
  );
});
