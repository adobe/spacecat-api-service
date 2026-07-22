# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Fastly

This service runs behind Fastly CDN service `DlxppS2VoAizEqJ9bPasq6` (AEM Sites Optimizer [SpaceCat] Prod) at `spacecat.experiencecloud.live`. VCL snippets handle routing, CORS, HSTS, and API gateway auth. See [mysticat-architecture Fastly services reference](https://github.com/adobe/mysticat-architecture/blob/main/platform/reference/fastly-services.md) for full reference.

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
npm run type-check         # Opt-in tsc --checkJs over // @ts-check files (serenity); blocking gate
```

### Single Test Execution
```bash
npx mocha test/path/to/specific.test.js              # Run single test file
npx mocha test/path/to/specific.test.js -g "pattern" # Run tests matching pattern
```

### Integration Tests
```bash
# PostgreSQL suite (requires Docker + ECR access)
npx mocha --require test/it/postgres/harness.js --timeout 30000 'test/it/postgres/**/*.test.js'

# Single IT test file
npx mocha --require test/it/postgres/harness.js --timeout 30000 test/it/postgres/sites.test.js

# Mock-backed suites (e.g. serenity, which drives the Semrush vendor mock
# containers over real HTTPS — not in-process stubs, no live Semrush) are slower
# than the pure-DB suites — run them with --timeout 60000:
npx mocha --require test/it/postgres/harness.js --timeout 60000 test/it/postgres/serenity.test.js
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

## Lambda Bundle Constraints

**Source code is bundled into a single Lambda artifact via `helix-deploy` (esbuild). Tests import from source where `import.meta.url` resolves to the real source path — the failure mode of "works in tests, breaks in production" is the bundling layer dropping a non-JS sibling asset on its way into the zip.**

History: SITES-45260 — `handlers/projects.js` read `data/locations.json` synchronously at module load via `readFileSync(import.meta.url)`. The JSON was not in `package.json` `hlx.static`, so `helix-deploy` never copied it into the Lambda zip. Every cold start hit `ENOENT … data/locations.json`, the module export went undefined, and the deploy wrapper raised `TypeError: main2 is not a function` on every invocation. Tests stayed green throughout.

### Rules

- **Do NOT use `readFileSync(import.meta.url, ...)` or any sibling-file reads at module load.** The bundled artifact does not preserve source-relative paths — `import.meta.url` resolves to the bundle location, not the original source location. Anything you read from a sibling path will be missing.
- **Prefer JS-module imports for static data.** Inline JSON / locale data / lookup tables as `export const FOO = { ... }` in a `.js` file and `import` it normally. The bundler resolves it at build time; no FS access at runtime; no static-asset registry to maintain. This is the preferred shape — see `src/support/serenity/* JS modules`.
- **If you must keep a file as a non-JS asset**, declare its repo-relative path in `package.json` under `hlx.static` so `helix-deploy` copies it into the Lambda zip. Do NOT compute its runtime path from `import.meta.url` — read it from the Lambda task root (`process.env.LAMBDA_TASK_ROOT` or a known absolute path inside the zip).
- **JSON import attributes** (`import x from './x.json' with { type: 'json' }`) are blocked by the repo's eslint parser today; don't try to work around the lint rule. Use the JS-module pattern instead.

### CI gate

The bundle is validated in CI by the `bundle-build: true` input on the `adobe/mysticat-ci` reusable workflow (`.github/workflows/ci.yaml`) — it runs `npm run build` (`hedy -v --test-bundle`) and invokes the bundled `lambda()` against a healthcheck, catching the module-load failures that source-only lint+test+coverage miss (SITES-45260). The gate lives upstream; don't re-add a repo-local `bundle-build` job.

If you touch the bundle layer (new asset, a dependency that uses FS at boot, `hlx.static` changes, new top-level side-effects), run `npm run build` locally before pushing — faster than waiting on CI.

## Architecture Overview

### Request Flow

The application uses a **middleware wrapper pattern** with `@adobe/helix-shared-wrap`:

```
Request → AWS Lambda → Middleware Stack → Route Matcher → Controller → DTO → Response
```

**Middleware Stack** (in order, defined in `src/index.js`):
1. `authWrapper` - Authentication (JWT, IMS, API Keys, Scoped API Keys)
2. `logWrapper` - Structured logging
3. `dataAccess` - Data access layer (`@adobe/spacecat-shared-data-access`)
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

**S2S consumer capability pattern** — use this instead of a bare `hasAdminAccess()` when a route is already mapped in `required-capabilities.js` and should be reachable by S2S consumers:

```javascript
import { CAP_CONFIGURATION_WRITE } from '../routes/capability-constants.js';

// Dual-layer check: admin bypass first, then fresh DB fetch for S2S consumers.
// Returns a forbidden Response when denied, null when access is granted.
const authorizeWrite = async (context, route) => {
  const requestId = context?.invocation?.id || 'unknown';
  const isAdmin = accessControlUtil.hasAdminAccess();
  const s2sResult = isAdmin
    ? { allowed: false, reason: 'admin-bypass' }
    : await accessControlUtil.hasS2SCapability(CAP_CONFIGURATION_WRITE);
  if (!isAdmin && !s2sResult.allowed) {
    log.info(`[acl] Denied ${route} - reason=${s2sResult.reason} clientId=${s2sResult.clientId || 'n/a'} consumerId=${s2sResult.consumerId || 'n/a'} requestId=${requestId}`);
    return forbidden('Forbidden');
  }
  if (s2sResult.allowed) {
    log.info(`[s2s] ${route} granted clientId=${s2sResult.clientId || 'n/a'} consumerId=${s2sResult.consumerId || 'n/a'} capability=${CAP_CONFIGURATION_WRITE} requestId=${requestId}`);
  }
  return null;
};

// In the handler:
const denied = await authorizeWrite(context, 'PATCH /configurations/latest');
if (denied) {
  return denied;
}
```

Capability constants live in `src/routes/capability-constants.js`. Both the route map (`required-capabilities.js`) and the controller must reference the **same constant** — the `capability-constants drift coverage` test enforces this. See `docs/s2s/READALL_CAPABILITY_DESIGN.md` for the full two-layer design.

**FACS-native authorization (state-layer endpoints — exception to the above):** The `/state/access-mappings`, `/product/capabilities`, `/user/capabilities`, and `/organizations/:id/permission/audit-logs` endpoints (`src/controllers/state-access-mappings.js`) do **not** use `AccessControlUtil`. They implement the hybrid MAC/FACS permission model directly: authorization is evaluated from the JWT's `facs_permissions` (read via `authInfo.getFacsPermissions()`) **unioned** with state-layer `granted_capabilities` rows in `facs_access_mappings`. A caller is an org-wide FACS manager if the JWT carries `<product>/can_manage_users`; otherwise they are a resource-scoped state-layer manager whose authority is the set of resources where they hold a state `can_manage_users` binding (`resolveManageAuthority`). This is deliberate — these endpoints govern the ReBAC bindings themselves, so they predate/sit beneath the entitlement model `AccessControlUtil` checks. `facsWrapper` (from `@adobe/spacecat-shared-http-utils`) is attached as the innermost wrapper in `src/index.js` and fronts these routes using the `routeFacsCapabilities` map in `src/routes/facs-capabilities.js` (per-product LaunchDarkly flag-gated, default-off in prod, so non-enrolled orgs bypass). The state-layer management endpoints additionally remain restricted to `AWS_ENV === 'dev'` (a `devOnly` blocker in the controller; handlers 404 elsewhere) until they graduate to production — the controller's own `can_manage_users` / `can_view` gating is the permanent authorization layer beneath the wrapper.

**Classifying route params when adding ANY endpoint (required):** Every dynamic `:param` in `src/routes/index.js` must be classified in `src/routes/facs-capabilities.js` so `facsWrapper` can resolve (or correctly ignore) the ReBAC resource for a route. The `routeFacsCapabilities` test suite (`test/routes/facs-capabilities.test.js`) **fails the build** if a param is unclassified, claimed by two buckets, or stale. When you add a route:

- **Param identifies an existing ReBAC entity** (a brand or a site) → reuse the existing alias in `PRODUCTS_FACS_RESOURCE_PARAM_ALIASES` (`LLMO.brand → ['brandId']`, `ASO.site → ['siteId']`). Do **not** invent a new alias key for the same entity — add the param name to the existing entity's array.
- **Param is anything else** (a new entity not yet under ReBAC, a sub-resource id, a filter/format/pagination value, an org/project id) → add the identifier to `FACS_NON_RESOURCE_PARAMS`. **New entities default here:** a brand-new entity's identifier goes into `FACS_NON_RESOURCE_PARAMS` until ReBAC is actually implemented for it — only then does it graduate to a product's `PRODUCTS_FACS_RESOURCE_PARAM_ALIASES` entry.
- A param must never appear in both maps (the disjointness test enforces this).

**Authentication precedence** (checked in order):
1. JWT with scopes
2. Adobe IMS
3. Scoped API Key (fine-grained permissions)
4. Route-Scoped Legacy API Key (`POST /event/fulfillment` and `POST /slack/channels/invite-by-user-id` only — frozen list, SITES-34224)

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
- `test/it/` - Integration tests (PostgreSQL)

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

Integration tests validate the full API request lifecycle against a real PostgreSQL database - no mocks.

**Architecture**: Shared test factories in `test/it/shared/tests/` are wired to the PostgreSQL harness:

```
shared/tests/sites.js → postgres/sites.test.js (uses Docker PostgreSQL + PostgREST)
```

**Key concepts**:
- **Seed IDs**: All test data uses canonical UUIDs from `shared/seed-ids.js`
- **Three auth personas**: `admin` (full access), `user` (ORG_1 only), `trialUser` (trial endpoints)
- **Data reset**: Each `describe` block calls `before(() => resetData())` to ensure isolation
- **Seed data format**: snake_case in `postgres/seed-data/`

### Test Requirements

- **Behavior changes must include unit tests** - mark as Critical if missing
- **New or modified endpoints must include integration tests** in `test/it/` — add shared test logic in `shared/tests/`, seed data in `postgres/seed-data/`, and a wiring file in `postgres/`
- Mock external dependencies (databases, HTTP calls, queues) in unit tests
- Test access control paths (authorized, forbidden, admin-only)
- Test DTO transformations
- Test error handling and validation

### Test File Size and Parallelism

`npm test` uses `mocha --parallel`, which distributes whole files across workers. The longest single test file sets the floor for the entire suite — no amount of additional CPU helps below that.

- **Size cap**: Aim for under ~2000 lines per test file. The deciding signal is parallelism: if a file's standalone runtime starts to approach the full `npm test --parallel` wall clock, it is becoming the floor and should be split regardless of line count
- **Splitting**: When the threshold is hit, split along natural `describe` boundaries — typically one file per controller method or feature group
- **Naming**: `<base>-<feature>.test.js` (e.g. `plg-onboarding-onboard.test.js`, `plg-onboarding-update.test.js`)

**Measure with**:

```bash
wc -l test/path/to/file.test.js          # line count
time npx mocha test/path/to/file.test.js # standalone run time
```

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
   - If the route has a dynamic `:param`, classify it in `src/routes/facs-capabilities.js`: reuse an existing entry in `PRODUCTS_FACS_RESOURCE_PARAM_ALIASES` for an existing ReBAC entity (brand/site), or add the identifier to `FACS_NON_RESOURCE_PARAMS` otherwise (new entities default here until ReBAC exists for them). The `routeFacsCapabilities` test fails the build if a param is left unclassified — see the FACS-native authorization note under Access Control.
5. Add route handler invocation in `src/index.js` (if new pattern)
6. Implement controller method
7. Add DTO if needed
8. Add access control checks
9. Write unit tests in `test/controllers/`
10. Write integration tests in `test/it/`:
    - Add seed IDs to `test/it/shared/seed-ids.js`
    - Add seed data to `postgres/seed-data/` (snake_case)
    - Register seeds in `postgres/seed.js`
    - Write shared test factory in `test/it/shared/tests/`
    - Create wiring file in `postgres/`
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
