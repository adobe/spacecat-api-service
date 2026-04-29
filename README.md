# SpaceCat API Service

> Provides an HTTP API to interact with SpaceCat data

## HTTP API Doc

https://opensource.adobe.com/spacecat-api-service/

### Build documentation locally

```bash
$ npm run docs
```

### Serve the documentation locally

```bash
$ npm run docs:serve
```

## Brand Presence Endpoints

### `POST /sites/:siteId/brand-presence/metrics`

Ingests a batch of brand presence execution metrics for a site into ClickHouse.

**Auth:** requires the `brand-presence.write` scope.

**Request body:**
```json
{
  "metrics": [
    {
      "site_id": "6221ce8b-40cd-4a80-8d97-b15e4f75de5e",
      "week": "2025-W38",
      "platform": "perplexity",
      "category": "brand",
      "topic": "product",
      "prompt": "What is the best product for X?",
      "visibility_score": 75.0,
      "mention_count": 5
    }
  ]
}
```

**Response `201`:** batch accepted. Records that fail ClickHouse validation are reported in `failures` without rejecting the whole batch.
```json
{
  "metadata": { "total": 3, "success": 2, "failure": 1 },
  "items": [ ... ],
  "failures": [ { "index": 2, "error": "visibility_score must be between 0 and 100" } ]
}
```

`visibility_score` must be between `0` and `100`. Requests with a missing or non-array `metrics` field return `400`.

---

### `GET /sites/:siteId/brand-presence/data`

Queries brand presence execution records for a site from ClickHouse.

**Auth:** standard API key.

**Query parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `start_week` | `string` | — | Start of week range, inclusive. Format: `YYYY-Www` (e.g. `2025-W01`). |
| `end_week` | `string` | — | End of week range, inclusive. Format: `YYYY-Www`. Must be ≥ `start_week`. |
| `platform` | `string` | — | Filter by platform. Omit or pass `all` to return all platforms. |
| `limit` | `integer` | `1000` | Maximum records to return. Must be ≥ 1. |
| `offset` | `integer` | `0` | Number of records to skip. Must be ≥ 0. |

**Response `200`:**
```json
{
  "metadata": { "total": 42, "limit": 100, "offset": 0 },
  "data": [ ... ]
}
```

Invalid week formats, `start_week` after `end_week`, or out-of-range `limit`/`offset` return `400` with a descriptive message.

---

## Installation

```bash
$ npm install @adobe/spacecat-api-service
```

## Usage

See the [API documentation](docs/API.md).

## Development

### Prerequisites

- **Node.js** (see `.nvmrc` for version)
- **Docker Desktop** (or equivalent Docker daemon)
- **AWS CLI** + ECR access for the private `mysticat-data-service` image

### Option 1: Local PostgreSQL via Docker (Recommended)

The API service uses PostgreSQL + PostgREST as its data backend. The same Docker Compose stack used by integration tests can be used for local development.

#### 1. Authenticate Docker to ECR (first time / every 12 hours)

The data-service image is hosted in a private AWS ECR registry under **SpaceCat Development (AWS3338)**.

1. Get temporary AWS credentials from KLAM for the **SpaceCat Development (AWS3338)** account
2. Add them to `~/.aws/credentials` under a profile name of your choice (e.g. `spacecat-dev`):

```ini
[spacecat-dev]
aws_access_key_id = <your-access-key-id>
aws_secret_access_key = <your-secret-access-key>
aws_session_token = <your-session-token>
```

3. Authenticate Docker to ECR (replace `spacecat-dev` with your profile name):

```bash
aws ecr get-login-password --profile spacecat-dev --region us-east-1 \
  | docker login --username AWS --password-stdin 682033462621.dkr.ecr.us-east-1.amazonaws.com
```

ECR login tokens expire after 12 hours. Re-run step 3 if you see `pull access denied` errors.

#### 2. Start the database stack

```bash
docker compose -f test/it/postgres/docker-compose.yml up -d
```

This starts:
- **PostgreSQL 16** on port `55432`
- **PostgREST** (with auto-applied dbmate migrations) on port `3300`

Wait for PostgREST to become ready:

```bash
curl -sf http://localhost:3300/ > /dev/null && echo "Ready" || echo "Not ready yet"
```

#### 3. Create your `.env` file

```bash
cp .env.example .env
```

All required variables (including `POSTGREST_API_KEY`) are pre-filled with working local-dev values. See [`.env.example`](.env.example) for details. The canonical source of truth for env variables is `test/it/env.js`.

#### 4. Start the development server

```bash
npm start
```

The server will start on `http://localhost:3002` by default.

#### 5. Tear down the database stack

```bash
docker compose -f test/it/postgres/docker-compose.yml down -v
```

### Option 2: Connect to Dev PostgREST Directly (No Docker)

If you don't want to run Docker locally, you can point the API service directly at the dev environment's PostgREST instance via CloudFront. This requires VPN access from a supported Adobe office (Basel, Dublin, San Jose).

> **Limitations**: The anonymous PostgREST role only supports **SELECT** and **INSERT**. UPDATE and DELETE operations require a `POSTGREST_API_KEY` JWT signed with the dev environment's secret (stored in Vault).

1. Copy the `.env.example` and update the PostgREST URL to the dev CloudFront URL:

```bash
cp .env.example .env
```

```plaintext
POSTGREST_URL=<dev CloudFront URL>
```

Find the dev CloudFront URL in the [mysticat-data-service CLAUDE.md](https://github.com/adobe/mysticat-data-service/blob/main/CLAUDE.md) under "CloudFront URLs" (not listed here as this is a public repo).

2. Start the dev server:

```bash
npm start
```

### Option 3: Full mysticat-data-service Stack

For a richer local environment (Swagger UI, separate test database, persistent data), clone the [mysticat-data-service](https://git.corp.adobe.com/anthropic/mysticat-data-service) repo and use its Docker Compose setup:

```bash
cd /path/to/mysticat-data-service/docker
docker compose up -d
```

This starts:
- **PostgreSQL 16** on port `5432` (with persistent volume and auto-applied migrations)
- **PostgREST** on port `3000`
- **Swagger UI** on port `8080` (API exploration at http://localhost:8080)

Then use the same `.env` from Option 1 (`cp .env.example .env`), but change the PostgREST URL:

```plaintext
POSTGREST_URL=http://localhost:3000
```

### Changing the Port

The dev server defaults to port `3002`. To change it, set the `PORT` variable in your `.env` file:

```plaintext
PORT=3001
```

### Build

```bash
$ npm install
```

### Test

```bash
$ npm test
```

To run a single test file:

```bash
npx mocha test/path/to/file.test.js
```

To run a single test file with a filter pattern:

```bash
npx mocha test/path/to/file.test.js -g "pattern"
```

Examples:

```bash
# Run all brand presence controller tests
npx mocha test/controllers/brand-presence.test.js

# Run only the ingest endpoint tests
npx mocha test/controllers/brand-presence.test.js -g "ingest endpoint"

# Run a specific test case by ID
npx mocha test/controllers/brand-presence.test.js -g "P-01"
```

### E2E Tests

End-to-end tests validate the API against the live CI environment.

#### Setup

Add the following to your `.env` file:

```plaintext
USER_API_KEY=your_api_key_for_ci_environment
```

The E2E tests use a hardcoded test site ID and auto-discover opportunities/suggestions for testing.
(You can change site id according to you)

#### Run E2E Tests Locally

```bash
$ npm run test-e2e
```

### Lint

```bash
$ npm run lint
```

### Integration Tests

Integration tests validate the full API lifecycle against real database backends (DynamoDB and PostgreSQL). They test routing, controllers, DTOs, access control, and data access in a single pass — no mocks.

```bash
# DynamoDB suite (requires Java 17+)
$ npx mocha --require test/it/dynamo/harness.js --timeout 30000 'test/it/dynamo/**/*.test.js'

# PostgreSQL suite (requires Docker + ECR access)
$ npx mocha --require test/it/postgres/harness.js --timeout 30000 'test/it/postgres/**/*.test.js'
```

Both suites run automatically in CI as parallel GitHub Actions jobs. For the full guide on structure, extending tests, and troubleshooting, see [test/it/README.md](test/it/README.md).

## Required ENV Variables

Currently, audit worker requires two env variables:

```plaintext
AUDIT_JOBS_QUEUE_URL=url of the queue to send audit jobs to
AUDIT_REPORT_SLACK_CHANNEL_ID=slack channel id to send the audit reports to
RUM_DOMAIN_KEY=global domain key for the rum api
SLACK_BOT_TOKEN=slack bot's token,
```

Fulfillment worker requires the following env variable:

```plaintext
FULFILLMENT_EVENTS_QUEUE_URL=url of the queue to send fulfillment events to
```

Organizations controller requires the following env variable:

```plaintext
SLACK_URL_WORKSPACE_EXTERNAL=url of the external Slack workspace, used to generate the Slack channel url
```

Slack controller requires the following env variables:

```plaintext
IMS_CLIENT_ID=client id for the IMS API
IMS_HOST=host for the IMS API
IMS_CLIENT_CODE=client code for the IMS API
IMS_CLIENT_SECRET=client secret for the IMS API

SLACK_TOKEN_WORKSPACE_EXTERNAL_ELEVATED=Slack token for the external workspace, elevated permissions
SLACK_OPS_CHANNEL_WORKSPACE_EXTERNAL=channel ID to use for operations messages in the external workspace
AGENT_WORKFLOW_STATE_MACHINE_ARN=ARN of the generic agent Step Functions workflow (used by the brand-profile Slack command)
```

LLMO onboarding requires the following env variable:

```plaintext
SLACK_LLMO_ALERTS_CHANNEL_ID=slack channel id for LLMO onboarding alerts (data folder exists, site already assigned)
```

Sandbox audit rate-limit (optional):

Minimum hours that must elapse before the same audit can run again for the same site. 
Default is 4 hrs. Set the variable to 0 to disable the rate-limit
entirely.

```plaintext
SANDBOX_AUDIT_RATE_LIMIT_HOURS=4
```

Import controller requires the following env variables:

```plaintext
IMPORT_CONFIGURATION=JSON document which includes the following configuration properties:
  - allowedApiKeys: array of allowed API keys, used to authenticate import requests
  - queues: array of queue names to use for import jobs. If a queue name is removed from this array, it will no longer be available for new import jobs
  - queueUrlPrefix: prefix for import queue URLs (eg. https://sqs.us-east-1.amazonaws.com/1234567890/), used to create the complete queue URL for import jobs
  - s3Bucket: the S3 bucket to store import job artifacts
```

The `multipartFormData` wrapper uses the following optional env variables:

```plaintext
MULTIPART_FORM_FILE_COUNT_LIMIT=Maximum number of files which can be included in a multipart/form-data request (defaults to 5)
MULTIPART_FORM_MAX_FILE_SIZE_MB=Maximum file size in MB for a single file in a multipart/form-data request (defaults to 20)
```
