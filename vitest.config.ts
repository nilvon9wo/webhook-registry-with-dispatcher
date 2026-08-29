import { defineConfig } from 'vitest/config';

/**
 * Test pyramid (see `docs/5 - testing.md`):
 *   - `unit`        — many fast, isolated tests; all I/O is faked. Co-located
 *                     as `src/**\/*.test.ts`.
 *   - `integration` — HTTP API + real in-memory repositories wired together.
 *   - `e2e`         — full flow against a real local webhook HTTP server.
 *
 * `npm test` runs `unit` + `integration`. `e2e` is opt-in via `npm run test:e2e`
 * (and included in `npm run test:all`) because it binds real sockets.
 */
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'e2e',
          include: ['tests/e2e/**/*.test.ts'],
          environment: 'node',
          testTimeout: 20_000,
        },
      },
    ],
  },
});
