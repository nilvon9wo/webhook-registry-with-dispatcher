# Steering Rules

These rules govern implementation decisions for the technical challenge.

## Correctness Over Cleverness

Build the smallest system that correctly satisfies the specification.

Do not introduce abstractions, infrastructure, frameworks, or distributed-system components merely because they are interesting.

## Four-Hour Constraint

The implementation must remain achievable within approximately four hours.

When forced to choose:

1. Core correctness.
2. Tests.
3. Clear architecture.
4. Persistence.
5. Reliability basics.
6. Bonus infrastructure.

Do not sacrifice the core implementation for bonus features.

## TypeScript

Use TypeScript with strict compiler settings.

Prefer explicit domain types and avoid `any` except where genuinely unavoidable.

Use descriptive names rather than abbreviated variables.

## Architecture

Keep these concerns separated:

```text
HTTP/API
   ↓
Application/use cases
   ↓
Domain
   ↓
Repository / infrastructure
```

The dispatcher should depend on abstractions rather than directly coupling business logic to DynamoDB.

## Persistence

Never make persistence an incidental implementation detail of an HTTP handler.

Use repository interfaces so business behavior can be tested without requiring a real AWS account.

Persist an event before considering it accepted for asynchronous processing.

Persist delivery state so that success/failure/retry state survives process restarts.

## Asynchronous Dispatch

Do not make `POST /events` wait for arbitrary subscriber HTTP requests.

The normal flow is:

`validate → persist → initiate asynchronous dispatch → return`

Do not use cron as the normal event-dispatch mechanism.

A periodic process may be used for recovery/retries.

## External HTTP Calls

Treat subscriber endpoints as unreliable external dependencies.

Every outbound request must have:

- an explicit timeout;
- error handling;
- response-status handling;
- bounded retry behavior where appropriate.

One subscriber failing must not prevent delivery to other subscribers.

## Retries

Do not blindly retry every failure.

Prefer:

- transient network errors → retry;
- timeout → retry;
- selected 5xx → retry;
- most 4xx → permanent failure.

Use bounded exponential backoff.

## Delivery Semantics

Assume duplicate delivery is possible.

The system should assign stable event IDs and delivery IDs so subscribers and operators can identify duplicates.

Do not claim exactly-once delivery unless it is actually guaranteed.

Webhook delivery should be treated as at-least-once in the presence of retries and crashes.

## Idempotency

The design should make duplicate processing detectable.

An event ID must remain stable across delivery attempts.

A retry must not create a new event ID.

The implementation should document whether the event ingestion API itself supports client-provided idempotency keys. If it does not, do not imply that it does.

## Security

Never commit secrets.

Validate webhook URLs.

Because the server makes outbound requests to user-provided URLs, explicitly consider SSRF.

For a four-hour implementation, document the limitation if full SSRF protection is outside scope rather than pretending arbitrary URL fetching is automatically safe.

## Validation

Reject malformed requests with clear 4xx responses.

Do not allow invalid event types, missing required properties, malformed URLs, or otherwise invalid domain objects into persistence.

## API Semantics

Use conventional HTTP semantics.

Examples:

- `201 Created` for successful subscription creation.
- `200 OK` for successful reads/updates.
- `204 No Content` for successful deletion where appropriate.
- `202 Accepted` for asynchronously accepted events.
- `400 Bad Request` for malformed input.
- `404 Not Found` for unknown resources.
- `409 Conflict` where an actual resource conflict exists.
- `500/503` for appropriate server/dependency failures.

## Testing Standards

Follow the test pyramid:

```
          E2E
         /---\
      Integration
     /-----------\
         Unit
    /---------------\
```

Favor many fast unit tests and a smaller number of integration tests.

Tests must verify behavior, not implementation details.

At minimum cover:

- subscription CRUD;
- matching by event type;
- event persistence;
- successful delivery;
- failed delivery;
- timeout behavior;
- retry behavior;
- subscriber isolation;
- delivery status;
- recovery behavior.

Do not modify production code merely to make a broken test pass if the test is exposing a real behavioral defect.

## Coding Standards
- Keep methods small and focused.
- Prefer clear names over abbreviations.
- Avoid magic numbers; use named configuration/constants.
- Prefer composition over unnecessary inheritance.
- Follow SOLID principles where they genuinely improve the design.
- Avoid premature abstraction.
- Keep infrastructure code separate from domain/application behavior.
- Make failure paths explicit.
- Use structured logging where practical.
- Keep public APIs documented.
- Avoid clever code when straightforward code is easier to review.

## Configuration

Environment-specific values must not be hard-coded.

Operational settings such as timeout, retry count, backoff, recovery interval, table names, and port should be configurable.

Configuration should have safe defaults where appropriate.

## Logging

Log useful operational events without logging secrets or sensitive payloads unnecessarily.

Useful fields include:

- event ID;
- subscription ID;
- delivery ID;
- attempt number;
- outcome;
- HTTP status;
- elapsed time.

## AI-Assisted Development

The challenge explicitly permits AI assistance.

Any AI-generated or AI-assisted implementation must still be reviewed by the developer.

Do not blindly accept generated code.

The final repository should include the relevant AI conversation and/or a concise plan/spec/steering record sufficient to demonstrate how AI was used.

The files in this repository constitute the governing implementation intent. If generated code conflicts with them, follow the specification and steering rules.

## Dependency Discipline

Prefer a small dependency footprint.

Every dependency should have a clear purpose.

Do not add a queue, cache, ORM, message broker, or framework unless it materially improves the required solution.

## CloudFormation

CloudFormation should describe infrastructure that corresponds to the actual application.

Do not create unused AWS resources solely to make the template look sophisticated.

If an SQS architecture is not implemented, do not pretend it is required merely because it is a plausible production evolution.

## Documentation

Document important engineering decisions and tradeoffs.

The README should allow another developer to:

1. install dependencies;
2. configure the application;
3. run it locally;
4. run tests;
5. understand persistence;
6. understand dispatch behavior;
7. understand the AWS/CloudFormation setup;
8. understand known limitations.

## Maintainability

Prefer code that another senior developer can understand quickly.

Avoid:

- unnecessary generic abstractions;
- excessive design patterns;
- deeply nested control flow;
- hidden side effects;
- implicit global state;
- infrastructure-specific assumptions in domain logic.  