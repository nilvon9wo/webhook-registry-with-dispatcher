/**
 * Process entry point: load configuration, build the application, start the
 * HTTP server, and shut down gracefully on SIGINT/SIGTERM.
 */

import { buildApplication } from './container.js';
import type { AppConfig } from './config.js';
import { ConfigError, configSummary, configWarnings, loadConfig } from './config.js';
import { errorFields, LOG_COMPONENTS } from './infrastructure/logger.js';

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

  const app = buildApplication(config);
  const log = app.logger.child({ component: LOG_COMPONENTS.bootstrap });

  log.info('config.loaded', { config: configSummary(config) });
  for (const warning of configWarnings(config)) {
    log.warn('config.warning', { detail: warning });
  }

  process.on('unhandledRejection', (reason) => {
    log.error('process.unhandled_rejection', errorFields(reason));
  });
  process.on('uncaughtException', (error) => {
    log.error('process.uncaught_exception', errorFields(error));
  });

  app.httpServer.listen(config.port, () => {
    log.info('server.listening', { port: config.port, persistence: config.persistence });
  });
  app.recovery.start(config.recovery.intervalMs);

  const shutdown = (signal: string): void => {
    log.info('server.stopping', { signal });
    app.recovery.stop();
    app.httpServer.close(() => process.exit(0));
    // Failsafe: do not hang forever if connections do not drain.
    setTimeout(() => process.exit(1), 10_000).unref();
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main();
