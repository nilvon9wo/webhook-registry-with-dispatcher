/**
 * Process entry point.
 *
 * Responsibilities of this file: load environment configuration, fail fast on
 * an invalid configuration, and (in later implementation steps) wire the
 * composition root — repositories, dispatcher, recovery sweeper, HTTP server —
 * and install graceful-shutdown handlers.
 *
 * Business functionality is intentionally not present yet.
 */

import type { AppConfig } from './config.js';
import { ConfigError, loadConfig } from './config.js';

function loadConfigOrExit(): AppConfig | undefined {
  try {
    return loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
      return undefined;
    }
    throw error;
  }
}

function main(): void {
  const config = loadConfigOrExit();
  if (config === undefined) {
    return;
  }

  process.stdout.write(
    `webhook-registry-dispatcher: configuration loaded ` +
      `(env=${config.nodeEnv}, persistence=${config.persistence}, port=${config.port}). ` +
      `HTTP server wiring is added in a later implementation step.\n`,
  );
}

main();
