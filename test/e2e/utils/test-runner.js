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
 * GENERIC TEST RUNNER - DO NOT MODIFY FOR NEW ENTITY SPECS
 * ============================================================================
 *
 * This module is the generic test executor for all E2E entity specs.
 * It handles setup, cleanup, and test execution based on spec definitions.
 *
 * IMPORTANT: When adding new entity specs, do NOT modify this file.
 * All entity-specific logic belongs in the spec files (test/e2e/specs/).
 *
 * If you need new functionality:
 * 1. Check if the spec structure already supports your use case
 * 2. Consult test/e2e/AGENT_INSTRUCTIONS.md for guidance
 * 3. Discuss framework extensions with the team before modifying this file
 *
 * Reference: test/e2e/specs/_template.spec.js
 * ============================================================================
 */

import { expect } from 'chai';
import { makeRequest, retryWithBackoff } from './utils.js';
import { BASE_URL } from '../config/config.js';
import {
  initSchemaValidator,
  validateSchema,
  formatValidationErrors,
} from './schema-validator.js';

const API_URL = `${BASE_URL}/ci`;
// const API_URL = 'http://localhost:3000';
const ADMIN_API_KEY = process.env.E2E_ADMIN_API_KEY;

/**
 * Resolves a value that may be either a static value or a function.
 * If the input is a function, it is called with the provided arguments.
 * Otherwise, the value is returned as-is.
 *
 * @param {*} valueOrFn - A static value or a function to be called
 * @param {...*} args - Arguments to pass if valueOrFn is a function
 * @returns {*} The resolved value
 */
function resolve(valueOrFn, ...args) {
  if (valueOrFn) {
    return typeof valueOrFn === 'function' ? valueOrFn(...args) : valueOrFn;
  }
  return valueOrFn;
}

/**
 * Executes a single API operation from a spec.
 *
 * @param {Object} spec - Entity spec containing basePath and operations
 * @param {Object} operation - Operation to run (e.g., spec.operations.get)
 * @param {Object} parentIds - Map of entityName -> id for parent entities
 * @param {Object|null} capturedEntity - The captured entity object (for get/update/delete)
 * @returns {Promise<{response: Response, body: Object|null}>}
 */
async function runOperation(spec, operation, parentIds = {}, capturedEntity = null) {
  // Resolve basePath - can be string or function taking parentIds
  const basePath = typeof spec.basePath === 'function'
    ? spec.basePath(parentIds)
    : spec.basePath;

  // Pass capturedEntity to path() when it's set, allowing access to any field
  const path = capturedEntity ? operation.path(capturedEntity) : operation.path();

  const url = `${API_URL}${basePath}${path}`;

  // Resolve requestPayload - can be null, object, or function
  const payload = resolve(operation.requestPayload, parentIds, capturedEntity);

  // Build request object
  const request = {
    url,
    method: operation.method,
    data: payload ? JSON.stringify(payload) : undefined,
    key: ADMIN_API_KEY,
  };

  console.log(`\n[${operation.operationId}] Request:`, {
    method: request.method,
    url: request.url,
    payload: payload ? JSON.stringify(payload, null, 2) : null,
  });

  const response = await retryWithBackoff(() => makeRequest(request));

  // Parse body if not 204 No Content
  const body = response.status !== 204 ? await response.json() : null;

  console.log(`[${operation.operationId}] Response:`, {
    status: response.status,
    body: body ? JSON.stringify(body, null, 2) : null,
  });

  return { response, body };
}

/**
 * Sets up parent entities required by the spec before tests run.
 * Iterates through setupChain in dependency order, creating dynamic entities
 * or collecting IDs from static fixtures.
 *
 * @param {Object} spec - Entity spec containing setupChain and operations
 * @returns {Promise<Object>} Map of entityName -> id for all parent entities
 */
async function setup(spec) {
  const parentIds = {};

  for (const parentSpec of (spec.setupChain ?? [])) {
    if (parentSpec.operations.create) {
      // eslint-disable-next-line no-await-in-loop
      const { body } = await runOperation(
        parentSpec,
        parentSpec.operations.create,
        parentIds,
      );
      parentIds[parentSpec.entityName] = body.id;
    } else {
      // Static fixture - no create operation
      parentIds[parentSpec.entityName] = parentSpec.staticFixture.id;
    }
  }

  return parentIds;
}

/**
 * Cleans up test state after all tests in a spec have run.
 * Performs three cleanup steps in order:
 * 1. Deletes dynamically created entities (if not a static fixture)
 * 2. Restores static fixtures to their original state (if mutated via update)
 * 3. Deletes parent entities in reverse dependency order
 *
 * Errors during cleanup are logged but do not fail the test suite.
 *
 * @param {Object} spec - Entity spec containing operations and fixture data
 * @param {Object} parentIds - Map of entityName -> id for parent entities
 * @param {Object|null} capturedEntity - The captured entity object created during tests
 */
async function cleanup(spec, parentIds, capturedEntity) {
  // 1. Delete entity if it was dynamically created
  const isStaticFixture = spec.staticFixture?.id
      && !spec.operations.delete
      && !spec.operations.create;

  const entityId = capturedEntity?.id ?? null;

  if (!isStaticFixture && entityId && spec.operations.delete) {
    try {
      await runOperation(spec, spec.operations.delete, parentIds, capturedEntity);
    } catch (e) {
      console.error(`[${spec.entityName} cleanup] Failed to delete ${entityId}:`, e.message);
    }
  }
  // 2. Restore static fixture to original state if mutated
  // Applicable only for pre-provisioned entities
  // (have staticFixture.id but no create operation)
  if (isStaticFixture && spec.operations.update?.requestPayload) {
    // Get the keys from the update operation's payload to preserve schema
    const updateKeys = Object.keys(spec.operations.update.requestPayload);

    const restorePayload = Object.fromEntries(updateKeys
      .filter((key) => key in spec.staticFixture)
      .map((key) => [key, spec.staticFixture[key]]));

    const restoreOp = {
      ...spec.operations.update,
      operationId: `restore-${spec.entityName.toLowerCase()}`,
      requestPayload: restorePayload,
    };

    try {
      // Pass staticFixture as the entity object for path resolution
      await runOperation(spec, restoreOp, parentIds, spec.staticFixture);
    } catch (e) {
      console.error(`[${spec.entityName} cleanup] Failed to restore ${spec.staticFixture.id}:`, e.message);
    }
  }

  // 3. Delete parent entities in reverse order
  for (const parentSpec of [...(spec.setupChain ?? [])].reverse()) {
    const parentId = parentIds[parentSpec.entityName];
    if (parentSpec.operations.delete && parentId) {
      try {
        // eslint-disable-next-line no-await-in-loop
        await runOperation(
          parentSpec,
          parentSpec.operations.delete,
          parentIds,
          { id: parentId }, // Wrap ID in object for path resolution
        );
      } catch (e) {
        console.error(`[${spec.entityName} cleanup] Failed to delete ${parentSpec.entityName}:`, e.message);
      }
    }
  }
}

/**
 * Runs all tests for an entity spec.
 * Handles setup/cleanup of parent entities via setupChain.
 *
 * @param {Object} spec - Entity spec
 */
export function runEntityTests(spec) {
  describe(`${spec.entityName} e2e`, () => {
    let parentIds = {};
    let capturedEntity = null;

    // Setup: initialize schema validator and create parent entities
    before(async () => {
      // Initialize schema validator once (idempotent)
      await initSchemaValidator();
      parentIds = await setup(spec);
    });

    // Cleanup: restore state and delete entities
    after(async () => {
      await cleanup(spec, parentIds, capturedEntity);
    });

    // Run each operation as a test
    Object.values(spec.operations).forEach((op) => {
      it(op.operationId, async () => {
        const { response, body } = await runOperation(spec, op, parentIds, capturedEntity);

        // Assertion
        expect(response.status).to.equal(op.expectedStatus);

        // Resolve expectedFields - can be an Object or function taking (parentIds, capturedEntity)
        if (op.expectedFields && body) {
          const expectedFields = resolve(op.expectedFields, parentIds, capturedEntity);
          expect(body).to.deep.include(expectedFields);
        }

        // Validate response against OpenAPI schema if specified
        if (op.responseSchema && body) {
          const result = validateSchema(body, op.responseSchema);
          if (!result.valid) {
            const errors = formatValidationErrors(result.errors);
            throw new Error(`Schema "${op.responseSchema}" validation failed:\n${errors}`);
          }
        }

        // Capture entity from create operations for subsequent tests
        // captureEntity can be:
        //   - true: stores entire body (for standard responses)
        //   - function: custom extractor, e.g., (body) => body.fixes?.[0]?.fix
        if (op.captureEntity && body) {
          capturedEntity = op.captureEntity === true ? body : resolve(op.captureEntity, body);
        }

        // Release entity after successful delete - cleanup will skip deletion
        if (op.releaseEntity) {
          capturedEntity = null;
        }
      });
    });
  });
}
