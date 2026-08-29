# Logging Conventions

## Decision

All logging is **structured**: one JSON object per line, emitted to stdout
(`debug`/`info`) or stderr (`warn`/`error`) by `src/infrastructure/logger.ts`.
There is no free-form log text. Every line can be parsed, filtered, grouped, and
alerted on by field, without regexes over prose.

The logger is deliberately tiny (no `pino`/`winston`) — the value is in the
*conventions* below, not the transport. Whether stdout-only is
"production-ready", and what it would cost to go further, is covered in
[Getting logs off the box](#getting-logs-off-the-box-production).

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

## Rendering (`LOG_FORMAT`)

The JSON line above is the **contract** — it is what any log processor parses.
For a human watching a local terminal it is also hard to scan: monochrome, and
led by a timestamp that is rarely what you are looking for.

`LOG_FORMAT` selects the rendering:

| Value | Result |
| --- | --- |
| `auto` *(default)* | `pretty` when stdout is a TTY, `json` otherwise — so `npm run dev` in a terminal is readable, and the same binary piped to a file or a log collector emits JSON. |
| `json` | Always the JSON line. Use in production / when shipping logs. |
| `pretty` | Always the coloured line. |

The pretty line reorders the same data for reading:

```
INFO   delivery.succeeded  deliveryId=del_1 attempt=1 httpStatus=200  dispatcher 07:19:45.922
WARN   delivery.retry_scheduled  deliveryId=del_2 attempt=2 backoffMs=2000  dispatcher 07:19:46.101
ERROR  recovery.sweep.failed  error="connect ECONNREFUSED"  recovery 07:19:47.550
```

- Level first, **colour-coded** (`DEBUG` dim, `INFO` cyan, `WARN` yellow,
  `ERROR` red), uppercased and padded so columns line up.
- Then the `message`, then the fields as `key=value`.
- `component` and a **time-of-day** stamp (no date) are pushed to the end, dimmed.
- Colour: on for an explicit `LOG_FORMAT=pretty` (so it still works when the TTY
  check is unreliable — e.g. stdout behind `tsx watch`), and for `auto` when
  stdout is a TTY. `NO_COLOR` disables it in all cases; `FORCE_COLOR` forces it.

`pretty` is a convenience of the **built-in sink only**. Supplying a custom
`write` to `createLogger` (tests, or a future transport) always receives the
JSON line, so structured consumers are unaffected by this setting.

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
| `dispatch.no_subscribers` | warn | dispatcher | an event matched **zero** subscriptions — accepted and persisted, but delivered nowhere (often a mis-typed event type; alert on this) |
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

## Getting logs off the box (production)

The spec (§15) asks the implementation to *demonstrate awareness* of
observability, not to ship a log-aggregation pipeline. This section is that
awareness written down: why stdout-only is a legitimate production choice, where
it stops being enough, and what each step further would cost in time, money, and
latency.

### Why stdout-only is a design, not a shortcut

This follows the [twelve-factor](https://12factor.net/logs) rule: **the process
writes its event stream, unbuffered, to stdout/stderr and knows nothing about
routing or storage.** The runtime platform captures the stream and a collector
ships it onward. Because our lines are already structured JSON, the collector
and backend parse fields directly — no grok patterns, no regex-over-prose.

| Platform | Captures stdout via | Lands in |
| --- | --- | --- |
| Kubernetes | kubelet → node log files | `kubectl logs`; Fluent Bit / Vector / Datadog Agent → Loki / Elastic / Datadog / Splunk |
| AWS ECS / Fargate | `awslogs` or `awsfirelens` log driver | CloudWatch Logs, or Firelens → third party |
| AWS Lambda | runtime | CloudWatch Logs (automatic) |
| Google Cloud Run / Azure Container Apps | runtime | Cloud Logging / Log Analytics (automatic) |
| Plain VM + systemd | journald | `journalctl`; optional agent → backend |
| Local `docker run` | json-file / journald driver | `docker logs` |

In all of these the application code is identical: write JSON to fd 1/2.
Swapping backend (Datadog → Elastic, say) is a collector config change, not a
redeploy.

### Where stdout-only stops being enough

- **A bare `node dist/index.js &` with stdout not redirected** — the stream goes
  to a detached terminal and is lost. stdout logging assumes *something* is
  capturing fd 1/2. True on every platform above; not true if you background the
  process by hand.
- **No local buffering across a collector outage.** If the shipping agent is
  down, container runtimes keep a bounded on-disk buffer (kubelet rotates at
  ~10 MiB/file by default); beyond that, lines are dropped. A durable guarantee
  needs an agent with a persistent queue (Vector's disk buffer, Fluent Bit
  `storage.type filesystem`).
- **`process.stdout.write` is synchronous** when fd 1 is a file or pipe (the
  usual container case). Under a very high log rate this blocks the event loop.
  Not a concern at this service's scale (a few lines per delivery); it is the
  reason high-volume services use `pino`.
- **No redaction / sampling layer.** We avoid the problem by construction — the
  field dictionary never carries a payload, a full URL, or a credential — but
  there is no second safety net if a future field is added carelessly.

### The extension point

`createLogger` (`src/infrastructure/logger.ts`) takes an optional
`write(line, level)` sink. Everything below is implemented by supplying a
different `write`, or by replacing the ~30-line factory with an adapter over a
library while keeping the `Logger` port and every convention in this document
unchanged. No call site changes.

### Options considered

| Option | What it adds | Est. effort | New deps | Cost impact | Performance impact |
| --- | --- | --- | --- | --- | --- |
| **A. stdout + document the pipeline** *(chosen)* | This section; a README pointer. The deployment platform captures fd 1/2 (table above). | ~30 min, no code | none | none | none |
| **B. Config-driven extra sink (file / syslog)** | `LOG_DESTINATION` (`stdout` \| `file` \| `both`) + `LOG_FILE_PATH`; a fan-out `write`; config validation; tests. | ~1–1.5 hr | none | none (writes to local disk; log **rotation** then becomes an ops task — `logrotate` or the platform) | negligible; a second synchronous write per line |
| **C. Swap internals for `pino`** | Replace the factory body with `pino`; thin adapter for argument order (`info(msg, fields)` → pino `info(fields, msg)`); keep the port, message catalogue, field dictionary, `child()`. Gain `redact`, and `pino.transport` targets: `pino/file`, `pino-opentelemetry-transport`, `pino-datadog-transport`, `pino-elasticsearch`, `pino-socket`, `pino-pretty` (dev). | ~1.5–3 hr incl. updating the ~3 tests that assert on the `write` seam and `docs/11` | `pino` (one dependency; the de-facto Node standard, actively maintained, no native addons) | none at runtime | **faster** than today: pino serialises in a fast path and, with a transport, moves I/O to a worker thread (`sonic-boom`), so the event loop no longer blocks on writes |
| **D. pino + a shipping pipeline in-repo** | C, plus `pino-opentelemetry-transport` (or a vendor transport) and a docker-compose with an OpenTelemetry Collector / Vector, wired end-to-end with a demo. | ~1 day | pino + OTel exporter packages | the collector runs somewhere: a sidecar (negligible compute) **or** managed ingest priced **per GB ingested + retention** — CloudWatch Logs ≈ $0.50/GB in + $0.03/GB·month; Datadog ≈ $0.10/GB in + retention tier; Azure Monitor ≈ $0.10–0.30/GB after a free grant. Fractions of a cent at challenge traffic; a real budget line at production webhook volume, which is why sampling and payload-free logs matter. | collector adds < 1 ms per line locally; backend ingestion is out-of-process and asynchronous |

### Recommendation

Ship **A**. It satisfies "demonstrate awareness of observability": the logs are
structured, correlated, and captured for free by any modern runtime.

If a stronger observability bonus is wanted and ~2–3 hours are available, do
**C** — it is the idiomatic Node equivalent of a Serilog setup with a
compact-JSON console sink plus transports, it keeps every convention in this
document, it is a net performance gain, and it costs one ubiquitous dependency.

Skip **B** (a file sink is *less* twelve-factor than stdout, and it drags in log
rotation). Skip **D** — building a log pipeline is beyond what the spec asks and
its real cost is per-GB backend ingestion, a decision that belongs with the team
that owns the production account.
