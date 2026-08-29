# Manual Test Plan

A script for a human tester. It covers every use in the original challenge —
the golden paths **and** the expected critical failures — plus the retry and
recovery behaviour. Follow it top to bottom; record the result of each scenario
in the [results log](#results-log). If anything behaves unexpectedly, note it
and raise it — we will fix it or document it before packaging.

The automated suite (`npm run check`) already covers all of this; this plan is
for hands-on confidence and for demonstrating the system.

---

## 1. Prerequisites

- Node.js 24 LTS (`node --version` → `v24.x`)
- `npm install` has been run
- **Two or three terminals running Git Bash** (on Windows), plus a browser. The
  scenarios use `curl`, heredocs, and `VAR=value cmd` prefixes — Bash syntax.
  `npm run …` works in any shell, but the `curl` scenarios do **not** run in
  PowerShell as written. PowerShell users: either drive the API from the Swagger
  UI / [`requests.http`](../requests.http) instead of `curl`, or call `curl.exe`
  explicitly and set env vars on their own line (`$env:VAR='value'`) rather than
  inline.
- **Internet is needed only for:**
  - the **Swagger UI page** at `/docs` — the app serves the page, but it pulls
    the Swagger UI script/stylesheet from a CDN. The spec itself
    (`GET /openapi.yaml`) and `requests.http` work fully offline.
  - **webhook.site**, *if* you use it as the external subscriber (§2.5). The
    bundled `npm run inbox` needs no internet.

## 2. Set up the test environment

### 2.1 Configuration for the session

Create a `.env` file in the repo root (it is git-ignored):

```dotenv
LOG_LEVEL=debug

# Deliver to the local inbox, which is a loopback address:
SSRF_GUARD_ENABLED=false
ALLOW_INSECURE_TARGET_URLS=true

# Make retries and recovery observable in a reasonable time:
MAX_DELIVERY_ATTEMPTS=4
RETRY_BASE_DELAY_MS=1000
RETRY_MAX_DELAY_MS=8000
RECOVERY_INTERVAL_MS=5000
STUCK_DELIVERING_THRESHOLD_MS=10000
```

A few scenarios (SSRF) need the guard **on** — they say so and give an inline
override.

### 2.2 Terminal 1 (Git Bash) — the webhook inbox (the "subscriber")

```bash
npm run inbox
```

Listens on `http://localhost:4000`. Open that URL in a browser — it shows every
incoming webhook live (method, path, `X-Webhook-*` headers, JSON body, and the
status it responded with). It stays empty until you publish an event.

Make the subscriber misbehave by adding query params to the target URL:

| Target URL | Behaviour |
| --- | --- |
| `http://localhost:4000/orders` | always responds `200` |
| `http://localhost:4000/orders?status=500` | always responds `500` |
| `http://localhost:4000/orders?status=500,500,200` | `500`, `500`, then `200` (per path+query) |
| `http://localhost:4000/orders?delay=8000` | waits 8 s, then `200` |

### 2.3 Terminal 2 (Git Bash) — the service

```bash
npm run dev
```

Watch this terminal. With `LOG_FORMAT=pretty` (set in the `.env` above) each
entry is one coloured line — `LEVEL  message  key=value …  component time` —
with **`WARN` in yellow and `ERROR` in red** so they stand out. Key events:
`event.accepted`, `dispatch.started`, `delivery.succeeded`,
`delivery.retry_scheduled`, `delivery.failed`, `recovery.sweep.completed`.
(Drop `LOG_FORMAT`, or set it to `json`, to see the raw structured line that a
log processor would consume.)

At startup it prints `config.loaded` and a `config.warning` line for each risky
setting — you should see **yellow** warnings for the SSRF guard being off and
insecure URLs being allowed. That is expected for this session.

### 2.4 Browser — Swagger UI

Open **`http://localhost:3000/docs`**. This is a live API console: expand an
endpoint, "Try it out", edit the body, "Execute". Use it, or `curl` (Git Bash),
or [`requests.http`](../requests.http) in your IDE — whichever you prefer. The
scenarios below give `curl`. The page needs internet (it loads Swagger UI from a
CDN); the raw spec at `http://localhost:3000/openapi.yaml` does not.

### 2.5 Alternative subscriber (guard on)

To test with `SSRF_GUARD_ENABLED=true`, the local inbox (loopback) is blocked.
Use [webhook.site](https://webhook.site) instead: open it, copy your unique
`https://webhook.site/<uuid>` URL, and use that as `targetUrl`. Its page shows
received requests. (It cannot simulate `500`/timeout the way the local inbox can,
so keep the retry scenarios on the local inbox with the guard off.)

---

## 3. Golden path

### Conventions for this section

`$SUB1`, `$SUB2`, `$EVT1`, `$DEL1` are **shell variables you set yourself** from
the previous response — they are not literal strings the server knows. Each
"create" step below shows a command that captures the new id into a variable;
later steps reuse it. If you prefer, read the id off the response and set it by
hand, e.g. `SUB1=sub_093505e2-…`.

Paste this helper once (Git Bash) so the capture commands work without `jq`.
It reads the first `"<key>":"<value>"` pair from stdin:

```bash
jval() { grep -o "\"$1\":\"[^\"]*\"" | head -1 | cut -d'"' -f4; }
```

(If you have `jq`, `... | jq -r .id` is equivalent and more robust.)

If you skip the helper and a command prints `subscription not found: $SUB1` or
similar, it means the variable is unset — go back and set it.

### G1 — health check

```bash
curl -i localhost:3000/health
```

**Expect:** `200`, body `{"status":"ok"}`.

### G2 — create a subscription

```bash
RESP=$(curl -s -X POST localhost:3000/subscriptions \
  -H 'content-type: application/json' \
  -d '{"eventType":"order.created","targetUrl":"http://localhost:4000/orders"}')
echo "$RESP"
SUB1=$(echo "$RESP" | jval id); echo "SUB1=$SUB1"
```

**Expect:** the printed body has `id` (starts `sub_`), `eventType`, `targetUrl`,
equal `createdAt` / `updatedAt`; the last line reads `SUB1=sub_…`. (Run the
`curl` on its own with `-i` if you also want to see the `201` status and the
`Location: /subscriptions/sub_…` header.)

### G3 — read it back

```bash
curl -s localhost:3000/subscriptions/$SUB1
curl -s localhost:3000/subscriptions
curl -s 'localhost:3000/subscriptions?eventType=order.created'
curl -s 'localhost:3000/subscriptions?eventType=nope'
```

**Expect:** the single GET returns the `$SUB1` object; the plain list returns
`{"items":[…]}` containing it; the `order.created` filter contains it; the
`nope` filter returns `{"items":[]}`.

### G4 — publish a matching event

```bash
RESP=$(curl -s -X POST localhost:3000/events \
  -H 'content-type: application/json' \
  -d '{"type":"order.created","data":{"orderId":"12345"}}')
echo "$RESP"
EVT1=$(echo "$RESP" | jval id); echo "EVT1=$EVT1"
```

**Expect:**

- Response is immediate (no wait — it is `202 Accepted`); body has `id` (starts
  `evt_`), `type`, `data`, `createdAt`.
- **Inbox** shows one `POST /orders` within ~1 s: `content-type: application/json`,
  `X-Webhook-Event-Id` = `$EVT1`, `X-Webhook-Delivery-Id: del_…`,
  `X-Webhook-Attempt: 1`, body
  `{"id":"<EVT1>","type":"order.created","timestamp":"…Z","data":{"orderId":"12345"}}`.
- Service log shows `dispatch.started` (`matchedCount: 1`) then
  `delivery.succeeded` (`httpStatus: 200`).

```bash
curl -s "localhost:3000/deliveries?eventId=$EVT1"
```

**Expect:** one delivery, `status: "delivered"`, `attempts: 1`,
`lastStatusCode: 200`, `completedAt` set, `subscriptionId` = `$SUB1`.

### G5 — publish a non-matching event

```bash
RESP=$(curl -s -X POST localhost:3000/events \
  -H 'content-type: application/json' -d '{"type":"customer.created"}')
echo "$RESP"
EVT_NM=$(echo "$RESP" | jval id)
curl -s "localhost:3000/deliveries?eventId=$EVT_NM"
```

**Expect:** the event is accepted; **inbox unchanged**; the `/deliveries` query
returns `{"items":[]}`; log shows `dispatch.started` with `matchedCount: 0`.

### G6 — event with no `data`

```bash
curl -s -X POST localhost:3000/events \
  -H 'content-type: application/json' -d '{"type":"order.created"}'
```

**Expect:** accepted; the delivered webhook body has `"data": {}`.

### G7 — fan-out to multiple subscribers

Create a second subscription for the same type, pointing at a different inbox
path, then publish one event:

```bash
SUB2=$(curl -s -X POST localhost:3000/subscriptions -H 'content-type: application/json' \
  -d '{"eventType":"order.created","targetUrl":"http://localhost:4000/orders-copy"}' | jval id)
echo "SUB2=$SUB2"
EVT2=$(curl -s -X POST localhost:3000/events -H 'content-type: application/json' \
  -d '{"type":"order.created","data":{"orderId":"777"}}' | jval id)
curl -s "localhost:3000/deliveries?eventId=$EVT2"
```

**Expect:** the inbox shows **two** POSTs (`/orders` and `/orders-copy`); the
`/deliveries` query returns **two** deliveries, both `delivered`.

### G8 — replace a subscription (re-routes matching)

```bash
curl -i -X PUT localhost:3000/subscriptions/$SUB1 \
  -H 'content-type: application/json' \
  -d '{"eventType":"order.updated","targetUrl":"http://localhost:4000/orders"}'
```

**Expect:** `200`; `id` unchanged, `createdAt` unchanged, `eventType` now
`order.updated`, `updatedAt` advanced.

```bash
curl -s -X POST localhost:3000/events -H 'content-type: application/json' \
  -d '{"type":"order.created","data":{"n":1}}' > /dev/null   # -> only $SUB2 / orders-copy
curl -s -X POST localhost:3000/events -H 'content-type: application/json' \
  -d '{"type":"order.updated","data":{"n":2}}' > /dev/null   # -> $SUB1 / orders
```

**Expect:** the `order.created` event reaches only `/orders-copy`; the
`order.updated` event reaches `/orders` (i.e. `$SUB1` now).

### G9 — delete a subscription

```bash
curl -i -X DELETE localhost:3000/subscriptions/$SUB1
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/subscriptions/$SUB1
```

**Expect:** `204`, then `404`.

```bash
curl -s -X POST localhost:3000/events -H 'content-type: application/json' \
  -d '{"type":"order.updated","data":{"n":3}}' > /dev/null
curl -s "localhost:3000/deliveries?subscriptionId=$SUB1"
```

**Expect:** the new `order.updated` event reaches nothing on `/orders` (`$SUB1`
is gone) — **but** the `/deliveries` query still returns the historical delivery
from G8. Deletion does not rewrite history.

### G10 — filter deliveries

```bash
curl -s 'localhost:3000/deliveries?status=delivered'
curl -s 'localhost:3000/deliveries?status=failed'
DEL1=$(curl -s 'localhost:3000/deliveries?status=delivered' | jval id)
curl -s "localhost:3000/deliveries/$DEL1"
curl -s -o /dev/null -w '%{http_code}\n' localhost:3000/deliveries/del_made_up
```

**Expect:** `status=delivered` lists the successes; `status=failed` is empty so
far; the single GET returns one full record; the made-up id → `404`.

---

## 4. Validation & critical failures

### F1 — invalid subscription bodies

```bash
curl -i -X POST localhost:3000/subscriptions -H 'content-type: application/json' -d '{"targetUrl":"https://x.example/h"}'
curl -i -X POST localhost:3000/subscriptions -H 'content-type: application/json' -d '{"eventType":"order.created"}'
curl -i -X POST localhost:3000/subscriptions -H 'content-type: application/json' -d '{"eventType":"bad type!","targetUrl":"https://x.example/h"}'
curl -i -X POST localhost:3000/subscriptions -H 'content-type: application/json' -d '{"eventType":"order.created","targetUrl":"not-a-url"}'
curl -i -X POST localhost:3000/subscriptions -H 'content-type: application/json' -d '{"eventType":"order.created","targetUrl":"https://user:pw@x.example/h"}'
```

**Expect:** each is `400` with `{"error":{"message":"Validation failed","details":[…]}}`
naming the problem. Nothing is persisted.

### F2 — non-HTTPS target when the strict policy is in effect

Stop the service and restart it **without** `ALLOW_INSECURE_TARGET_URLS`:

```bash
ALLOW_INSECURE_TARGET_URLS=false npm run dev
curl -i -X POST localhost:3000/subscriptions -H 'content-type: application/json' \
  -d '{"eventType":"order.created","targetUrl":"http://plain.example/h"}'
```

**Expect:** `400`, detail mentions `https`. (Then restart with your `.env`.)

### F3 — SSRF guard blocks internal targets

Restart with the guard **on**:

```bash
SSRF_GUARD_ENABLED=true ALLOW_INSECURE_TARGET_URLS=true npm run dev
```

```bash
curl -i -X POST localhost:3000/subscriptions -H 'content-type: application/json' -d '{"eventType":"order.created","targetUrl":"http://127.0.0.1:9000/h"}'
curl -i -X POST localhost:3000/subscriptions -H 'content-type: application/json' -d '{"eventType":"order.created","targetUrl":"http://169.254.169.254/latest/meta-data"}'
curl -i -X POST localhost:3000/subscriptions -H 'content-type: application/json' -d '{"eventType":"order.created","targetUrl":"http://10.0.0.5/h"}'
curl -i -X POST localhost:3000/subscriptions -H 'content-type: application/json' -d '{"eventType":"order.created","targetUrl":"https://[::1]/h"}'
```

**Expect:** each `400`, detail `targetUrl rejected: … loopback / private /
link-local / cloud-metadata address`. A public `https://` target still works
(try one against your `webhook.site` URL). Then restart with your `.env`.

### F4 — invalid event bodies

```bash
curl -i -X POST localhost:3000/events -H 'content-type: application/json' -d '{}'
curl -i -X POST localhost:3000/events -H 'content-type: application/json' -d '{"type":""}'
curl -i -X POST localhost:3000/events -H 'content-type: application/json' -d '{"type":"order.created","data":[1,2]}'
curl -i -X POST localhost:3000/events -H 'content-type: application/json' -d '{"type":"order.created","data":"nope"}'
```

**Expect:** each `400`. Nothing dispatched.

### F5 — malformed JSON

```bash
curl -i -X POST localhost:3000/events -H 'content-type: application/json' -d '{ not json'
```

**Expect:** `400`, `{"error":{"message":"Request body must be valid JSON"}}`.

### F6 — request body too large

```bash
node -e "process.stdout.write(JSON.stringify({type:'order.created',data:{blob:'x'.repeat(2_000_000)}}))" | \
  curl -i -X POST localhost:3000/events -H 'content-type: application/json' --data-binary @-
```

**Expect:** `413` (`MAX_REQUEST_BODY_BYTES` default is 1 MiB), `Connection: close`.

### F7 — unknown route and wrong method

```bash
curl -i localhost:3000/nope
curl -i -X PATCH localhost:3000/subscriptions/sub_anything
curl -i -X DELETE localhost:3000/events
```

**Expect:** `404` for the unknown path; `405` with an `Allow` header for a known
path with an unsupported method.

### F8 — internal error is not leaked

There is no built-in way to force one from the API. Confirmed by the automated
test `security.test.ts > does not leak internals in a 500 response`: a `500`
returns exactly `{"error":{"message":"Internal server error"}}` and the real
error (with stack) goes to the log only.

---

## 5. Retry & recovery

Use the local inbox with your `.env` (`MAX_DELIVERY_ATTEMPTS=4`,
`RETRY_BASE_DELAY_MS=1000`). Each scenario uses its **own event type** so it does
not matter what subscriptions §3 left behind. The `jval` helper from §3 is used
again. To watch a delivery, re-run its `/deliveries?eventId=…` line every second
or so.

### R1 — retry, then eventual success

```bash
curl -s -X POST localhost:3000/subscriptions -H 'content-type: application/json' \
  -d '{"eventType":"retry.ok","targetUrl":"http://localhost:4000/flaky?status=500,500,200"}' > /dev/null
EVT=$(curl -s -X POST localhost:3000/events -H 'content-type: application/json' \
  -d '{"type":"retry.ok"}' | jval id); echo "EVT=$EVT"
curl -s "localhost:3000/deliveries?eventId=$EVT"
```

**Expect:**

- Inbox shows 3 POSTs to `/flaky`, ~1 s then ~2 s apart (equal-jitter backoff),
  responding `500`, `500`, `200`.
- The delivery goes `pending → delivering → pending → … → delivered`,
  `attempts` climbing to `3`, `lastError` cleared once it succeeds,
  `nextAttemptAt` set between attempts.
- Log shows `delivery.retry_scheduled` (with `backoffMs`, `nextAttemptAt`) twice,
  then `delivery.succeeded`.

### R2 — retry budget exhausted → failed

```bash
curl -s -X POST localhost:3000/subscriptions -H 'content-type: application/json' \
  -d '{"eventType":"retry.exhaust","targetUrl":"http://localhost:4000/broken?status=503"}' > /dev/null
EVT=$(curl -s -X POST localhost:3000/events -H 'content-type: application/json' \
  -d '{"type":"retry.exhaust"}' | jval id); echo "EVT=$EVT"
curl -s "localhost:3000/deliveries?eventId=$EVT"
```

**Expect:** exactly **4** POSTs to `/broken` (`MAX_DELIVERY_ATTEMPTS`), then the
delivery is `failed`, `attempts: 4`, `lastStatusCode: 503`, `lastError` set,
`completedAt` set. Log ends with `delivery.failed`
(`reason: retry_budget_exhausted`).

### R3 — timeout is retried

Restart the service with a short timeout first, then run the scenario:

```bash
# terminal 2:  (Ctrl+C, then)   WEBHOOK_TIMEOUT_MS=1000 npm run dev
curl -s -X POST localhost:3000/subscriptions -H 'content-type: application/json' \
  -d '{"eventType":"retry.timeout","targetUrl":"http://localhost:4000/slow?delay=8000"}' > /dev/null
EVT=$(curl -s -X POST localhost:3000/events -H 'content-type: application/json' \
  -d '{"type":"retry.timeout"}' | jval id); echo "EVT=$EVT"
curl -s "localhost:3000/deliveries?eventId=$EVT"
```

**Expect:** each attempt times out after ~1 s (the inbox still logs the request —
it received it, it just answers late); the delivery retries and finally `failed`
with `lastError` mentioning a timeout. Restore `.env` and restart afterwards.

### R4 — non-retryable failure is not retried

```bash
curl -s -X POST localhost:3000/subscriptions -H 'content-type: application/json' \
  -d '{"eventType":"retry.permanent","targetUrl":"http://localhost:4000/gone?status=404"}' > /dev/null
EVT=$(curl -s -X POST localhost:3000/events -H 'content-type: application/json' \
  -d '{"type":"retry.permanent"}' | jval id); echo "EVT=$EVT"
curl -s "localhost:3000/deliveries?eventId=$EVT"
```

**Expect:** exactly **one** POST to `/gone`; the delivery is `failed` almost
immediately, `lastStatusCode: 404`, log `delivery.failed` with
`reason: non_retryable_response`.

### R5 — crash recovery

```bash
curl -s -X POST localhost:3000/subscriptions -H 'content-type: application/json' \
  -d '{"eventType":"crash.test","targetUrl":"http://localhost:4000/crash?status=503"}' > /dev/null
EVT=$(curl -s -X POST localhost:3000/events -H 'content-type: application/json' \
  -d '{"type":"crash.test"}' | jval id); echo "EVT=$EVT"
curl -s "localhost:3000/deliveries?eventId=$EVT"    # status: pending, nextAttemptAt set
```

1. The first POST to `/crash` gets `503`; the delivery is `pending` with a retry
   scheduled.
2. **Within the ~1 s before the retry fires, kill the service** in terminal 2
   (`Ctrl+C`, or kill the PID to simulate a hard crash — see §5 note below). The
   in-process retry timer dies with it.
3. **Restart** `npm run dev`. Within `RECOVERY_INTERVAL_MS` (5 s) the log shows
   `recovery.started` then `recovery.sweep.completed` with `resumedCount: 1`, and
   `curl -s "localhost:3000/deliveries?eventId=$EVT"` shows `attempts`
   incremented — recovery re-drove it. It keeps retrying `/crash` until the
   budget is spent (`failed`); if you edit the target to stop failing it would go
   `delivered` instead.

**Expect:** the abandoned delivery is not lost — recovery resumes it after the
restart, and the attempt cap is still honoured.

> **Hard-crash kill (Git Bash / Windows):** find the PID with
> `netstat -ano | grep :3000 | grep LISTENING` and then `taskkill //F //PID <pid>`.
> Never `taskkill //IM node.exe` — that kills every Node process on the machine.

### R6 — recovery leaves completed deliveries alone

After R1 (a `delivered` delivery on record), restart the service and watch a few
`recovery.sweep.completed` lines (or their absence). The delivered delivery is
never re-sent; the inbox count for that path does not increase.

---

## 6. Results log

| # | Scenario | Pass? | Notes / anything unexpected |
| --- | --- | --- | --- |
| G1 | health | | |
| G2 | create subscription | | |
| G3 | read / list / filter subscriptions | | |
| G4 | publish matching event → delivered | | |
| G5 | non-matching event → no delivery | | |
| G6 | event with no data → `{}` | | |
| G7 | fan-out to 2 subscribers | | |
| G8 | PUT re-routes matching | | |
| G9 | DELETE stops future, keeps history | | |
| G10 | filter deliveries | | |
| F1 | invalid subscription bodies → 400 | | |
| F2 | non-https target (strict) → 400 | | |
| F3 | SSRF guard blocks internal targets → 400 | | |
| F4 | invalid event bodies → 400 | | |
| F5 | malformed JSON → 400 | | |
| F6 | body too large → 413 | | |
| F7 | unknown route → 404, wrong method → 405 | | |
| F8 | 500 does not leak internals (test) | | |
| R1 | retry then success | | |
| R2 | budget exhausted → failed | | |
| R3 | timeout retried | | |
| R4 | non-retryable not retried | | |
| R5 | crash recovery resumes | | |
| R6 | recovery ignores completed | | |

## 7. When something is unexpected

Write it in the notes column, then bring it to the assistant with:
the scenario, the exact request, the actual response / log lines, and what you
expected. We will decide whether it is a defect to fix or a limitation to
document (see `docs/12` for how the existing known limitations are recorded).

---

## 8. Appendix — verify against real AWS DynamoDB

This proves the CloudFormation template builds from zero and that the app works
against a real datastore, not just the in-memory default. Run it as part of the
pre-packaging checklist (`docs/9` §4). Needs `aws` CLI + a valid SSO session
(`aws sso login --profile webhook-challenge`).

> **Cost:** the tables are `PAY_PER_REQUEST` — a handful of requests is
> effectively free, and an idle stack costs nothing beyond point-in-time-recovery
> storage (pennies). Still, tear it down afterwards if you do not need it for
> review.

### 8.1 Recreate the stack from scratch

```bash
aws cloudformation delete-stack --stack-name webhook-registry --profile webhook-challenge --region eu-central-1
aws cloudformation wait stack-delete-complete --stack-name webhook-registry --profile webhook-challenge --region eu-central-1

aws cloudformation deploy \
  --stack-name webhook-registry \
  --template-file infrastructure/cloudformation.yaml \
  --profile webhook-challenge --region eu-central-1

aws cloudformation describe-stacks --stack-name webhook-registry \
  --profile webhook-challenge --region eu-central-1 \
  --query 'Stacks[0].{Status:StackStatus,Outputs:Outputs}'
```

**Expect:** `CREATE_COMPLETE`; outputs list the three table names
(`webhook-registry-subscriptions` / `-events` / `-deliveries`) and ARNs.

### 8.2 Point the app at the real tables

Stop the local service. Add to `.env` (or export inline):

```dotenv
PERSISTENCE=dynamodb
AWS_REGION=eu-central-1
AWS_PROFILE=webhook-challenge
DYNAMODB_SUBSCRIPTIONS_TABLE=webhook-registry-subscriptions
DYNAMODB_EVENTS_TABLE=webhook-registry-events
DYNAMODB_DELIVERIES_TABLE=webhook-registry-deliveries
```

Keep the inbox settings from §2.1 (guard off / insecure URLs on) so you can still
deliver to `npm run inbox`. Start the service — the `config.loaded` line should
show `persistence: "dynamodb"`.

### 8.3 Walk the core scenarios

Run **G2, G3, G4, G7, G9** and **R1** and **R5** from this plan unchanged. Then
confirm the data is really in DynamoDB, not in process memory:

```bash
aws dynamodb scan --table-name webhook-registry-subscriptions --profile webhook-challenge --region eu-central-1 --query 'Count'
aws dynamodb scan --table-name webhook-registry-deliveries    --profile webhook-challenge --region eu-central-1 --query 'Items[].status.S'
```

For **R5** (crash recovery): after killing and restarting the service, the
`pending` delivery is still in the Deliveries table and the recovery sweep
re-drives it — this is the test that matters most against a real datastore.

**Expect:** every scenario behaves exactly as with in-memory persistence; the
scans show the rows; `GET /deliveries` after a restart returns records written
before the restart.

### 8.4 Tear down (optional)

```bash
aws cloudformation delete-stack --stack-name webhook-registry --profile webhook-challenge --region eu-central-1
aws cloudformation wait stack-delete-complete --stack-name webhook-registry --profile webhook-challenge --region eu-central-1
aws dynamodb list-tables --profile webhook-challenge --region eu-central-1   # no webhook-registry-* tables
```

Then revert `.env` to `PERSISTENCE=memory`.

| Step | Pass? | Notes |
| --- | --- | --- |
| 8.1 stack recreated → CREATE_COMPLETE | | |
| 8.2 app starts with `persistence: dynamodb` | | |
| 8.3 core scenarios pass against real tables | | |
| 8.3 scans show the written rows | | |
| 8.3 R5 recovery works against real DynamoDB | | |
| 8.4 teardown clean (if done) | | |
