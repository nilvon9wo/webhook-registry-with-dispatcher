# Webhook Registry + Dispatcher

A TypeScript/Node.js service where clients register webhook subscriptions for
specific event types, publish events, and have those events delivered
asynchronously to every matching subscriber — with persistence, bounded retries,
and crash recovery.

## Challenge

The original challenge statement is preserved in
**[docs/0 - SW Engineer task - WebhookRegistryTask.md](docs/0%20-%20SW%20Engineer%20task%20-%20WebhookRegistryTask.md)**.

## Project documentation

The project was specified and designed before implementation so that both human
and AI contributors work from an explicit, reviewable source of truth.

| Document                                                  | Purpose                                                   |
| --------------------------------------------------------- | --------------------------------------------------------- |
| [1 - spec.md](docs/1%20-%20spec.md)                       | Functional and non-functional requirements                |
| [2 - plan.md](docs/2%20-%20plan.md)                       | Implementation plan and development sequence              |
| [3 - steering-rules.md](docs/3%20-%20steering-rules.md)   | Coding, architectural, and AI-development rules           |
| [4 - architecture.md](docs/4%20-%20architecture.md)       | Architecture and major technical decisions                |
| [5 - testing.md](docs/5%20-%20testing.md)                 | Testing strategy and quality gates                        |
| [6 - prompts.md](docs/6%20-%20prompts.md)                 | AI development prompts and workflow                       |
| [7 - troubleshooting.md](docs/7%20-%20troubleshooting.md) | Expected failure diagnosis and recovery guidance          |
| [8 - setup.md](docs/8%20-%20setup.md)                     | Development environment, tooling, accounts, and AWS setup |
| [9 - decisions.md](docs/9%20-%20decisions.md)             | Reconciliation log and every implementation decision      |
| [10 - security.md](docs/10%20-%20security.md)             | Security review: what is mitigated, what is documented    |

## Requirements

- Node.js 24 LTS (`engines` requires `>=24`)
- No AWS account is needed to run or test the service with the default in-memory
  persistence. DynamoDB persistence uses the standard AWS SDK credential chain.

## Install

```bash
npm install
```

## Run

```bash
npm run dev      # watch mode (tsx), loads .env if present
npm run build && npm start   # compiled
```

The server listens on `PORT` (default `3000`). `GET /health` returns `{"status":"ok"}`.

## Configuration

Every operational setting is an environment variable with a safe default — see
[`.env.example`](.env.example). `npm run dev` / `npm start` load `.env` if it is
present. Invalid values are reported together at startup and the process exits.

| Variable                        | Default                          | Purpose                                                            |
| ------------------------------- | -------------------------------- | ------------------------------------------------------------------ |
| `NODE_ENV`                      | `development`                    | Environment name (affects startup warnings only)                   |
| `PORT`                          | `3000`                           | HTTP server port                                                   |
| `LOG_LEVEL`                     | `info`                           | `debug` \| `info` \| `warn` \| `error`                             |
| `PERSISTENCE`                   | `memory`                         | `memory` (in-process) or `dynamodb`                                |
| `AWS_REGION`                    | `eu-central-1`                   | Region for the DynamoDB client                                     |
| `DYNAMODB_ENDPOINT`             | _(unset)_                        | Override endpoint, e.g. `http://localhost:8000` for DynamoDB Local |
| `DYNAMODB_SUBSCRIPTIONS_TABLE`  | `webhook-registry-subscriptions` | Table name                                                         |
| `DYNAMODB_EVENTS_TABLE`         | `webhook-registry-events`        | Table name                                                         |
| `DYNAMODB_DELIVERIES_TABLE`     | `webhook-registry-deliveries`    | Table name                                                         |
| `MAX_REQUEST_BODY_BYTES`        | `1048576`                        | Request body size limit (413 above)                                |
| `WEBHOOK_TIMEOUT_MS`            | `5000`                           | Per-attempt outbound webhook timeout                               |
| `MAX_DELIVERY_ATTEMPTS`         | `5`                              | Total attempts per delivery (initial + retries)                    |
| `RETRY_BASE_DELAY_MS`           | `500`                            | Exponential-backoff base delay                                     |
| `RETRY_MAX_DELAY_MS`            | `30000`                          | Cap on any single backoff delay                                    |
| `RECOVERY_INTERVAL_MS`          | `60000`                          | Recovery sweep interval; `0` disables it                           |
| `STUCK_DELIVERING_THRESHOLD_MS` | `60000`                          | Age after which a `delivering` delivery is treated as abandoned    |
| `RECOVERY_BATCH_LIMIT`          | `100`                            | Max deliveries handled per sweep                                   |
| `ALLOW_INSECURE_TARGET_URLS`    | `false`                          | Allow `http://` webhook targets (needed for local E2E)             |
| `SSRF_GUARD_ENABLED`            | `true`                           | Reject targets on loopback/private/link-local/metadata ranges      |

No secrets are read from configuration. AWS credentials come only from the SDK
provider chain (environment, SSO, shared config, instance/task role).

## Test

```bash
npm test           # unit + integration (in-memory; no AWS, no network egress)
npm run test:e2e   # end-to-end (real local HTTP servers)
npm run test:all   # everything above
npm run check      # format check + lint + typecheck + all tests
```

Opt-in DynamoDB repository tests run the shared repository contract against real
DynamoDB (create their own throwaway tables, tear them down afterwards):

```bash
RUN_DYNAMODB_TESTS=1 DYNAMODB_ENDPOINT=http://localhost:8000 \
  AWS_REGION=eu-central-1 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local \
  npm run test:integration
```

## API

| Method   | Path                  | Notes                                                                   |
| -------- | --------------------- | ----------------------------------------------------------------------- |
| `POST`   | `/subscriptions`      | Create. Body `{ eventType, targetUrl }`. `201`                          |
| `GET`    | `/subscriptions`      | List. Optional `?eventType=`. `200`                                     |
| `GET`    | `/subscriptions/{id}` | `200` / `404`                                                           |
| `PUT`    | `/subscriptions/{id}` | Replace. `200` / `404`                                                  |
| `DELETE` | `/subscriptions/{id}` | `204` / `404`                                                           |
| `POST`   | `/events`             | Body `{ type, data? }`. Persists, then dispatches asynchronously. `202` |
| `GET`    | `/deliveries`         | List. Optional `?eventId= &subscriptionId= &status=`. `200`             |
| `GET`    | `/deliveries/{id}`    | `200` / `404`                                                           |
| `GET`    | `/health`             | `200`                                                                   |

Errors use `{ "error": { "message": string, "details"?: string[] } }`.

Ready-to-run requests are in [`requests.http`](requests.http).

## Infrastructure

[`infrastructure/cloudformation.yaml`](infrastructure/cloudformation.yaml)
describes the DynamoDB tables and indexes. It is not deployed as part of the
challenge. Validate it with `npm run cfn:lint` (needs `cfn-lint`) or
`npm run cfn:validate` (needs AWS credentials).

## Status

Implementation in progress — see [docs/9 - decisions.md](docs/9%20-%20decisions.md)
for what is done and why.
