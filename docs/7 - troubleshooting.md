# Expected Failures and Recovery Procedure

Failures are expected during AI-assisted development.

The AI must not respond to a failure by blindly changing unrelated code until the error disappears.

When a prompt results in a failure, use the following procedure.

## Step 1: Stop and Diagnose

Do not immediately modify production code.

Determine:

- what failed;
- where it failed;
- whether the failure is in code, configuration, dependencies, infrastructure, test assumptions, or the environment;
- whether the failure contradicts the specification.

Explain the likely root cause.

## Step 2: Check the Existing Requirements

Before changing behavior, re-read the relevant sections of:

- docs/1 - spec.md;
- docs/3 - steering-rules.md;
- docs/4 - architecture.md;
- docs/5 - testing.md.

Do not "fix" a failure by violating one of these documents.

## Step 3: Reproduce the Failure

Where practical, reproduce the problem with the smallest relevant command or test.

For example:

`npm test -- relevant-test`

or:

`npm run build`

Do not make a large collection of changes before confirming the failure.

## Step 4: Classify the Failure

Classify the problem as one of:

### Implementation Bug

The code does not behave according to the specification.

Fix the implementation.

### Test Bug

The test incorrectly describes the required behavior.

Fix the test only if the specification confirms that the test is wrong.

Do not weaken a test simply because the implementation fails it.

### Specification Ambiguity

The requirements genuinely permit multiple interpretations.

Explain the ambiguity and choose the simplest defensible interpretation.

Update the relevant documentation if the decision materially affects the architecture.

### Dependency/API Issue

A library or SDK behaves differently from expected.

Check the installed version and actual API before changing architecture.

Prefer the simplest compatible implementation.

### Environment/Infrastructure Issue

Examples:

- AWS credentials unavailable;
- Docker unavailable;
- local service unavailable;
- network unavailable;
- missing environment variable.

Do not rewrite application code to conceal an environment problem.

Document the required environment setup.

### Tooling Issue

Examples:

- formatter failure;
- TypeScript configuration problem;
- test runner configuration;
- build tooling.

Fix the tooling/configuration rather than weakening the application.

# Expected Failure Prompt Template

When a failure occurs, use this prompt:

## Prompt

The previous implementation step produced the following failure:

`[PASTE EXACT ERROR / TEST OUTPUT HERE]`

Do not make changes yet.

Analyze the failure against:

- docs/1 - spec.md
- docs/3 - steering-rules.md
- docs/4 - architecture.md
- docs/5 - testing.md

Determine:

1. The most likely root cause.
2. Whether the implementation, test, configuration, dependency, or environment is responsible.
3. The smallest appropriate fix.
4. Whether the proposed fix changes any architectural decision.
5. Whether any documentation needs to be updated.

Do not work around the failure by weakening requirements or tests.

After explaining the diagnosis, propose the fix.

Wait for approval before making substantial architectural changes.

# Expected Test Failure Prompt
## Prompt

A test is failing:

`[PASTE TEST FAILURE HERE]`

Analyze the failure.

Determine whether:

- the production implementation is incorrect;
- the test expectation is incorrect;
- the test setup is incorrect;
- the failure is caused by an external dependency/environment.

Do not modify the test merely to make it pass.

Compare the expected behavior with docs/1 - spec.md.

If the production code is wrong, fix the production code.

If the test is wrong, explain why and correct the test.

After the fix, run the relevant test and then the complete test suite.

# Expected AWS/DynamoDB Failure Prompt
## Prompt

The DynamoDB implementation/configuration is failing with:

`[PASTE EXACT ERROR HERE]`

Do not replace DynamoDB with another database yet.

First determine whether the problem is:

- credentials;
- region configuration;
- table configuration;
- key/index design;
- AWS SDK usage;
- local test configuration;
- CloudFormation configuration.

Separate environment problems from application problems.

If real AWS access is unavailable, preserve the repository abstraction and ensure the behavior can still be tested with an in-memory implementation or suitable local test strategy.

Do not introduce unrelated infrastructure.

# Expected Integration/E2E Failure Prompt
## Prompt

The integration/E2E test is failing:

`[PASTE EXACT FAILURE HERE]`

Determine whether the problem is:

- API behavior;
- persistence;
- asynchronous timing;
- dispatcher behavior;
- HTTP webhook behavior;
- test-server setup;
- eventual consistency;
- test synchronization.

Do not add arbitrary sleeps as the first solution.

Prefer explicit synchronization with observable application state.

If the implementation is asynchronous, make the test wait for the actual expected state rather than relying on fixed delays.

# Unexpected Requirement Prompt

If implementation reveals a genuine requirement gap not covered by the documents:

## Prompt

The implementation has revealed the following requirement gap:

`[DESCRIBE GAP]`

Do not immediately implement a complex solution.

Analyze:

1. What behavior is currently unspecified?
2. What are the reasonable alternatives?
3. Which alternative best fits the existing architecture?
4. Which alternative is appropriate given the four-hour constraint?
5. What impact does the decision have on APIs, persistence, tests, and documentation?

Recommend the simplest defensible decision.

After the decision is made, update the appropriate documentation before implementing the feature.

# Scope-Control Prompt

Use this whenever the AI proposes substantial additional infrastructure or complexity.

## Prompt

You are proposing additional complexity beyond the current implementation.

Before implementing it, explain:

1. Which requirement it satisfies.
2. What problem it solves.
3. Why the current implementation is insufficient.
4. What additional dependencies/infrastructure it introduces.
5. What new failure modes it introduces.
6. How much implementation/testing effort it is likely to require.
7. Whether it is appropriate within the four-hour challenge.

Prefer the simpler implementation unless the additional complexity provides a meaningful improvement that is worth its cost.

# Final AI Conversation Requirement

The final repository should retain enough of the AI-assisted development record to demonstrate that AI was used deliberately.

The important evidence is:

1. The initial specification and architecture were established before implementation.
2. AI was instructed to follow those artifacts.
3. AI-generated code was reviewed and tested.
4. Failures were diagnosed rather than blindly worked around.
5. Tests were treated as behavioral quality gates.
6. Architectural decisions were deliberate rather than accidental.

The AI must not be treated as an autonomous authority.

The developer remains responsible for the final implementation.