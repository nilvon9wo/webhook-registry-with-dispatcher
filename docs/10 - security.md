# Security Review

Focused review against the checklist in `docs/6 - prompts.md` step 16. Each item
is either **mitigated** (implemented and tested) or **documented** (out of scope
for the timebox, with the production mitigation named). Nothing below is claimed
solved that is only documented.

## 1 & 2. SSRF and URL / protocol validation — *mitigated (partial)*

The service makes server-side HTTP requests to consumer-supplied URLs.

- **Protocol / syntax** (`src/domain/target-url.ts`): `targetUrl` must be a
  syntactically valid absolute URL using `https:` (or `http:` only when
  `ALLOW_INSECURE_TARGET_URLS=true`), with no embedded credentials and a host.
- **Address guard** (`src/infrastructure/ssrf-guard.ts`, `SSRF_GUARD_ENABLED`,
  on by default): resolves the target host and rejects **loopback**, **private**
  (RFC 1918 / CGNAT / IPv6 ULA), **link-local**, **unspecified**, and the
  **`169.254.169.254`** cloud-metadata address. IP-literal targets are checked
  without a lookup. Enforced at two points:
  - `POST` / `PUT /subscriptions` → `400` if the target is blocked;
  - every delivery attempt → permanent `failed` if the target is blocked
    (a subscription registered while the host was public but now resolving
    private is stopped).
- **Redirects are not followed** (`redirect: 'manual'` in the webhook client) —
  a redirect to an internal address cannot be used as a bypass; a `3xx` is a
  permanent delivery failure.

**Documented, not solved:** *DNS rebinding.* There is a TOCTOU gap between the
guard's lookup and the lookup `fetch`/`undici` performs. Full protection
requires resolving once and connecting to the pinned IP (a custom `undici`
dispatcher / `lookup` hook). Also unhandled: split-horizon DNS, IPv6 NAT64
(`64:ff9b::/96`) to a metadata address, and non-DNS name services.
**Production:** pin-and-connect, plus an egress allowlist or forward proxy for
webhook traffic.

## 3. AWS credential handling — *mitigated*

`src/infrastructure/dynamodb/dynamodb-client.ts` constructs the SDK client with
only `region` and an optional non-secret `endpoint`. Credentials come solely
from the AWS default provider chain (environment, SSO, shared config,
container/instance role). No credential is read from application config or
appears in source. CloudFormation contains no IAM principal; the least-privilege
DynamoDB policy the runtime needs is documented in the template header.

## 4. Committed secrets — *mitigated*

`.gitignore` excludes `.env`, `.env.*` (except `.env.example`), `*.pem`,
`*.key`, `*.p12`, `*.pfx`, and `.aws/`. Only `.env.example` is tracked and it
contains no secret (`AWS_REGION` only). `git grep` for key/password/private-key
patterns over tracked non-doc files is clean. No credentials — real or
placeholder — appear anywhere in the repository; the DynamoDB tests take
credentials from the AWS SDK provider chain.

## 5. Unbounded request body — *mitigated*

`src/http/server.ts` stops buffering once `MAX_REQUEST_BODY_BYTES` (default
1 MiB) is exceeded and returns `413` with `Connection: close`. Tested.

## 6. Unbounded webhook timeout — *mitigated*

Every outbound request has an `AbortController` timeout of `WEBHOOK_TIMEOUT_MS`
(default 5 s; config rejects a value `< 1`). A timeout is a retryable outcome.
Tested against a slow local server.

## 7. Sensitive data in logs — *mitigated*

Structured logs carry correlation ids (`eventId`, `subscriptionId`,
`deliveryId`, `attempt`), HTTP status, elapsed time, and short error strings.
They do **not** log event payloads (`event.data`), request/response bodies, the
full target URL, or any credential. `configSummary` is asserted by test to
contain no secret-like field. Request logging records `method` + `path` only
(no query string). Residual: a `network-error` message from `fetch` can include
the target hostname — acceptable operational detail, not a secret.

## 8. Injection — *mitigated*

- **DynamoDB**: all queries use `ExpressionAttributeNames` /
  `ExpressionAttributeValues`; no user input is concatenated into an expression.
  No SQL, no ORM.
- **Command injection**: the service never spawns a process.
- **Header / CRLF injection**: response headers are built from
  server-generated ids only; outbound `X-Webhook-*` headers carry a UUID and a
  number.
- **Log injection**: logs are JSON lines (`JSON.stringify` escapes control
  characters); user-controlled `eventType` / `type` are pattern-restricted to
  `[A-Za-z0-9._-]`.
- **Prototype pollution**: validators read named fields only; `event.data` is
  stored as opaque data and never merged into an object or used as a key path.

## 9. Error responses — *mitigated*

A handler that throws an unexpected error returns exactly
`{"error":{"message":"Internal server error"}}` with status `500`; the real
error and its stack go to the log only (`http.request_error`, `error` level).
Asserted by `tests/integration/security.test.ts`. Validation failures return
`400` with a `details` array naming the offending fields — no internal paths or
types. There is in fact no way for a caller to *reach* a `500` through the
public API (every input error is a validated `4xx`), so this is defence in
depth.

**Considered and rejected:** a `DEBUG_ERRORS` / non-production toggle that echoes
the exception (message + stack) in the response body. It adds a config branch
and a well-known deployment footgun (shipping it enabled, or the environment
gate being wrong) for no real gain: a developer running the service locally
already sees the full error with stack in the terminal, next to the request
line, and anyone actually working *on* the service has a debugger. The one
scenario it helps — a third party hitting a shared non-prod instance whose logs
they cannot see — is better solved by granting log access than by leaking stack
traces over HTTP.

## 10. Authentication / authorization — *documented, not implemented*

The spec does not call for authentication and none is built. **All endpoints
are unauthenticated**: any caller can create subscriptions, publish events, and
read every delivery record. There is also no tenant isolation and **outbound
webhooks are not signed**, so a subscriber cannot verify a POST originated from
this service.

**Production:**
- Authenticate callers (API keys / OAuth2 client credentials / mTLS) and scope
  subscriptions, events, and deliveries to the caller.
- Sign each outbound delivery — HMAC-SHA256 over the raw body with a
  per-subscription secret, sent as `X-Webhook-Signature` plus a timestamp to
  bound replay.
- Rate-limit `POST /events` and subscription creation per caller.

## Other production hardening (noted, out of scope)

- Idempotency keys on `POST /events` (currently not supported — documented in
  `docs/9`).
- A dead-letter path and alerting for deliveries that end `failed`.
- Per-subscription concurrency / circuit-breaking so one slow subscriber cannot
  consume all dispatch capacity.
- Response pagination on `GET /subscriptions` and `GET /deliveries`.
