# Testing Strategy

## Test Pyramid

The project should use a test pyramid rather than attempting to test everything end-to-end.

```text
              ┌─────┐
              │ E2E │
              └─────┘
             ┌───────┐
             │  API  │
             │ /Int. │
             └───────┘
          ┌─────────────┐
          │    Unit     │
          │             │
          └─────────────┘
```

The majority of tests should be unit tests.

## Testing Goals

Tests should provide confidence in:

1. API correctness.
2. Domain/business behavior.
3. Persistence behavior.
4. Dispatcher behavior.
5. Delivery failure handling.
6. Retry behavior.
7. Recovery behavior.
8. Isolation between subscribers.

Tests should verify externally meaningful behavior rather than implementation details.

## Unit Tests

Test business behavior in isolation.

- Subscription Tests
- Valid subscription accepted.
- Missing event type rejected.
- Invalid event type rejected.
- Missing target URL rejected.
- Invalid URL rejected.
- Non-HTTPS URL rejected if HTTPS is the chosen policy.
- Subscription update behaves correctly.
-  Deleting a subscription prevents future matching deliveries.

## Event Tests
- Valid event accepted.
- Missing event type rejected.
- Missing payload rejected if payload is required.
- Event ID is generated.
- Event timestamp is generated.
- Persisted event remains unchanged across delivery attempts.

## Matching Tests
- Exact event type match produces a match.
- Different event type does not match.
- One matching subscription produces one delivery.
- Three matching subscriptions produce three deliveries.
- No matching subscriptions produces no deliveries.
- Non-matching subscriptions are never called.

## Delivery Tests
- 2xx response produces delivered.
- 4xx response produces a non-retryable failure.
- 5xx response is retryable.
- Timeout is retryable.
- Network error is retryable.
- Maximum retry count is enforced.
- Successful retry produces delivered.
- Final unsuccessful attempt produces failed.

## Isolation Tests

Given:

```
Subscriber A → 200
Subscriber B → 500
Subscriber C → 200
```

the result must be:

```
A → delivered
B → retrying/failed
C → delivered
```

B's failure must not prevent A or C from being delivered.

## Integration/API Tests

Exercise the HTTP layer and persistence implementation together.

Examples:

### Subscription CRUD
```
POST /subscriptions
        ↓
GET /subscriptions/{id}
        ↓
PUT /subscriptions/{id}
        ↓
DELETE /subscriptions/{id}
```

Verify the complete lifecycle.

### Event Persistence
```
POST /events
        ↓
retrieve persisted event
```

Verify that the accepted event is durable.

### Delivery Tracking
```
POST /events
        ↓
dispatcher
        ↓
GET /deliveries
```

Verify that delivery state is observable.

### Event-to-Webhook Integration

Use a local test HTTP server as the subscriber.

```
POST /subscriptions
        ↓
POST /events
        ↓
test webhook server receives POST
        ↓
delivery becomes delivered
```
Verify:

- HTTP method;
- content type;
- JSON body;
- event ID;
- event type;
- payload.

## End-to-End Tests

Keep E2E tests few and focused.

### Happy Path
```
create subscription
   ↓
publish event
   ↓
webhook receives POST
   ↓
delivery becomes successful
```

### Failure/Retry Path
```
create subscription
   ↓
publish event
   ↓
webhook initially returns 500
   ↓
retry occurs
   ↓
webhook returns 200
   ↓
delivery becomes successful
```

### Recovery Tests

Simulate a delivery that is left incomplete.

For example:
```
delivery.status = delivering
lastAttemptAt = older than recovery threshold
```

The recovery process should identify it and make it eligible for another attempt.

Also test that already-completed deliveries are not unnecessarily retried.

### Repository Tests

Repository implementations should have tests for the actual access patterns.

For subscriptions:

- create;
- retrieve;
- update;
- delete;
- query by event type.

For events:

- create;
- retrieve by ID.

For deliveries:

- create;
- update;
- retrieve by ID;
- query by event;
- query by subscription;
- query retryable/incomplete records.

### Test Doubles

Use test doubles for external dependencies in unit tests.

Examples:

```
SubscriptionRepository → mock/fake
EventRepository        → mock/fake
DeliveryRepository     → mock/fake
HTTP client             → mock/fake
```

Integration tests should use real repository implementations where practical.

E2E tests should use a real local HTTP server to represent a subscriber.

### Test Data

Tests should use explicit, readable test data.

Avoid sharing mutable global test state.

Each test should be independently runnable.

### Test Quality

Avoid tests that merely verify:

- a private method was called;
- an implementation-specific class exists;
- an exact internal call sequence where multiple implementations would be valid.

The tests should make refactoring safe without freezing the implementation unnecessarily.

## Minimum Test Set for the Four-Hour Challenge

If time becomes constrained, the minimum useful set is:

1. Subscription creation validation.
2. Subscription CRUD.
3. Event persistence.
4. Event/subscription matching.
5. Successful webhook delivery.
6. Failed webhook delivery.
7. Retry behavior.
8. Multiple-subscriber isolation.
9. Delivery status.
10. One complete API/E2E happy-path test.

Additional tests should be added if time permits.