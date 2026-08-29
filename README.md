# Webhook Registry + Dispatcher

A TypeScript / Node.js service where clients register webhook subscriptions for
specific event types, publish events, and have those events delivered
asynchronously to every matching subscriber — with external persistence, bounded
retries, and a recovery sweep for work abandoned by a crash.

## What it does

```
POST /subscriptions   { eventType, targetUrl }        register interest
POST /events          { type, data }                  publish an event
        │
        ├─ validate → persist the event → return 202 Accepted
        │
        └─ (async) for each subscription whose eventType == event.type:
               create a Delivery record (pending)
               POST the event JSON to targetUrl, with a timeout
               2xx → delivered
               retryable failure → back off and retry (bounded)
               permanent failure / attempts exhausted → failed
```

Delivery state is queryable at `GET /deliveries`.

## Documentation

Everything below has a fuller treatment in `docs/`. This project was specified
and designed before implementation, so the docs are the source of truth. The
files are numbered in the order they were written; the groups below are the
better reading order.

**Start here**

| Document                                                                        | Purpose                                    |
| ------------------------------------------------------------------------------- | ------------------------------------------ |
| [0 - challenge](docs/0%20-%20SW%20Engineer%20task%20-%20WebhookRegistryTask.md) | The original challenge statement           |
| [1 - spec.md](docs/1%20-%20spec.md)                                             | Functional and non-functional requirements |

**Design (pre-implementation)**

| Document                                                | Purpose                                           |
| ------------------------------------------------------- | ------------------------------------------------- |
| [4 - architecture.md](docs/4%20-%20architecture.md)     | Architecture and the major technical decisions    |
| [3 - steering-rules.md](docs/3%20-%20steering-rules.md) | Coding, architecture, and AI-development rules    |
| [5 - testing.md](docs/5%20-%20testing.md)               | Testing strategy, the Arrange/Act/Assert standard |
| [8 - setup.md](docs/8%20-%20setup.md)                   | Dev environment, tooling, AWS setup               |

**AI development process**

| Document                                  | Purpose                                                 |
| ----------------------------------------- | ------------------------------------------------------- |
| [2 - plan.md](docs/2%20-%20plan.md)       | Original implementation plan (superseded by 9 as built) |
| [6 - prompts.md](docs/6%20-%20prompts.md) | The AI development prompts / workflow                   |

**Implementation record**

| Document                                                            | Purpose                                                   |
| ------------------------------------------------------------------- | --------------------------------------------------------- |
| [9 - decisions.md](docs/9%20-%20decisions.md)                       | Reconciliation log + every implementation decision        |
| [12 - architecture-review.md](docs/12%20-%20architecture-review.md) | Post-implementation review + resolution log + open issues |

**Reference**

| Document                                                      | Purpose                                           |
| ------------------------------------------------------------- | ------------------------------------------------- |
| [10 - security.md](docs/10%20-%20security.md)                 | Security review — what is mitigated vs documented |
| [11 - logging.md](docs/11%20-%20logging.md)                   | Structured-logging conventions + field dictionary |
| [13 - manual-test-plan.md](docs/13%20-%20manual-test-plan.md) | Hands-on test script — golden paths and failures  |
| [7 - troubleshooting.md](docs/7%20-%20troubleshooting.md)     | Expected-failure diagnosis guidance               |

The API also has an OpenAPI spec ([`openapi.yaml`](openapi.yaml)) served with a
live Swagger UI at `/docs` when the server is running.

## Requirements

- **Node.js 24 LTS** (`package.json` `engines` requires `>=24`).
- **No AWS account** is needed to build, run, or test with the default in-memory
  persistence. DynamoDB persistence uses the standard AWS SDK credential chain.
- Optional: `cfn-lint` (Python) to validate the CloudFormation template;
  Docker + `amazon/dynamodb-local` to run the opt-in DynamoDB tests.

## Install

```bash
npm install
```

## Run

```bash
npm run dev                    # watch mode (tsx); loads .env if present
npm run build && npm start     # compiled
```

The server listens on `PORT` (default `3000`). `GET /health` → `{"status":"ok"}`.
On startup it logs a non-secret configuration summary and a warning line for each
risky setting (in-memory persistence in production, SSRF guard off, etc.).

Graceful shutdown on `SIGINT` / `SIGTERM`: stop accepting connections, cancel
pending retry timers, wait (bounded) for in-flight deliveries, exit.

## Configuration

Every operational setting is an environment variable with a safe default — see
[`.env.example`](.env.example). `npm run dev` / `npm start` load `.env` if
present. Invalid values are reported **together** at startup and the process
exits non-zero.

| Variable                        | Default                          | Purpose                                                                    |
| ------------------------------- | -------------------------------- | -------------------------------------------------------------------------- |
| `NODE_ENV`                      | `development`                    | Environment name (affects startup warnings only)                           |
| `PORT`                          | `3000`                           | HTTP server port                                                           |
| `LOG_LEVEL`                     | `info`                           | `debug` \| `info` \| `warn` \| `error`                                     |
| `PERSISTENCE`                   | `memory`                         | `memory` (in-process) or `dynamodb`                                        |
| `AWS_REGION`                    | `eu-central-1`                   | Region for the DynamoDB client                                             |
| `DYNAMODB_ENDPOINT`             | _(unset)_                        | Override endpoint, e.g. `http://localhost:8000` for DynamoDB Local         |
| `DYNAMODB_SUBSCRIPTIONS_TABLE`  | `webhook-registry-subscriptions` | Table name                                                                 |
| `DYNAMODB_EVENTS_TABLE`         | `webhook-registry-events`        | Table name                                                                 |
| `DYNAMODB_DELIVERIES_TABLE`     | `webhook-registry-deliveries`    | Table name                                                                 |
| `MAX_REQUEST_BODY_BYTES`        | `1048576`                        | Request body size limit (`413` above it)                                   |
| `WEBHOOK_TIMEOUT_MS`            | `5000`                           | Per-attempt outbound webhook timeout                                       |
| `MAX_DELIVERY_ATTEMPTS`         | `5`                              | Total attempts per delivery (initial + retries)                            |
| `RETRY_BASE_DELAY_MS`           | `500`                            | Exponential-backoff base delay                                             |
| `RETRY_MAX_DELAY_MS`            | `30000`                          | Cap on any single backoff delay                                            |
| `RECOVERY_INTERVAL_MS`          | `60000`                          | Recovery sweep interval; `0` disables it                                   |
| `STUCK_DELIVERING_THRESHOLD_MS` | `60000`                          | Age after which a `delivering` delivery is treated as abandoned            |
| `RECOVERY_BATCH_LIMIT`          | `100`                            | Max deliveries handled per sweep                                           |
| `ALLOW_INSECURE_TARGET_URLS`    | `false`                          | Allow `http://` webhook targets (needed for local E2E)                     |
| `SSRF_GUARD_ENABLED`            | `true`                           | Reject targets resolving to loopback/private/link-local/metadata addresses |

**No secrets are read from configuration.** AWS credentials come only from the
SDK provider chain (environment, SSO, shared config, instance/task role).

## API

| Method   | Path                  | Body                       | Success            | Notes                                                |
| -------- | --------------------- | -------------------------- | ------------------ | ---------------------------------------------------- |
| `POST`   | `/subscriptions`      | `{ eventType, targetUrl }` | `201` + `Location` | Server assigns `id` + timestamps                     |
| `GET`    | `/subscriptions`      | —                          | `200 { items }`    | Optional `?eventType=`                               |
| `GET`    | `/subscriptions/{id}` | —                          | `200` / `404`      |                                                      |
| `PUT`    | `/subscriptions/{id}` | `{ eventType, targetUrl }` | `200` / `404`      | Full replace; no upsert                              |
| `DELETE` | `/subscriptions/{id}` | —                          | `204` / `404`      | Stops future deliveries; keeps delivery history      |
| `POST`   | `/events`             | `{ type, data? }`          | `202`              | Persists, then dispatches asynchronously             |
| `GET`    | `/deliveries`         | —                          | `200 { items }`    | Optional `?eventId= &subscriptionId= &status=` (AND) |
| `GET`    | `/deliveries/{id}`    | —                          | `200` / `404`      |                                                      |
| `GET`    | `/health`             | —                          | `200`              | Liveness only; does not probe the datastore          |

- `eventType` / `type`: dot/underscore/hyphen-separated alphanumeric segments
  (e.g. `order.created`), ≤ 100 chars.
- `targetUrl`: absolute `https://` URL (or `http://` when
  `ALLOW_INSECURE_TARGET_URLS=true`), no embedded credentials.
- `data`: optional JSON object, defaults to `{}`.
- Errors: `{ "error": { "message": string, "details"?: string[] } }`. Internal
  faults return a generic `500` (the detail is logged, not returned).

Ready-to-run requests: [`requests.http`](requests.http) (JetBrains HTTP Client /
VS Code REST Client).

## How webhook delivery works

**Matching** is an exact, case-sensitive comparison of the event's `type`
against each subscription's `eventType`. No wildcards.

**Outbound request** — one HTTP `POST` per matching subscription:

```
POST <targetUrl>
Content-Type: application/json
X-Webhook-Event-Id: evt_…
X-Webhook-Delivery-Id: del_…
X-Webhook-Attempt: 1

{ "id": "evt_…", "type": "order.created", "timestamp": "2026-…Z", "data": { … } }
```

- A `2xx` response is a **successful delivery**.
- Redirects are **not followed** (a user-supplied target could redirect to an
  internal address); a `3xx` is a permanent failure.
- Each request has an explicit `WEBHOOK_TIMEOUT_MS` timeout.
- **One subscriber failing never affects another** — deliveries run
  concurrently and independently.

**Retry classification** (`MAX_DELIVERY_ATTEMPTS` total attempts):

| Outcome                            | Retried?       |
| ---------------------------------- | -------------- |
| network error / connection refused | yes            |
| timeout                            | yes            |
| `5xx`, `408`, `425`, `429`         | yes            |
| other `4xx`, `3xx`                 | no (permanent) |

Backoff is **capped exponential with equal jitter** (`RETRY_BASE_DELAY_MS` ×
2ⁿ, capped at `RETRY_MAX_DELAY_MS`; half the window fixed, half random — a
struggling subscriber never gets a near-instant retry). Between attempts the
delivery is persisted as `pending` with a `nextAttemptAt`. When attempts are
exhausted the delivery is `failed` and the final error is retained.

**Delivery semantics are at-least-once.** Event IDs and delivery IDs are stable
across retries and recovery, so subscribers can deduplicate. The service does
**not** claim exactly-once.

## Recovery

A periodic sweep (`RECOVERY_INTERVAL_MS`, `0` disables it) — **not** the primary
dispatch path — finds work abandoned by a crash, restart, or transient outage:

- deliveries stuck in `delivering` past `STUCK_DELIVERING_THRESHOLD_MS` → back
  to `pending`;
- `pending` deliveries whose `nextAttemptAt` is due (their in-process backoff
  timer was lost when the process stopped) → re-driven.

Re-driving enforces the attempt cap and **abandons** (`failed`) a delivery whose
budget is spent or whose source event is gone, so recovery can never retry
forever. Each sweep is bounded by `RECOVERY_BATCH_LIMIT` and is reentrancy-guarded.

## Persistence

Three concepts, each behind a repository interface in `src/application/ports.ts`:

| Concept          | Why persisted                                                |
| ---------------- | ------------------------------------------------------------ |
| **Subscription** | the registration itself                                      |
| **Event**        | durable identity, audit trail, a stable source for retries   |
| **Delivery**     | one event→subscription attempt record, with status + history |

- **`PERSISTENCE=memory`** (default) — an in-process `Map`-backed store. No AWS,
  no network. Data is lost on restart.
- **`PERSISTENCE=dynamodb`** — AWS DynamoDB via `@aws-sdk/lib-dynamodb`.

### DynamoDB design

Three on-demand tables. Table names come from the `DYNAMODB_*_TABLE` env vars
(defaults match the CloudFormation `ResourcePrefix` default).

| Table         | Key     | GSIs                                                                                |
| ------------- | ------- | ----------------------------------------------------------------------------------- |
| Subscriptions | PK `id` | `eventType-index` (`eventType`, `id`)                                               |
| Events        | PK `id` | —                                                                                   |
| Deliveries    | PK `id` | `eventId-index`, `subscriptionId-index`, `status-index` — all sorted on `createdAt` |

`status-index` sorts on `createdAt`, **not** `nextAttemptAt`: a `delivering` or
terminal delivery has `nextAttemptAt = null`, and DynamoDB omits an item from a
GSI when its sort-key attribute is absent — which would hide the stuck records
recovery must find. Single-item `get`s use `ConsistentRead: true`; GSI queries
are eventually consistent by design (see limitations). Full rationale and every
access-pattern mapping: [docs/4](docs/4%20-%20architecture.md) §DynamoDB.

## Infrastructure (CloudFormation)

[`infrastructure/cloudformation.yaml`](infrastructure/cloudformation.yaml)
declares the three DynamoDB tables and their GSIs — nothing else (no compute,
queue, or IAM role; the deploy platform owns the app's identity, and the header
comment documents the least-privilege DynamoDB policy it needs).

**It is not deployed as part of the challenge.** Validate / deploy:

```bash
npm run cfn:lint        # cfn-lint (offline)
npm run cfn:validate    # aws cloudformation validate-template (needs credentials)

aws cloudformation deploy \
  --template-file infrastructure/cloudformation.yaml \
  --stack-name webhook-registry \
  --parameter-overrides ResourcePrefix=webhook-registry
```

Parameters: `ResourcePrefix` (table-name prefix, default `webhook-registry`),
`EnablePointInTimeRecovery` (default `true`). Stack outputs give the table names
and ARNs. Tables use the default `DeletionPolicy: Delete` for easy teardown of a
challenge stack — a production stack should set `Retain`.

## Tests

```bash
npm test           # unit + integration (in-memory; no AWS, no network egress)
npm run test:e2e   # end-to-end (real local HTTP servers)
npm run test:all   # unit + integration + e2e
npm run check      # format check + lint + typecheck + all tests
```

252 unit / 49 integration (+ 17 opt-in DynamoDB) / 6 E2E, following an explicit
Arrange/Act/Assert standard ([docs/5](docs/5%20-%20testing.md)).

**DynamoDB repository tests are opt-in** (`npm test` skips them). They create
their own uuid-prefixed tables, run the shared repository contract, and delete
the tables afterwards.

```bash
# DynamoDB Local (docker run -p 8000:8000 amazon/dynamodb-local):
RUN_DYNAMODB_TESTS=1 DYNAMODB_ENDPOINT=http://localhost:8000 \
  AWS_REGION=eu-central-1 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
  npm run test:integration

# Real AWS (needs create/delete-table permission):
RUN_DYNAMODB_TESTS=1 AWS_PROFILE=<profile> npm run test:all              # bash
$env:RUN_DYNAMODB_TESTS=1; $env:AWS_PROFILE='<profile>'; npm run test:all  # PowerShell
```

## Architecture at a glance

```
HTTP (node:http, tiny router)      src/http/
      │
Application (use cases, ports)     src/application/    ← depends only on ports + domain
      │
Domain (pure types + rules)        src/domain/         ← no dependencies
      │
Infrastructure (adapters)          src/infrastructure/ ← in-memory & DynamoDB repos,
                                                         fetch webhook client, DNS SSRF
                                                         guard, JSON logger
Composition root                   src/container.ts
```

`Clock`, `Scheduler`, `IdGenerator`, and a jitter source are injectable seams so
retry timing and identifiers are deterministic in tests.

## Deliberate tradeoffs

| Choice                                         | Instead of                     | Why                                                                                                                               |
| ---------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| In-process async dispatcher                    | SQS + worker fleet             | The spec calls a simple in-process dispatcher acceptable for the timebox; a durable queue is the documented production evolution. |
| Immediate dispatch on `POST /events`           | cron-driven dispatch           | Cron as the _primary_ path adds latency and reinvents a poor queue. Cron is used only for recovery.                               |
| At-least-once delivery                         | attempting exactly-once        | Exactly-once is not achievable across crash + retry windows without subscriber cooperation.                                       |
| Three DynamoDB tables                          | single-table design            | Easier to implement correctly, test, and explain at this scale.                                                                   |
| Built-in `node:http` + hand-written validation | Express + zod                  | Dependency discipline; the routing/validation here is small.                                                                      |
| `oxlint`                                       | `eslint` + `typescript-eslint` | `typescript-eslint` does not support the pinned TypeScript 7 (see [docs/9](docs/9%20-%20decisions.md)).                           |
| In-memory persistence as the default           | DynamoDB always                | Build, run, and test with zero AWS setup.                                                                                         |

## Known limitations & production follow-ups

Full detail, with effort/risk estimates, in
[docs/12 - architecture-review.md](docs/12%20-%20architecture-review.md).

- **No authentication / authorization.** All endpoints are open; no tenant
  isolation. Production: API keys / OAuth2 / mTLS, scoped resources.
- **Outbound webhooks are not signed.** A subscriber cannot verify a POST came
  from this service. Production: per-subscription HMAC-SHA256 signature header.
- **No idempotency key on `POST /events`.** A client retry of `POST /events`
  creates a distinct event. Event IDs are still stable across _delivery_ retries.
- **SSRF guard does not defend against DNS rebinding.** There is a TOCTOU gap
  between the guard's lookup and `fetch`'s. Production: pin the resolved IP, or
  an egress allowlist / proxy. See [docs/10](docs/10%20-%20security.md).
- **List endpoints are unbounded** — no `?limit=` or pagination cursor
  (`GET /deliveries`, `GET /subscriptions`). Fine at this scale.
- **Crash-during-fan-out window.** Delivery records are persisted before any
  HTTP call, so a crash after that is fully recoverable; a crash _during_ the
  (millisecond) materialise pass drops the not-yet-written subscribers.
  Production: transactional event + delivery-stub write, or an outbox.
- **Recovery is single-instance.** The reentrancy guard is in-process; multiple
  instances would each sweep. Production: a durable queue or a lease.

## Status

Implementation complete against the spec and the bonuses (DynamoDB persistence,
`/deliveries`, CloudFormation, recovery, structured logging). Remaining items are
the production follow-ups above. See [docs/9](docs/9%20-%20decisions.md) for the
per-step record.
