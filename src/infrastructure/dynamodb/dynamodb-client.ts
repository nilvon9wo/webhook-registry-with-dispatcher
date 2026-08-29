/**
 * DynamoDB document-client factory.
 *
 * Credentials are never passed here — the AWS SDK default provider chain
 * (environment, SSO, shared config/profile, container/instance roles) resolves
 * them. `endpoint` is only set to target a local DynamoDB-compatible service
 * instead of real AWS.
 */

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export interface DynamoClientOptions {
  readonly region: string;
  readonly endpoint?: string | undefined;
}

export interface DynamoTableNames {
  readonly subscriptions: string;
  readonly events: string;
  readonly deliveries: string;
}

export function createDynamoDocumentClient(options: DynamoClientOptions): DynamoDBDocumentClient {
  const base = new DynamoDBClient({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
  });
  return DynamoDBDocumentClient.from(base, {
    marshallOptions: {
      // Domain objects use explicit `null` for unset fields (kept as-is);
      // this only guards against a stray `undefined` inside an event payload.
      removeUndefinedValues: true,
    },
  });
}
