# Webhook Registry + Dispatcher Specification

## 1. Purpose

Build a service that allows consumers to register webhook endpoints for specific event types and delivers matching events to those endpoints.

A webhook URL is an HTTP(S) endpoint owned by a subscriber. The service sends an HTTP POST containing an event as JSON to that URL when a matching event occurs.

Example:

```
Subscription:
  eventType: order.created
  targetUrl: https://customer.example.com/webhooks/orders

Event:
  type: order.created
  data: { orderId: "12345" }

Result:
  POST https://customer.example.com/webhooks/orders
```  

## 2. Terminology
### Subscription

> A persistent registration stating:

For events of type X, deliver them to URL Y.

### Event

A notification submitted to this service.

An event has:

- a unique ID;
- an event type;
- a timestamp;
- a JSON payload (`data`) — **optional**, defaulting to `{}`. Many event types
  legitimately carry no payload (the type is the information), consistent with
  CloudEvents where `data` is optional. When `data` is present it must be a JSON
  object; a non-object (`null`, array, string, number) is a `400`. A missing
  `data` is **not** flagged to the caller or the logs — see `docs/9`
  → "Event `data` is optional".

### Subscriber

The external system represented by a subscription's target URL.

### Delivery

One event-to-subscription delivery record, including its attempts and current/final status.

### Dispatcher

The application component responsible for finding matching subscriptions and delivering events to their target URLs.

## 3. API
### Subscriptions
#### POST `/subscriptions`

Create a subscription.

Example request:

``` 
{
  "eventType": "order.created",
  "targetUrl": "https://customer.example.com/webhooks/orders"
}
```

The service generates the subscription ID and timestamps.

Example response:

``` 
{
  "id": "sub_123",
  "eventType": "order.created",
  "targetUrl": "https://customer.example.com/webhooks/orders",
  "createdAt": "2026-08-28T10:00:00Z",
  "updatedAt": "2026-08-28T10:00:00Z"
}
``` 

#### GET `/subscriptions`

List subscriptions.

Optional filtering by event type is desirable.

#### GET `/subscriptions/{id}`

Retrieve one subscription.

#### PUT `/subscriptions/{id}`

Replace/update a subscription.

#### DELETE `/subscriptions/{id}`

Delete a subscription.

Deleting a subscription prevents future deliveries. It must not rewrite historical delivery records.

### Events
#### POST `/events`

Publish an event to the service.

Example:

```
{
  "type": "order.created",
  "data": {
    "orderId": "12345"
  }
}
```

The service assigns a unique event ID and persists the event.

The API must not synchronously wait for every subscriber to respond.

The intended behavior is:

```
HTTP request
   ↓
validate
   ↓
persist event
   ↓
initiate asynchronous dispatch
   ↓
return 202 Accepted
```

Persisting before dispatch is important: once the API accepts an event, the event should not disappear merely because the process crashes during dispatch.

Publishing is decoupled from subscribing. `POST /events` returns `202` even when **no** subscription matches the event type — the event is still validated and persisted, and a subscriber may be registered later. This matches SNS / EventBridge / Pub/Sub and hosted webhook products. Zero matches is surfaced as a `dispatch.no_subscribers` warning in the logs (so a mis-typed `type` is visible), not as an error to the caller. See `docs/9` → "Decoupled publish".

## 4. Event Delivery

For every subscription whose eventType matches the event type:

1. Create a delivery record.
2. POST the event JSON to the subscription's target URL.
3. Apply an explicit HTTP timeout.
4. Record the result.
5. Retry transient failures according to the configured retry policy.

A failed delivery to one subscriber must not prevent delivery to other matching subscribers.

The outbound request should contain enough information for the subscriber to identify the event.

Example:

```
POST https://subscriber.example/webhooks
Content-Type: application/json

{
  "id": "evt_123",
  "type": "order.created",
  "timestamp": "2026-08-28T10:15:00Z",
  "data": {
    "orderId": "12345"
  }
}
```

A successful 2xx response is considered a successful delivery.

Non-2xx responses and network/timeout failures are unsuccessful attempts.

## 5. Delivery Status

A delivery should contain at least:

```
id
eventId
subscriptionId
status
attempts
createdAt
lastAttemptAt
lastStatusCode
lastError
completedAt
```

Suggested statuses:

```
pending
delivering
delivered
failed
```

A retryable failure may return to `pending`.

## 6. Delivery API

Possible endpoints:

- `GET /deliveries`
- `GET /deliveries/{id}`

Useful filters:

- event ID;
- subscription ID;
- status.

The delivery API is a bonus feature but is strongly aligned with the persistent delivery model.

## 7. Persistence

Persistence is required and must be external to the process.

Preferred implementation: DynamoDB.

The minimum persistent concepts are:

```
Subscriptions
Events
Deliveries
```

Events should be persisted even though they are not necessarily exposed as a conventional CRUD resource.

Persisting events provides:

- durable identity;
- auditability;
- recovery after process crashes;
- a stable source for delivery retries;
- a relationship between events and deliveries.

The exact DynamoDB table design is an implementation decision.

It should support access patterns such as:

- find subscriptions by event type;
- retrieve an event by ID;
- retrieve deliveries by event;
- retrieve deliveries by subscription;
- retrieve retryable/incomplete deliveries.

## 8. Dispatch Architecture

```
The normal path should be asynchronous:

                 POST /events
                       |
                       v
                 Persist Event
                       |
                       v
               Start Dispatch
                       |
                       v
                 Dispatcher
                 /    |    \
                /     |     \
               v      v      v
          Subscriber A B  Subscriber C
```

The API should not wait for arbitrary external webhook latency.

`A simple in-process asynchronous dispatcher is acceptable for the timeboxed challenge.`

A production deployment with multiple application instances would benefit from a durable queue such as SQS:

API → Persistent Event → Queue → Dispatcher → Subscribers

That is an architectural evolution, not a requirement to add unnecessary infrastructure to the four-hour solution.

## 9. Recovery

Periodic polling/cron is not the primary dispatch mechanism.

Instead:

```
Normal:
POST /events → persist → dispatch immediately

Recovery:
periodic job → find incomplete/retryable deliveries → retry
```

Recovery should address crashes, restarts, and transient outages.

The implementation should avoid indefinitely retrying a permanently invalid target.

## 10. Retry Policy

The implementation must define a bounded retry strategy.

Reasonable defaults:

- retry network errors and timeouts;
- retry selected 5xx responses;
- do not normally retry 4xx validation/client errors;
- use exponential backoff;
- cap the number of attempts;
- retain the final failure in delivery history.

Exact values should be configurable.

## 11. URL Validation

Subscriptions should require HTTPS target URLs unless there is a documented reason to support HTTP.

The service should validate URL syntax.

Production hardening should also consider SSRF protections if arbitrary users can register arbitrary URLs. At minimum, this concern should be documented because the dispatcher makes server-side HTTP requests to user-provided destinations.

## 12. Configuration

Environment/configuration should control operational settings such as:

database/table configuration;
retry count;
retry delays;
webhook timeout;
server port;
logging level;
recovery interval.

Do not hard-code environment-specific infrastructure identifiers or secrets.

## 13. CloudFormation

Provide CloudFormation describing the AWS infrastructure required by the solution.

At minimum, this should cover DynamoDB resources and their indexes.

The template does not need to be deployed as part of the challenge.

## 14. Testing

Use a test pyramid.

### Unit Tests

Many, fast, isolated tests for:

- subscription validation;
- event validation;
- event/subscription matching;
- retry classification;
- delivery state transitions;
- dispatcher behavior with mocked repositories/HTTP clients.

### Integration/API Tests

Fewer tests exercising:

- HTTP API;
- repository implementation;
- persistence;
- dispatcher integration.

### End-to-End Tests

A small number covering the complete flow:

- create subscription
  ↓
- publish event
  ↓
- webhook receives POST
  ↓
- delivery becomes successful

Also consider one complete failure/retry scenario.

## 15. Production-Readiness Requirements

The implementation should demonstrate awareness of:

- external dependency failures;
- timeouts;
- retries;
- duplicate delivery;
- crash recovery;
- concurrent dispatch;
- input validation;
- SSRF;
- secrets/configuration;
- observability;
- testing.

Production-ready does not require implementing every possible distributed-systems feature.

## 16. Gaps Filled by This Specification

The original challenge leaves several decisions unspecified. This solution explicitly chooses:

- JSON HTTP webhooks.
- HTTPS target URLs.
- POST for delivery.
- Unique event IDs.
- Persistent events.
- Persistent delivery records.
- Asynchronous dispatch.
- Immediate dispatch rather than cron-based normal dispatch.
- Periodic recovery for incomplete/retryable work.
- Explicit webhook timeouts.
- Bounded retries with backoff.
- 2xx as successful delivery.
- Test pyramid.
- Environment-based configuration.
- CloudFormation for AWS infrastructure.
- Documentation of production concerns such as SSRF.
- At-least-once delivery semantics rather than claiming exactly-once delivery.

