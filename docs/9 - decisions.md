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
| 11 | The deployed CloudFormation stack (already created on AWS) will diverge from the corrected template. | Accepted by the repository owner; the stack can be redeployed at will. The app reads table names from configuration, so it is not coupled to the stack. Template rewritten (prompt 6) and finalised (prompt 14): `ResourcePrefix` + `EnablePointInTimeRecovery` parameters, Subscriptions PK=`id` + `eventType-index`, Deliveries GSIs re-keyed on `createdAt` + `status-index`, table ARN outputs, least-privilege IAM policy documented in a header comment. Validated with `cfn-lint` **and** `aws cloudformation validate-template` (server-side). Every GSI name matches the DynamoDB repositories; default table names match the default `ResourcePrefix`. Tables keep the default `DeletionPolicy: Delete` for easy challenge teardown (production → `Retain`). **2026-08-29: the stack was deleted and redeployed from the corrected template** — the originally-deployed stack still had the pre-implementation schema (Subscriptions keyed `eventType`+`id`, no GSIs), which made every `GET /subscriptions/{id}` a `500` and every dispatch fail with "table does not have the specified index: eventType-index" when the app ran against real DynamoDB. Found during manual testing (`docs/13` §8); the code and the automated DynamoDB contract tests were always correct (they build throwaway tables from the in-code schema). Live tables now: Subscriptions PK `id` + `eventType-index`; Deliveries PK `id` + `eventId-index` / `subscriptionId-index` / `status-index`; Events PK `id`. Verified end-to-end (create → publish → deliver → survives a process restart). |

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
- **Event `data` is optional.** Defaults to `{}`; when present it must be a JSON
  object (a `null`, array, string, or number `data` is a `400`). `type` is a
  required non-empty string. Rationale: many event types legitimately carry no
  payload — the type *is* the information (`user.logged_out`,
  `cache.invalidated`, `nightly.rollup.done`) — and CloudEvents likewise makes
  `data` optional. A missing `data` is a valid event, not a mistake, so it is
  **not** rejected and **not** logged as a warning (contrast
  `dispatch.no_subscribers`, which signals likely misconfiguration): a
  payload-less event is routine, and a per-event log line for it would be pure
  noise. A
  publisher verifying its integration sees `"data": {}` in the delivered webhook
  immediately. Distinguishing "omitted" from an explicit `{}` (e.g. echoing a
  `dataPresent` flag) was considered and rejected as needless surface for no
  consumer benefit.
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
- **`PERSISTENCE` defaults to `memory`.** Persistence is a port with two
  adapters (`memory`, `dynamodb`); the challenge *requires* external storage and
  we implement it, but the **default** is the in-process store because a fresh
  clone (or a reviewer, or CI) can then run `npm install && npm run dev` / `npm
  test` with zero AWS setup. `dynamodb` is one env var away (`.env.example`
  shows the exact toggle). Running `memory` is never silent: `configWarnings`
  emits a startup `config.warning` for `PERSISTENCE=memory` in **every**
  environment (escalated wording under `NODE_ENV=production`). Trade-off
  accepted: the in-memory store does not
  survive a process restart (including a `tsx watch` reload), so manual testing
  that needs durable state should switch to `dynamodb` (`docs/13` §2.1 / §8).
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
- **List responses name their array after the resource:**
  `GET /subscriptions` → `{ "subscriptions": [...] }`, `GET /deliveries` →
  `{ "deliveries": [...] }`. A generic `{ "items": [...] }` envelope was used
  initially (uniform decoder, room for pagination metadata) but changed to
  resource-named keys — self-documenting wins, and there is no plausible reason
  this endpoint would need to return a *different* collection under the same key
  (pagination metadata would just be sibling properties: `{ deliveries, nextCursor }`).
  Single-resource responses have no envelope — the object is the body.
  Distinguishing outcomes from `GET /deliveries?eventId=X`: `deliveries: []`
  means **no subscription matched** (also logged as `dispatch.no_subscribers`);
  a non-empty array of records with `status: "failed"` means subscribers matched
  but delivery failed. The one gap: if a delivery *record* could not be persisted
  (`dispatch.partial_failure`, the S1-residual window), that subscriber shows
  neither — cross-check `dispatch.started`'s `matchedCount` in the logs.
- **`GET /events/{id}` — read-back only, no update/delete.** The initial build
  had `POST /events` only (`docs/1` §3 says events "need not be a CRUD API").
  A final review against `docs/0` — which lists `/events` under "CRUD APIs" —
  judged a read endpoint worth the ~15 minutes to remove the ambiguity and let
  a publisher confirm what was stored. `GET /events/{id}` → `200` with the
  stored event, `404` if unknown. Events are immutable facts once accepted, so
  there is deliberately **no** `PUT` / `DELETE` for them.
- **`POST /events` returns `202` with the stored event body** (`id`, `type`,
  `data`, `createdAt`) and no `Location` header.
- **Decoupled publish — zero matching subscribers is not an error.** `POST
  /events` validates, persists, and returns `202` regardless of how many
  subscriptions match. This is how every comparable system behaves (SNS,
  EventBridge, Pub/Sub, and hosted webhook products like Stripe / Svix): the
  publisher is intentionally decoupled from the subscriber set, whose lifecycle
  is independent, and a subscriber may be registered moments later. Returning a
  `4xx` would wrongly tell the caller the event was rejected. The typo risk
  (a mis-typed `type` silently going nowhere) is addressed with **observability,
  not a status code**: the dispatcher emits a distinct `dispatch.no_subscribers`
  **warning** (`docs/11`) that an operator can alert on — matching the
  "unmatched-events metric" pattern EventBridge/SNS use.

  Alternatives considered and rejected:
  - **A stricter registered-event-types model** (reject unknown types): the
    spec's model lets subscriptions define the types implicitly, and up-front
    type registration is a heavier design than the four-hour build wants.
  - **A distinct 2xx status for zero matches** (e.g. `200` instead of `202`):
    overloads the status code with a business outcome. Proxies, gateways,
    uptime monitors and generated clients treat every 2xx alike, so it needs
    custom client branching anyway — no cheaper than a metric — and it is
    invisible to standard tooling. No comparable system does this.
  - **A `matchedSubscriptions` count in the `202` body** (EventBridge-style):
    would move the subscription-match query onto the synchronous request path
    (an extra datastore round-trip per publish) purely for telemetry, and the
    value is still a racy point-in-time count — "no subscribers *now*" is not
    "this event was wasted". Publishers that genuinely need it can already poll
    `GET /deliveries?eventId=…` or check `GET /subscriptions?eventType=…`.

  Conclusion: "no subscribers" is an operator/platform concern (is routing
  configured correctly?), not a publisher concern, so it lives in logs/metrics,
  and `POST /events` stays a uniform `202`.
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

- **Observability / structured logging (prompts 17 + follow-up):** every log
  line is a JSON object with a **stable dot-namespaced `message`** (an event
  identifier, not a sentence), a **`component`** field, and fields drawn from a
  fixed dictionary. Recurring field groups are built by helpers in
  `src/infrastructure/log-fields.ts` so a concept always serialises identically.
  Full reference — line shape, correlation model, field dictionary, and the
  event catalogue — is **`docs/11 - logging.md`**. Delivery-scoped lines carry
  `eventId` + `subscriptionId` + `deliveryId` + `attempt` + `targetHost` (host
  only). No line contains an event payload, a request/response body, a full
  target URL, or a credential (asserted by test). `index.ts` logs
  `process.unhandled_rejection` / `process.uncaught_exception`. A
  per-HTTP-request id is a noted future addition.
  - **Production delivery of logs + rendering (prompt 21 follow-up):** stdout is
    the only sink — a deliberate twelve-factor choice; the alternatives (config
    file sink, `pino` swap, full pipeline) with effort/cost/performance
    estimates are in `docs/11 - logging.md`. Added a `LOG_FORMAT` env
    (`auto` \| `json` \| `pretty`, default `auto`): `pretty` renders one
    colour-coded line per entry (level first and coloured, `WARN` yellow /
    `ERROR` red, time-of-day pushed to the end) for a local terminal; `auto`
    uses it only when stdout is a TTY, so piped/production output stays JSON. It
    is a built-in-sink convenience — a custom `write` always gets the JSON line.

- **Configuration review (prompt 15):** every operational setting in the spec §12
  list is an env var with a safe default and aggregated validation
  (`config.ts` + `.env.example`, both cross-checked in a test). No secrets in
  config — AWS credentials only from the SDK provider chain. Startup logs a
  non-secret `configSummary` and `configWarnings` for risky combinations
  (`PERSISTENCE=memory` in production, insecure target URLs, SSRF guard off,
  recovery disabled). Added `requests.http` and a README Configuration section.

- **Test review (prompt 18):** the pyramid holds — a large unit base, a thin
  integration layer (in-memory), 17 opt-in DynamoDB contract tests, a handful of
  E2E (current totals are in the README). Every `docs/5` checklist item is
  covered. Gaps filled: the `abandonDelivery` pure transition (+
  terminal-state guards for `abandonDelivery`/`reclaimStuck`); `DELETE
  /subscriptions` prevents future deliveries **and** leaves historical delivery
  records intact (spec §3); `PUT` re-routes matching; the event id and payload
  stay identical across every retry attempt and the persisted event is untouched
  by dispatch (steering); concurrent (not serial) dispatch to matching
  subscribers; a real slow subscriber past `WEBHOOK_TIMEOUT_MS` fails the
  delivery end-to-end. Added a `logger` build option so a test that deliberately
  triggers an error-level log can silence it.
- **All tests pass, DynamoDB included.** `npm test` / `test:all` keep the
  DynamoDB repository tests skipped (they need a DynamoDB endpoint, and CI has
  none): **321 pass, 17 skipped**. Verified with `RUN_DYNAMODB_TESTS=1
  AWS_PROFILE=webhook-challenge npm run test:all` → **338 pass, 0 skipped**
  against real AWS, throwaway tables torn down, no orphans (re-run for prompt 22).
- **AAA standard tightened (`docs/5`):** the "Act is one statement" rule now
  spells out that value-extraction, async synchronisation (`whenIdle` /
  `waitFor`), and searching recorded output are Assert-phase; a multi-call
  logical act (dispatch + drain the manual scheduler) is wrapped in a helper
  (`dispatchToCompletion`); one behaviour per test (lifecycle checks split into a
  test per step); genuinely coordinated acts (peak-concurrency, reentrancy) keep
  their statements together with a one-line reason. All existing tests were
  brought into line.

- **Architecture review (prompts 19–20):** full review in
  `docs/12 - architecture-review.md`. Changes made: delivery records for a whole
  fan-out are persisted before any HTTP call (crash-recovery hole S1); the
  logging / webhook-client / SSRF-guard **port interfaces moved from
  `infrastructure/` into `application/`** so the application layer no longer
  imports infrastructure (S2); `Application.drain()` + graceful shutdown wired
  into `index.ts` (S3); DynamoDB `get()` uses `ConsistentRead: true` (S4);
  `uncaughtException` shuts down instead of continuing (S5); SSRF re-check moved
  before `beginAttempt` (S7); recovery re-drives in parallel (S9); attempt
  timing via `performance.now()` (S10); backoff changed to **equal jitter** so a
  retry never fires near-instantly (S11); dead `HttpError` removed (S6).

- **Documentation review + manual-testing tooling (prompt 21 follow-up):**
  - **API console:** added a hand-written `openapi.yaml` (OpenAPI 3.0.3, the
    outbound webhook documented as an OpenAPI `callback`) served at
    `GET /openapi.yaml`, with Swagger UI at `GET /docs` (loads the UI bundle from
    a CDN; the spec itself is served locally). This makes the API testable
    without Postman/curl. Not generated from code — kept in sync by hand and by
    an integration test that asserts `/docs` and `/openapi.yaml` respond.
    `HandlerResult` gained a `rawBody` field for non-JSON responses.
  - **Local subscriber:** `npm run inbox` (`scripts/webhook-inbox.ts`) — a
    self-contained `node:http` webhook inbox with a live HTML page, no
    dependencies beyond Node. Query params make it misbehave (`?status=500`,
    `?status=500,500,200` sequences, `?delay=ms`) to exercise retries. Bundled so
    there is a zero-setup option; `docs/13` also documents
    [webhook.site](https://webhook.site) as the external alternative (used when
    the SSRF guard is on and loopback is blocked).
  - **Manual test plan:** `docs/13 - manual-test-plan.md` — a step-by-step
    script (start the server locally, every golden-path scenario, every
    critical-failure scenario from the challenge, retry + crash-recovery
    scenarios, a pass/fail results log). The automated suite already covers all
    of it; this is for hands-on confidence and demos.
  - **Docs folder stays flat and keeps its numbering.** Considered subdividing
    `docs/` by concern and renumbering into a more optimal reading order. Not
    done: the numbers are referenced from ~30 cross-links across the README and
    the docs themselves, and renumbering is roughly an hour of careful
    find-and-replace surgery for no functional benefit — this is a documentation
    ergonomics question, **not an architectural one**. Instead: the README doc
    table now groups the files under reading-order headings (Start here / Design
    / AI process / Implementation record / Reference), and `docs/2` carries a
    banner pointing at `docs/9` as the as-built record.

## 4. Pre-packaging checklist (prompt 22)

Run immediately before packaging, in order:

1. `RUN_DYNAMODB_TESTS=1 AWS_PROFILE=webhook-challenge npm run test:all` →
   all green, throwaway tables torn down (`aws dynamodb list-tables` shows no
   orphans).
2. `npm run check` (format:check + lint + typecheck + test:all).
3. Complete the manual test plan (`docs/13`); fix or document anything
   unexpected.
4. **CloudFormation from zero + app against real DynamoDB** (`docs/13` §8):
   delete the `webhook-registry` stack, recreate it from the template, confirm
   `CREATE_COMPLETE`, then run the app with `PERSISTENCE=dynamodb` against the
   real tables and walk the golden-path + one retry + the recovery scenario.
   This exercises the template's actual table/GSI definitions (the automated
   DynamoDB tests use throwaway uuid-prefixed tables). Leave the stack deployed
   for review (PAY_PER_REQUEST — negligible idle cost) or tear it down after.
   Hosting the app itself on AWS stays out of scope (see §5).
5. **Export this AI conversation** — the challenge asks for it. Run
   `npm run export:conversation` (`scripts/export-conversation.ts`): renders the
   session transcript to `docs/ai-conversation.md` — human + assistant text
   verbatim, tool calls as a one-line trace, thinking/tool-output omitted. Do
   this **last** so it captures the whole session, then commit the result.
6. **Package only what is tracked in git.** Produce the archive with
   `git archive --format=zip --output=../webhook-registry.zip HEAD` (or
   `git archive … --prefix=webhook-registry/ HEAD | tar -x` into a clean dir).
   Never hand-copy the working tree — that would pull in `.git/`, `node_modules/`,
   `.idea/`, `.env`, `dist/`, `coverage/`, and anything else in `.gitignore`.
   Sanity-check: `git status` clean, `git ls-files | grep -E '\.env$|node_modules'`
   returns nothing.

## 5. Explicitly out of scope for the four-hour build

SQS / durable queue, multi-instance coordination, full SSRF protection
(DNS-rebinding-safe resolution), authentication, real AWS deployment,
single-table DynamoDB design, *code-generated* OpenAPI (a hand-written spec is
included), metrics/tracing backends, dead-letter queues, rate limiting, response
pagination.
