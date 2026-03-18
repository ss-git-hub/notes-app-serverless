# Notes App — Serverless TypeScript

A production-grade serverless REST API built with AWS Lambda, API Gateway, and DynamoDB.
This README serves as a quick reference for the architecture and config concepts used in this project.

---

## Table of Contents

- [Project Structure](#project-structure)
- [Config Files](#config-files)
  - [serverless.yml](#serverlessyml)
  - [config/functions.yml](#configfunctionsyml)
  - [config/resources.yml](#configresourcesyml)
  - [config/iam.yml](#configiamyml)
  - [config/environment.yml](#configenvironmentyml)
- [How the Config Files Connect](#how-the-config-files-connect)
- [Key Concepts](#key-concepts)
- [API Endpoints](#api-endpoints)
- [Deployment](#deployment)
- [Useful Commands](#useful-commands)
- [Install and Configure AWS](#install-and-configure-aws)

---

## Project Structure

```
notes-app-serverless/
├── config/
│   ├── environment.yml   # environment variables (replaces .env)
│   ├── functions.yml     # Lambda functions and API routes (replaces Express router)
│   ├── iam.yml           # permissions (what Lambdas are allowed to do)
│   └── resources.yml     # AWS infrastructure (DynamoDB tables etc.)
├── shared/
│   ├── dynamo.ts         # shared DynamoDB client
│   ├── response.ts       # shared HTTP response helpers (replaces res.json())
│   └── types.ts          # shared TypeScript interfaces
├── authorizer/
│   └── handler.ts        # JWT Lambda Authorizer (replaces Express auth middleware)
├── users/
│   ├── register.ts
│   ├── login.ts
│   ├── getProfile.ts
│   └── updateProfile.ts
├── notes/
│   ├── create.ts
│   ├── getAll.ts
│   ├── getOne.ts
│   ├── update.ts
│   └── delete.ts
├── serverless.yml         # main orchestrator — pulls in all config files
├── tsconfig.json
└── package.json
```

---

## Config Files

The `serverless.yml` is intentionally kept lean. All configuration is split across four
dedicated files inside `config/`. This keeps the project maintainable as it grows —
each file owns exactly one concern.

---

### `serverless.yml`

The **orchestrator**. It does not contain any configuration itself — it just pulls in
the four config files and defines the global provider settings.

```yaml
service: notes-app          # app name — prefixes all AWS resources

plugins:
  - serverless-plugin-typescript   # compiles TypeScript before deploy

provider:
  name: aws
  runtime: nodejs18.x
  region: us-east-1
  stage: ${opt:stage, 'dev'}       # pass --stage prod to override
  environment: ${file(config/environment.yml)}
  iam:
    role:
      statements: ${file(config/iam.yml)}

functions: ${file(config/functions.yml)}
resources: ${file(config/resources.yml)}
```

**Key idea:** `serverless.yml` is the equivalent of your `server.js` entry point —
it wires everything together but does not contain business logic.

---

### `config/functions.yml`

The **Express router equivalent**. Every function block = one Lambda = one API endpoint.

#### Structure of a single function

```yaml
functionName:                        # internal label used in CLI commands
  handler: path/to/file.exportedFn   # file path + exported function name
  events:
    - http:
        path: /your-path             # URL path
        method: post                 # HTTP method
        authorizer: authorizer       # optional — omit for public routes
        cors: true                   # required for React frontend to call this
```

#### Breaking down each field

| Field | What it does | Express equivalent |
|---|---|---|
| `functionName` | Internal label for CLI and AWS console | Route variable name |
| `handler` | `file.exportedFunction` — tells AWS where your code is | `require('./routes/notes')` |
| `events.http` | Makes API Gateway trigger this Lambda via HTTP | `app.use('/notes', router)` |
| `path` | The URL path | `router.post('/')` |
| `method` | HTTP verb | `router.post`, `router.get` etc. |
| `authorizer` | Runs JWT check Lambda before this Lambda | `app.use(authMiddleware)` |
| `cors: true` | Adds CORS headers so browser requests are allowed | `app.use(cors())` |

#### Event types

Right now all functions use `http` events (triggered by API Gateway).
In later phases you will encounter other event types:

```yaml
# HTTP request triggers Lambda (Phase 1 — what you have now)
events:
  - http: { path: /notes, method: post }

# SQS message triggers Lambda (Phase 3 — event-driven)
events:
  - sqs:
      arn: !GetAtt MyQueue.Arn

# SNS notification triggers Lambda (Phase 3 — notifications)
events:
  - sns:
      arn: !Ref MyTopic
```

---

### `config/resources.yml`

Defines the **actual AWS infrastructure** your Lambda functions depend on.
This is the equivalent of running `mongoose.connect()` and creating your
collections — except here you are defining the real database infrastructure itself.

Follows CloudFormation syntax:

```yaml
Resources:
  LogicalName:               # internal reference used elsewhere in config
    Type: AWS::Service::ResourceType
    Properties:
      # resource-specific configuration
```

#### Key concepts

**LogicalName** — a name you choose. Used to reference this resource elsewhere.
For example `!GetAtt NotesTable.Arn` in `iam.yml` refers to the `NotesTable`
logical name defined here.

**Type** — tells CloudFormation what to create. Follows the pattern `AWS::Service::Resource`:
- `AWS::DynamoDB::Table` — creates a DynamoDB table
- `AWS::S3::Bucket` — creates an S3 bucket
- `AWS::SQS::Queue` — creates an SQS queue

**BillingMode: PAY_PER_REQUEST** — you pay per database operation rather than
provisioning capacity upfront. Zero traffic = zero cost. Always use this for
learning and low-traffic projects.

**KeySchema** — DynamoDB requires you to define keys upfront:
- `HASH` — partition key (like a MongoDB collection grouping). All items with the
  same partition key are stored together. Use the most common query field here.
- `RANGE` — sort key (like a unique ID within a partition). Enables range queries
  and sorting within a partition.

**GlobalSecondaryIndex (GSI)** — DynamoDB can only query by its partition key natively.
A GSI adds a secondary index on a different field, enabling efficient queries on that
field. In this project the Users table has a GSI on `email` so login can look up
users by email without scanning the entire table.

---

### `config/iam.yml`

Answers one question: **what is this Lambda allowed to do?**

In Express your server can connect to any database it has credentials for. In AWS,
**everything is denied by default**. You must explicitly grant each permission.
This is called the **Principle of Least Privilege** — grant only what the code
actually needs, nothing more.

```yaml
- Effect: Allow          # Allow or Deny
  Action:                # specific operations permitted
    - dynamodb:PutItem
    - dynamodb:GetItem
    - dynamodb:Query
  Resource:              # which specific AWS resources this applies to
    - !GetAtt NotesTable.Arn
```

#### Key concepts

**Effect** — almost always `Allow`. `Deny` is used in advanced scenarios to
explicitly override an allow elsewhere.

**Action** — granular operations. DynamoDB example:
- `dynamodb:PutItem` — INSERT a new item
- `dynamodb:GetItem` — GET a single item by key
- `dynamodb:UpdateItem` — UPDATE an existing item
- `dynamodb:DeleteItem` — DELETE an item
- `dynamodb:Query` — QUERY items by partition key

**Resource** — which specific resource this permission applies to.

**`!GetAtt NotesTable.Arn`** — CloudFormation intrinsic function. Reads as
"get the ARN attribute of the NotesTable resource defined in resources.yml".

**ARN (Amazon Resource Name)** — a unique identifier for any AWS resource.
Like a connection string but for the entire AWS ecosystem.
Format: `arn:aws:dynamodb:us-east-1:123456789:table/notes-app-dev-notes`

**Why the GSI needs its own permission:**
```yaml
- !Sub "${UsersTable.Arn}/index/email-index"
```
DynamoDB GSIs are treated as separate resources. Without this line your
Lambda cannot query the email index even if it can access the table itself.

---

### `config/environment.yml`

Your **`.env` file for AWS**. Every key defined here is available inside
every Lambda via `process.env.KEY_NAME` — exactly like a `.env` file in Express.

```yaml
NOTES_TABLE: ${self:service}-${sls:stage}-notes
```

#### Serverless Framework variable syntax

| Syntax | What it resolves to | Example |
|---|---|---|
| `${self:service}` | The `service` name in `serverless.yml` | `notes-app` |
| `${sls:stage}` | The current deployment stage | `dev` or `prod` |
| `${opt:stage, 'dev'}` | CLI option with fallback default | `dev` |
| `${ssm:/path/to/secret}` | Value from AWS SSM Parameter Store | your JWT secret |
| `${file(path.yml)}` | Contents of another YAML file | used in `serverless.yml` |

#### Why stage in the table name?

```yaml
NOTES_TABLE: ${self:service}-${sls:stage}-notes
# dev  → notes-app-dev-notes
# prod → notes-app-prod-notes
```

Your dev and prod environments automatically get completely separate DynamoDB tables
without any extra configuration. You can deploy to dev, break things, and your
production data is completely unaffected.

#### Why SSM for secrets?

```yaml
JWT_SECRET: ${ssm:/notes-app/jwt-secret}
```

Never put secrets in YAML files that get committed to Git. SSM Parameter Store
keeps secrets centrally managed, access-controlled by IAM, and completely out
of your codebase.

---

## How the Config Files Connect

```
serverless.yml  (orchestrator — pulls everything together)
│
├── functions.yml   "here are my Lambda functions and API routes"
│       │
│       └── each function references a handler file in users/ or notes/
│           and optionally references the authorizer function
│
├── resources.yml   "here is the infrastructure those functions need"
│       │
│       └── creates DynamoDB tables, assigns logical names (NotesTable, UsersTable)
│
├── iam.yml         "here is what those functions are allowed to do"
│       │
│       └── references logical names from resources.yml via !GetAtt
│
└── environment.yml "here are the environment variables for all functions"
        │
        └── table names reference ${self:service} and ${sls:stage}
            secrets reference SSM Parameter Store
```

None of these files work in isolation. They only mean something together.

---

## Key Concepts

### Traditional Express vs Serverless

| Concept | Express | Serverless Lambda |
|---|---|---|
| Entry point | `server.js` + `app.listen()` | `serverless.yml` |
| Routing | Express Router | `functions.yml` events |
| Request data | `req.body`, `req.params` | `event.body`, `event.pathParameters` |
| Auth | `app.use(authMiddleware)` | Lambda Authorizer |
| Response | `res.status(200).json({})` | `return { statusCode, headers, body }` |
| DB connection | `mongoose.connect()` | DynamoDB client (no persistent connection) |
| Env vars | `.env` via dotenv | SSM + `environment.yml` |
| Logs | `console.log` → terminal | `console.log` → CloudWatch |
| Deployment | SSH + PM2 | `serverless deploy` |
| Scaling | Manual (PM2 cluster, load balancer) | Automatic (AWS manages it) |

### Lambda Execution Model

Unlike Express which runs one persistent server, each Lambda function:
- Spins up on demand when a request arrives
- Runs your handler function
- Returns a response
- May stay warm for a few minutes, then shuts down

This means there is no persistent in-memory state between requests.
Everything must come from the database or environment variables.

### Cold Starts

When a Lambda function has not been invoked recently, AWS needs to initialise
a new execution environment. This takes 100–500ms and is called a cold start.
After the first request the function stays warm and subsequent requests are fast.

`AWS_NODEJS_CONNECTION_REUSE_ENABLED=1` in `environment.yml` reuses HTTP
connections between invocations, significantly reducing DynamoDB latency.

---

## API Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| POST | `/users/register` | Public | Create account |
| POST | `/users/login` | Public | Returns JWT token |
| GET | `/users/profile` | Protected | Get own profile |
| PUT | `/users/profile` | Protected | Update name or password |
| POST | `/notes` | Protected | Create a note |
| GET | `/notes` | Protected | Get all notes |
| GET | `/notes/{id}` | Protected | Get one note |
| PUT | `/notes/{id}` | Protected | Update a note |
| DELETE | `/notes/{id}` | Protected | Delete a note |

Protected routes require `Authorization: Bearer <token>` header.

---

## Deployment

### One-time setup

```bash
# Configure AWS credentials
aws configure

# Store JWT secret in SSM Parameter Store
aws ssm put-parameter \
  --name "/notes-app/jwt-secret" \
  --value "your-secret-min-32-chars" \
  --type SecureString \
  --region us-east-1
```

### Deploy

```bash
# Deploy to dev
npx serverless deploy --stage dev

# Deploy to prod
npx serverless deploy --stage prod
```

### Tear down (removes all AWS resources)

```bash
npx serverless remove --stage dev
```

---

## Useful Commands

```bash
# Deploy everything
npx serverless deploy --stage dev

# Deploy a single function (faster during development)
npx serverless deploy function -f createNote --stage dev

# Tail live logs from a function
npx serverless logs -f createNote --stage dev --tail

# Invoke a function directly without HTTP
npx serverless invoke -f getAllNotes --stage dev

# Check deployed stack info
npx serverless info --stage dev

# Compile TypeScript without deploying
npx tsc --noEmit
```

## Install and Configure AWS
npm install -g aws-cli

# Configure with your IAM user keys
aws configure

# It will ask:
# AWS Access Key ID:     (from the .csv you downloaded)
# AWS Secret Access Key: (from the .csv)
# Default region:        us-east-1
# Default output format: json

# Verify it works
aws sts get-caller-identity
# Should return your account ID and user ARN