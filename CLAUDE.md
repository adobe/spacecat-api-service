# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

### Development
```bash
npm start                  # Start development server with hot reload
npm test                   # Run unit tests (excludes Post-Deploy tests)
npm run test:bundle        # Test production bundle
npm run test-postdeploy    # Run post-deployment tests
npm run test-e2e           # Run end-to-end tests (30s timeout)
npm run lint               # Run ESLint
npm run lint:fix           # Auto-fix linting issues
```

### Single Test Execution
```bash
npx mocha test/path/to/specific.test.js              # Run single test file
npx mocha test/path/to/specific.test.js -g "pattern" # Run tests matching pattern
```

### Integration Tests
```bash
# DynamoDB suite (requires Java 17+)
npx mocha --require test/it/dynamo/harness.js --timeout 30000 'test/it/dynamo/**/*.test.js'

# PostgreSQL suite (requires Docker + ECR access)
npx mocha --require test/it/postgres/harness.js --timeout 30000 'test/it/postgres/**/*.test.js'

# Single IT test file
npx mocha --require test/it/dynamo/harness.js --timeout 30000 test/it/dynamo/sites.test.js
```

### Documentation
```bash
npm run docs              # Lint and build OpenAPI documentation
npm run docs:build        # Build docs from OpenAPI specs
npm run docs:lint         # Validate OpenAPI specs
npm run docs:serve        # Preview docs locally
```

### Deployment
```bash
npm run build             # Build production bundle with Helix Deploy
npm run deploy-dev        # Deploy to dev environment
npm run deploy-stage      # Deploy to stage environment
npm run deploy            # Deploy to production
```

## Architecture Overview

### Request Flow

The application uses a **middleware wrapper pattern** with `@adobe/helix-shared-wrap`:

```
Request → AWS Lambda → Middleware Stack → Route Matcher → Controller → DTO → Response
```

**Middleware Stack** (in order, defined in `src/index.js`):
1. `authWrapper` - Authentication (JWT, IMS, API Keys, Scoped API Keys)
2. `logWrapper` - Structured logging
3. `dataAccess` - DynamoDB access layer (`@adobe/spacecat-shared-data-access`)
4. `bodyData` - Request body parsing
5. `multipartFormData` - File upload handling
6. `enrichPathInfo` - Path parameter extraction
7. `sqs` - AWS SQS client
8. `s3ClientWrapper` - AWS S3 client
9. `imsClientWrapper` - Adobe IMS client
10. `elevatedSlackClientWrapper` - Slack client
11. `secrets` - AWS Secrets Manager
12. `helixStatus` - Health checks

All dependencies are injected into `context` and available throughout the request lifecycle.

### Routing Architecture

**Location**: `src/routes/index.js`

Routes use a two-tier matching system:
- **Static routes**: Exact string match (fastest)
- **Dynamic routes**: Pattern matching with parameter extraction (`:siteId`, `:auditType`, etc.)

All routes are defined declaratively as `METHOD /path` → controller function mappings.

**Important**: UUID parameters (`:siteId`, `:organizationId`) are validated in `src/index.js` using `isValidUUIDV4()` before reaching controllers.

### Controller Pattern

Controllers use **factory functions** (not classes, except FixesController):

```javascript
function SitesController(ctx, log, env) {
  const { dataAccess } = ctx;
  const { Site, Organization } = dataAccess;

  const createSite = async (context) => {
    // 1. Access control check
    const accessControlUtil = AccessControlUtil.fromContext(context);
    if (!accessControlUtil.hasAdminAccess()) {
      return forbidden('Only admins can create sites');
    }

    // 2. Business logic
    const site = await Site.create(context.data);

    // 3. DTO transformation
    return createResponse(SiteDto.toJSON(site), 201);
  };

  return { createSite, getAll, getByID, ... };
}
```

**Controllers are instantiated per request** - no shared state between requests.

### Data Access Layer

Uses `@adobe/spacecat-shared-data-access` (external package) providing Active Record-style models:

**Core Models** (accessed via `context.dataAccess`):
- `Site` - Websites being monitored (primary entity)
- `Organization` - Multi-tenant container for sites
- `Project` - Groups sites by project
- `Audit` - Historical audit results
- `LatestAudit` - Optimized view of most recent audits per site/type
- `Opportunity` - Issues/recommendations for sites
- `Suggestion` - AI-generated suggestions for opportunities
- `Fix` - Applied fixes for suggestions
- `Configuration` - Global system configuration
- `ImportJob` - Import job tracking
- `ApiKey` - Scoped API key management
- `Entitlement` - Product entitlements for organizations
- `SiteEnrollment` - Site-level product enrollment

**Pattern**: `Model.findById()`, `Model.all()`, `model.save()`, `Audit.allBySiteId(siteId, auditType)`

### DTO Layer

**Location**: `src/dto/`

DTOs transform internal models to API responses. **Never expose raw database models**.

```javascript
// Always use DTOs
return ok({ sites: sites.map(SiteDto.toJSON) });

// Never return raw models
return ok({ sites }); // ❌ Wrong - exposes internal fields
```

### Access Control Pattern

**File**: `src/support/access-control-util.js`

**Always check access control** before returning tenant-specific data:

```javascript
const accessControlUtil = AccessControlUtil.fromContext(context);

// Admin-only operations
if (!accessControlUtil.hasAdminAccess()) {
  return forbidden('Only admins can perform this operation');
}

// Organization/site access
if (!await accessControlUtil.hasAccess(site)) {
  return forbidden('User does not have access to this site');
}

// Product-specific access with entitlement validation
const hasAccess = await accessControlUtil.hasAccess(
  site,           // entity
  '',             // subService (optional)
  'llmo_optimizer' // productCode
);
```

**Authentication precedence** (checked in order):
1. JWT with scopes
2. Adobe IMS
3. Scoped API Key (fine-grained permissions)
4. Legacy API Key (backward compatibility)

### Queue-Based Async Pattern

**File**: `src/support/sqs.js`

Long-running operations are queued, not processed synchronously:

```javascript
// Accept request → Queue message → Return 202 Accepted
await context.sqs.sendMessage(queueUrl, {
  type: 'apex',
  url: site.getBaseURL(),
  auditContext: { slackContext }
});

return accepted('Audit queued successfully');
```

**Common queues**:
- `AUDIT_JOBS_QUEUE_URL` - Audit processing
- `FULFILLMENT_EVENTS_QUEUE_URL` - External event processing
- Import queues (configured via `IMPORT_CONFIGURATION`)

### Slack Integration

**Files**:
- `src/controllers/slack.js` - Main controller
- `src/support/slack/commands/` - Command handlers (36 commands)
- `src/support/slack/actions/` - Action handlers (17 actions)

Architecture:
1. Slack events → `/slack/events` endpoint
2. `@slack/bolt` processes with custom handlers
3. **Commands**: Text interactions (e.g., `@spacecat run-audit`)
4. **Actions**: Button clicks, modal submissions
5. **Views**: Modal interactions

**Important**: Ignore retry requests with `x-slack-retry-reason === 'http_timeout'`

### Agent Workflows

**File**: `src/support/agent-workflow.js`

Complex AI operations use AWS Step Functions:

```javascript
await startAgentWorkflow(context, {
  agentId: 'brand-profile',
  siteId: site.getId(),
  // agent-specific configuration
});
```

Agents in `src/agents/` use `@langchain/langgraph` for workflow orchestration.

## API Design Principles

### Must-Follow Patterns

1. **OpenAPI First**: Define API contract in `docs/openapi/` before implementation
2. **Specification Sync**: Keep OpenAPI specs and implementation in sync
   - Run `npm run docs:lint` after modifying specs
   - Run `npm run docs:build` before completing implementation
3. **Routing Consistency**: Add routes to BOTH `src/index.js` and `src/routes/index.js`
4. **Access Control**: Always use `AccessControlUtil` for tenant data
5. **DTO Usage**: Transform all responses through DTOs
6. **HTTP Helpers**: Use shared helpers from `@adobe/spacecat-shared-http-utils` (`ok`, `badRequest`, `notFound`, `forbidden`, `accepted`, etc.)
7. **UUID Validation**: Validate UUID parameters with `isValidUUIDV4()`

### When Designing New Endpoints

**Before implementation, clarify**:

**Data Access Patterns**:
- Where will data surface? (internal UI, customer UI, services)
- Query patterns needed? (filtering, sorting, pagination)
- Read vs write frequency?
- Simple root-level filters or complex nested conditions?

**Data Model**:
- What data needs to be surfaced?
- Simple fields or complex nested structures?
- Data size (bandwidth implications)?
- Access control requirements?
- Update frequency and concurrency patterns?

**Scale & Performance**:
- Expected record count and growth rate?
- List operation payload size concerns?
- Projection to exclude heavy fields?
- Progressive/lazy loading needed?

**Ask for clarification if**:
- Business use cases are vague
- Requirements include "filter/sort by any field"
- Data structure is mostly free-form
- Multiple services update same fields concurrently
- Different access control needed for different data parts

### Implementation Approach

1. **Follow existing patterns**: Examine similar features (e.g., Site/Audit, Opportunity/Suggestion)
2. **Don't over-engineer**: Match solution complexity to actual requirements
3. **Concurrent updates**: Use atomic operations, avoid read-modify-write patterns
4. **Pagination**: Use cursor-based pagination with `limit` and `cursor` parameters
5. **Bulk operations**: Prefer bulk endpoints accepting arrays over separate single/multi-item endpoints
6. **URL parameters**: Encode URLs as base64url (RFC 4648 §5) when used in path parameters

### OpenAPI Guidelines

- All schemas defined in `docs/openapi/schemas.yaml` (reuse, don't inline)
- Examples in `docs/openapi/examples.yaml` (reference, don't inline)
- Validate examples against schemas
- Use composition, inheritance, polymorphism to avoid duplication
- Unimplemented endpoints: description starts with "Not implemented yet" + return HTTP 501

## Testing Patterns

### Test Structure

Tests mirror source structure in `test/`:
- `test/controllers/` - Controller unit tests
- `test/dto/` - DTO transformation tests
- `test/routes/` - Route matching tests
- `test/support/` - Utility tests
- `test/e2e/` - End-to-end tests
- `test/it/` - Integration tests (DynamoDB v2 + PostgreSQL v3)

### Standard Test Pattern

```javascript
import { expect } from 'chai';
import sinon from 'sinon';
import esmock from 'esmock';

describe('Sites Controller', () => {
  let sandbox;
  let sitesController;
  let mockDataAccess;

  beforeEach(async () => {
    sandbox = sinon.createSandbox();

    mockDataAccess = {
      Site: {
        findById: sandbox.stub(),
        create: sandbox.stub(),
      },
    };

    sitesController = await esmock('../../src/controllers/sites.js', {
      '../../src/support/access-control-util.js': {
        default: { fromContext: () => ({ hasAdminAccess: () => true }) }
      }
    });
  });

  afterEach(() => {
    sandbox.restore();
  });

  it('creates a site with valid data', async () => {
    const mockSite = { getId: () => 'site-123' };
    mockDataAccess.Site.create.resolves(mockSite);

    const response = await sitesController.createSite({
      dataAccess: mockDataAccess,
      data: { baseURL: 'https://example.com' }
    });

    expect(response.status).to.equal(201);
  });
});
```

**Tools**:
- **Mocha**: Test runner
- **Chai**: Assertions (`expect`, `chai-as-promised`)
- **Sinon**: Mocking/stubbing
- **Esmock**: ES module mocking
- **Nock**: HTTP request mocking

### Integration Tests (IT)

**Location**: `test/it/` — see [test/it/README.md](test/it/README.md) for full documentation.

Integration tests validate the full API request lifecycle against real database backends — no mocks. Every test runs identically against DynamoDB (v2) and PostgreSQL (v3) to ensure migration parity.

**Architecture**: Shared test factories in `test/it/shared/tests/` are wired to backend-specific harnesses:

```
shared/tests/sites.js → dynamo/sites.test.js   (uses DynamoDB Local + v2 data access)
                       → postgres/sites.test.js (uses Docker PostgreSQL + PostgREST)
```

**Key concepts**:
- **Seed IDs**: All test data uses canonical UUIDs from `shared/seed-ids.js`
- **Three auth personas**: `admin` (full access), `user` (ORG_1 only), `trialUser` (trial endpoints)
- **Data reset**: Each `describe` block calls `before(() => resetData())` to ensure isolation
- **Backend-specific options**: Use `options` parameter for v3-only features (e.g., `{ skipAsyncJobTests: true }` for DynamoDB)
- **Seed data format**: DynamoDB uses camelCase, PostgreSQL uses snake_case
- **v3-only entities**: `AsyncJob` only exists in PostgreSQL — DynamoDB tests skip these

### Test Requirements

- **Behavior changes must include unit tests** - mark as Critical if missing
- **New or modified endpoints must include integration tests** in `test/it/` — add shared test logic in `shared/tests/`, seed data in both `dynamo/seed-data/` and `postgres/seed-data/`, and wiring files in both backend directories
- Mock external dependencies (databases, HTTP calls, queues) in unit tests
- Test access control paths (authorized, forbidden, admin-only)
- Test DTO transformations
- Test error handling and validation

## Configuration Hierarchy

1. **Global Configuration** (`Configuration` model) - System-wide settings, queue URLs
2. **Organization Config** - Slack channels, IMS org mappings
3. **Site Config** - Site-specific overrides, LLMO settings
4. **Environment Variables** - AWS resources, API keys, feature flags

## Key Domain Areas

### Sites & Audits
- **Sites**: Primary entity representing monitored websites
- **Audits**: Historical results stored separately
- **LatestAudits**: Optimized collection for most recent audits per type
- Audit types: apex, cwv, canonical, broken-backlinks, sitemap, structured-data, etc.
- Configuration: `site.getConfig()` returns merged configuration (global + org + site)

### Organizations & Projects
- **Organizations**: Multi-tenant containers with Slack channels, IMS org IDs
- **Projects**: Group sites by project (e.g., "Marketing Sites", "Regional Sites")
- Access control tied to organization membership

### Opportunities & Suggestions
- **Opportunities**: Issues/recommendations identified for sites
- **Suggestions**: AI-generated suggestions for opportunities
- **Fixes**: Applied fixes with status tracking
- DTO composition: `OpportunityDto` can include nested `SuggestionDto` objects

### LLM Optimizer (LLMO)
**Location**: `src/controllers/llmo/`

Most complex domain:
- **Onboarding/Offboarding**: Multi-step customer setup with Wikipedia analysis
- **Config Management**: Site-specific LLM configurations with versioning
- **Query Handler**: Natural language queries against customer data
- **Sheet Data**: Integration with customer data sources
- **Rationale**: AI explanation generation for recommendations

20+ specialized endpoints under `/llmo/*`

### Import System
- Job-based import for bulk operations
- Queue-based processing with S3 artifact storage
- Multiple queues support
- Progress tracking via `ImportJob` model

### Slack Commands
**Location**: `src/support/slack/commands/`

36 commands for operations:
- Site management: `/add-site`, `/update-site`, `/remove-site`
- Audit operations: `/run-audit`, `/run-audit-for-all-sites`
- Organization setup: `/add-slack-channel`, `/configure-slack`
- Debugging: `/site-info`, `/audit-info`
- LLMO: `/brand-profile`, `/llmo-onboard`

## Common Utilities

**Location**: `src/utils/` and shared packages

### Validation
```javascript
import { isValidUrl, hasText, isIsoDate } from '@adobe/spacecat-shared-utils';
import { isValidUUIDV4 } from './src/utils/common.js';
```

Use shared utilities from `@adobe/spacecat-shared-utils` instead of custom implementations.

### HTTP Response Helpers
```javascript
import { ok, created, accepted, badRequest, notFound, forbidden, internalServerError } from '@adobe/spacecat-shared-http-utils';

return ok({ data: SiteDto.toJSON(site) });
return created(SiteDto.toJSON(newSite));
return accepted('Operation queued');
return badRequest('Invalid request parameters');
return notFound('Site not found');
return forbidden('User does not have access');
return internalServerError('Internal error occurred');
```

### Error Handling
- Use structured error responses
- Sanitize error messages with `cleanupHeaderValue()` before returning
- Log errors with context using `context.log.error()`
- Never expose stack traces or internal details to clients

## Development Workflow

### Conventional Commits
- This repo uses conventional commits for semantic-release (version bumps) and changelog generation
- PR title or merge commit must follow the conventional commit style (e.g. `feat:`, `fix:`, `docs:`)

### Adding a New Endpoint

1. Define OpenAPI spec in `docs/openapi/paths/*.yaml`
2. Add/update schemas in `docs/openapi/schemas.yaml`
3. Run `npm run docs:lint` to validate
4. Add route to `src/routes/index.js`
5. Add route handler invocation in `src/index.js` (if new pattern)
6. Implement controller method
7. Add DTO if needed
8. Add access control checks
9. Write unit tests in `test/controllers/`
10. Write integration tests in `test/it/`:
    - Add seed IDs to `test/it/shared/seed-ids.js`
    - Add seed data to both `dynamo/seed-data/` (camelCase) and `postgres/seed-data/` (snake_case)
    - Register seeds in both `dynamo/seed.js` and `postgres/seed.js`
    - Write shared test factory in `test/it/shared/tests/`
    - Create wiring files in both `dynamo/` and `postgres/`
11. Run `npm run docs:build` to generate documentation
12. Run `npm test` to verify unit tests pass
13. Run IT suites to verify integration tests pass (see Integration Tests commands above)

### Adding a Slack Command

1. Create command handler in `src/support/slack/commands/your-command.js`
2. Export handler function: `export default async function handleYourCommand(context, command) { ... }`
3. Register in `src/support/slack/commands.js`
4. Add tests in `test/support/slack/commands/`
5. Test via Slack workspace

### Modifying Data Models

Data models are defined in `@adobe/spacecat-shared-data-access` (external package).

For this repo:
1. Update DTOs in `src/dto/` to handle new fields
2. Update OpenAPI schemas in `docs/openapi/schemas.yaml`
3. Update controller logic using the model
4. Update tests with new fixtures

## Security Guidelines

1. **Always validate access control** using `AccessControlUtil` before returning data
2. **Validate all UUID parameters** with `isValidUUIDV4()`
3. **Use DTOs** to prevent leaking internal model fields
4. **Sanitize error messages** before returning to clients
5. **Validate repository URLs** with `validateRepoUrl()`
6. **Check body size limits** with `checkBodySize()`
7. **Respect multipart limits** from environment configuration
8. **Never log secrets** or sensitive user data
9. **Use scoped API keys** for fine-grained access control
10. **Validate product entitlements** for paid features

## Troubleshooting

### Common Issues

**Route not found**:
- Check route definition in `src/routes/index.js`
- Verify route handler in `src/index.js` getRouteHandlers()
- Check HTTP method matches

**Access control failures**:
- Verify `AccessControlUtil.fromContext(context)` instantiation
- Check `hasAdminAccess()` or `hasAccess(entity)` calls
- Verify JWT scopes, IMS org, or API key permissions

**DTO errors**:
- Ensure all model fields used in DTO exist
- Check for null/undefined before accessing nested properties
- Verify DTO composition for nested objects

**Queue/SQS errors**:
- Verify queue URL in environment variables
- Check queue permissions in AWS IAM role
- Validate message payload structure

**Test failures**:
- Check mock setup in `beforeEach`
- Verify stubs are restored in `afterEach`
- Use `esmock` for ES module mocking
- Check test fixtures match current schema

### Debugging

```bash
# Run specific test with debugging
node --inspect node_modules/.bin/mocha test/path/to/test.js

# View logs for deployed lambda
npm run logs

# Test locally with dev server
npm start
# Hit http://localhost:3000/your-endpoint
```
