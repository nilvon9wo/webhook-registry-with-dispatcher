# Architecture Review & Resolution Log

This document is a point-in-time **review** and the log of what was done about
it. It is not a description of the current design — for that, see
`docs/4 - architecture.md` and `docs/9 - decisions.md`. Anything still open is in
the [Remaining issues](#remaining-issues) table at the bottom and is also
commented at the relevant place in the code.

| | |
| --- | --- |
| Reviewed against | `docs/1` (spec), `docs/3` (steering), `docs/4` (architecture), `docs/5` (testing) |
| Diagnosed | 2026-08-29 ~09:55 UTC+2 (commit `d337c2c`) |
| Resolved | 2026-08-29 10:03–10:11 UTC+2 (commits `1260f0b`, `cc5e521`) — same session |
| Status | 10 of 12 findings resolved; S8 and two soft items deferred (see the table) |

## Summary (as reviewed)

Core flow correct, cleanly layered, disciplined about scope. One high-severity
durability gap and a cluster of medium issues (layering direction, shutdown
draining, DynamoDB read consistency, uncaught-exception handling), plus low/nits.

## Findings

Severity is as assessed at diagnosis. Each finding keeps its original text; the
**Resolution** line records what changed (or why not).

---

### S1 — HIGH · crash during `dispatchEvent`, before delivery records are persisted, drops subscribers unrecoverably

- **Diagnosed:** 2026-08-29 · **Status:** RESOLVED 2026-08-29 (partial — residual window remains, documented)

`EventService.ingest` persists the event and returns `202`, then
`Dispatcher.dispatch` runs `dispatchEvent` in the background. If the process
died between the `202` and the point where every matching subscription had a
persisted `pending` delivery, the affected subscriptions got no delivery record.
Recovery only looks at existing delivery records, so those subscribers were
lost — even though the event is durable. This is the "process crashes during
dispatch" scenario the spec calls out (§8).

**Resolution:** `dispatchEvent` now creates and persists a `pending` delivery
record for **every** matching subscription (`Promise.allSettled` over
`materializeDelivery`) *before* it makes any HTTP call (a second `allSettled`
over the attempts). A crash after the materialise pass leaves recoverable rows
for every subscriber. New unit test: "persists a delivery record for every
subscription before making any HTTP call". Fault injection covers the
`dispatch.partial_failure` branch.

**Residual (open):** a crash *during* the materialise pass, or in
`findSubscriptionsForEvent` before it, still drops the not-yet-written
subscribers. Window is milliseconds. The fully crash-proof fix is a
transactional event + delivery-stub write (DynamoDB `TransactWriteItems`, ≤100
items) or an outbox. Commented at `dispatcher.ts:dispatchEvent`. See the
[Remaining issues](#remaining-issues) table.

---

### S2 — MEDIUM · the application layer imports concrete infrastructure

- **Diagnosed:** 2026-08-29 · **Status:** RESOLVED 2026-08-29 (commit `1260f0b`)

`src/application/{dispatcher,event-service,recovery,subscription-service}.ts`
imported from `src/infrastructure/{logger,webhook-client,ssrf-guard,log-fields}`.
The interfaces are legitimate abstractions but lived in the infrastructure
layer, so the import direction was backwards and inconsistent with `Clock`,
`Scheduler`, and the repository ports.

**Resolution:** the port interfaces + shared helpers moved into `application/`
(`logging.ts`, `webhook-client.ts`, `target-url-guard.ts`; `log-fields.ts` moved
up). The concrete factories (`createLogger`, `createHttpWebhookClient`,
`createDnsTargetUrlGuard`) stay in `infrastructure/`. `grep` confirms no non-test
file under `src/application` or `src/domain` imports `src/infrastructure`.
Behaviour unchanged.

---

### S3 — MEDIUM · graceful shutdown does not drain the dispatcher

- **Diagnosed:** 2026-08-29 · **Status:** RESOLVED 2026-08-29 (commit `cc5e521`)

`index.ts` shutdown called `recovery.stop()` + `httpServer.close()` but never
`cancelScheduledRetries()` / `whenIdle()`, and `Application.eventDispatcher` was
the bare `EventDispatcher` so those were unreachable. In-flight deliveries and
scheduled retries were hard-killed on `SIGTERM` (data-safe via recovery, but not
graceful).

**Resolution:** `Application.drain(timeoutMs?)` — stops recovery,
`cancelScheduledRetries()`, then `Promise.race([whenIdle(), timeout])`.
`index.ts` calls it after `httpServer.close()`. `Application.dispatcher`
(concrete) is exposed. New `tests/integration/shutdown.test.ts`;
`test-app.close()` drains too so tests cannot leak background work.

---

### S4 — MEDIUM · DynamoDB reads are eventually consistent where correctness wants strong consistency

- **Diagnosed:** 2026-08-29 · **Status:** RESOLVED 2026-08-29 for `get`; GSI window documented

`DynamoDeliveryRepository.get` used a default (eventually consistent) `GetItem`,
so recovery's `resumeDelivery` could act on a stale `pending` view of a
delivered delivery (an extra POST). `findSubscriptionsForEvent` queries a GSI,
which is always eventually consistent — a subscription created moments before a
matching event can be missed.

**Resolution:** `get()` in all three DynamoDB repos now uses
`ConsistentRead: true`. The GSI-match window cannot be removed (GSIs have no
strong-consistency option) and is documented in the repo header and at
`matching.ts:findSubscriptionsForEvent`.

---

### S5 — MEDIUM · `uncaughtException` handler logs and continues

- **Diagnosed:** 2026-08-29 · **Status:** RESOLVED 2026-08-29 (commit `cc5e521`)

After an uncaught exception the process state is undefined; continuing risks
serving corrupt state.

**Resolution:** the handler logs `process.uncaught_exception` then runs
`shutdown('uncaughtException', 1)`.

---

### S6 — LOW · unused `HttpError` class

- **Diagnosed:** 2026-08-29 · **Status:** RESOLVED 2026-08-29 (commit `cc5e521`)

`src/http/problem.ts` defined and handled `HttpError` but nothing threw it.

**Resolution:** removed. `toErrorResponse` maps `ValidationError`→400,
`ResourceNotFoundError`→404, everything else→generic 500.

---

### S7 — LOW · SSRF guard runs after `beginAttempt`

- **Diagnosed:** 2026-08-29 · **Status:** RESOLVED 2026-08-29 (commit `cc5e521`)

A blocked target consumed an attempt and briefly showed `delivering`.

**Resolution:** the guard check runs before `beginAttempt`; a blocked target is
`abandonDelivery` (`pending → failed`) and spends no attempt.

---

### S8 — LOW · list endpoints are unbounded

- **Diagnosed:** 2026-08-29 · **Status:** OPEN — deferred (see the table)

`GET /deliveries` and `GET /subscriptions` have no `?limit=` / cursor; a hot
`eventId` loads the whole set into memory and one JSON response.

**Resolution:** none. Commented at `ports.ts`, both handlers, and
`dynamodb-repositories.ts:collectPages`. See the table for effort/risk.

---

### S9 — LOW · recovery re-drives deliveries sequentially

- **Diagnosed:** 2026-08-29 · **Status:** RESOLVED 2026-08-29 (commit `cc5e521`)

`RecoveryService` used `for … of` with `await` while normal dispatch fans out.

**Resolution:** `reclaimStuckDeliveries` and `resumeDueDeliveries` use
`Promise.allSettled`, matching the dispatcher. Batch is capped by `batchLimit`.

---

### S10 — LOW · `durationMs` uses `Date.now()`

- **Diagnosed:** 2026-08-29 · **Status:** RESOLVED 2026-08-29 (commit `cc5e521`)

**Resolution:** attempt duration measured with `performance.now()` (monotonic),
rounded to ms.

---

### S11 — LOW · full-jitter backoff has no floor

- **Diagnosed:** 2026-08-29 · **Status:** RESOLVED 2026-08-29 (commit `cc5e521`)

`computeBackoffMs` returned `round(random() * capped)` — a retry could fire
almost immediately.

**Resolution:** switched to **equal jitter** (`half + random()*half`). A
struggling subscriber never gets a near-zero-delay retry; `random() === 1` still
yields the full window so the dispatcher tests are unaffected.

---

### S12 — NIT · minor logger duplication

- **Diagnosed:** 2026-08-29 · **Status:** RESOLVED 2026-08-29 (commit `cc5e521`)

**Resolution:** `materializeDelivery` uses `this.log.child(...)` instead of
re-adding `component`.

---

## What is satisfied (spot-checked at diagnosis)

| Requirement | Status |
| --- | --- |
| CRUD `/subscriptions`, conventional status codes | ✅ |
| `POST /events` → validate → persist → 202 → async dispatch | ✅ (event durable; S1 residual for the delivery-record gap) |
| Persistence external, behind repository ports | ✅ (in-memory + DynamoDB, contract-tested) |
| Matching by exact event type | ✅ |
| One delivery record per matching subscription | ✅ |
| Explicit webhook timeout | ✅ (`AbortController`) |
| Failure isolation between subscribers | ✅ (`Promise.allSettled`, tested) |
| Bounded retry, exponential backoff, retry classification | ✅ |
| Retry does not create a new event id; event stable across attempts | ✅ (tested) |
| Recovery for stuck `delivering` + due `pending`, not cron-primary | ✅ (S1 residual for the uncovered case) |
| `/deliveries` bonus with filters | ✅ |
| CloudFormation for the real resources | ✅ (`cfn-lint` + `validate-template` clean) |
| Env-driven config, safe defaults, no secrets | ✅ |
| HTTPS-only URLs, SSRF consideration | ✅ (guard implemented; DNS-rebinding documented) |
| At-least-once semantics, not exactly-once | ✅ (documented) |
| Test pyramid | ✅ (~235 unit / ~48 integration / 8 E2E) |

## Remaining issues

Everything still open, with the full recommendation.

| Ref | Description | Affects | Recommendation | Effort | Risk | Deferred because |
| --- | --- | --- | --- | --- | --- | --- |
| **S8** | `GET /deliveries` & `GET /subscriptions` return the whole result set — no `?limit=`, no cursor. A hot `eventId`/`status` loads a whole partition into memory and one response body. | **Production** | (a) internal hard cap `MAX_LIST_RESULTS` (~1000) + `warn` on truncation; (b) add validated `?limit=` (1–500, default 100); (c) full continuation cursor — needs a repo-agnostic opaque token (in-memory offset vs DynamoDB `LastEvaluatedKey`), base64 encode/decode, `nextCursor` in the body. | (a) ~30 min · (b) +~30 min · (c) ~2–3 hrs | (a)/(b) low · (c) medium (new abstraction, breaking response shape) | At the challenge's data scale nothing lists more than tens of rows; a partial pagination API is worse than none. Commented in code. |
| **S1-residual** | A crash *during* the delivery-stub materialise pass (or in `findSubscriptionsForEvent` before it) still drops the not-yet-written subscribers — recovery keys on existing delivery rows. Window is milliseconds. | **Production** | Write the event + all delivery stubs in one transaction (DynamoDB `TransactWriteItems`, ≤100 items) at ingest, or an outbox table drained by a worker. | ~2–4 hrs (transaction) / ~1 day (outbox) | medium — changes the ingest path and the in-memory repo would need a matching primitive | Disproportionate for the timebox; the common case (crash after materialise) is already covered. Commented at `dispatcher.ts:dispatchEvent`. |
| **Test gap** | Nothing exercises the S1 residual window or a real process kill. | **Test only** | *Not* a subprocess crash harness (~2–3 hrs, inherently flaky — the sub-millisecond window can't be hit deterministically). Instead, fault injection: a fake `DeliveryRepository` whose `save` fails/hangs on the Nth call. Covers `dispatch.partial_failure` and "materialised-then-recovered". | ~30 min | low | The high-value fault-injection subset is cheap and could be added later; the subprocess harness is not worth it. |
| **File size** | `dispatcher.ts` (~360 lines) and `dispatcher.test.ts` (~560 lines) are large. | **Neither** (maintainability only) | Split `dispatcher.test.ts` into `dispatcher-delivery.test.ts` + `dispatcher-retry.test.ts` (~15 min, zero risk). Leave `dispatcher.ts` — the class is cohesive (fan-out + attempt + retry share `inFlight`/`scheduledRetries` state); splitting the class adds coupling. If it grows, extract a retry-scheduling collaborator. | test split ~15 min | none | Soft finding; not material. Noted in the `dispatcher.ts` header. |
