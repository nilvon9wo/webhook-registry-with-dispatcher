# Architecture Review

Senior-engineer review of the implementation against `docs/1` (spec), `docs/3`
(steering), `docs/4` (architecture), `docs/5` (testing).

## Resolution (prompt 20)

| # | Resolution |
| --- | --- |
| S1 | `dispatchEvent` now materialises + persists a `pending` delivery record for every matching subscription **before** any HTTP call (`Promise.allSettled` over `materializeDelivery`, then a second `allSettled` over the attempts). A crash after this leaves recoverable rows for every subscriber; a crash during it leaves a recoverable subset. The fully crash-proof transactional fan-out is still noted as the production path. New test: "persists a delivery record for every subscription before making any HTTP call". |
| S2 | Fixed — port interfaces moved to `application/` (`logging.ts`, `webhook-client.ts`, `target-url-guard.ts`), `log-fields.ts` moved up; `grep` confirms no non-test file under `src/application`/`src/domain` imports `src/infrastructure`. |
| S3 | `Application.drain(timeoutMs?)` added: stops recovery, `cancelScheduledRetries()`, then `Promise.race([whenIdle(), timeout])`. `index.ts` shutdown calls it after `httpServer.close()`. `Application.dispatcher` (concrete) is now exposed. New test: `shutdown.test.ts`. |
| S4 | `get()` in all three DynamoDB repos uses `ConsistentRead: true`. The GSI-match eventual-consistency window is documented in the repo header + here. |
| S5 | `uncaughtException` now logs then runs `shutdown('uncaughtException', 1)`. |
| S6 | Unused `HttpError` removed from `problem.ts`. |
| S7 | The SSRF re-check runs **before** `beginAttempt`; a blocked target is `abandonDelivery` (`pending → failed`) and spends no attempt. |
| S8 | Not changed — remains documented as out of scope (LOW). Production fix is `?limit=` + a continuation token on the list endpoints. |
| S9 | Recovery re-drives (`resumeDueDeliveries`) and reclaims (`reclaimStuckDeliveries`) via `Promise.allSettled`, matching the dispatcher. |
| S10 | Attempt duration measured with `performance.now()`. |
| S11 | Backoff switched to **equal jitter** (`half + random()*half`) — a struggling subscriber never gets a near-zero-delay retry. `random() === 1` still yields the full window, so the dispatcher tests are unaffected. |
| S12 | `deliverToSubscription`/`materializeDelivery` use `this.log.child(...)` instead of re-adding `component`. |

`test:all` after the changes: **307 pass** (324 with DynamoDB).

---

Original review below. No code was changed for the review itself; findings were
addressed in the step above.

## Summary

The implementation is correct on the core flow, cleanly layered, and disciplined
about scope (no queue, no ORM, no DI framework, no speculative infrastructure).
Persistence, asynchronous dispatch, failure isolation, bounded retry, and
recovery all work and are well tested (321 tests, correct pyramid).

One **high-severity** durability gap, a handful of **medium** issues (layering
direction, shutdown draining, DynamoDB read consistency, uncaught-exception
handling), and several low/nit items.

## Findings (by severity)

### S1 — HIGH · a crash during `dispatchEvent`, before the delivery records are persisted, drops subscribers unrecoverably

`EventService.ingest` persists the event and returns `202`, then
`Dispatcher.dispatch` runs `dispatchEvent` in the background:

```
findSubscriptionsForEvent            ← DNS/DB round-trip
Promise.allSettled(subs.map(deliverToSubscription))
  deliverToSubscription: createDelivery → deliveries.save(pending) → attemptDelivery
```

If the process dies **between the `202` and the point where every matching
subscription has a persisted `pending` delivery**, the affected subscriptions
get no delivery record. Recovery only ever looks at existing delivery records
(`listPendingDue`, `listStuckDelivering`), so those subscribers are lost — even
though the event is durable.

This is exactly the "process crashes during dispatch" scenario the spec calls
out (§8: *"the event should not disappear merely because the process crashes
during dispatch"*). The event survives; the work does not.

The window is small (matching + N concurrent stub writes, tens of ms) but real.

**Options:**
1. *Eager materialisation in `dispatchEvent`* — create and `save` **all** delivery
   stubs in one pass, then attempt them. A crash after the stub pass leaves N
   recoverable `pending` deliveries; a crash during it leaves a recoverable
   prefix. Small change, closes most of the window.
2. *Materialise at ingest* — `EventService.ingest` matches + writes the delivery
   stubs synchronously (still not waiting on any webhook), so a crash any time
   after `202` is fully recoverable. Couples `EventService` to matching + the
   delivery repo, and a partial stub-write failure would surface as a `5xx` to
   the publisher (who then retries with a new event id → duplicate deliveries
   for the subscriptions whose stubs succeeded — the dual-write problem).
3. *Outbox / transactional write* — fully correct, clearly beyond the timebox.

**Recommendation:** option 1 for the timebox, and document the residual window
plus option 3 as the production path. Add a test asserting `dispatchEvent`
persists every delivery record before it makes any HTTP call.

### S2 — MEDIUM · the application layer imports concrete infrastructure

`src/application/{dispatcher,event-service,recovery,subscription-service}.ts`
import from `src/infrastructure/{logger,webhook-client,ssrf-guard,log-fields}.ts`.

The *interfaces* being imported (`Logger`, `WebhookClient`, `TargetUrlGuard`) are
legitimate abstractions, but they physically live in the infrastructure layer,
so the import direction is backwards — and inconsistent with `Clock`,
`Scheduler`, and the repository ports, which correctly live in `application/`.
`SsrfBlockedError`, `errorFields`, `LOG_COMPONENTS`, and the `log-fields`
builders are concrete and also imported upward.

Steering (`docs/3`): *"Keep infrastructure code separate from domain/application
behavior"* / *"depend on abstractions"*.

**Fix:** move the port interfaces + shared error/field helpers into
`application/` (e.g. `application/ports/`), leaving the concrete factories
(`createLogger`, `createHttpWebhookClient`, `createDnsTargetUrlGuard`) in
`infrastructure/`. Mechanical; no behaviour change.

### S3 — MEDIUM · graceful shutdown does not drain the dispatcher

`index.ts` shutdown calls `recovery.stop()` + `httpServer.close()` but never
`dispatcher.cancelScheduledRetries()` or `await dispatcher.whenIdle()` — and
`Application.eventDispatcher` is typed as the bare `EventDispatcher`, so those
methods are not even reachable. On `SIGTERM`, in-flight deliveries and scheduled
retries are hard-killed.

Data is safe (a `delivering` record is persisted before the HTTP call and
reclaimed by recovery; a scheduled retry is persisted `pending`), but it is not
a graceful drain, and `docs/9` explicitly deferred this to this step.

**Fix:** expose the concrete dispatcher (or a `LifecycleDispatcher` interface) on
`Application`; on shutdown `cancelScheduledRetries()` then
`await Promise.race([dispatcher.whenIdle(), timeout])` before closing.

### S4 — MEDIUM · DynamoDB reads are eventually consistent where correctness wants strong consistency

- `DynamoDeliveryRepository.get` uses a default (eventually consistent)
  `GetItem`. Recovery's `resumeDelivery` reads the delivery with `get`, so it can
  act on a stale `pending` view of a delivery that has actually been delivered →
  an extra (duplicate) POST. Covered by the documented at-least-once contract,
  but a `ConsistentRead: true` on `get` removes this particular cause cheaply.
- `findSubscriptionsForEvent` queries the `eventType-index` GSI, which is always
  eventually consistent. A subscription created moments before a matching event
  is published can be missed — a genuine missed-delivery window, not just a
  duplicate.

**Fix:** `ConsistentRead: true` on all single-item `get`s; document the GSI-match
window as an inherent DynamoDB property (webhook registration is rarely followed
within milliseconds by a matching event; a client that needs the guarantee
should poll `GET /subscriptions/{id}` before publishing).

### S5 — MEDIUM · `uncaughtException` handler logs and continues

`index.ts` logs `process.uncaught_exception` and returns. After an uncaught
exception the process is in an undefined state; Node guidance is to log and then
exit (or trigger shutdown). Continuing risks serving corrupt state.

**Fix:** after logging, run `shutdown('uncaughtException')` / `process.exit(1)`.

### S6 — LOW · unused `HttpError` class

`src/http/problem.ts` defines and handles `HttpError`, but nothing ever throws
it (`requiredParam` throws a plain `Error`; handlers throw domain errors).
Dead code — remove it, or actually use it for the "route param missing" case.

### S7 — LOW · SSRF guard runs after `beginAttempt`

`attemptDelivery` does `beginAttempt` (→ `delivering`, `attempts++`) and `save`
*before* the SSRF re-check. A blocked target therefore consumes an attempt and
briefly shows `delivering`. Move the guard check above `beginAttempt` so a
blocked delivery fails without spending an attempt.

### S8 — LOW · list endpoints are unbounded

`GET /deliveries` and `GET /subscriptions` have no `Limit` / pagination. A hot
`eventId` (many deliveries) loads the whole set into memory and into one JSON
response. Documented as out-of-scope in `docs/9`, but note it as a real
production risk; a `?limit=` + continuation token is the standard fix.

### S9 — LOW · recovery re-drives deliveries sequentially

`RecoveryService.resumeDueDeliveries` is a `for … of` with `await`, while normal
dispatch fans out with `Promise.allSettled`. A sweep that picks up a batch of
deliveries each hitting the webhook timeout can exceed its own interval (the next
ticks are correctly skipped by the reentrancy guard, but the sweep falls
behind). Bounded parallelism here would match the dispatcher and the intent.

### S10 — LOW · `durationMs` uses `Date.now()`

Attempt duration is measured with `Date.now()` rather than `performance.now()`
(monotonic) and independently of the injected `Clock`. Harmless for logs; a
fixed-clock test would still show real elapsed time.

### S11 — LOW · full-jitter backoff has no floor

`computeBackoffMs` returns `round(random() * capped)` — a retry can fire almost
immediately. This is AWS "full jitter" and is documented, but "equal jitter"
(`capped/2 + random()*capped/2`) would guarantee a minimum spacing for a
struggling subscriber.

### S12 — NIT · minor logger duplication

`deliverToSubscription` rebuilds a child logger with `component` by hand instead
of using `this.log`.

## What is satisfied (spot-checked)

| Requirement | Status |
| --- | --- |
| CRUD `/subscriptions`, conventional status codes | ✅ |
| `POST /events` → validate → persist → 202 → async dispatch | ✅ (event durable; see S1 for the delivery-record gap) |
| Persistence external, behind repository ports | ✅ (in-memory + DynamoDB, contract-tested) |
| Matching by exact event type | ✅ |
| One delivery record per matching subscription | ✅ |
| Explicit webhook timeout | ✅ (`AbortController`) |
| Failure isolation between subscribers | ✅ (`Promise.allSettled`, tested) |
| Bounded retry, exponential backoff, retry classification | ✅ |
| Retry does not create a new event id; event stable across attempts | ✅ (tested) |
| Recovery for stuck `delivering` + due `pending`, not cron-primary | ✅ (see S1 for the uncovered case) |
| `/deliveries` bonus with filters | ✅ |
| CloudFormation for the real resources | ✅ (`cfn-lint` + `validate-template` clean) |
| Env-driven config, safe defaults, no secrets | ✅ |
| HTTPS-only URLs, SSRF consideration | ✅ (guard implemented; DNS-rebinding documented) |
| At-least-once semantics, not exactly-once | ✅ (documented) |
| Test pyramid | ✅ (~230 unit / ~45 integration / 8 E2E) |

## Unnecessary complexity

None material. `Clock` / `Scheduler` / `IdGenerator` seams, the repository
ports, `configSummary`/`configWarnings`, and `log-fields` are all justified.
`dispatcher.ts` (~340 lines) and `dispatcher.test.ts` (~520 lines) are getting
large and could be split by concern (attempt vs retry vs resume), but that is
optional.

## Test quality

Strong: contract tests for the repositories, AAA throughout, fakes over mocks,
behaviour-focused, `waitFor` instead of fixed sleeps. Gaps: nothing exercises
the S1 window or `dispatch.partial_failure` (both hard to test without a crash
harness).
