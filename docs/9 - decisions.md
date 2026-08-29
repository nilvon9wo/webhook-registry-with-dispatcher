# Implementation Decisions & Documentation Reconciliation

This document records decisions taken during the implementation phase and any
points where the repository state was reconciled against `docs/1`–`docs/8`.
It is a living document, updated as implementation proceeds.

## 1. Reconciliation of pre-existing repository state

| # | Finding | Resolution |
|---|---------|------------|
| 1 | `infrastructure/cloudformation.yaml` keyed the Subscriptions table on `eventType` (HASH) + `id` (RANGE), which cannot serve "get/update/delete subscription by id" or "list subscriptions" (required access patterns in `docs/4`). | Template will be changed: Subscriptions PK = `id`, with GSI `eventType-index` for "find subscriptions by event type". List = `Scan`. **Redeploying the updated template replaces the table** (empty, no data loss, no cost). |
| 2 | No index supported "find retryable/incomplete deliveries". | Add `status-index` GSI (PK `status`, RANGE `createdAt`) to the Deliveries table. |
| 3 | Delivery GSIs sorted by random `id`. | GSIs use `createdAt` as the range key for chronological ordering. |
| 4 | `.gitignore` was wrapped in a ```` ```gitignore ```` markdown fence. | Fence removed. |
| 5 | `package.json` had no scripts; no lint/format/test config. | Added scripts + `.oxlintrc.json`, `.prettierrc.json`, `vitest.config.ts`, `tsconfig.test.json`. |
| 6 | No HTTP framework or validation library installed. | Deliberate — using the Node built-in `node:http` and hand-written validation (dependency discipline, `docs/3`). |
| 7 | `docs/6 - prompts.md` lists `docs/1 - spec.md` twice and omits `docs/2 - plan.md` (typo). | Noted; not corrected (cosmetic, in an authoritative doc). |
| 8 | `.env` / `.env.example` only contained `AWS_REGION`. | `.env.example` expanded to document every operational setting. `.env` remains git-ignored. |
| 9 | `docs/8 - setup.md` referenced `cloudformation/template.yaml`. | Corrected to `infrastructure/cloudformation.yaml`. |
| 10 | `tsconfig.json` (`rootDir: src`) would not type-check `tests/`. | Added `tsconfig.test.json`; `npm run typecheck` checks both. Unit tests are co-located `src/**/*.test.ts` and excluded from the build. |
| 11 | The deployed CloudFormation stack (already created on AWS) will diverge from the corrected template. | Accepted by the repository owner; the stack can be redeployed at will. The app reads table names from configuration, so it is not coupled to the stack. Template rewritten (prompt 6) and finalised (prompt 14): `ResourcePrefix` + `EnablePointInTimeRecovery` parameters, Subscriptions PK=`id` + `eventType-index`, Deliveries GSIs re-keyed on `createdAt` + `status-index`, table ARN outputs, least-privilege IAM policy documented in a header comment. Validated with `cfn-lint` **and** `aws cloudformation validate-template` (server-side). Every GSI name matches the DynamoDB repositories; default table names match the default `ResourcePrefix`. Tables keep the default `DeletionPolicy: Delete` for easy challenge teardown (production → `Retain`). |

## 2. Tooling decisions

- **Linter: `oxlint`** instead of ESLint. `typescript-eslint` hard-refuses
  TypeScript 7.0 (the pinned latest stable; see typescript-eslint#10940), so the
  standard `eslint` + `typescript-eslint` stack cannot run here. `oxlint` parses
  modern TypeScript natively, has no TypeScript-compiler peer dependency, and is
  a single self-contained dependency. Type-level checking is enforced separately
  by the already-strict `tsc` configuration.
- **Test runner: Vitest 4** with three projects (`unit`, `integration`, `e2e`).
  `npm test` runs `unit` + `integration`; `e2e` is opt-in.
- **Formatter: Prettier 3** (config committed).
- **`@types/node`** added (required for Node built-in typings).
- **Test structure standard: Arrange / Act / Assert**, enforced by convention and
  documented in `docs/5 - testing.md`. Every test marks the three phases; Act is a
  single statement; expected-throw tests use the `captureError` helper
  (`tests/support/capture-error.ts`) to keep Act to one statement.
- **Entry point:** `src/index.ts` loads and validates configuration and fails
  fast on `ConfigError`. Composition-root wiring (HTTP server, dispatcher,
  recovery) is added in later steps.

## 3. Behavioural decisions (from the pre-implementation Q&A)

- **HTTP layer:** built-in `node:http` + a small router. No Express/Fastify.
- **Validation:** hand-written validators returning structured errors.
- **IDs:** prefixed — `sub_<uuid>`, `evt_<uuid>`, `del_<uuid>` (`crypto.randomUUID()`).
- **Event `data`:** optional, defaults to `{}`, must be a JSON object if present.
  `type` is a required non-empty string.
- **`PUT /subscriptions/{id}` on an unknown id:** `404` (no upsert).
- **Retry execution:** in-process exponential backoff with jitter for the normal
  path; the recovery sweep is the crash safety net, never the primary mechanism.
- **HTTPS enforcement:** `https:` targets required by default;
  `ALLOW_INSECURE_TARGET_URLS=true` permits `http:` (needed for local E2E).
- **SSRF guard (implemented prompt 16):** `src/infrastructure/ssrf-guard.ts`,
  on by default. Resolves the target host and rejects loopback / private (RFC
  1918 / CGNAT / IPv6 ULA) / link-local / unspecified / `169.254.169.254`.
  Enforced at subscription create/replace (`400`) **and** at each delivery
  attempt (permanent `failed`). DNS-rebinding TOCTOU is out of scope and
  documented in `docs/10 - security.md`, which holds the full security review.
- **Outbound webhook:** body `{ id, type, timestamp, data }` plus headers
  `Content-Type: application/json`, `X-Webhook-Event-Id`, `X-Webhook-Delivery-Id`,
  `X-Webhook-Attempt`.
- **Default config:** webhook timeout 5000 ms; max attempts 5; backoff base
  500 ms (×2, capped at 30000 ms); recovery interval 60000 ms; stuck-`delivering`
  threshold 60000 ms; max request body 1 MiB.
- **DynamoDB in tests:** unit tests fully mock the repositories. DynamoDB-backed
  repository tests are opt-in (`RUN_DYNAMODB_TESTS=1`, with `DYNAMODB_ENDPOINT`
  pointing at DynamoDB Local); the suite creates its own uuid-prefixed tables,
  runs the shared repository contracts against the DynamoDB implementations, and
  deletes those tables in `afterAll` regardless of outcome. Not run by `npm test`.
- **DynamoDB `list` filtering:** the repository picks the most selective GSI for
  the first present filter field (`eventId` → `subscriptionId` → `status`) and
  applies any remaining filter fields in memory. Recovery queries sort the
  filtered result by the relevant timing field so ordering does not depend on
  GSI sort-key uniqueness.
- **Idempotency:** `/events` does **not** accept client idempotency keys in v1.
  Event IDs are stable across retries. Delivery is at-least-once.
- **Recovery (prompt 13):** a periodic sweep (`RECOVERY_INTERVAL_MS`, `0`
  disables; `RECOVERY_BATCH_LIMIT` bounds a run), **not** the primary dispatch
  path. Each run: (1) reclaim deliveries stuck in `delivering` past
  `STUCK_DELIVERING_THRESHOLD_MS` back to `pending` (`reclaimStuck`); (2) re-drive
  `pending` deliveries whose `nextAttemptAt` is due via
  `Dispatcher.resumeDelivery`, which enforces the attempt cap and abandons
  (`abandonDelivery`: `pending → failed`) deliveries that cannot progress —
  budget spent, or source event gone — so recovery can never retry forever.
  Reentrancy-guarded (a slow run skips the next tick). The `Dispatcher` now
  depends on `EventRepository` so `resumeDelivery` can reload the payload; the
  in-process retry timer also routes through `resumeDelivery` (single code
  path). `start`/`stop` wired into `index.ts`. Overlap between a recovery sweep
  and the in-process retry timer can cause an extra delivery attempt
  (at-least-once, documented) — the `status !== 'pending'` guard narrows the
  window.
- **`/deliveries` API (prompt 12, bonus):** `GET /deliveries` with optional
  `?eventId=` / `?subscriptionId=` / `?status=` (AND-combined; unknown `status`
  → 400), `GET /deliveries/{id}` (404 if unknown). Read-only — delivery state is
  written only by the dispatcher and recovery. Returns the full delivery record
  (status, attempts, `lastStatusCode`, `lastError`, `nextAttemptAt`, timestamps).
  No pagination (out of scope; documented).
- **No `GET /events/{id}` endpoint.** The spec says events need not be a CRUD
  resource; `/deliveries` (prompt 12) is the observability surface. Events are
  still persisted for durability/audit. A read endpoint would be a reasonable
  future addition.
- **`POST /events` returns `202` with the stored event body** (`id`, `type`,
  `data`, `createdAt`) and no `Location` header (there is no event GET route).
- **Dispatcher seam:** `EventService` depends on an `EventDispatcher` interface
  (`dispatch(event): void`, must return promptly and never throw into the
  caller). Persist is awaited before `dispatch` is called.
- **Dispatcher (prompt 9):** in-process, `Promise.allSettled` over per-subscription
  delivery tasks for failure isolation. `dispatch()` is fire-and-forget and
  swallows/logs background errors; `whenIdle()` lets shutdown and tests await
  in-flight work. `dispatchEvent()` is also public so recovery can re-drive an
  event.
- **Retry (prompt 11):** a `retryable` outcome with attempts remaining →
  `scheduleRetry` (persisted `pending` + `nextAttemptAt`) + a deferred re-attempt
  through an injected `Scheduler` seam (`setTimeout` in prod, a manual scheduler
  in tests). `permanent`, or `retryable` past `maxAttempts` → `failed`. Backoff
  is capped exponential with full jitter; jitter source is injectable
  (`random`). All bounds from config (`MAX_DELIVERY_ATTEMPTS`,
  `RETRY_BASE_DELAY_MS`, `RETRY_MAX_DELAY_MS`). The re-attempt reloads the
  delivery and no-ops if it is no longer `pending` (race with recovery).
  `cancelScheduledRetries()` (for shutdown) drops in-flight backoff timers,
  leaving the deliveries `pending` for recovery; real scheduler timers are
  `unref()`ed so a pending retry never blocks process exit. Wiring the shutdown
  call into `index.ts` is left for prompt 19.
- **Webhook client:** `fetch` + `AbortController` timeout; never throws (maps to
  an `AttemptOutcome`); `redirect: 'manual'` so a user-supplied target cannot
  redirect the server to an internal address (3xx → permanent failure); response
  body is cancelled (delivery success depends only on status).
- **Outbound headers:** `Content-Type: application/json`, `X-Webhook-Event-Id`,
  `X-Webhook-Delivery-Id`, `X-Webhook-Attempt`.
- **Delivery state tracking (prompt 10)** was largely delivered earlier: the
  `Delivery` entity + pure transition functions in prompt 3, persistence in
  prompt 4, and the dispatcher persisting after every transition in prompt 9.
  The `delivering` state is persisted *before* the HTTP call so a crash
  mid-attempt leaves a recoverable record. Every transition advances
  `updatedAt`; the record always reflects the latest attempt's status
  code/error; `lastError` is cleared when a delivery finally succeeds. Prompt 10
  added history tests (≥3 attempts, exhausted-attempts failure, `updatedAt`
  progression) and a "persist `delivering` before HTTP" dispatcher test. No new
  states — `pending | delivering | delivered | failed` as the spec suggests.
- **AuthN/AuthZ:** out of scope; documented as an assumption.

- **Configuration review (prompt 15):** every operational setting in the spec §12
  list is an env var with a safe default and aggregated validation
  (`config.ts` + `.env.example`, both cross-checked in a test). No secrets in
  config — AWS credentials only from the SDK provider chain. Startup logs a
  non-secret `configSummary` and `configWarnings` for risky combinations
  (`PERSISTENCE=memory` in production, insecure target URLs, SSRF guard off,
  recovery disabled). Added `requests.http` and a README Configuration section.

## 4. Explicitly out of scope for the four-hour build

SQS / durable queue, multi-instance coordination, full SSRF protection
(DNS-rebinding-safe resolution), authentication, real AWS deployment,
single-table DynamoDB design, OpenAPI generation, metrics/tracing backends,
dead-letter queues, rate limiting, response pagination.
