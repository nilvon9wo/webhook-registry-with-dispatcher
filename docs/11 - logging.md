# Logging Conventions

## Decision

All logging is **structured**: one JSON object per line, emitted to stdout
(`debug`/`info`) or stderr (`warn`/`error`) by `src/infrastructure/logger.ts`.
There is no free-form log text. Every line can be parsed, filtered, grouped, and
alerted on by field, without regexes over prose.

The logger is deliberately tiny (no `pino`/`winston`) — the value is in the
*conventions* below, not the transport.

## Line shape

```json
{
  "time": "2026-08-29T07:19:45.922Z",
  "level": "info",
  "message": "delivery.succeeded",
  "component": "dispatcher",
  "eventId": "evt_…", "subscriptionId": "sub_…", "deliveryId": "del_…",
  "attempt": 1, "targetHost": "hooks.customer.example",
  "outcome": "success", "httpStatus": 200, "durationMs": 34
}
```

- **`message`** — a **stable, dot-namespaced event identifier**
  (`^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$`), never a sentence. Renaming one is a
  breaking change for downstream consumers, so it is done deliberately.
- **`component`** — the subsystem. Set once per subsystem via
  `logger.child({ component })`; values in `LOG_COMPONENTS`:
  `bootstrap` · `http` · `event-service` · `dispatcher` · `recovery` · `persistence`.
- **`time`**, **`level`** — added by the logger.
- Everything else is a field from the dictionary below.

## Correlation

`logger.child(fields)` merges `fields` into every subsequent line. The dispatch
path is traced by `eventId` → `subscriptionId` → `deliveryId` → `attempt`:

- `EventService` logs `event.accepted` with `eventId` + `eventType`.
- `Dispatcher` logs `dispatch.started` (per event), then per delivery attempt a
  child logger carries `deliveryId` + `eventId` + `subscriptionId` +
  `targetHost` + `attempt` — so `delivery.succeeded` / `delivery.retry_scheduled`
  / `delivery.failed` / `delivery.abandoned` / `delivery.blocked` are all
  joinable.
- `RecoveryService` logs `recovery.delivery.reclaimed` with the same delivery
  correlation fields.

A per-HTTP-request id is a future addition; today `eventId` is the primary key
across the whole asynchronous flow.

## Field dictionary

Repeated field groups are produced by helpers in
`src/infrastructure/log-fields.ts` (`eventFields`, `subscriptionFields`,
`deliveryFields`, `outcomeFields`) so the same concept always serialises the
same way. New logging code must reuse these names.

| Field | Type | Meaning |
| --- | --- | --- |
| `component` | string | subsystem (see above) |
| `eventId` | string | `evt_…` |
| `eventType` | string | event type / subscription `eventType` |
| `subscriptionId` | string | `sub_…` |
| `deliveryId` | string | `del_…` |
| `deliveryStatus` | string | `pending` \| `delivering` \| `delivered` \| `failed` |
| `attempt` | number | 1-based attempt number |
| `maxAttempts` | number | configured attempt cap |
| `matchedCount` | number | subscriptions matched for an event |
| `failedRecordCount` | number | deliveries whose record could not be persisted |
| `reclaimedCount` / `resumedCount` | number | recovery sweep results |
| `targetHost` | string | webhook target **hostname only** — never the full URL |
| `httpStatus` | number \| null | subscriber HTTP status, or API response status |
| `httpMethod` / `httpPath` | string | inbound request line (no query string) |
| `outcome` | string | `success` \| `retryable` \| `permanent` |
| `durationMs` | number | elapsed wall-clock time for the operation |
| `backoffMs` | number | retry backoff delay |
| `nextAttemptAt` | string | ISO-8601 timestamp of the next scheduled attempt |
| `reason` | string | short snake_case reason code (`retry_budget_exhausted`, `source_event_missing`, …) |
| `detail` | string | one human-readable sentence (config warnings only) |
| `error` | string | error message |
| `errorStack` | string | stack trace — `error` level only, via `errorFields()` |
| `signal` | string | OS signal name |
| `port` | number | listen port |
| `persistence` | string | `memory` \| `dynamodb` |
| `intervalMs`, `stuckDeliveringThresholdMs` | number | recovery timings |

## Event catalogue

| `message` | level | component | when |
| --- | --- | --- | --- |
| `config.loaded` | info | bootstrap | startup — `config` holds the `configSummary` snapshot |
| `config.warning` | warn | bootstrap | a risky configuration combination |
| `persistence.selected` | info | persistence | which store was wired |
| `server.listening` | info | bootstrap | HTTP server bound |
| `server.stopping` | info | bootstrap | SIGINT/SIGTERM received |
| `process.unhandled_rejection` / `process.uncaught_exception` | error | bootstrap | last-resort handlers |
| `http.request` | info | http | every request — method, path, status, duration |
| `http.request_error` | error | http | a handler threw a 5xx (details logged, not returned) |
| `event.accepted` | info | event-service | `POST /events` persisted an event |
| `dispatch.started` | info | dispatcher | matching done for an event |
| `dispatch.failed` | error | dispatcher | the whole async dispatch threw |
| `dispatch.partial_failure` | error | dispatcher | ≥1 delivery record could not be saved |
| `delivery.created` | debug | dispatcher | a delivery record was persisted |
| `delivery.succeeded` | info | dispatcher | 2xx from the subscriber |
| `delivery.retry_scheduled` | warn | dispatcher | retryable failure, backoff scheduled |
| `delivery.retry_error` | error | dispatcher | the scheduled retry itself threw |
| `delivery.failed` | warn | dispatcher | permanent failure or retry budget exhausted |
| `delivery.blocked` | warn | dispatcher | SSRF guard blocked the target at delivery time |
| `delivery.abandoned` | warn | dispatcher | recovery gave up (budget spent / event gone) |
| `recovery.started` | info | recovery | sweeper enabled |
| `recovery.sweep.completed` | info | recovery | a sweep did something (`reclaimedCount` / `resumedCount`) |
| `recovery.sweep.failed` | error | recovery | a sweep threw |
| `recovery.delivery.reclaimed` | debug | recovery | a stuck delivery returned to `pending` |
