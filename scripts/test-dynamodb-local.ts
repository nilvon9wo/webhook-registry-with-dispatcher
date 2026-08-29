/**
 * Runs the opt-in DynamoDB repository contract tests against a throwaway
 * DynamoDB Local container — no AWS account needed.
 *
 *   npm run test:dynamodb:local
 *
 * Starts `docker-compose.dynamodb-local.yml`, waits for the endpoint, runs the
 * DynamoDB test file with dummy credentials pointed at it, then tears the
 * container down (even if the tests fail). The test suite creates and drops its
 * own uuid-prefixed tables.
 */

import { spawnSync } from 'node:child_process';
import * as http from 'node:http';

const COMPOSE = ['compose', '-f', 'docker-compose.dynamodb-local.yml'];
const ENDPOINT = 'http://localhost:8000';

function docker(args: string[]): number {
  const result = spawnSync('docker', args, { stdio: 'inherit' });
  return result.status ?? 1;
}

/** DynamoDB Local answers any HTTP request once it is listening (a 4xx is fine). */
async function waitForEndpoint(timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const up = await new Promise<boolean>((resolve) => {
      const request = http.get(ENDPOINT, (response) => {
        response.resume();
        resolve(true);
      });
      request.on('error', () => resolve(false));
      request.setTimeout(1000, () => {
        request.destroy();
        resolve(false);
      });
    });
    if (up) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`DynamoDB Local did not become reachable at ${ENDPOINT}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

async function main(): Promise<void> {
  if (docker([...COMPOSE, 'up', '-d']) !== 0) {
    process.exitCode = 1;
    return;
  }
  try {
    await waitForEndpoint();
    // `shell: true` so this resolves `npx` on Windows (npx.cmd) as well as POSIX.
    const vitest = spawnSync(
      'npx vitest run --project integration tests/integration/dynamodb-repositories.test.ts',
      {
        stdio: 'inherit',
        shell: true,
        env: {
          ...process.env,
          RUN_DYNAMODB_TESTS: '1',
          DYNAMODB_ENDPOINT: ENDPOINT,
          AWS_REGION: 'eu-central-1',
          AWS_ACCESS_KEY_ID: 'local',
          AWS_SECRET_ACCESS_KEY: 'local',
        },
      },
    );
    process.exitCode = vitest.status ?? 1;
  } finally {
    docker([...COMPOSE, 'down']);
  }
}

void main();
