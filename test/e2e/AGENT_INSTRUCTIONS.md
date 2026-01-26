# E2E Test Framework - Agent Instructions

This document provides guidance for AI agents and developers creating E2E test specs for the SpaceCat API. It complements the spec template at `specs/_template.spec.js`.

## Overview

The E2E framework uses a **spec-driven approach** where test definitions (specs) are separated from test execution logic (test-runner). Each entity has a spec file that declares its test data and operations.

### Key Files

| File | Purpose |
|------|---------|
| `entity-tests.spec.e2e.js` | Single entry point for all entity specs |
| `specs/_template.spec.js` | Annotated template for creating new specs |
| `specs/organization.spec.js` | Reference: Static fixture pattern |
| `specs/project.spec.js` | Reference: Dynamic entity pattern |
| `utils/test-runner.js` | Generic test executor **(DO NOT MODIFY)** |
| `utils/utils.js` | Request utilities (makeRequest, retryWithBackoff) |
| `config/config.js` | Environment configuration |

> **IMPORTANT:** Do NOT modify `utils/test-runner.js` when adding new entity specs. The test runner is generic and designed to handle all specs through the spec structure. All entity-specific logic belongs in the spec files. If you encounter a limitation that seems to require modifying the test runner, consult with the team first—the spec structure may need to be extended instead.

## Quick Start: Adding a New Entity Spec

### Step 1: Identify the Entity Pattern

Check OpenAPI schema at `docs/openapi/<entity>-api.yaml` and determine:

| Question | Pattern A: Static Fixture | Pattern B: Dynamic Entity |
|----------|---------------------------|---------------------------|
| Can tests create this entity? | No | Yes |
| Can tests delete this entity? | No | Yes |
| Does entity exist in test env? | Yes (pre-provisioned) | No (created by test) |
| Has `id` in test data? | Yes (`staticFixture.id`) | No (`initialData`) |
| Operations | get, update | create, get, update, delete |

### Step 2: Create the Spec File

```bash
cp test/e2e/specs/_template.spec.js test/e2e/specs/<entity>.spec.js
```

### Step 3: Define Test Data

**Pattern A: Static Fixture**
```javascript
const staticFixture = {
  id: '<existing-entity-uuid>',
  fieldName: '<original-value>',
};
const { id, fieldName } = staticFixture;
```

**Pattern B: Dynamic Entity**
```javascript
const initialData = {
  fieldName: '<value>',
  // NO id field - assigned by API
};
const { fieldName } = initialData;
```

### Step 4: Define Updated Values

Use `updated<FieldName>` naming convention:

```javascript
const updatedFieldName = '<new-value>';
```

### Step 5: Configure the Spec Export

```javascript
export const entitySpec = {
  entityName: 'Entity',           // PascalCase
  basePath: '/entities',          // API path prefix
  staticFixture,                  // Pattern A only
  // initialData,                 // Pattern B only
  setupChain: [parentSpec],       // Parent dependencies
  operations: { /* ... */ },
};
```

### Step 6: Register in Entry Point

Add your spec to `test/e2e/entity-tests.spec.e2e.js`:

```javascript
import { entitySpec } from './specs/<entity>.spec.js';
// ... other imports

runEntityTests(entitySpec);
```

### Step 7: Run Tests

```bash
npm run test-e2e-op -- "<operationId>"
```

## Spec Structure Reference

### Top-Level Properties

| Property | Required | Type | Description |
|----------|----------|------|-------------|
| `entityName` | Yes | string | PascalCase entity name (e.g., `'Project'`) |
| `basePath` | Yes | string \| function | API path prefix (e.g., `'/projects'`) |
| `staticFixture` | Conditional | object | Pre-provisioned entity data (Pattern A) |
| `initialData` | Conditional | object | Entity creation data (Pattern B) |
| `setupChain` | No | array | Parent specs in dependency order |
| `operations` | Yes | object | Map of operation definitions |

### Operation Properties

| Property | Required | Type | Description |
|----------|----------|------|-------------|
| `operationId` | Yes | string | Unique ID for CLI filtering |
| `method` | Yes | string | HTTP method: `GET`, `POST`, `PATCH`, `PUT`, `DELETE` |
| `path` | Yes | function | Returns path relative to basePath |
| `requestPayload` | No | object \| function \| null | Request body |
| `expectedStatus` | Yes | number | Expected HTTP status code |
| `responseSchema` | No | string | OpenAPI schema reference |
| `expectedFields` | No | object \| function | Fields to verify in response |
| `captureEntity` | No | boolean \| function | Store entity object after this operation |
| `releaseEntity` | No | boolean | Clear `capturedEntity` after this operation |

### Dynamic Values (Functions)

Several properties accept functions for runtime value resolution:

| Property | Signature | Use Case |
|----------|-----------|----------|
| `basePath` | `(parentIds) => string` | Nested resource paths |
| `path` | `(entity) => string` | Include entity fields in path (e.g., `entity.id`) |
| `requestPayload` | `(parentIds, entityId) => object` | Inject parent IDs |
| `expectedFields` | `(parentIds, entity) => object` | Assert dynamic values |
| `captureEntity` | `(body) => object` | Extract entity from non-standard responses |

## Operation Flags

### `captureEntity: true | function`

Use on **create** operations. After successful creation, stores the entity object for subsequent operations.

**Simple form** (`true`): Stores entire response body.

```javascript
create: {
  // ...
  captureEntity: true,  // Stores body as capturedEntity
}
```

**Function form**: Custom extraction for non-standard responses (e.g., 207 Multi-Status).

```javascript
create: {
  expectedStatus: 207,
  captureEntity: (body) => body.suggestions?.[0]?.suggestion,  // Extract from batch response
}
```

### `releaseEntity: true`

Use on **delete** operations. After successful deletion, clears `capturedEntity` so cleanup skips redundant deletion.

```javascript
delete: {
  // ...
  releaseEntity: true,
}
```

## Parent Dependencies (setupChain)

For entities that belong to parents (e.g., Project belongs to Organization):

```javascript
import { organizationSpec } from './organization.spec.js';

export const projectSpec = {
  // ...
  setupChain: [organizationSpec],
  operations: {
    create: {
      requestPayload: (parentIds) => ({
        projectName,
        organizationId: parentIds.Organization,  // Injected from parent
      }),
    },
  },
};
```

**Test Runner Behavior:**
1. **Setup**: Creates parents in order (or uses `staticFixture.id`)
2. **Tests**: Runs operations with access to `parentIds`
3. **Cleanup**: Deletes parents in reverse order

## Retry Behavior

The test runner automatically retries failed API requests using exponential backoff:

| Setting | Default | Description |
|---------|---------|-------------|
| Max retries | 3 | Total number of attempts before failing |
| Base delay | 1000ms | Initial delay before first retry |
| Backoff | Exponential | Delay doubles each retry (1s → 2s → 4s) |
| Jitter | Random | Up to 50% of delay added to prevent thundering herd |
| Retry condition | 5xx status | Only server errors trigger retries |

**Behavior:**
- Retries are transparent to spec authors—no configuration needed
- Client errors (4xx) fail immediately without retry
- All retries are logged to console for debugging
- If all retries fail, the test fails with the last response

## Cleanup Logic

The test runner performs automatic cleanup after tests:

| Step | Condition | Action |
|------|-----------|--------|
| 1 | Dynamic entity + `entityId` set + has delete op | Delete the entity |
| 2 | Static fixture + has update op | Restore to original state |
| 3 | Has setupChain | Delete parents in reverse order |

**Note:** Cleanup errors are logged but don't fail the test suite.

## Common Patterns

### Explicit Key Mapping in expectedFields

When asserting updated values, use explicit key mapping:

```javascript
// CORRECT: Creates { config: updatedConfig }
expectedFields: {
  config: updatedConfig,
}

// WRONG: Creates { updatedConfig: {...} }
expectedFields: {
  updatedConfig,  // Shorthand creates wrong property name!
}
```

### Static Fixture with Update

For static entities that tests modify but don't delete:

```javascript
const staticFixture = {
  id: 'existing-uuid',
  name: 'original-name',
  config: { key: 'original-value' },
};

const updatedConfig = { key: 'updated-value' };

export const entitySpec = {
  staticFixture,  // Include for restoration
  operations: {
    get: { /* ... */ },
    update: {
      requestPayload: { config: updatedConfig },
      // Cleanup uses staticFixture values to restore
    },
  },
};
```

### Nested Resource Path

For resources nested under parents:

```javascript
export const siteSpec = {
  basePath: (parentIds) => `/organizations/${parentIds.Organization}/sites`,
  setupChain: [organizationSpec],
  // ...
};
```

## Naming Conventions

| Item | Convention | Example |
|------|------------|---------|
| Spec file | `<entity>.spec.js` | `project.spec.js` |
| Spec export | `<entity>Spec` | `projectSpec` |
| Entity name | PascalCase | `'Project'` |
| Operation ID | `<verb>-<entity>` | `'create-project'` |
| Original data | `staticFixture` or `initialData` | — |
| Updated values | `updated<FieldName>` | `updatedProjectName` |

## Troubleshooting

### "No updates provided" (400)

The PATCH endpoint requires at least one field that differs from current state. Ensure your `requestPayload` includes a field that will actually change.

### Parent ID undefined

Check that:
1. Parent spec is in `setupChain`
2. Using correct `entityName` from parent: `parentIds.ParentEntityName`
3. Parent has either `staticFixture.id` or `create` operation

### Entity not deleted in cleanup

If using full CRUD lifecycle, ensure:
1. `captureId: true` on create operation
2. `releaseId: true` on delete operation (if delete test runs)

### Wrong field name in assertion

Use explicit key mapping, not shorthand:
```javascript
// If variable is `updatedConfig` but field is `config`:
expectedFields: { config: updatedConfig }  // Correct
expectedFields: { updatedConfig }          // Wrong!
```

## OpenAPI Schema Reference

Before creating a spec, check the OpenAPI schemas:

- Entity schemas: `docs/openapi/schemas.yaml`
- API endpoints: `docs/openapi/<entity>-api.yaml`
- Required fields: Look for `required` array in `<Entity>Create` schema

Ensure field names in your spec match the **actual API** (database schema), not just the OpenAPI docs, as there may be discrepancies (e.g., `projectName` vs `name`).
