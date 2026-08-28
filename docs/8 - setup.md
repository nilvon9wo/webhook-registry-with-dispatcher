# Development Environment and Prerequisites

## 1. Purpose

This document describes the software, accounts, subscriptions, local configuration, and AWS configuration required to develop and test the Webhook Registry + Dispatcher challenge.

The target environment is Windows with a TypeScript/Node.js application and AWS DynamoDB persistence.

The goal is to have everything ready before implementation begins.

---

# 2. Required Software

## 2.1 Node.js

Use the current **LTS** release.

As of August 28, 2026:

```text
Node.js 24.20.0 LTS
```

Node.js 26.8.1 is currently the "Current" release, but Node 24 is the appropriate choice for a challenge because it is the active LTS line.

Verify:

```powershell
node --version
npm --version
```

Expected:

```text
v24.20.0
```

npm is bundled with Node.js.

Do not install TypeScript globally.

TypeScript should be a project-local development dependency so that the repository records the exact version used.

---

# 3. TypeScript

Current stable version:

```text
TypeScript 7.0.2
```

Install it locally when initializing the project:

```powershell
npm install --save-dev typescript@7.0.2
```

Verify:

```powershell
npx tsc --version
```

Do not rely on a globally installed `tsc`.

The project's `package.json` and lockfile are authoritative for the version used by the application.

---

# 4. Git

Git is required for source control and is strongly recommended even for a short technical challenge.

Current Git for Windows release at the time this document was written:

```text
Git 2.55.0
```

The Windows installer may report a build suffix such as:

```text
2.55.0(5)
```

Verify:

```powershell
git --version
```

Configure the identity used for commits if it has not already been configured:

```powershell
git config --global user.name "Your Name"
git config --global user.email "your@email.example"
```

Do not commit:

* AWS credentials;
* API keys;
* `.env` files containing secrets;
* local AWS configuration;
* generated credentials;
* IDE-specific secrets.

The repository should contain an appropriate `.gitignore`.

---

# 5. IDE

## Recommended: JetBrains WebStorm

WebStorm is the preferred IDE for this project. It is specifically designed for JavaScript/TypeScript and Node.js development and provides everything needed for this challenge.

Current stable release:

### JetBrains WebStorm 2026.2.1

Useful WebStorm capabilities:

- TypeScript/JavaScript language support;
- Node.js and npm integration;
- npm script execution;
- integrated terminal;
- debugger;
- Vitest/test runner integration;
- Git integration;
- ESLint and Prettier integration;
- JSON/YAML support;
- integrated HTTP Client for API testing;
- Docker support if Docker is used;
- code inspections and refactoring.

Make sure the Node.js runtime configured by WebStorm points to the intended Node 24 LTS installation.

The integrated HTTP Client is particularly useful for this challenge because API requests can be kept as .http files in the repository, providing a convenient way to manually exercise endpoints without requiring Postman or another API client.

### Alternative: Visual Studio Code

Visual Studio Code is also a suitable choice for the project, particularly if using an AI coding agent through its editor integration.

Current stable release as of this document:

`Visual Studio Code 1.134`

Useful extensions include:

- ESLint;
- Prettier;
- AWS Toolkit;
- TypeScript/JavaScript language support.

Use either WebStorm or VS Code. There is no need to install or maintain multiple IDEs solely for this project.

### Other JetBrains IDEs

Rider and IntelliJ IDEA are capable of supporting parts of this project, but neither is the preferred choice:

- Rider is primarily targeted at .NET development and provides more functionality than this TypeScript-only project requires.
- IntelliJ IDEA Community is primarily targeted at Java development and is therefore not the most appropriate JetBrains IDE for this project.

If the challenge were implemented in Java instead of TypeScript, IntelliJ IDEA would be the natural JetBrains choice.

---

# 6. AI Development Tool

The challenge explicitly permits AI assistance.

Only one paid AI coding service is necessary.

## Recommended: Claude Pro + Claude Code

Claude Pro currently includes Claude Code.

Claude Pro is currently:

```text
$20/month
```

or approximately:

```text
$17/month
```

when billed annually.

Claude Code is particularly suitable for this challenge because it can operate directly against the repository, read the `docs/*.md` steering/specification files, modify files, run tests, and inspect command output.

The important point is not which AI is used, but that its work is governed by:

* `docs/1 - spec.md`
* `docs/2 - plan.md`
* `docs/3 - steering-rules.md`
* `docs/4 - architecture.md`
* `docs/5 - testing.md`
* `docs/6 - prompts.md`

Do not let the AI treat the repository as an empty greenfield project after these documents have been established.

## Alternative: OpenAI Codex

OpenAI Codex CLI is another suitable coding agent.

Current npm release at the time of writing:

```text
@openai/codex 0.150.1
```

It can be installed with:

```powershell
npm install --global @openai/codex
```

However, a separate paid Claude subscription is not necessary if Codex is the chosen coding agent.

## Do Not Buy Both Solely for This Challenge

The challenge only requires evidence of AI-assisted development.

There is no technical need to pay for both Claude and OpenAI specifically for this project.

Choose one primary coding agent.

If an existing ChatGPT subscription already provides suitable Codex access, use that rather than purchasing another service solely for the challenge.

---

# 7. AWS Account

An AWS account is required if DynamoDB is going to be used as the actual external persistence layer.

AWS is explicitly named in the challenge through the DynamoDB and CloudFormation bonuses.

The application should use a dedicated development AWS account if one is available.

If using a personal AWS account, be particularly careful about credentials and billing.

---

# 8. AWS CLI

Install **AWS CLI version 2**.

As of this document, the current CLI 2.36.x line is current.

Verify after installation:

```powershell
aws --version
```

The exact patch version may change during the challenge; using the latest AWS CLI v2 release is preferred.

AWS CLI v2 is the appropriate CLI. Do not install AWS CLI v1 for this project.

---

# 9. AWS Authentication

## Preferred: IAM Identity Center

Use temporary credentials rather than long-lived IAM access keys where practical.

AWS recommends IAM Identity Center/temporary credentials rather than long-lived IAM user credentials.

Configure the CLI:

```powershell
aws configure sso
```

Then authenticate:

```powershell
aws sso login --profile webhook-challenge
```

Verify:

```powershell
aws sts get-caller-identity --profile webhook-challenge
```

The output should identify the intended AWS account and role.

When running commands during development, use the named profile explicitly:

```powershell
aws dynamodb list-tables --profile webhook-challenge
```

Or configure the application to use the same AWS profile during local development.

## Important

Never create AWS access keys for the AWS root user.

The root account should have MFA enabled and should be used only for tasks that genuinely require root privileges.

---

# 10. AWS Permissions

The development identity needs enough access to:

* DynamoDB;
* CloudFormation;
* CloudWatch/logging if used;
* STS identity verification.

A broad development permission set such as `PowerUserAccess` is acceptable for a personal challenge account if necessary, although a narrower custom permission set is preferable.

For a production system, use the least privilege.

Do not give the running application unnecessary administrative AWS permissions.

---

# 11. AWS Region

Choose one AWS region and use it consistently.

A reasonable default is:

```text
eu-central-1
```

because the development environment is in Europe.

Configure the AWS CLI:

```powershell
aws configure set region eu-central-1 --profile webhook-challenge
```

Verify:

```powershell
aws configure get region --profile webhook-challenge
```

The application configuration, CloudFormation template, and CLI should use the same region during development unless there is a specific reason not to.

---

# 12. AWS Billing Protection

Before creating resources, configure billing protection.

At minimum:

* enable AWS account billing notifications;
* create a small AWS Budget;
* configure email notification for unexpected spend.

The application should cost little or nothing at this scale, but "probably free" is not an acceptable billing-control strategy.

Do not assume that every AWS service or configuration is free merely because DynamoDB has an always-free allowance.

---

# 13. DynamoDB

DynamoDB is the preferred persistence technology for this challenge because the specification explicitly identifies it as a bonus.

DynamoDB currently includes an always-free tier containing:

* 25 GB storage;
* 25 provisioned WCU;
* 25 provisioned RCU.

This is vastly more capacity than this challenge should require.

The service should therefore remain effectively free at challenge scale, provided unnecessary resources and traffic are not introduced.

## Capacity Mode

The implementation should choose the simplest sensible capacity configuration.

For a tiny development workload, either:

* on-demand capacity; or
* appropriately sized provisioned capacity

is technically viable.

The choice should be documented.

Do not optimize DynamoDB capacity for a workload that does not exist.

---

# 14. DynamoDB Local

DynamoDB Local is **optional**.

It is not required for the first implementation.

The preferred testing strategy is:

```text
Unit tests
    ↓
in-memory repository/test doubles

Integration tests
    ↓
appropriate local/test persistence

AWS verification
    ↓
real DynamoDB development resources
```

Do not introduce DynamoDB Local merely because it exists.

If the implementation benefits from DynamoDB Local, Docker Desktop can be installed as an optional development dependency.

---

# 15. Docker

Docker is **optional**.

It is not required for the basic implementation.

The application can run directly on Node.js.

Docker becomes useful if we later decide to use:

* DynamoDB Local;
* LocalStack;
* containerized integration tests;
* a reproducible local environment.

Do not make Docker a prerequisite unless the implementation actually needs it.

---

# 16. CloudFormation

The challenge specifically requests CloudFormation.

No separate CloudFormation application is required.

CloudFormation functionality is available through the AWS CLI.

Useful commands include:

```powershell
aws cloudformation validate-template `
  --template-body file://cloudformation/template.yaml `
  --profile webhook-challenge
```

CloudFormation resources can also be deployed through the AWS Management Console or CLI if desired.

## AWS CDK

AWS CDK is **not required**.

Do not install or introduce CDK merely because it is another AWS Infrastructure-as-Code tool.

The challenge explicitly asks for CloudFormation configuration, so a normal YAML CloudFormation template is simpler and more directly aligned with the requirement.

---

# 17. CloudFormation Linter

A useful optional tool is `cfn-lint`.

Current version:

```text
cfn-lint 1.55.1
```

It can be installed with Python:

```powershell
py -m pip install cfn-lint
```

Verify:

```powershell
cfn-lint --version
```

Then validate:

```powershell
cfn-lint cloudformation/template.yaml
```

This is recommended because the challenge explicitly requests a CloudFormation artifact.

It is not required for the application itself.

---

# 18. Node.js Development Dependencies

These should be installed locally in the project rather than globally.

The following versions are current stable versions at the time this document was prepared:

| Package    | Version | Purpose                         |
|------------|--------:|---------------------------------|
| TypeScript |   7.0.2 | TypeScript compiler             |
| Vitest     |  4.1.11 | Unit/integration testing        |
| ESLint     |  10.9.1 | Static analysis                 |
| Prettier   |   3.9.6 | Formatting                      |
| tsx        | 4.23.12 | Convenient TypeScript execution |

Install them as project dependencies as appropriate.

Do not blindly install every package listed above if the selected project tooling provides an equivalent capability.

The final `package.json` and lockfile are authoritative.

---

# 19. AWS SDK for JavaScript

Use the AWS SDK for JavaScript v3.

For DynamoDB:

```text
@aws-sdk/client-dynamodb
```

and, if useful:

```text
@aws-sdk/lib-dynamodb
```

Current versions are changing frequently.

At the time this document was checked:

```text
@aws-sdk/client-dynamodb 3.1119.0
@aws-sdk/lib-dynamodb    3.1116.0
```

Rather than globally installing these packages, add them to the project and commit the lockfile.

The application should use the SDK through a persistence/infrastructure layer rather than scattering AWS SDK calls throughout the domain code.

---

# 20. HTTP/API Testing Tool

A dedicated API client is optional.

The following are sufficient:

* `curl`;
* PowerShell's `Invoke-RestMethod`;
* Rider's HTTP Client;
* VS Code REST Client;
* Postman.

Because Rider already provides an HTTP client, a separate Postman installation is unnecessary unless preferred.

Example:

```powershell
Invoke-RestMethod `
  -Method Post `
  -Uri http://localhost:3000/subscriptions `
  -ContentType "application/json" `
  -Body '{"eventType":"order.created","targetUrl":"https://example.com/webhook"}'
```

---

# 21. Browser

A normal modern browser is required for:

* AWS Console;
* Claude;
* OpenAI/Codex if applicable;
* Railway if used;
* authentication/SSO;
* documentation.

Chrome, Edge, or Firefox are all suitable.

No special browser configuration should be necessary.

---

# 22. GitHub

GitHub is optional but recommended.

If the challenge submission is simply a ZIP archive, the final source does not necessarily need to be hosted on GitHub.

However, Git provides useful local history during AI-assisted development.

A local repository should be initialized before implementation:

```powershell
git init
```

Create an initial commit containing the documentation before AI-generated implementation begins.

This provides a clean baseline.

---

# 23. Railway

Railway is optional.

It can be useful for deploying the TypeScript application to a public HTTPS endpoint.

Possible architecture:

```text
Railway
    |
    +-- TypeScript application
             |
             | AWS SDK
             v
         DynamoDB
```

Railway is not required to satisfy the challenge.

It should not replace DynamoDB if DynamoDB is being used to demonstrate the requested AWS bonus.

If deployment time becomes an issue, prioritize the local implementation, tests, DynamoDB, and CloudFormation.

---

# 24. AWS Resources to Create

The initial AWS environment should be intentionally small.

Expected resources:

```text
AWS Account
    |
    +-- DynamoDB
    |     |
    |     +-- application persistence
    |
    +-- CloudFormation
          |
          +-- optional stack for the above resources
```

Do not create:

* EC2 instances;
* ECS clusters;
* EKS clusters;
* RDS databases;
* Lambda functions;
* API Gateway;
* SQS;
* SNS;
* EventBridge;

unless the final architecture explicitly requires them.

The four-hour challenge does not justify building a complete AWS platform.

---

# 25. Local Directory Structure

Before implementation, the project should roughly resemble:

```text
webhook-registry/
│
├── docs/
│   ├── architecture.md
│   ├── plan.md
│   ├── prompts.md
│   ├── spec.md
│   ├── steering-rules.md
│   └── testing.md
│
├── src/
│
├── tests/
│
├── infrastructure/
│
├── package.json
├── package-lock.json
├── tsconfig.json
├── .gitignore
└── README.md
```

The exact source layout is an implementation decision.

Do not create all directories merely because they appear in this example if they are not needed.

---

# 26. Environment Variables

Do not commit secrets or machine-specific configuration.

A development configuration may eventually contain variables such as:

```text
NODE_ENV=development
PORT=3000

AWS_REGION=eu-central-1
AWS_PROFILE=webhook-challenge

DYNAMODB_TABLE_NAME=webhook-registry

WEBHOOK_TIMEOUT_MS=5000
MAX_DELIVERY_ATTEMPTS=3
RETRY_BASE_DELAY_MS=1000
RECOVERY_INTERVAL_MS=60000
```

The exact names are implementation decisions.

Provide:

```text
.env.example
```

if environment variables are used.

Do not commit:

```text
.env
```

when it contains local secrets/configuration.

---

# 27. Pre-Implementation Verification

Before beginning the actual challenge implementation, verify all the following.

## Local Tools

```powershell
node --version
npm --version
git --version
aws --version
```

If using Python/cfn-lint:

```powershell
python --version
cfn-lint --version
```

## AWS Authentication

```powershell
aws sts get-caller-identity --profile webhook-challenge
```

The result must identify the intended AWS account.

## AWS Region

```powershell
aws configure get region --profile webhook-challenge
```

Expected:

```text
eu-central-1
```

or whichever region was deliberately selected.

## AWS DynamoDB Access

Verify that the development identity can query DynamoDB:

```powershell
aws dynamodb list-tables --profile webhook-challenge
```

An empty table list is fine.

The command itself must succeed.

## Git

```powershell
git status
```

The project should be a clean Git repository before implementation begins.

---

# 28. Recommended Installation Order

Perform setup in this order:

1. Install/update Node.js 24 LTS.
2. Verify npm.
3. Install/update Git.
4. Update Rider or VS Code.
5. Install AWS CLI v2.
6. Configure AWS authentication.
7. Enable AWS root MFA.
8. Configure AWS billing protection/budget.
9. Select AWS region.
10. Verify DynamoDB access.
11. Install `cfn-lint` if desired.
12. Install/configure the chosen AI coding agent.
13. Initialize the Git repository.
14. Verify the development environment.
15. Start the AI-assisted implementation process using `docs/6 - prompts.md`.

---

# 29. What Is Actually Required?

## Required

```text
✓ Node.js 24 LTS
✓ npm
✓ Git
✓ TypeScript project
✓ TypeScript compiler
✓ Test framework
✓ An IDE
✓ AWS account
✓ AWS CLI v2
✓ AWS authentication
✓ DynamoDB access
✓ One AI coding assistant
```

## Strongly Recommended

```text
✓ ESLint
✓ Prettier
✓ cfn-lint
✓ AWS billing budget
✓ Git repository
✓ README
```

## Optional

```text
○ Docker
○ DynamoDB Local
○ LocalStack
○ Postman
○ Railway
○ AWS CDK
○ OpenAI Codex if Claude is being used
○ Claude if Codex is being used
```

Do not install optional tools merely for the sake of having them.

---

# 30. Final Principle

The development environment should remain deliberately boring.

The challenge is evaluating the webhook registry and dispatcher, not the sophistication of the developer's infrastructure.

Prefer:

```text
Node.js
TypeScript
HTTP API
DynamoDB
AWS CLI
CloudFormation
Tests
AI coding agent
```

over an unnecessarily large stack.

The implementation should demonstrate that additional infrastructure could be introduced when justified, without introducing it merely because it exists.
