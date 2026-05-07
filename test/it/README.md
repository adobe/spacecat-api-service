# Integration Tests (IT)

End-to-end integration tests that validate the full API request lifecycle - from HTTP request through middleware, routing, controllers, DTOs, and data access - against a real PostgreSQL database.

Tests run against **PostgreSQL** via PostgREST (Docker Compose), using `@adobe/spacecat-shared-data-access` with `DATA_SERVICE_PROVIDER=postgres`.

## Directory Structure

```
test/it/
├── server.js                     # Dev server start/stop
├── env.js                        # Environment variable builder
│
├── shared/                       # Backend-agnostic code
│   ├── seed-ids.js               # Canonical UUIDs and constants for all seed data
│   ├── auth.js                   # ES256 JWT generation (admin/user/trialUser)
│   ├── http-client.js            # HTTP client factory with auth personas
│   ├── postgrest-jwt.js          # PostgREST writer JWT for mutations
│   ├── helpers/
│   │   └── assertions.js         # Reusable assertion helpers
│   └── tests/                    # Shared test suites (18 files)
│       ├── sites.js
│       ├── organizations.js
│       ├── audits.js
│       ├── opportunities.js
│       ├── suggestions.js
│       ├── fixes.js
│       ├── projects.js
│       ├── entitlements.js
│       ├── site-enrollments.js
│       ├── audit-urls.js
│       ├── sentiment-topics.js
│       ├── sentiment-guidelines.js
│       ├── experiments.js
│       ├── site-top-pages.js
│       ├── user-activities.js
│       └── preflight.js
│
└── postgres/                     # PostgreSQL backend
    ├── harness.js                # Mocha root hooks (beforeAll/afterAll)
    ├── setup.js                  # Docker Compose startup + PostgREST polling
    ├── seed.js                   # TRUNCATE + re-seed via PostgREST HTTP API
    ├── docker-compose.yml        # PostgreSQL + PostgREST containers
    ├── .mocharc.postgres.yml     # Mocha config
    ├── seed-data/                # Seed data in snake_case
    │   ├── organizations.js
    │   ├── sites.js
    │   ├── audits.js
    │   ├── opportunities.js
    │   ├── suggestions.js
    │   ├── fixes.js
    │   ├── projects.js
    │   ├── entitlements.js
    │   ├── site-enrollments.js
    │   ├── experiments.js
    │   ├── site-top-pages.js
    │   ├── sentiment-topics.js
    │   ├── sentiment-guidelines.js
    │   ├── audit-urls.js
    │   ├── trial-users.js
    │   ├── trial-user-activities.js
    │   └── async-jobs.js
    └── *.test.js                  # Wiring files (16 files)
```

## What's Tested

### Entities and Endpoints

| Entity | Shared Test File | Key Endpoints | Test Count |
|--------|-----------------|---------------|------------|
| Sites | `sites.js` | GET/POST/PATCH /sites, /sites/by-base-url, /sites/by-delivery-type | ~16 |
| Organizations | `organizations.js` | GET/POST/PATCH /organizations, /organizations/by-ims-org-id | ~12 |
| Audits | `audits.js` | GET /audits (all variants), /audits/latest, /sites/:id/latest-audit | ~10 |
| Opportunities | `opportunities.js` | GET/POST/PATCH/DELETE /opportunities, /by-status | ~11 |
| Suggestions | `suggestions.js` | GET/POST/PATCH/DELETE /suggestions, /paged, /by-status | ~14 |
| Fixes | `fixes.js` | GET/POST/PATCH/DELETE /fixes, /by-status, /status batch | ~16 |
| Projects | `projects.js` | GET /projects (admin-only) | ~5 |
| Entitlements | `entitlements.js` | GET /organizations/:id/entitlements | ~4 |
| Site Enrollments | `site-enrollments.js` | GET /sites/:id/site-enrollments | ~5 |
| Audit URLs | `audit-urls.js` | GET/POST/PATCH /url-store, POST /url-store/delete, /by-audit | ~15 |
| Sentiment Topics | `sentiment-topics.js` | GET/POST/PATCH/DELETE /sentiment/topics | ~10 |
| Sentiment Guidelines | `sentiment-guidelines.js` | GET/POST/PATCH/DELETE /sentiment/guidelines | ~10 |
| Experiments | `experiments.js` | GET /experiments | ~5 |
| Site Top Pages | `site-top-pages.js` | GET /top-pages, /by-source, /by-source/:geo | ~7 |
| User Activities | `user-activities.js` | GET/POST /user-activities | ~6 |
| Preflight | `preflight.js` | POST/GET /preflight/jobs | ~10 |

**Total**: ~150+ test cases across 16 test suites.

### What Each Test Validates

- **Full HTTP lifecycle**: Request -> middleware -> routing -> controller -> DTO -> response
- **Access control**: Three auth personas (admin, user, trialUser) with different permission levels
- **CRUD operations**: Create, read, update, delete with proper HTTP status codes
- **Batch operations**: 201 batch-create and 207 multi-status response envelopes
- **Pagination**: Cursor-based pagination with `limit`, `hasMore`, and `cursor`
- **Error handling**: 400 (validation), 403 (forbidden), 404 (not found)
- **DTO transformation**: Response shapes match expected API contracts
- **Data relationships**: Junction tables (fixes<->suggestions), nested DTOs, entity references

## How It Works

### Architecture

```
┌────────────────────────────────────────────────────────────┐
│  Shared Test Logic (test/it/shared/tests/*.js)             │
│  - Test factories: export default function(getHttp, reset) │
│  - Backend-agnostic assertions                             │
└─────────────────────────────┬──────────────────────────────┘
                              │
                ┌─────────────▼─────────────┐
                │  PostgreSQL Backend        │
                │  (test/it/postgres/)       │
                │                            │
                │  harness.js                │
                │  ├─ Start Docker Compose   │
                │  ├─ Start dev server       │
                │  └─ Create HTTP client     │
                │                            │
                │  seed.js                   │
                │  ├─ TRUNCATE CASCADE       │
                │  ├─ POST via PostgREST     │
                │  └─ snake_case format      │
                └────────────────────────────┘
```

### The Shared Test Factory Pattern

Each shared test file exports a factory function:

```javascript
// test/it/shared/tests/sites.js
export default function siteTests(getHttpClient, resetData, options = {}) {
  describe('Sites', () => {
    before(() => resetData());

    it('admin: lists all sites', async () => {
      const http = getHttpClient();
      const res = await http.admin.get('/sites');
      expect(res.status).to.equal(200);
      // ...assertions
    });

    it('user: returns 403 for denied site', async () => {
      const http = getHttpClient();
      const res = await http.user.get(`/sites/${SITE_3_ID}`);
      expect(res.status).to.equal(403);
    });
  });
}
```

Wiring files are minimal - typically 4 lines:

```javascript
// postgres/sites.test.js
import { ctx } from './harness.js';
import { resetPostgres } from './seed.js';
import siteTests from '../shared/tests/sites.js';
siteTests(() => ctx.httpClient, resetPostgres);
```

### Authentication (Three Personas)

Tests use ES256 JWTs generated at startup with an ephemeral keypair:

| Persona | JWT Claims | Can Access |
|---------|-----------|------------|
| `admin` | `is_admin: true`, tenant: ORG_1 IMS org | All orgs/sites, admin-only endpoints |
| `user` | `is_admin: false`, tenant: ORG_1 IMS org | ORG_1 and its sites only |
| `trialUser` | `trial_email: test-trial@example.com`, tenant: ORG_1 IMS org | Trial-specific endpoints |

The public key is injected into the dev server via `AUTH_PUBLIC_KEY_B64` so the auth middleware validates tokens correctly.

### Seed Data Strategy

All seed data uses **canonical UUIDs** defined in `shared/seed-ids.js`:

- **ORG_1** (accessible) + **ORG_2** (denied) - enables access control testing
- **SITE_1**, **SITE_2** (under ORG_1) + **SITE_3** (under ORG_2, denied)
- Child entities (audits, opportunities, suggestions, etc.) reference these via FK
- **Non-existent IDs** (e.g., `NON_EXISTENT_SITE_ID`) for 404 tests

Each `describe` block calls `before(() => resetData())` which truncates all data and re-seeds from baseline, ensuring test isolation.

**PostgreSQL seed** (`postgres/seed.js`): POSTs rows directly to PostgREST (snake_case). Also seeds entities like `async_jobs`.

## Running Locally

### Prerequisites

| Requirement | Purpose |
|-------------|---------|
| Docker Desktop (or equivalent) | PostgreSQL + PostgREST containers |
| AWS CLI + ECR access | Pull private PostgREST image |

#### Docker + ECR Authentication

The PostgreSQL suite uses a Docker Compose stack with a private image from AWS ECR:

- **Repository**: `682033462621.dkr.ecr.us-east-1.amazonaws.com/mysticat-data-service`
- **Tag**: pinned in `docker-compose.yml`
- **Account**: SpaceCat Development (AWS3338)

**First-time setup:**

1. Get AWS credentials for **SpaceCat Development (AWS3338)** from `klam.corp.adobe.com`
2. Add them to `~/.aws/credentials` under a profile name:

```ini
[spacecat-dev]
aws_access_key_id = <your-access-key-id>
aws_secret_access_key = <your-secret-access-key>
```

3. Authenticate Docker to ECR:

```bash
aws ecr get-login-password --profile spacecat-dev --region us-east-1 \
  | docker login --username AWS --password-stdin 682033462621.dkr.ecr.us-east-1.amazonaws.com
```

ECR login tokens expire after 12 hours. Re-run the command if you see `pull access denied` errors.

### Run Tests

```bash
npx mocha --require test/it/postgres/harness.js --timeout 30000 'test/it/postgres/**/*.test.js'
```

This will:
1. Start Docker Compose (PostgreSQL + PostgREST on port 3300)
2. Wait for PostgREST readiness (up to 60s)
3. Start the dev server on port 3002 with `DATA_SERVICE_PROVIDER=postgres`
4. Run all 16 test suites
5. Tear down Docker Compose and dev server

### Run a Single Test File

```bash
npx mocha --require test/it/postgres/harness.js --timeout 30000 test/it/postgres/sites.test.js
```

### Environment Variables

The test harness auto-configures all environment variables. No `.env` file is needed. Key variables set by `env.js`:

| Variable | Value |
|----------|-------|
| `DATA_SERVICE_PROVIDER` | `postgres` |
| `POSTGREST_URL` | `http://localhost:3300` |
| `POSTGREST_API_KEY` | Writer JWT for mutations |
| `AUTH_PUBLIC_KEY_B64` | Ephemeral ES256 public key |

## CI Pipeline

The PostgreSQL IT suite runs as a GitHub Actions job via the shared `mysticat-ci` workflow:

```
build ─┬─ it-postgres       (all push/PR events)
       ├─ semantic-release   (main only)
       ├─ deploy-stage       (main only)
       └─ branch-deploy      (non-main only)
```

`it-postgres` authenticates to AWS ECR to pull the private PostgREST image.

## Extending the Tests

### Adding Tests for a New Entity

1. **Define seed IDs** in `shared/seed-ids.js`:

```javascript
// -- YourEntity --
export const YOUR_ENTITY_1_ID = 'ab111111-1111-4111-b111-111111111111';
export const NON_EXISTENT_YOUR_ENTITY_ID = 'ab999999-9999-4999-b999-999999999999';
```

2. **Create seed data** in `postgres/seed-data/your-entities.js`:

```javascript
export const yourEntities = [
  { id: YOUR_ENTITY_1_ID, site_id: SITE_1_ID, name: 'Test Entity' },
];
```

3. **Register seed data** in `postgres/seed.js`:

```javascript
import { yourEntities } from './seed-data/your-entities.js';
await insertRows('your_entities', yourEntities);
```

4. **Write shared test logic** in `shared/tests/your-entities.js`:

```javascript
import { expect } from 'chai';
import { SITE_1_ID, SITE_3_ID, YOUR_ENTITY_1_ID } from '../seed-ids.js';

export default function yourEntityTests(getHttpClient, resetData) {
  describe('Your Entities', () => {
    before(() => resetData());

    it('admin: lists all entities', async () => {
      const http = getHttpClient();
      const res = await http.admin.get(`/sites/${SITE_1_ID}/your-entities`);
      expect(res.status).to.equal(200);
    });

    it('user: returns 403 for denied site', async () => {
      const http = getHttpClient();
      const res = await http.user.get(`/sites/${SITE_3_ID}/your-entities`);
      expect(res.status).to.equal(403);
    });
  });
}
```

5. **Create wiring file** in `postgres/your-entities.test.js`:

```javascript
import { ctx } from './harness.js';
import { resetPostgres } from './seed.js';
import yourEntityTests from '../shared/tests/your-entities.js';
yourEntityTests(() => ctx.httpClient, resetPostgres);
```

### Adding Tests to an Existing Entity

Add new `it(...)` blocks inside the existing shared test file. The wiring files don't need changes.

### Using the Assertion Helpers

```javascript
import {
  expectISOTimestamp,   // Validates ISO 8601 + within +/-1hr
  expectBatch201,       // Validates 201 batch-create envelope
  expectBatch207,       // Validates 207 multi-status envelope
  sortById,             // Deterministic ordering for assertions
  expectNonEmptyString, // Validates non-empty string fields
} from '../helpers/assertions.js';
```

### Using the HTTP Client

The HTTP client provides three authenticated personas:

```javascript
const http = getHttpClient();

// Admin requests (full access)
const res = await http.admin.get('/sites');
const res = await http.admin.post('/sites', { baseURL: 'https://example.com' });
const res = await http.admin.patch('/sites/123', { deliveryType: 'aem_cs' });

// User requests (ORG_1 access only)
const res = await http.user.get(`/sites/${SITE_1_ID}`);

// Trial user requests
const res = await http.trialUser.get('/user-activities');

// DELETE with body (workaround for bodyData middleware)
const res = await http.user.deleteWithBody('/sites/123/url-store', { urls: [...] });
```

Response shape: `{ status: number, headers: object, body: object | string }`

## Troubleshooting

### PostgreSQL Suite

**`EADDRINUSE: port 3300`**
- Docker Compose containers are still running from a previous run
- Clean up: `cd test/it/postgres && docker-compose down -v`

**`Error: ECR authentication failed`**
- The PostgREST image is hosted in a private ECR registry
- Authenticate: `aws ecr get-login-password --region us-east-1 | docker login --username AWS --password-stdin 682033462621.dkr.ecr.us-east-1.amazonaws.com`

**`PostgREST not ready after 60 attempts`**
- Check Docker containers: `docker ps`
- Check PostgREST logs: `cd test/it/postgres && docker-compose logs postgrest`
- Ensure Docker has enough resources allocated

**`column "X" does not exist` when seeding**
- The PostgreSQL schema is managed by dbmate migrations in the Docker image
- Seed data columns must match the schema exactly (snake_case)
- Check available columns: `cd test/it/postgres && docker-compose exec db psql -U postgres -d mysticat -c "\d your_table"`

**`EADDRINUSE: port 3002`**
- The dev server port is in use (possibly from a crashed previous run)
- Kill it: `lsof -ti:3002 | xargs kill -9`

**Tests pass locally but fail in CI**
- Ensure seed data is deterministic (no `Date.now()`, no random values)
- Check that all seed IDs are valid UUIDv4 (position 13 = `4`, position 17 in `{8,9,a,b}`)
- CI uses `--timeout 30000` - if tests are slow, increase the timeout

**`resetData()` seems to not work**
- Each `describe` block should call `before(() => resetData())` - not `beforeEach`
- `beforeEach` would re-seed before every single `it()`, which is slow and usually unnecessary

**Access control test returns unexpected status**
- Verify the seed data places the target entity under the correct org
- `user` persona can only access ORG_1 entities; ORG_2 entities should return 403
- `admin` persona has access to everything

## Current Test Counts

| Suite | Passing | Pending | Notes |
|-------|---------|---------|-------|
| PostgreSQL | 272 | 5 | Pending: DELETE body parsing (3), mutation skips (2) |
