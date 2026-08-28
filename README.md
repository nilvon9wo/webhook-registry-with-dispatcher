# Webhook Registry + Dispatcher

A TypeScript implementation of the **Webhook Registry + Dispatcher** technical challenge.

The system allows clients to register webhook subscriptions for specific event types and publish events that are asynchronously dispatched to matching subscribers.

## Challenge

The original challenge specification is preserved in:

**[0 - SW Engineer task - WebhookRegistryTask.md](docs/0%20-%20SW%20Engineer%20task%20-%20WebhookRegistryTask.md)**

## Project Documentation

The project is intentionally documented before implementation so that both human and AI contributors have an explicit, reviewable source of truth.

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

**These documents are the authoritative project documentation.** The README intentionally does not duplicate their contents.

## Technology

The implementation uses TypeScript and Node.js, with AWS DynamoDB as the persistent data store.

Additional dependencies and infrastructure are introduced only when justified by the requirements and architecture.

## Getting Started

See **[8 - setup.md](docs/8%20-%20setup.md)** for the required development environment and AWS configuration.

Once the environment is configured:

```bash
npm install
```

Build and test commands are documented in the project configuration and will be finalized as implementation progresses.

## Development Approach

Implementation follows **[2 - plan.md](docs/2%20-%20plan.md)** and is governed by **[3 - steering-rules.md](docs/3%20-%20steering-rules.md)**.

AI-assisted development follows **[6 - prompts.md](docs/6%20-%20prompts.md)**. AI-generated changes are treated as proposed implementation rather than unquestioned authority and are subject to the project's testing and quality gates.

## Status

**Implementation in progress.**
