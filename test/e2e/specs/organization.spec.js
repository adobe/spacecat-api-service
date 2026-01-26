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
 * Organization Entity Spec
 *
 * This spec demonstrates the pattern for testing pre-provisioned (static) entities
 * that cannot be deleted via the API. The test runner will restore the entity to its
 * original state after tests complete.
 *
 * Pattern for updating fields:
 * - Define original values in `staticFixture` (used for restore and baseline assertions)
 * - Define updated values separately (e.g., `updatedConfig`) for mutation testing
 * - In `expectedFields`, use explicit key mapping: `{ config: updatedConfig }`
 *   NOT shorthand `{ updatedConfig }` which creates a property named 'updatedConfig'
 */

// Static fixture - single source of truth for test data
// All fields here represent the original/baseline state of the entity.
// The test runner uses these values to restore the entity after mutations.
const staticFixture = {
  id: '4eed02e2-a47d-48ba-8fef-0bdf2e4d0f28',
  name: 'e2e_test_organization',
  imsOrgId: '8C6043F15F43B6390A49401A@AdobeOrg',
  config: {
    slack: {
      channel: 'e2e-channel',
      workspace: 'e2e-default-workspace',
    },
  },
};

// Destructure for use in operations
const {
  id, name, imsOrgId, config,
} = staticFixture;

// Updated values for mutation testing - these differ from staticFixture
// to verify the API correctly applies changes. Use a distinct value
// (e.g., 'e2e-updated-workspace') to confirm the update was applied.
const updatedConfig = {
  slack: {
    channel: 'e2e-channel',
    workspace: 'e2e-updated-workspace',
  },
};

export const organizationSpec = {
  entityName: 'Organization',
  basePath: '/organizations',
  staticFixture,

  // Specs in dependency order. Runner will:
  // - create: run operations.create if exists, else use staticFixture.id
  // - cleanup: reverse order, run operations.delete if exists

  operations: {
    get: {
      operationId: 'get-organization',
      method: 'GET',
      path: () => `/${id}`,
      requestPayload: null,
      expectedStatus: 200,
      responseSchema: 'Organization',
      expectedFields: {
        id, name, imsOrgId, config,
      },
    },
    update: {
      operationId: 'update-organization',
      method: 'PATCH',
      path: () => `/${id}`,
      requestPayload: {
        name,
        config: updatedConfig,
      },
      expectedStatus: 200,
      responseSchema: 'Organization',
      // Use explicit key mapping `config: updatedConfig` to assert the response
      // contains a 'config' field with the updated values. Shorthand `{ updatedConfig }`
      // would incorrectly assert for a field named 'updatedConfig'.
      expectedFields: {
        id, name, imsOrgId, config: updatedConfig,
      },
    },
  },
};
