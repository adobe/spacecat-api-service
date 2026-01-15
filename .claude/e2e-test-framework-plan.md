# E2E Test Framework for SpaceCat API Service

## Overview

SpaceCat API Service is an Adobe HTTP API backend (~380 routes) that sits on top of the SpaceCat infrastructure. It handles site management, audit orchestration, opportunity tracking, and integrations with Slack and external services.

- **OpenAPI documentation:** `docs/openapi/api.yaml`

## Goal

Black-box API testing that verifies:
1. CRUD operations behave correctly (functional)
2. Responses conform to OpenAPI schemas (contract)

**Primary design goal:** Easy to write new tests (minimal boilerplate, clear patterns)

### Initial Scope

| Resource | Strategy | Operations Tested |
|----------|----------|-------------------|
| **Organizations** | Static fixture (pre-provisioned) | Read, Update |
| **Sites, Audits, etc.** | Full lifecycle via API | Create, Read, Update, Delete |

Organizations are parent entities for other resources. Since the DELETE API is restricted, we use a pre-provisioned organization as a static fixture and test only read/update operations.

### Out of Scope

- **Import jobs e2e tests** - Owned by a separate team, maintained in `e2e-tests.yaml`

---

## Design Principles

1. **Convention over configuration** - sensible defaults, minimal setup per test
2. **Reusable building blocks** - auth, requests, schema validation
3. **Clear organization** - obvious where to add new tests

---

## High-Level Approach

### Test Structure

Each resource gets a test file. Each test follows this pattern:
1. Make request
2. Assert status code
3. Validate response against OpenAPI schema
4. (Optional) Assert specific field values

### Building Blocks

| Component | Purpose | File | Status |
|-----------|---------|------|--------|
| **API Client** | Wrapper around fetch with auth, base URL, JSON handling | `utils/utils.js` | Exists |
| **Config** | Environment config (BASE_URL, API keys) | `config/config.js` | Exists (needs update) |
| **Schema Validator** | AJV + OpenAPI spec parsing | `utils/schema-validator.js` | To be created |
| **Assertions** | Helpers that combine status + schema validation | `utils/assertions.js` | To be created |
| **Fixtures** | Pre-provisioned entity IDs for restricted resources | `fixtures/fixtures.js` | To be created |

### Test Data Strategy

**Hybrid approach:**
- **Restricted resources** (e.g., organizations): Use pre-provisioned fixtures with known IDs
- **Deletable resources** (e.g., sites): Sequential lifecycle tests (create → read → update → delete)
- Clear naming convention (`e2e_*`) to identify test data
- Tests should reset fixtures to original state after mutations

### Test Execution

- **Sequential execution** - Tests run one at a time, not in parallel
- **Isolation** - Test suites are independent; no shared state between suites. Within a lifecycle suite, tests run in order.
- **Timeout** - 30 seconds per test (`mocha --timeout 30s`), configured in `package.json`
- **Failure logging** - Request and response are logged to console when assertions fail, enabling reproducibility

---

## Decisions

### 1. Test style: Imperative ✅

**Decision:** Use imperative style (see [Appendix A.1](#a1-imperative-test-example))

**Rationale:**
- Easier to debug when tests fail
- More flexibility for edge cases and complex assertions
- Clearer for new contributors
- No custom DSL to learn

---

### 2. Test data strategy: Hybrid (fixtures + lifecycle tests) ✅

**Decision:** Use a combination based on resource lifecycle constraints.

- **Restricted resources (no DELETE API):** Use pre-provisioned fixtures (see [Appendix A.2](#a2-fixtures-definition))
- **Deletable resources:** Sequential lifecycle tests (see [Appendix A.3](#a3-lifecycle-tests-pattern))

**Rationale:**
- Fixtures for restricted resources (organizations) avoid test data accumulation
- Lifecycle tests for deletable resources cover full CRUD and appear in test reports
- Clear naming convention (`e2e_*`) identifies test data

**Fixture management:**
- Pre-provision fixtures once per environment (dev)
- Document fixture IDs in `fixtures.js`
- Tests should leave fixtures in original state (reset after mutations)

---

### 3. Schema validation: AJV with manual schema extraction ✅

**Decision:** Use AJV with `@apidevtools/swagger-parser` for schema validation (see [Appendix A.4](#a4-schema-validator) and [Appendix A.5](#a5-assertions-helper)).

**Rationale:**
- Detailed, actionable error messages
- Validate any schema by name (not coupled to path/method)
- Cached validators for performance
- AJV is actively maintained
- Full control over validation behavior

**Dependencies:**
```bash
npm install --save-dev ajv ajv-formats @apidevtools/swagger-parser
```

---

### 4. Authentication & CI Integration: GitHub Secrets in branch-deploy ✅

**Decision:** Use GitHub Actions secrets for API keys. Run e2e tests as part of the existing `branch-deploy` job in `ci.yaml` (dev environment only).

**Note:** The existing `e2e-tests.yaml` workflow is owned by the import jobs team and should not be modified.

#### CI Integration

The e2e tests will run in the existing `branch-deploy` job (`.github/workflows/ci.yaml`), which:
- Triggers on push to non-main branches
- Deploys to dev environment
- Already runs post-deployment tests

See [Appendix A.6](#a6-ci-workflow-step) for the workflow configuration.

#### GitHub Secrets vs AWS Secrets Manager

These are **completely separate systems** with no automatic synchronization:

| Aspect | GitHub Secrets | AWS Secrets Manager |
|--------|----------------|---------------------|
| **Storage** | GitHub infrastructure | AWS infrastructure |
| **Access** | GitHub Actions workflows only | AWS SDK / Lambda / services |
| **Update** | Manual via GitHub UI/API | Manual via AWS console/CLI/Terraform |
| **Sync** | None - independent | None - independent |

#### Implementation Steps

1. Add secret to GitHub: `Settings → Secrets and variables → Actions → New repository secret`
   - Name: `E2E_ADMIN_API_KEY_DEV`
   - Value: `<admin-api-key-value>`

2. Add step to `ci.yaml` branch-deploy job (see [Appendix A.6](#a6-ci-workflow-step))

3. Update `config.js` to export `adminApiKey` (see [Appendix A.7](#a7-config-setup))

#### Local Development

```bash
# Set env var manually
export E2E_ADMIN_API_KEY=xxx
npm run test-e2e
```

---

## Proposed Directory Structure

```
test/e2e/
├── utils/
│   ├── utils.js             # Existing makeRequest helper
│   ├── schema-validator.js  # AJV + OpenAPI validation
│   └── assertions.js        # expectResponse, expectError helpers
├── config/
│   └── config.js            # Environment config (BASE_URL, API keys)
├── fixtures/
│   └── fixtures.js          # Pre-provisioned entity IDs for restricted resources
│
├── organizations.e2e.js     # Organizations endpoint tests
├── sites.e2e.js             # Sites endpoint tests
├── audits.e2e.js            # Audits endpoint tests
│
└── (existing import tests remain separate)
```

---

## Next Steps

All key decisions have been made:
- ✅ Test style: Imperative
- ✅ Test data strategy: Hybrid (fixtures + lifecycle tests)
- ✅ Schema validation: AJV with manual schema extraction
- ✅ Authentication: GitHub Secrets (dev-only initially)

**Implementation tasks:**
1. Add `E2E_ADMIN_API_KEY_DEV` to GitHub repository secrets
2. Add e2e test step to `.github/workflows/ci.yaml` branch-deploy job
3. Update `config.js` to export `adminApiKey`
4. Install dependencies: `ajv`, `ajv-formats`, `@apidevtools/swagger-parser`
5. Create `schema-validator.js` utility
6. Create `assertions.js` with `expectResponse` and `expectError` helpers
7. Create `fixtures/fixtures.js` with pre-provisioned org ID
8. Complete `organizations.e2e.js` as reference implementation
9. Expand to sites, audits, and other resources

---

## Appendix: Code Snippets

### A.1 Imperative Test Example

```javascript
it('should get site by ID', async () => {
  const response = await makeRequest({
    url: `${API_URL}/sites/${siteId}`,
    method: 'GET',
    key: adminApiKey,
  });

  expect(response.status).to.equal(200);
  const body = await response.json();
  expect(body.id).to.equal(siteId);
});
```

### A.2 Fixtures Definition

```javascript
// test/e2e/fixtures/fixtures.js
export const fixtures = {
  // Pre-provisioned in dev environment, dedicated to e2e tests
  organization: {
    id: 'e2e-org-uuid-here',
    name: 'e2e_test_organization',
  },
};
```

Usage in tests:

```javascript
import { expect } from 'chai';
import { fixtures } from './fixtures/fixtures.js';
import { makeRequest } from './utils/utils.js';
import { adminApiKey, API_URL } from './config/config.js';

describe('Organizations e2e', () => {
  it('should get organization by ID', async () => {
    const response = await makeRequest({
      url: `${API_URL}/organizations/${fixtures.organization.id}`,
      method: 'GET',
      key: adminApiKey,
    });
    expect(response.status).to.equal(200);
  });

  it('should update organization', async () => {
    const response = await makeRequest({
      url: `${API_URL}/organizations/${fixtures.organization.id}`,
      method: 'PATCH',
      data: JSON.stringify({ name: 'e2e_test_organization' }),
      key: adminApiKey,
    });
    expect(response.status).to.equal(200);
  });
});
```

### A.3 Lifecycle Tests Pattern

Tests run sequentially, each covering a CRUD operation:

```javascript
import { expect } from 'chai';
import { makeRequest } from './utils/utils.js';
import { adminApiKey, API_URL } from './config/config.js';

describe('Sites CRUD', () => {
  let siteId;

  it('should create a site', async () => {
    const response = await makeRequest({
      url: `${API_URL}/sites`,
      method: 'POST',
      data: JSON.stringify({ baseURL: 'https://e2e-test.example.com' }),
      key: adminApiKey,
    });
    expect(response.status).to.equal(201);
    const body = await response.json();
    expect(body.baseURL).to.equal('https://e2e-test.example.com');
    siteId = body.id;
  });

  it('should get site by ID', async () => {
    const response = await makeRequest({
      url: `${API_URL}/sites/${siteId}`,
      method: 'GET',
      key: adminApiKey,
    });
    expect(response.status).to.equal(200);
    const body = await response.json();
    expect(body.id).to.equal(siteId);
  });

  it('should update site', async () => {
    const response = await makeRequest({
      url: `${API_URL}/sites/${siteId}`,
      method: 'PATCH',
      data: JSON.stringify({ baseURL: 'https://updated.example.com' }),
      key: adminApiKey,
    });
    expect(response.status).to.equal(200);
    const body = await response.json();
    expect(body.baseURL).to.equal('https://updated.example.com');
  });

  it('should delete site', async () => {
    const response = await makeRequest({
      url: `${API_URL}/sites/${siteId}`,
      method: 'DELETE',
      key: adminApiKey,
    });
    expect(response.status).to.equal(204);
  });

  it('should return 404 for deleted site', async () => {
    const response = await makeRequest({
      url: `${API_URL}/sites/${siteId}`,
      method: 'GET',
      key: adminApiKey,
    });
    expect(response.status).to.equal(404);
  });
});
```

### A.4 Schema Validator

```javascript
// test/e2e/utils/schema-validator.js
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import * as parser from '@apidevtools/swagger-parser';

let spec = null;
let ajv = null;
const validatorCache = new Map();

// Call once before all tests, e.g., in a global before() hook or test setup file
export async function initSchemaValidator(specPath = './docs/openapi/api.yaml') {
  spec = await parser.dereference(specPath);
  ajv = new Ajv({ allErrors: true, verbose: true, strict: false });
  addFormats(ajv);
  return spec;
}

export function validateSchema(data, schemaName) {
  if (!validatorCache.has(schemaName)) {
    const schema = spec.components?.schemas?.[schemaName];
    validatorCache.set(schemaName, ajv.compile(schema));
  }
  const validator = validatorCache.get(schemaName);
  return { valid: validator(data), errors: validator.errors };
}
```

### A.5 Assertions Helper

```javascript
// test/e2e/utils/assertions.js
import { expect } from 'chai';
import { validateSchema } from './schema-validator.js';

export async function expectResponse(response, { status, schema }) {
  const body = await response.json();

  expect(response.status).to.equal(status);

  if (schema) {
    const result = validateSchema(body, schema);
    if (!result.valid) {
      const errors = result.errors.map(e => `${e.instancePath}: ${e.message}`).join('\n');
      throw new Error(`Schema "${schema}" validation failed:\n${errors}`);
    }
  }
  return body;
}
```

Note: A separate logging helper will handle printing request/response on failure.

### A.6 CI Workflow Step

```yaml
# .github/workflows/ci.yaml - add to branch-deploy job after post-deploy test
- name: E2E API Tests
  env:
    E2E_ADMIN_API_KEY: ${{ secrets.E2E_ADMIN_API_KEY_DEV }}
  run: npm run test-e2e
```

### A.7 Config Setup

```javascript
// test/e2e/config/config.js
export const BASE_URL = 'https://spacecat.experiencecloud.live/api';
export const API_URL = `${BASE_URL}/ci`;
export const adminApiKey = process.env.E2E_ADMIN_API_KEY;
```