/**
 * Provisions the DynamoDB tables against a **local** DynamoDB-compatible
 * endpoint, then exits. Used by `docker-compose.yml` before the app starts, and
 * runnable directly (`node dist/provision.js`).
 *
 * Guarded: refuses to run unless `DYNAMODB_ENDPOINT` is set — on real AWS,
 * tables come from `infrastructure/cloudformation.yaml`, never from here.
 */

import { loadConfig } from './config.js';
import { LOG_COMPONENTS } from './application/logging.js';
import { createLogger } from './infrastructure/logger.js';
import { createDynamoClient } from './infrastructure/dynamodb/dynamodb-client.js';
import { ensureTables } from './infrastructure/dynamodb/ensure-tables.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const log = createLogger({ level: config.logLevel, format: config.logFormat }).child({
    component: LOG_COMPONENTS.persistence,
  });

  if (config.aws.dynamoEndpoint === undefined) {
    log.error('provision.refused', {
      detail: 'DYNAMODB_ENDPOINT is not set — table provisioning is for a local endpoint only',
    });
    process.exitCode = 1;
    return;
  }

  const client = createDynamoClient({
    region: config.aws.region,
    endpoint: config.aws.dynamoEndpoint,
  });

  // The endpoint (e.g. a sibling container) may not be listening yet.
  const deadline = Date.now() + 30_000;
  for (;;) {
    try {
      await ensureTables(client, config.aws.tables, log);
      break;
    } catch (error) {
      const code = (error as { name?: string; code?: string }).code ?? '';
      if (Date.now() > deadline || !['ECONNREFUSED', 'ETIMEDOUT', 'EAI_AGAIN'].includes(code)) {
        throw error;
      }
      log.info('provision.waiting', { endpoint: config.aws.dynamoEndpoint });
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  log.info('provision.completed', { endpoint: config.aws.dynamoEndpoint });
}

void main();
