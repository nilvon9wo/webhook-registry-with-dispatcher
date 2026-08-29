# Final Report

Webhook Registry + Dispatcher — submission report and release check.

- **Source of truth for decisions:** [`9 - decisions.md`](9%20-%20decisions.md)
- **Full AI session:** [`ai-conversation.md`](ai-conversation.md)
- **Architecture review + open issues:** [`12 - architecture-review.md`](12%20-%20architecture-review.md)

---

## Release check

| Check | Result |
| --- | --- |
| Clean TypeScript build | ✅ `rm -rf dist && npm run build` → exit 0 |
| Complete test suite | ✅ `npm run check` → **342 passed, 17 skipped**; with real DynamoDB → **359 passed** |
| Lint / format | ✅ oxlint clean · `prettier --check .` clean · typecheck (src + tests) clean |
| No secrets / credentials | ✅ no keys / ARNs / account IDs / PEM in tracked files (one `secret:` hit is a test fixture asserting such fields are **not** logged) |
| No unnecessary files | ✅ packaged with `git archive HEAD` (tracked files only) — no `.env` / `node_modules` / `.idea` / `dist` / `coverage` |
| CloudFormation valid | ✅ `aws cloudformation validate-template` + `cfn-lint`; live stack `CREATE_COMPLETE`, 3 tables, no test orphans |
| Configuration docs accurate | ✅ `config.test.ts` asserts `.env.example` documents every key `config.ts` reads (and that `config.ts` references none outside `KNOWN_CONFIG_ENV_KEYS`) |
| README accurate | ✅ corrected this pass (test counts; the DynamoDB-Local claim — see [§6](#6-for-the-evaluator)) |
| Package scripts from a clean checkout | ✅ end-to-end smoke from a fresh `dist/`: health, CRUD, publish → deliver, `/openapi.yaml`, `/docs` |
| Docker image | ✅ `docker build` → `docker run` → health / create / publish / `docker stop` (graceful `SIGTERM`, exit 0); ~350 MB, non-root; also verified `-e PERSISTENCE=dynamodb` against real AWS |
| DynamoDB Local | ✅ `npm run test:dynamodb:local` → **17 pass** in a throwaway container, torn down after |
| Spec consistency | ✅ endpoints, status codes, delivery states, headers, retry classification all match `1 - spec.md` |
| Temp / debug code | ✅ no `console.*`, `debugger`, `.only`, `TODO` / `FIXME` in `src/` or `scripts/` |

---

## 1. Implemented requirements

| # | Requirement | Where |
| --- | --- | --- |
| 1 | TypeScript / Node.js | TS 7.0.2, Node 24, ESM, strict `tsconfig` |
| 3a | Subscription CRUD — `POST` / `GET` / `PUT` / `DELETE /subscriptions` (+ `?eventType=`) | `src/http/handlers/subscriptions.ts` |
| 3b | Event publish + read-back — `POST /events`, `GET /events/{id}` (immutable, no update/delete) | `src/http/handlers/events.ts` |
| 4 | Dispatcher — deliver each event to every matching subscription | `src/application/dispatcher.ts` |
| 5 | External persistence | in-memory **and** DynamoDB adapters behind a port; `PERSISTENCE` selects |
| — | Asynchronous delivery — the publish call does not wait for subscribers (`202`) | event persisted, then fire-and-forget dispatch |
| — | Bounded retries, capped exponential backoff with equal jitter, retryable vs permanent classification | `src/domain/retry-policy.ts` |
| — | Crash recovery — a periodic sweep re-drives abandoned / stuck deliveries and honours the attempt cap | `src/application/recovery.ts` |
| — | Input validation with structured `400`s | `src/domain/*` (hand-written, no validation library) |

## 2. Implemented bonus requirements

- **DynamoDB persistence** (bonus on #5) — 3 tables; GSIs matched to the application's access patterns; `ConsistentRead` on every `get`; verified against real AWS.
- **`/deliveries`** (#6) — `GET /deliveries` (`?eventId= &subscriptionId= &status=`, AND-combined) and `GET /deliveries/{id}`; returns the full record (status, attempts, `lastStatusCode`, `lastError`, timestamps).
- **CloudFormation** (#7) — `infrastructure/cloudformation.yaml`; parameterised; least-privilege IAM documented in the header; validated with `cfn-lint` **and** server-side; **actually deployed and exercised**.
- **Production-readiness (#8):**
  - structured JSON logging — stable event catalogue, correlation IDs, field dictionary, no payloads / URLs / secrets in logs (`11 - logging.md`);
  - `LOG_FORMAT` (`auto` / `json` / `pretty`) — a coloured line renderer for a local terminal, JSON everywhere else;
  - SSRF guard — DNS-resolving; blocks loopback / RFC 1918 / CGNAT / link-local / cloud-metadata; enforced at registration **and** at every delivery attempt;
  - full environment-variable configuration with aggregated validation and startup warnings;
  - graceful shutdown (`SIGINT` / `SIGTERM` → stop accepting, cancel retry timers, bounded drain of in-flight work);
  - clean startup-failure handling (`server.listen_failed` + exit 1, not an uncaught exception);
  - **OpenAPI 3.0.3** spec (`openapi.yaml`) + **Swagger UI** at `/docs`;
  - a verified multi-stage **`Dockerfile`** (non-root, `HEALTHCHECK`, `SIGTERM` → graceful shutdown; verified against both in-memory and real DynamoDB); `npm run test:dynamodb:local` (the opt-in DynamoDB tests against DynamoDB Local — **no AWS account**); and `npm run stack:up` (`docker compose up` — the full app + DynamoDB Local stack, tables auto-provisioned);
  - a **manual test plan** (`13 - manual-test-plan.md`) and a bundled **`npm run inbox`** webhook receiver;
  - a **security review** (`10 - security.md`) and a **post-implementation architecture review** (`12 - architecture-review.md`).

## 3. Known limitations

Each is documented in `12 - architecture-review.md` (with effort / risk) and commented at the relevant code site.

- **No authentication / authorization / tenant isolation / webhook signing.** Out of scope per the spec; production mitigations named in `10 - security.md`.
- **Single-instance recovery.** The reentrancy guard is in-process; multiple instances would each sweep. Production: a lease or a durable queue.
- **Crash-during-fan-out window.** Delivery records are written before any HTTP call, so a crash after that is fully recoverable; a crash *during* the (millisecond) materialise pass drops the not-yet-written subscribers. Production: a transactional event + delivery-stub write, or an outbox.
- **In-process dispatch** — no durable queue. Accepted for the timebox; SQS + workers is the documented evolution.
- **Unbounded list endpoints** — `GET /subscriptions` and `GET /deliveries` return the whole result set; no pagination.
- **SSRF guard does not defend against DNS rebinding** — a TOCTOU gap between the guard's lookup and `fetch`'s.
- **No idempotency key on `POST /events`** — a client retry creates a distinct event (delivery-side IDs are stable across retries).
- **Recovery-sweep failures during a persistent outage** log a full stack trace every interval with no backoff — log noise, not a fault. Noted for follow-up.
- **At-least-once** delivery, not exactly-once — stated explicitly, not hidden.

## 4. Important architectural decisions

Full record in `9 - decisions.md`. Highlights:

- **Hexagonal / ports-and-adapters.** `domain` (pure) ← `application` (services + port interfaces) ← `infrastructure` (adapters) ← `http` ← `container.ts` (composition root). The application layer imports no infrastructure.
- **Every hard-to-test dependency is an injected seam** — `Clock`, `Scheduler`, `IdGenerator`, jitter `random`, `Logger`, `WebhookClient`, `TargetUrlGuard`.
- **Delivery is a state machine of pure transition functions** (`pending → delivering → delivered | failed`, plus `scheduleRetry` / `reclaimStuck` / `abandonDelivery`); the record is persisted after each transition, and `delivering` is persisted *before* the HTTP call so a crash mid-attempt is recoverable.
- **Immediate dispatch is the primary path; the recovery sweep is only a safety net.**
- **No HTTP framework, no validation library** — Node's built-in `http` + a small router + hand-written validators. The only runtime dependencies are the two AWS SDK packages.
- **Zero-based configuration** — every operational setting is an env var with a safe default; in-memory persistence is the default so a fresh clone runs with no AWS.
- **List responses are named after the resource** (`{ "subscriptions": [...] }`, `{ "deliveries": [...] }`), not a generic envelope.
- **Publishing is decoupled from subscribing** — an event with no matching subscription is still `202` and persisted, logged distinctly as `dispatch.no_subscribers`.
- **oxlint instead of ESLint** — `typescript-eslint` refuses TypeScript 7.0 (`9 - decisions.md` §2).

## 5. Test results

```
npm run check           → 342 passed, 17 skipped      (283 unit / 53 integration / 6 e2e)
RUN_DYNAMODB_TESTS=1 …   → 359 passed, 0 skipped       (+17 DynamoDB contract tests, real AWS)
```

- Test pyramid per `5 - testing.md`; every test follows an explicit `// Arrange` / `// Act` (one statement) / `// Assert` structure.
- The 17 skipped are the opt-in DynamoDB repository contract tests (they need a DynamoDB endpoint; CI has none). They run the same shared contract as the in-memory adapter, create uuid-prefixed throwaway tables, and delete them in `afterAll` whether they pass or fail — verified: no orphan tables.
- Also verified by a full **manual test pass** (`13 - manual-test-plan.md`) against real DynamoDB — every golden-path, validation, retry, and crash-recovery scenario, plus a CloudFormation delete-and-redeploy from zero.

## 6. For the evaluator

1. **Run it:** `npm install && npm test` (no AWS needed — in-memory). Then `npm run dev` and open `http://localhost:3000/docs` for a live API console, or use `requests.http`. `npm run inbox` is a local webhook receiver for watching deliveries. Persistence has three backends — in-memory (default), DynamoDB Local via `docker compose up`, or real AWS DynamoDB; `docs/13` §2.1.1 walks through each.
2. **[`ai-conversation.md`](ai-conversation.md)** is the full AI session (requirement #2), generated by `scripts/export-conversation.ts` (`npm run export:conversation`). Because the transcript only stops growing when the session ends, the copy in the ZIP omits the final few messages around packaging itself.
3. **Packaging** was done with `git archive` (tracked files only). `.env` (real configuration) is intentionally not tracked — only `.env.example`.
4. **Docs numbering:** `docs/` is flat and numbered in the order the files were written; the README groups them into a reading order. `2 - plan.md` is the *original* plan — `9 - decisions.md` is the as-built record and the reconciliation log.
5. **The deployed CloudFormation stack was redeployed during testing.** The originally-deployed stack still carried the pre-implementation key schema, which broke the app against real DynamoDB; found via the manual pass, fixed by `delete-stack` + redeploy from the corrected template, then verified end-to-end (`9 - decisions.md` item 11).
6. **DynamoDB was verified two ways** — against real AWS (`RUN_DYNAMODB_TESTS=1 AWS_PROFILE=… npm run test:all` → 359 pass; the app and the container both), and against **DynamoDB Local** (`npm run test:dynamodb:local` → the 17 contract tests in a throwaway container). Docker is used for the app image and that local test fixture; it is **optional** — the service runs directly on Node.js and 342 tests need nothing but `npm install`.
7. **AWS SSO tokens last ~1 h.** If you point the app at DynamoDB and see `recovery.sweep.failed` / `Token is expired`, run `aws sso login --profile webhook-challenge` — the running server self-heals on its next sweep.
