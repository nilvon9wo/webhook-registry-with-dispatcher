
# Architecture Notes

## Core Model

The service is a webhook registry and event dispatcher.

```text
                 ┌─────────────────────┐
                 │      Consumers      │
                 └──────────┬──────────┘
                            │
              ┌─────────────┴─────────────┐
              │                           │
       POST /subscriptions          POST /events
              │                           │
              v                           v
       ┌──────────────┐             ┌──────────────┐
       │ Subscription │             │    Events    │
       │   Storage    │             │    Storage   │
       └──────┬───────┘             └──────┬───────┘
              │                            │
              │ matching subscriptions     │
              └────────────┬───────────────┘
                           v
                    ┌────────────┐
                    │ Dispatcher │
                    └─────┬──────┘
                          │
                 ┌────────┼────────┐
                 v        v        v
              POST A    POST B    POST C
                 │        │        │
                 └────────┼────────┘
                          v
                   Delivery Storage
```

## Core Entities
### Subscription

Represents a request to receive a particular event type at a particular URL.

```
Subscription
------------
id
eventType
targetUrl
createdAt
updatedAt
```

### Event

Represents an event accepted by the service.

```
Event
-----
id
type
data
createdAt
```

### Delivery

Represents the relationship between an event and a subscription, including delivery state.

```
Delivery
--------
id
eventId
subscriptionId
status
attempts
lastAttemptAt
lastStatusCode
lastError
createdAt
completedAt
```

### Why Persist Events?

It is technically possible to receive an event, keep it only in memory, and immediately dispatch it.

That is not the preferred design.

Persisting the event provides:

- durable identity;
- an audit trail;
- recovery after process crashes;
- a stable source for delivery retries;
- a relationship between event and deliveries.

The event does not necessarily need its own CRUD API. Persistence and external resource exposure are separate concerns.

### Why Persist Deliveries?

An event can match multiple subscriptions, so there is not one delivery result per event.

For example:

```
Event evt-123
   |
   +-- Delivery d1 → subscriber A → 200 → delivered
   +-- Delivery d2 → subscriber B → 500 → retrying
   +-- Delivery d3 → subscriber C → timeout → failed
```

This model supports `/deliveries`, retrying individual failures, and operational diagnosis.

### Why Not Cron-Based Dispatch?

Cron-based primary dispatch introduces unnecessary latency and effectively recreates a poor message queue.

Instead:

```
POST /events
  → persist
  → dispatch asynchronously
```

A periodic recovery job can separately find abandoned/retryable work.

### Why Not Synchronously Dispatch?

If `/events` waits for every webhook:

```
POST /events
  → subscriber A (5 sec)
  → subscriber B (30 sec)
  → subscriber C (timeout)
  → response
```

then the API's reliability and latency become dependent on arbitrary third-party systems.

Asynchronous dispatch avoids that coupling.

### Simple Versus Production Architecture
#### Four-hour implementation
```
API
 |
 +-- DynamoDB
 |
 +-- In-process async dispatcher
       |
       +-- HTTP subscribers
```

This is intentionally simple.

#### More resilient production evolution
```
API
 |
 +-- DynamoDB
 |
 +-- SQS
       |
       v
   Dispatcher workers
       |
       +-- HTTP subscribers
```       

A durable queue makes work survive process termination and supports multiple dispatcher instances more naturally.

The challenge does not require this additional complexity.

### DynamoDB

The DynamoDB design should follow the application's required access patterns.

An **access pattern** describes how the application needs to retrieve or manipulate data. It is a requirement for database access, not a DynamoDB configuration object or query syntax. The actual DynamoDB keys, indexes, and table structure should be selected to support these patterns efficiently.

The important access patterns for this application are:

| Access Pattern                       | Input                               | Expected Result                                     |
| ------------------------------------ | ----------------------------------- | --------------------------------------------------- |
| Get subscription                     | `subscriptionId`                    | One subscription                                    |
| List subscriptions                   | None                                | All subscriptions                                   |
| Find subscriptions by event type     | `eventType`                         | All subscriptions matching the event type           |
| Get event                            | `eventId`                           | One event                                           |
| Get deliveries for event             | `eventId`                           | All deliveries associated with the event            |
| Get delivery                         | `deliveryId`                        | One delivery                                        |
| Get deliveries for subscription      | `subscriptionId`                    | Deliveries associated with the subscription         |
| Find retryable/incomplete deliveries | Delivery status and/or retry timing | Deliveries eligible for recovery or another attempt |

These access patterns are the requirements that the DynamoDB design must support. The implementation should determine the appropriate partition keys, sort keys, and secondary indexes based on them.

Whether these are represented by separate tables or a single-table design is an implementation decision. For a four-hour challenge, choose the design that is easiest to implement correctly, test, explain, and maintain. Do not introduce a more sophisticated DynamoDB modeling strategy merely for its own sake.

The implementation should document the resulting key/index design and explain how each required access pattern is supported.

### Railway

Railway is a viable place to host the TypeScript application, but Railway does not make DynamoDB available as a native managed service.

A possible deployment is:

Railway
  └── TypeScript application
          |
          | AWS SDK
          v
       AWS DynamoDB

Alternatively, Railway-hosted PostgreSQL could satisfy the external-storage requirement, but DynamoDB is preferred because it is explicitly called out as a bonus in the challenge.

### Salesforce

A Salesforce Developer Edition could technically be used as external persistence, but it is a poor fit for this challenge.

It introduces:

- Salesforce-specific APIs;
- governor limits;
- authentication complexity;
- unnecessary domain coupling;
- awkward persistence semantics.

It would obscure rather than demonstrate the webhook architecture.

Do not use Salesforce merely because it is familiar.

### CloudFormation

CloudFormation is AWS Infrastructure as Code.

It is conceptually similar to Terraform:

```
CloudFormation template → AWS infrastructure
Terraform configuration  → infrastructure
```

The challenge's CloudFormation requirement therefore means providing a declarative infrastructure template, not manually creating resources in AWS.

## External Webhook Contract

The target URL is expected to accept an HTTP POST with JSON.

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

The subscriber returns an HTTP response.

A 2xx response indicates successful receipt.

Failures are recorded and may be retried according to policy.

### Failure Isolation

Each delivery is independent.

For:

Event
 ├── Subscriber A
 ├── Subscriber B
 └── Subscriber C

if B returns 500, A and C should still be attempted.

The dispatcher should therefore treat each delivery as an independent unit of work.

### Security Consideration: SSRF

The target URL is supplied by a consumer, and the server subsequently makes an outbound HTTP request to it.

This creates an SSRF risk.

A production-grade implementation should consider restricting destinations such as:

- loopback addresses;
- private IP ranges;
- link-local addresses;
- cloud metadata endpoints;
- unexpected protocols;
- DNS rebinding scenarios.

Full SSRF protection may be outside the four-hour scope, but the issue must be recognized and documented.

### Delivery Semantics

The service should be considered at least once.

There are unavoidable failure windows such as:

```
POST webhook
   ↓
subscriber receives event
   ↓
subscriber returns 200
   ↓
process crashes before recording success
```

On recovery, the system may send the same event again.

Therefore, subscribers should use the stable event ID for idempotency.

The system must not claim exactly-once delivery.


