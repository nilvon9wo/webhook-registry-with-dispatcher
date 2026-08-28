# AI Development Prompts

This document defines the intended sequence of AI prompts for implementing the Webhook Registry + Dispatcher challenge.

The AI should treat the following repository documents as authoritative:

- `docs/1 - plan.md`
- `docs/2 - spec.md`
- `docs/3 - steering-rules.md`
- `docs/4 - architecture.md`
- `docs/5 - testing.md`

The implementation should remain within the stated four-hour challenge constraint.

---

# 1. Initial Project Assessment
## Prompt

Read the following project documentation before making any changes:

- `docs/2 - spec.md`
- `docs/1 - plan.md`
- `docs/3 - steering-rules.md`
- `docs/4 - architecture.md`
- `docs/5 - testing.md`

Do not write code yet.

First:

1. Summarize your understanding of the requirements.
2. Identify the major components you expect to implement.
3. Identify any contradictions or ambiguities in the documentation.
4. Identify any requirements that you believe are unnecessary to implement for the four-hour challenge.
5. Propose a concrete implementation sequence.
6. Identify any decisions that need to be made before implementation.

Do not invent requirements merely to make the architecture more complicated.

The four-hour constraint is important. Prefer the smallest implementation that satisfies the specification while demonstrating sound engineering judgment.

Wait for approval before making implementation changes.

---

# 2. Establish the Project
## Prompt

Proceed with the project setup based on the approved plan.

Create the TypeScript project and establish:

- strict TypeScript configuration;
- package management;
- application entry point;
- test framework;
- linting/formatting if appropriate;
- configuration/environment handling;
- sensible project structure.

Do not implement business functionality yet.

Keep the dependency footprint small.

After making the changes:

1. Build the project.
2. Run the test suite.
3. Report the files created/modified.
4. Report any warnings or unresolved issues.

Do not proceed past a broken build without explaining the failure.

---

# 3. Define the Domain Model
## Prompt

Implement the core domain types and validation model for:

- Subscription
- Event
- Delivery

Follow `docs/2 - spec.md` and `docs/3 - steering-rules.md`.

Keep domain logic independent of HTTP and DynamoDB.

Do not implement the HTTP endpoints or persistence implementation yet.

Add unit tests for the domain validation and important state-transition behavior.

Run the build and tests when finished.

Report any assumptions made.

---

# 4. Define Persistence Interfaces
## Prompt

Introduce repository abstractions for the persistent domain concepts.

At minimum, consider:

- `SubscriptionRepository`
- `EventRepository`
- `DeliveryRepository`

The application/domain layer must not depend directly on DynamoDB.

Define interfaces around the actual access patterns required by the specification.

Do not implement DynamoDB yet.

Provide an in-memory implementation or suitable test doubles where useful for unit testing.

Add tests for the repository behavior where appropriate.

Run the full test suite.

---

# 5. Implement Subscription CRUD
## Prompt

Implement the `/subscriptions` API according to `docs/2 - spec.md`.

Implement:

- `POST /subscriptions`
- `GET /subscriptions`
- `GET /subscriptions/{id}`
- `PUT /subscriptions/{id}`
- `DELETE /subscriptions/{id}`

Requirements:

- validate input;
- require a valid HTTPS target URL;
- generate IDs server-side;
- persist subscriptions;
- return conventional HTTP status codes;
- provide useful error responses.

Keep HTTP concerns separate from application/domain logic.

Add unit and API/integration tests covering the subscription lifecycle and validation failures.

Run the complete test suite.

Do not proceed if the implementation introduces avoidable architectural coupling.

---

# 6. Implement DynamoDB Persistence
## Prompt

Implement the production persistence layer using DynamoDB.

Use the access patterns documented in `docs/2 - spec.md` and `docs/4 - architecture.md`.

Before coding:

1. Determine the minimum DynamoDB tables/indexes required.
2. Explain the proposed key design.
3. Explain why the design supports the required queries.
4. Avoid introducing unnecessary tables/indexes.

Then implement the repository layer.

The rest of the application should continue to depend on repository abstractions rather than DynamoDB-specific APIs.

Add appropriate repository integration tests.

Do not require real AWS credentials for ordinary unit tests.

Run the complete test suite.

---

# 7. Implement Event Ingestion
## Prompt

Implement `POST /events`.

The endpoint must:

1. Validate the request.
2. Create a unique event ID.
3. Record the event timestamp.
4. Persist the event.
5. Initiate asynchronous dispatch.
6. Return without waiting for external webhook requests to complete.

Use `202 Accepted` if that is consistent with the final API design.

Do not make the HTTP request synchronously wait for arbitrary subscriber response times.

Add tests for:

- valid event;
- invalid event;
- event persistence;
- generated event ID;
- asynchronous behavior.

Run the complete test suite.

---

# 8. Implement Subscription Matching
## Prompt

Implement the application logic that determines which subscriptions match an event.

Matching should be based on event type.

For example:

```text
Event:
  type = order.created

Subscriptions:

  order.created → A     MATCH
  order.created → B     MATCH
  customer.created → C  NO MATCH
```

The matching logic should be deterministic, independently testable, and independent of HTTP.

Add unit tests covering:

- zero matches;
- one match;
- multiple matches;
- non-matching event types.

Do not implement external webhook delivery yet.

# 9. Implement the Dispatcher
## Prompt

Implement the asynchronous dispatcher according to docs/2 - spec.md.

For each event:

1. Find matching subscriptions.
2. Create one delivery record per matching subscription.
3. Attempt delivery independently for each subscription.
4. POST the event as JSON to each target URL.
5. Apply an explicit HTTP timeout.
6. Record the result.

One subscriber failing must not prevent delivery to other subscribers.

Do not use cron as the normal dispatch mechanism.

Do not introduce SQS or another message broker unless there is a compelling reason and the change is explicitly justified against the four-hour constraint.

Add unit tests using mocked repositories and HTTP clients.

Add an integration/E2E test using a local HTTP server as a fake subscriber.

Run the complete test suite.

# 10. Implement Delivery State Tracking
## Prompt

Complete the delivery persistence and state model.

Each delivery should record at least:

- delivery ID;
- event ID;
- subscription ID;
- status;
- attempt count;
- timestamps;
- HTTP status where available;
- last error where available.

Use the states documented in docs/2 - spec.md.

Ensure state transitions are explicit and valid.

Add tests for:

- pending → delivering;
- delivering → delivered;
- delivering → retryable failure;
- retryable failure → delivering;
- final failure;
- repeated attempts.

Do not introduce unnecessary state complexity.

# 11. Implement Retry Handling
## Prompt

Implement bounded retry behavior for webhook delivery.

Follow the rules in docs/2 - spec.md and docs/3 - steering-rules.md.

Default policy:

- network errors → retry;
- timeouts → retry;
- appropriate 5xx responses → retry;
- most 4xx responses → permanent failure;
- exponential backoff;
- maximum attempt count;
- final failure recorded permanently.

Make retry-related operational settings configurable.

Do not retry indefinitely.

Add unit tests covering each retry classification and the maximum retry limit.

Run the complete test suite.

# 12. Implement Delivery Endpoints
## Prompt

Implement the bonus /deliveries API.

At minimum:

- `GET /deliveries`
- `GET /deliveries/{id}`

Where practical, support filtering by:

- event ID;
- subscription ID;
- status.

Return enough information to understand whether a delivery succeeded, failed, or is pending/retrying.

Add API tests.

Run the complete test suite.

# 13. Implement Recovery
## Prompt

Implement a lightweight recovery mechanism for incomplete or retryable deliveries.

Important distinction:

The normal dispatch mechanism must remain:

```
POST /events
  → persist
  → initiate asynchronous dispatch
```

Do not replace this with cron-based dispatch.

Recovery should instead find work that may have been abandoned because of:

- process crashes;
- application restarts;
- timeouts;
- transient infrastructure failures.

Consider deliveries stuck in delivering and retryable failures.

The recovery interval and relevant thresholds should be configurable.

Add tests demonstrating that:

- abandoned work can be recovered;
- completed deliveries are not unnecessarily redelivered;
- retry limits remain enforced.

Keep the implementation simple enough for the four-hour constraint.

# 14. Add CloudFormation
## Prompt

Create the CloudFormation configuration required by the implemented AWS persistence architecture.

The CloudFormation template should describe the resources the application actually uses.

At minimum, include:

- DynamoDB table(s);
- required indexes;
- appropriate billing/capacity configuration;
- useful outputs/configuration where appropriate.

Do not add unused AWS resources simply to make the template look more sophisticated.

The template does not need to be deployed.

Validate the template as far as practical.

Ensure the documented application configuration matches the resources described by the template.

# 15. Add Configuration and Operational Concerns
## Prompt

Review the application configuration and make operational settings configurable.

At minimum consider:

- HTTP server port;
- DynamoDB table configuration;
- webhook timeout;
- retry count;
- retry backoff;
- recovery interval;
- logging level.

Do not hard-code secrets.

Provide safe development defaults where appropriate.

Document required environment variables in the README.

# 16. Security Review
## Prompt

Perform a focused security review of the implementation.

Pay particular attention to:

1. SSRF caused by user-controlled webhook URLs.
2. URL/protocol validation.
3. AWS credential handling.
4. Secrets accidentally committed to source.
5. Unbounded request body sizes.
6. Unbounded webhook timeouts.
7. Sensitive data appearing in logs.
8. Injection vulnerabilities.
9. Authentication/authorization assumptions.

Do not implement an authentication system unless the challenge requires it.

For security issues that are outside the four-hour scope, document the limitation and recommend the appropriate production mitigation.

Do not claim that a limitation is solved when it is merely documented.

# 17. Observability Review
## Prompt

Review logging and operational observability.

Ensure delivery-related operations can be correlated using:

- event ID;
- subscription ID;
- delivery ID;
- attempt number.

Avoid logging secrets or unnecessarily logging complete event payloads.

Add useful error context.

Keep the logging implementation proportional to the challenge.

# 18. Full Test Review
## Prompt

Review the test suite against `docs/5 - testing.md`.

Verify that the project follows a test pyramid:

- many unit tests;
- fewer integration/API tests;
- very few E2E tests.

Identify important untested behavior.

Add tests for any meaningful gaps, especially:

- subscriber isolation;
- timeout handling;
- retry classification;
- maximum retries;
- persistence;
- delivery state transitions;
- recovery;
- invalid API input.

Do not add tests merely to increase coverage percentage.

The objective is behavioral confidence.

Run the entire test suite.

Report:

- test count;
- passing/failing tests;
- important remaining gaps.

# 19. Architecture Review
## Prompt

Perform a senior-engineer review of the complete implementation against:

- docs/2 - spec.md
- docs/1 - plan.md
- docs/3 - steering-rules.md
- docs/4 - architecture.md
- docs/5 - testing.md

Do not make changes yet.

Review:

- correctness;
- separation of concerns;
- persistence;
- asynchronous dispatch;
- failure isolation;
- retry behavior;
- recovery;
- test quality;
- security;
- configuration;
- maintainability;
- four-hour scope discipline.

Identify:

1. Defects.
2. Requirements not satisfied.
3. Important risks.
4. Unnecessary complexity.
5. Reasonable improvements.

Prioritize findings by severity.

# 20. Address Review Findings
## Prompt

Address the findings from the previous architecture review.

Only make changes that materially improve correctness, reliability, maintainability, security, or compliance with the specification.

Do not introduce unrelated refactoring.

After changes:

1. Build the application.
2. Run the complete test suite.
3. Confirm that previously passing tests remain passing.
4. Report the changes made.

# 21. Documentation Review
## Prompt

Review the README and project documentation.

A developer who has never seen this repository should be able to determine:

- what the application does;
- how to install it;
- how to configure it;
- how to run it;
- how to run tests;
- what APIs exist;
- how webhook delivery works;
- what persistence is used;
- how DynamoDB is configured;
- how CloudFormation is used;
- what retry/recovery behavior exists;
- what security limitations exist;
- what production improvements remain.

Document deliberate architectural tradeoffs.

Do not claim features that are not implemented.

# 22. Final Build and Packaging Check
## Prompt

Perform the final release check.

Verify:

- clean TypeScript build;
- complete test suite passes;
- lint/format checks pass if configured;
- no secrets or credentials are present;
- no unnecessary files are included;
- CloudFormation is syntactically valid;
- configuration documentation is accurate;
- README is accurate;
- package scripts work from a clean checkout;
- implementation remains consistent with the specification.

Inspect the repository for temporary/debugging code.

Do not make broad refactors at this stage.

Provide a concise final report containing:

1. Implemented requirements.
2. Implemented bonus requirements.
3. Known limitations.
4. Important architectural decisions.
5. Test results.
6. Anything that should be explained to the evaluator.

