/**
 * Process entry point: load configuration, build the application, start the
 * HTTP server, and shut down gracefully on SIGINT/SIGTERM.
 */

import { buildApplication } from './container.js';
import type { AppConfig } from './config.js';
import { ConfigError, configSummary, configWarnings, loadConfig } from './config.js';
import { errorFields, LOG_COMPONENTS } from './application/logging.js';

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

  // A bind failure (port in use, permission denied) is a startup problem, not a
  // runtime fault — report it plainly and exit rather than routing it through
  // the uncaughtException handler with a stack trace and a drain of a server
  // that never started.
  app.httpServer.on('error', (error: NodeJS.ErrnoException) => {
    const detail =
      error.code === 'EADDRINUSE'
        ? `port ${config.port} is already in use — stop the other process or set PORT`
        : (error.message ?? String(error));
    log.error('server.listen_failed', { port: config.port, detail });
    process.exit(1);
  });
  app.httpServer.listen(config.port, () => {
    log.info('server.listening', { port: config.port, persistence: config.persistence });
    app.recovery.start(config.recovery.intervalMs);
  });

  let shuttingDown = false;
  const shutdown = (reason: string, exitCode: number): void => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log.info('server.stopping', { reason });
    // Failsafe: never hang the shutdown.
    const failsafe = setTimeout(() => process.exit(exitCode || 1), 15_000);
    failsafe.unref();

    app.httpServer.close(() => {
      void app
        .drain()
        .catch((error: unknown) => log.error('shutdown.drain_failed', errorFields(error)))
        .finally(() => process.exit(exitCode));
    });
  };

  process.on('SIGINT', () => shutdown('SIGINT', 0));
  process.on('SIGTERM', () => shutdown('SIGTERM', 0));
  process.on('unhandledRejection', (rejection) => {
    log.error('process.unhandled_rejection', errorFields(rejection));
  });
  process.on('uncaughtException', (error) => {
    log.error('process.uncaught_exception', errorFields(error));
    // After an uncaught exception the process state is undefined — shut down.
    shutdown('uncaughtException', 1);
  });
}

main();
