/*
 * Copyright 2026 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */

/**
 * ============================================================================
 * ENTITY SPEC TEMPLATE
 * ============================================================================
 *
 * This template provides the structure for creating E2E test specs.
 * Copy this file and replace placeholders (marked with <angle-brackets>) to
 * create a new entity spec.
 *
 * QUICK START:
 * 1. Copy this file: cp _template.spec.js <entity>.spec.js
 * 2. Replace all <placeholders> with actual values
 * 3. Choose ONE data pattern: staticFixture OR initialData (not both)
 * 4. Create entry point: test/e2e/<entity>.spec.e2e.js
 * 5. Run: npm run test-e2e-op -- --grep="<entity>"
 *
 * IMPORTANT: Do NOT modify test-runner.js when adding new entity specs.
 * The test runner is generic and handles all specs. If you need new
 * functionality, discuss extending the framework first.
 *
 * NOTE: All API requests are automatically retried on 5xx errors using
 * exponential backoff (up to 3 attempts). No spec configuration needed.
 *
 * For detailed guidance, see: test/e2e/AGENT_INSTRUCTIONS.md
 *
 * REFERENCE IMPLEMENTATIONS:
 * - Static fixture pattern: organization.spec.js
 * - Dynamic entity pattern: project.spec.js
 *
 * ============================================================================
 * DATA PATTERNS
 * ============================================================================
 *
 * Choose ONE of these patterns based on entity lifecycle:
 *
 * PATTERN A: STATIC FIXTURE (Pre-provisioned entities)
 * - Entity already exists in the test environment
 * - Tests do NOT create or delete it
 * - Tests may update it, but cleanup restores original state
 * - Use: `staticFixture` with `id` field
 * - Operations: get, update (NO create, NO delete)
 *
 * PATTERN B: DYNAMIC ENTITY (Full CRUD lifecycle)
 * - Tests create the entity at start, delete at end
 * - Use: `initialData` WITHOUT `id` field
 * - Operations: create, get, update, delete
 * - Flags: `captureEntity: true` on create, `releaseEntity: true` on delete
 *
 * ============================================================================
 */

// ============================================================================
// IMPORTS
// ============================================================================
// Import parent specs if this entity depends on others.
// The test runner will set up parents before running tests.

// import { parentEntitySpec } from './parent-entity.spec.js';

// ============================================================================
// PATTERN A: STATIC FIXTURE
// ============================================================================
// Use for pre-provisioned entities that cannot be deleted via API.
// Include ALL fields that may be read or mutated by tests.
// The test runner uses these values to restore the entity after mutations.
//
// IMPORTANT: Include only fields present in the API response schema.
// Check the OpenAPI schema at: docs/openapi/schemas.yaml

/*
const staticFixture = {
  // REQUIRED: The ID of the existing entity
  id: '<uuid>',

  // Include all fields that tests will read or modify
  fieldName: '<original-value>',

  // For nested objects, include the complete structure
  config: {
    nested: {
      field: '<original-value>',
    },
  },
};

// Destructure for convenient use in operations
const { id, fieldName, config } = staticFixture;
*/

// ============================================================================
// PATTERN B: INITIAL DATA (Dynamic Entities)
// ============================================================================
// Use for entities created and deleted by tests.
// Do NOT include `id` - it will be assigned by the API on creation.
//
// IMPORTANT: Include only fields required for entity creation.
// Check the OpenAPI schema at: docs/openapi/schemas.yaml#<EntityName>Create

/*
const initialData = {
  // Include fields required for creation
  fieldName: '<value>',

  // Do NOT include: id, createdAt, updatedAt (auto-generated)
  // Do NOT include: parent IDs here (injected via requestPayload function)
};

const { fieldName } = initialData;
*/

// ============================================================================
// UPDATED VALUES FOR MUTATION TESTING
// ============================================================================
// Define modified values to verify PATCH/PUT operations work correctly.
//
// NAMING CONVENTION: Use `updated<FieldName>` (camelCase with 'updated' prefix)
// This clearly distinguishes mutation values from original values.
//
// IMPORTANT: Use values that differ from original to verify the update occurred.

/*
const updatedFieldName = '<new-value>';

// For complex objects, define the complete updated structure
const updatedConfig = {
  nested: {
    field: '<updated-value>',
  },
};
*/

// ============================================================================
// SPEC EXPORT
// ============================================================================

/*
export const <entityName>Spec = {
  // --------------------------------------------------------------------------
  // REQUIRED: Entity identifier
  // --------------------------------------------------------------------------
  // Use PascalCase, matching the model/schema name.
  // This is used for test suite naming and parentIds key.
  entityName: '<EntityName>',

  // --------------------------------------------------------------------------
  // REQUIRED: Base API path
  // --------------------------------------------------------------------------
  // The path prefix for all operations (without trailing slash).
  //
  // OPTION 1: Static string (most common)
  basePath: '/<entities>',

  // OPTION 2: Function for nested resources (receives parent IDs)
  // basePath: (parentIds) => `/parents/${parentIds.Parent}/<entities>`,

  // --------------------------------------------------------------------------
  // CONDITIONAL: Static fixture (Pattern A only)
  // --------------------------------------------------------------------------
  // Include ONLY for pre-provisioned entities.
  // Do NOT include if using initialData pattern.
  staticFixture,

  // --------------------------------------------------------------------------
  // CONDITIONAL: Initial data (Pattern B only)
  // --------------------------------------------------------------------------
  // Include ONLY for dynamic entities.
  // Do NOT include if using staticFixture pattern.
  // initialData,

  // --------------------------------------------------------------------------
  // OPTIONAL: Parent entity dependencies
  // --------------------------------------------------------------------------
  // List specs in dependency order (parent before child).
  // The test runner will:
  // - Setup: Create parents (or use their staticFixture.id) before tests
  // - Cleanup: Delete parents in reverse order after tests
  //
  // Parent IDs are available in operations via `parentIds.<EntityName>`
  setupChain: [],
  // setupChain: [parentEntitySpec],

  // --------------------------------------------------------------------------
  // REQUIRED: Operations to test
  // --------------------------------------------------------------------------
  // Operations run in the order defined here.
  // For full CRUD, use order: create → get → update → delete
  operations: {

    // ========================================================================
    // CREATE (POST) - Dynamic entities only
    // ========================================================================
    // Do NOT include for static fixtures.
    //
    // create: {
    //   // Unique identifier for this operation (used for CLI filtering)
    //   operationId: 'create-<entity>',
    //
    //   // HTTP method
    //   method: 'POST',
    //
    //   // Path relative to basePath (empty string for collection endpoint)
    //   path: () => '',
    //
    //   // Request body - use function to inject parent IDs
    //   requestPayload: (parentIds) => ({
    //     ...initialData,
    //     parentId: parentIds.ParentEntity,  // Inject parent reference
    //   }),
    //
    //   // Expected HTTP status code
    //   expectedStatus: 201,
    //
    //   // OpenAPI schema reference (for documentation/future validation)
    //   responseSchema: '<EntityName>',
    //
    //   // Fields to verify in response body
    //   // Use function when values depend on runtime data
    //   expectedFields: (parentIds) => ({
    //     fieldName,
    //     parentId: parentIds.ParentEntity,
    //   }),
    //
    //   // REQUIRED for create: Store entity object for subsequent operations
    //   // Use `true` for standard responses, or function for batch responses:
    //   // captureEntity: (body) => body.items?.[0]?.entity,
    //   captureEntity: true,
    // },

    // ========================================================================
    // GET (Read)
    // ========================================================================
    //
    // get: {
    //   operationId: 'get-<entity>',
    //   method: 'GET',
    //
    //   // Path receives captured entity for operations on specific resource
    //   // Static fixtures: use destructured id from staticFixture
    //   // Dynamic entities: use entity.id from captured entity
    //   path: (entity) => `/${entity.id}`,
    //   // For static fixtures without captured entity: path: () => `/${id}`,
    //
    //   requestPayload: null,
    //   expectedStatus: 200,
    //   responseSchema: '<EntityName>',
    //
    //   // Use function to access captured entity in assertions
    //   expectedFields: (parentIds, entity) => ({
    //     id: entity.id,
    //     fieldName,
    //   }),
    //   // For static fixtures: expectedFields: { id, fieldName },
    // },

    // ========================================================================
    // UPDATE (PATCH/PUT)
    // ========================================================================
    //
    // update: {
    //   operationId: 'update-<entity>',
    //   method: 'PATCH',  // or 'PUT' for full replacement
    //   path: (entity) => `/${entity.id}`,
    //
    //   // Send updated values
    //   // IMPORTANT: For explicit key mapping, use { fieldName: updatedFieldName }
    //   // NOT shorthand { updatedFieldName } which creates wrong property name
    //   requestPayload: {
    //     fieldName: updatedFieldName,
    //   },
    //
    //   expectedStatus: 200,
    //   responseSchema: '<EntityName>',
    //
    //   // Verify response contains updated values
    //   // Use explicit key mapping: { fieldName: updatedFieldName }
    //   expectedFields: (parentIds, entity) => ({
    //     id: entity.id,
    //     fieldName: updatedFieldName,
    //   }),
    // },

    // ========================================================================
    // DELETE - Dynamic entities only
    // ========================================================================
    // Do NOT include for static fixtures.
    //
    // delete: {
    //   operationId: 'delete-<entity>',
    //   method: 'DELETE',
    //   path: (entity) => `/${entity.id}`,
    //   requestPayload: null,
    //   expectedStatus: 204,
    //
    //   // REQUIRED for delete: Clear capturedEntity so cleanup skips deletion
    //   // If delete test fails, capturedEntity remains set and cleanup will retry
    //   releaseEntity: true,
    // },

  },
};
*/

// ============================================================================
// REGISTER IN ENTRY POINT
// ============================================================================
// Add your spec to test/e2e/entity-tests.spec.e2e.js:
//
// ```
// import { <entityName>Spec } from './specs/<entity>.spec.js';
// // ... other imports
//
// runEntityTests(<entityName>Spec);
// ```

// Template marker - indicates this file is for documentation purposes only
export const TEMPLATE_VERSION = '1.1.0';
